# Builds each map's render mesh and bakes its lighting, CS 1.6 style.
#
#   node web/tools/export-maps.mjs art/build/maps       (collision set -> JSON)
#   blender -b --factory-startup -P art/blender/build_maps.py -- [map_id ...] [--quick]
#
# Output per map, in web/public/assets/maps/:
#   <id>.glb      world mesh. Materials are named after the surface texture ids
#                 (the client binds assets/tex/<id>.jpg to them). TEXCOORD_0
#                 tiles those textures in world space; TEXCOORD_1 is the
#                 lightmap UV. A separate `skyline` node holds the unreachable
#                 scenery outside the perimeter (lit live, no lightmap).
#   <id>_lm.jpg   baked sun + sky + bounce light, gamma-encoded and scaled by
#                 LM_SCALE (the client multiplies it back).
#
# Geometry comes straight from the collider list the server uses, so every
# visible wall is exactly where the physics says it is. The only extra meshes
# are flush decals (windows, doors) and 8 u coping caps on tall walls.

import os, sys, json, math, random
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy, bmesh, numpy as np
from mathutils import Vector
from lib import reset_scene, hexcol, rgb, new_image, bake, save_image, save_raw, export_glb, args, BUILD, PUBLIC, REPO

LM_SIZE = 2048
LM_SCALE = 4.0          # stored = (irradiance / LM_SCALE) ** (1/2.2)
OUT = os.path.join(PUBLIC, 'maps')


def to_bl(p):
    """three.js / game coords (x, y-up, z) -> Blender (x, -z, y)."""
    return (p[0], -p[2], p[1])


class Builder:
    """Accumulates quads per material with world UVs (UV0)."""

    def __init__(self, solids=None):
        self.verts, self.faces, self.uvs, self.mats = [], [], [], []
        self.mat_index = {}
        self.solids = solids or []   # boxes that hide faces buried inside them
        self.culled = 0

    def holes(self, a, sgn, plane, ua, va, rect, vol):
        """Regions of an axis-aligned face (normal axis `a`, facing `sgn`) that
        can never be seen: covered by any solid directly in front of it, or
        lying on/within the surface of a LARGER solid behind it (the bigger
        box's face wins, so coplanar faces never z-fight or shadow each other
        in the bake)."""
        out = []
        front, back = plane + sgn * 0.5, plane - sgn * 0.5
        for b in self.solids:
            lo, hi = b['min'][a], b['max'][a]
            covers = lo < front < hi or (vol is not None and b['vol'] > vol and lo < back < hi)
            if not covers:
                continue
            h = (max(rect[0], b['min'][ua]), min(rect[1], b['max'][ua]),
                 max(rect[2], b['min'][va]), min(rect[3], b['max'][va]))
            if h[1] - h[0] > 0.01 and h[3] - h[2] > 0.01:
                out.append(h)
        return out

    @staticmethod
    def subtract(rects, h):
        res = []
        for (u0, u1, v0, v1) in rects:
            if h[1] <= u0 or h[0] >= u1 or h[3] <= v0 or h[2] >= v1:
                res.append((u0, u1, v0, v1)); continue
            hu0, hu1, hv0, hv1 = max(u0, h[0]), min(u1, h[1]), max(v0, h[2]), min(v1, h[3])
            if hu0 > u0: res.append((u0, hu0, v0, v1))
            if hu1 < u1: res.append((hu1, u1, v0, v1))
            if hv0 > v0: res.append((hu0, hu1, v0, hv0))
            if hv1 < v1: res.append((hu0, hu1, hv1, v1))
        return [r for r in res if r[1] - r[0] > 0.01 and r[3] - r[2] > 0.01]

    def mi(self, name):
        if name not in self.mat_index:
            self.mat_index[name] = len(self.mat_index)
        return self.mat_index[name]

    def quad(self, pts, uvs, mat, vol=None):
        if self.solids:
            # axis-aligned rectangle: find its normal axis and extent
            e1 = [pts[1][i] - pts[0][i] for i in range(3)]
            e2 = [pts[2][i] - pts[1][i] for i in range(3)]
            n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]
            a = max(range(3), key=lambda i: abs(n[i]))
            sgn = 1 if n[a] > 0 else -1
            ua, va = [i for i in range(3) if i != a]
            rect = (min(p[ua] for p in pts), max(p[ua] for p in pts), min(p[va] for p in pts), max(p[va] for p in pts))
            pieces = [rect]
            for h in self.holes(a, sgn, pts[0][a], ua, va, rect, vol):
                pieces = self.subtract(pieces, h)
                if not pieces:
                    break
            if pieces != [rect]:
                self.culled += 1
                du, dv = (rect[1] - rect[0]) or 1, (rect[3] - rect[2]) or 1
                for (u0, u1, v0, v1) in pieces:
                    npts, nuvs = [], []
                    for p, uv in zip(pts, uvs):
                        q = list(p)
                        q[ua] = u0 if p[ua] == rect[0] else u1
                        q[va] = v0 if p[va] == rect[2] else v1
                        npts.append(tuple(q))
                    # bilinear re-interpolation of the corner UVs
                    corner = {(p[ua] == rect[0], p[va] == rect[2]): uv for p, uv in zip(pts, uvs)}
                    for q in npts:
                        fu, fv = (q[ua] - rect[0]) / du, (q[va] - rect[2]) / dv
                        c00, c10 = corner[(True, True)], corner[(False, True)]
                        c01, c11 = corner[(True, False)], corner[(False, False)]
                        nuvs.append(tuple(
                            (c00[k] * (1 - fu) + c10[k] * fu) * (1 - fv) + (c01[k] * (1 - fu) + c11[k] * fu) * fv
                            for k in range(2)))
                    self._emit(npts, nuvs, mat)
                return
        self._emit(pts, uvs, mat)

    def _emit(self, pts, uvs, mat):
        base = len(self.verts)
        self.verts += [to_bl(p) for p in pts]
        self.faces.append((base, base + 1, base + 2, base + 3))
        self.uvs += uvs
        self.mats.append(self.mi(mat))

    def box(self, mn, mx, mat, tile, bottom=False, skip_sides=False):
        x0, y0, z0 = mn; x1, y1, z1 = mx
        vol = (x1 - x0) * (y1 - y0) * (z1 - z0)
        quad = lambda pts, uvs, m: self.quad(pts, uvs, m, vol)
        u = (lambda a: a / tile) if tile else None

        def fuv(a0, a1, b0, b1):
            if tile:
                return [(u(a0), u(b0)), (u(a1), u(b0)), (u(a1), u(b1)), (u(a0), u(b1))]
            return [(0, 0), (1, 0), (1, 1), (0, 1)]

        # top (normal +y): wound CCW seen from above in game space
        quad([(x0, y1, z1), (x1, y1, z1), (x1, y1, z0), (x0, y1, z0)], fuv(x0, x1, -z1, -z0), mat)
        if bottom:
            quad([(x0, y0, z0), (x1, y0, z0), (x1, y0, z1), (x0, y0, z1)], fuv(x0, x1, z0, z1), mat)
        if skip_sides:
            return
        quad([(x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)], fuv(x0, x1, y0, y1), mat)      # +z
        quad([(x1, y0, z0), (x0, y0, z0), (x0, y1, z0), (x1, y1, z0)], fuv(-x1, -x0, y0, y1), mat)    # -z
        quad([(x1, y0, z1), (x1, y0, z0), (x1, y1, z0), (x1, y1, z1)], fuv(-z1, -z0, y0, y1), mat)    # +x
        quad([(x0, y0, z0), (x0, y0, z1), (x0, y1, z1), (x0, y1, z0)], fuv(z0, z1, y0, y1), mat)      # -x

    def object(self, name, materials):
        me = bpy.data.meshes.new(name)
        me.from_pydata(self.verts, [], self.faces)
        uvl = me.uv_layers.new(name='UVMap')
        for poly, mi in zip(me.polygons, self.mats):
            poly.material_index = mi
            for k, li in enumerate(poly.loop_indices):
                uvl.data[li].uv = self.uvs[poly.index * 4 + k]
        ordered = sorted(self.mat_index.items(), key=lambda kv: kv[1])
        for mname, _ in ordered:
            me.materials.append(materials[mname])
        me.validate()
        me.update()
        ob = bpy.data.objects.new(name, me)
        bpy.context.scene.collection.objects.link(ob)
        return ob


def make_material(name, color_hex):
    """Plain material: the bake only needs albedo for bounce light; the real
    texture is bound by name in the client."""
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = hexcol(color_hex)
    bsdf.inputs['Roughness'].default_value = 0.9
    return m


def inside_any(p, boxes, pad=0.0):
    for b in boxes:
        if all(b['min'][i] - pad <= p[i] <= b['max'][i] + pad for i in range(3)):
            return True
    return False


def build_map(path, quick=False):
    reset_scene()
    data = json.load(open(path))
    mid = data['id']
    theme = data['theme']
    boxes = data['boxes']
    for bx in boxes:
        bx['vol'] = (bx['max'][0] - bx['min'][0]) * (bx['max'][1] - bx['min'][1]) * (bx['max'][2] - bx['min'][2])
    bnd = data['bounds']
    rnd = random.Random(data['coverSeed'])
    print(f'== {mid}: {len(boxes)} boxes')

    # surface material per palette material (named after its texture id)
    mat_tex = {k: v['tex'] for k, v in theme['mats'].items()}
    tiles = {k: v['tile'] for k, v in theme['mats'].items()}
    materials = {}

    def mat_for(pal):
        tid = mat_tex.get(pal, 'dust_sandstone')
        if tid not in materials:
            materials[tid] = make_material(tid, data['palette'].get(pal, '8a8a8a'))
        return tid

    world = Builder(boxes)
    for b in boxes:
        mn, mx, pal = b['min'], b['max'], b['mat']
        tid = mat_for(pal)
        tile = tiles.get(pal, 128)
        world.box(mn, mx, tid, tile, bottom=mn[1] > 1)
        h = mx[1] - mn[1]
        thin = min(mx[0] - mn[0], mx[2] - mn[2])
        if h >= 160 and pal in ('wall', 'accent') and thin <= 96:
            cap = mat_for('accent')
            world.box([mn[0] - 4, mx[1], mn[2] - 4], [mx[0] + 4, mx[1] + 8, mx[2] + 4], cap, 64, bottom=True)

    # flush decals: shuttered windows high on long walls, doors at the foot
    for tex in ('window_shutter', 'door_wood'):
        materials[tex] = make_material(tex, '6b5a44')
    for b in boxes:
        mn, mx, pal = b['min'], b['max'], b['mat']
        h = mx[1] - mn[1]
        if pal not in ('wall', 'accent') or h < 192:
            continue
        for axis, other in ((0, 2), (2, 0)):
            length = mx[other] - mn[other]
            if length < 256 or (mx[axis] - mn[axis]) > length:
                continue
            for side in (-1, 1):
                face = mx[axis] if side > 0 else mn[axis]
                n_slots = int(length // 256)
                for k in range(n_slots):
                    if rnd.random() > 0.45:
                        continue
                    c = mn[other] + (k + 0.5) * (length / n_slots)
                    probe = [0, 0, 0]
                    probe[axis] = face + side * 40
                    probe[other] = c
                    probe[1] = mn[1] + 40
                    if inside_any(probe, boxes) or not (bnd['x0'] < probe[0] < bnd['x1'] and bnd['z0'] < probe[2] < bnd['z1']):
                        continue
                    door = mn[1] <= 1 and rnd.random() < 0.3
                    w, hh = (56, 96) if door else (48, 56)
                    y0 = mn[1] if door else mn[1] + h * 0.55
                    if y0 + hh > mx[1] - 8:
                        continue
                    off = face + side * 0.6
                    a0, a1 = c - w / 2, c + w / 2
                    def P(o, y):
                        p = [0, y, 0]; p[axis] = off; p[other] = o; return tuple(p)
                    # wind so the decal faces outward
                    if (axis == 0) == (side > 0):
                        pts = [P(a1, y0), P(a0, y0), P(a0, y0 + hh), P(a1, y0 + hh)]
                    else:
                        pts = [P(a0, y0), P(a1, y0), P(a1, y0 + hh), P(a0, y0 + hh)]
                    world.quad(pts, [(0, 0), (1, 0), (1, 1), (0, 1)], 'door_wood' if door else 'window_shutter')

    # water sheets (lightmapped like everything else)
    for wtr in data['water']:
        tid = mat_for('water')
        px, pz = wtr['pos']
        world.box([px - wtr['w'] / 2, wtr['y'] - 2, pz - wtr['d'] / 2], [px + wtr['w'] / 2, wtr['y'] + 2, pz + wtr['d'] / 2], tid, 256, skip_sides=True)

    ob = world.object(mid, materials)
    print(f'   trimmed {world.culled} faces against hidden/coplanar regions, {len(world.faces)} quads')

    # --- lightmap UVs: area-proportional islands, one atlas for the whole map
    lm = ob.data.uv_layers.new(name='LM')
    ob.data.uv_layers.active = lm
    bpy.context.view_layer.objects.active = ob
    ob.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.004, area_weight=0.0,
                             correct_aspect=True, scale_to_bounds=False)
    bpy.ops.uv.pack_islands(margin=0.003, rotate=True)
    bpy.ops.object.mode_set(mode='OBJECT')

    # --- lighting: sun + sky, the same direction the client uses
    scn = bpy.context.scene
    sd = Vector(to_bl(theme['sunDir'])).normalized()
    sun_data = bpy.data.lights.new('sun', 'SUN')
    sun_data.energy = theme['sunStrength'] * data['sun']
    sun_data.angle = math.radians(1.2)
    sun_data.color = hexcol(theme['sunColor'])[:3]
    sun = bpy.data.objects.new('sun', sun_data)
    sun.rotation_euler = sd.to_track_quat('Z', 'Y').to_euler()
    scn.collection.objects.link(sun)

    wd = bpy.data.worlds.new('sky')
    scn.world = wd
    wd.use_nodes = True
    bg = wd.node_tree.nodes['Background']
    sky = hexcol(data['sky']['top'])
    bg.inputs['Color'].default_value = tuple(c * 0.45 + 0.55 * 0.9 for c in sky[:3]) + (1.0,)
    bg.inputs['Strength'].default_value = theme['skyStrength'] * data['ambient'] * 1.6

    scn.cycles.max_bounces = 4
    scn.cycles.diffuse_bounces = 3
    scn.cycles.use_denoising = False
    size = 256 if quick else LM_SIZE
    img = new_image(mid + '_lm', size, float_buf=True)
    bake(ob, 'DIFFUSE', img, samples=16 if quick else 160, margin=6, passes={'DIRECT', 'INDIRECT'}, uv_layer='LM')

    # denoise (OIDN via the compositor), then encode: (irr / LM_SCALE) ** (1/2.2)
    img = denoise(img) if not quick else img
    px = np.array(img.pixels[:], dtype=np.float32).reshape(-1, 4)
    rgbv = np.clip(px[:, :3] / LM_SCALE, 0, 1) ** (1 / 2.2)
    out = new_image(mid + '_lm8', size, non_color=True)
    o = np.ones((rgbv.shape[0], 4), dtype=np.float32)
    o[:, :3] = rgbv
    out.pixels = o.ravel()
    out.update()
    save_raw(out, os.path.join(OUT, mid + '_lm.jpg'), quality=92)

    # --- skyline (separate node, lit live)
    sky = build_skyline(data, theme, materials, mat_for, rnd)

    # the glTF only needs UVs + material names; drop the bake nodes
    for m in materials.values():
        n = m.node_tree.nodes.get('__bake__')
        if n:
            m.node_tree.nodes.remove(n)
    ob.data.uv_layers.active = ob.data.uv_layers['UVMap']
    ob.data.uv_layers['UVMap'].active_render = True
    export_glb(os.path.join(OUT, mid + '.glb'), [ob, sky])


def denoise(img):
    scn = bpy.context.scene
    scn.use_nodes = True
    nt = scn.node_tree
    nt.nodes.clear()
    src = nt.nodes.new('CompositorNodeImage'); src.image = img
    dn = nt.nodes.new('CompositorNodeDenoise'); dn.prefilter = 'ACCURATE'
    vw = nt.nodes.new('CompositorNodeViewer')
    comp = nt.nodes.new('CompositorNodeComposite')
    nt.links.new(src.outputs[0], dn.inputs['Image'])
    nt.links.new(dn.outputs[0], vw.inputs[0])
    nt.links.new(dn.outputs[0], comp.inputs[0])
    scn.render.resolution_x = img.size[0]
    scn.render.resolution_y = img.size[1]
    scn.render.resolution_percentage = 100
    # render only the compositor (no scene): cheap, since nothing renders layers
    scn.render.use_compositing = True
    scn.render.use_sequencer = False
    scn.view_layers[0].use = True
    tmp = os.path.join(BUILD, 'tmp_dn.exr')
    os.makedirs(BUILD, exist_ok=True)
    scn.render.image_settings.file_format = 'OPEN_EXR'
    scn.render.filepath = tmp
    # make sure the camera exists for the render call
    if not scn.camera:
        cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
        scn.collection.objects.link(cam)
        scn.camera = cam
    scn.cycles.samples = 1
    for ob in scn.objects:
        ob.hide_render = True
    bpy.ops.render.render(write_still=True)
    for ob in scn.objects:
        ob.hide_render = False
    res = bpy.data.images.load(tmp)
    res.colorspace_settings.name = 'Non-Color'
    return res


def tiles_floor(theme):
    return theme['mats'].get('floor', {}).get('tile', 256) or 256


def build_skyline(data, theme, materials, mat_for, rnd):
    b = data['bounds']
    sk = Builder()

    def ring_point():
        side = rnd.randrange(4)
        out = 220 + rnd.random() * 1300
        t = rnd.random()
        if side == 0: return b['x0'] + (b['x1'] - b['x0']) * t, b['z0'] - out
        if side == 1: return b['x0'] + (b['x1'] - b['x0']) * t, b['z1'] + out
        if side == 2: return b['x0'] - out, b['z0'] + (b['z1'] - b['z0']) * t
        return b['x1'] + out, b['z0'] + (b['z1'] - b['z0']) * t

    # ground apron under the skyline, just below the playable floor (y = 0)
    sk.box([b['x0'] - 5000, -40, b['z0'] - 5000], [b['x1'] + 5000, -2, b['z1'] + 5000], mat_for('floor'), tiles_floor(theme))

    if theme['skyline'] == 'town':
        wall = mat_for('wall')
        roof = mat_for('accent')
        for _ in range(70):
            x, z = ring_point()
            w, d, h = 192 + rnd.random() * 448, 192 + rnd.random() * 448, 320 + rnd.random() * 640
            sk.box([x - w / 2, -8, z - d / 2], [x + w / 2, h, z + d / 2], wall, 128)
            sk.box([x - w / 2 - 8, h, z - d / 2 - 8], [x + w / 2 + 8, h + 20, z + d / 2 + 8], roof, 128, bottom=True)
            # a few windows on the visible faces
            for _k in range(int(w // 160)):
                wx = x - w / 2 + 80 + _k * 160
                for side in (-1, 1):
                    zf = z + side * (d / 2 + 0.6)
                    wy = h * (0.35 + rnd.random() * 0.4)
                    pts = [(wx - 24, wy, zf), (wx + 24, wy, zf), (wx + 24, wy + 56, zf), (wx - 24, wy + 56, zf)]
                    if side < 0:
                        pts = [pts[1], pts[0], pts[3], pts[2]]
                    sk.quad(pts, [(0, 0), (1, 0), (1, 1), (0, 1)], 'window_shutter')
        for _ in range(5):   # minarets
            x, z = ring_point()
            h = 800 + rnd.random() * 500
            sk.box([x - 56, -8, z - 56], [x + 56, h, z + 56], wall, 128)
            sk.box([x - 80, h, z - 80], [x + 80, h + 28, z + 80], roof, 128, bottom=True)
            sk.box([x - 40, h + 28, z - 40], [x + 40, h + 150, z + 40], wall, 128)
    else:
        stone = mat_for('stone')
        leaves = mat_for('foliage')
        wood = mat_for('wood')
        for _ in range(80):
            x, z = ring_point()
            h = 360 + rnd.random() * 520
            sk.box([x - 14, -8, z - 14], [x + 14, h, z + 14], wood, 128)
            for k in range(3):
                s = 90 + rnd.random() * 120
                ox, oz = (rnd.random() - 0.5) * 140, (rnd.random() - 0.5) * 140
                y = h - 60 + k * 60
                sk.box([x + ox - s, y, z + oz - s], [x + ox + s, y + s * 0.8, z + oz + s], leaves, 96, bottom=True)
        px, pz = b['x1'] + 2600, b['z0'] - 1800
        for s in range(6):
            half = 900 - s * 140
            sk.box([px - half, s * 140, pz - half], [px + half, (s + 1) * 140, pz + half], stone, 192)
    return sk.object('skyline', materials)


def main():
    a = args()
    quick = '--quick' in a
    want = [x for x in a if not x.startswith('--')]
    src = os.path.join(BUILD, 'maps')
    files = sorted(f for f in os.listdir(src) if f.endswith('.json'))
    for f in files:
        if want and f[:-5] not in want:
            continue
        build_map(os.path.join(src, f), quick=quick)


main()
