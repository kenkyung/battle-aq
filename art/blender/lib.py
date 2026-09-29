# Shared helpers for the Battle-AQ Blender build scripts.
#
# Everything under art/blender is run headless:
#     blender -b --factory-startup -P art/blender/<script>.py -- [args]
# (art/build.sh runs them all in order.) Nothing is hand-edited in a .blend:
# the scripts ARE the source, so any asset can be regenerated and reviewed
# as a diff.

import bpy, math, os, sys, bmesh
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..'))
PUBLIC = os.path.join(REPO, 'web', 'public', 'assets')
BUILD = os.path.join(REPO, 'art', 'build')


def args():
    return sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scn = bpy.context.scene
    scn.render.engine = 'CYCLES'
    scn.cycles.device = 'CPU'
    scn.cycles.use_denoising = False
    scn.render.threads_mode = 'AUTO'
    # bakes are data, not photos: no AgX/filmic tone mapping on save
    scn.view_settings.view_transform = 'Standard'
    scn.view_settings.look = 'None'
    return scn


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hexcol(h, alpha=1.0):
    """'#rrggbb' / 'rrggbb' (sRGB) -> linear RGBA tuple for node inputs."""
    h = h.lstrip('#')
    r, g, b = (int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))
    return (srgb_to_linear(r), srgb_to_linear(g), srgb_to_linear(b), alpha)


def rgb(r, g, b, alpha=1.0):
    """0..1 sRGB floats -> linear RGBA."""
    return (srgb_to_linear(r), srgb_to_linear(g), srgb_to_linear(b), alpha)


# ------------------------------------------------------------------ node graph

TAU = math.tau


class G:
    """Tiny builder for shader node trees: every helper returns an output
    socket, and every input accepts either a socket or a constant."""

    def __init__(self, mat):
        mat.use_nodes = True
        self.nt = mat.node_tree
        self.nt.nodes.clear()
        self.x = 0

    def node(self, kind, **props):
        n = self.nt.nodes.new(kind)
        n.location = (self.x, 0)
        self.x += 30
        for k, v in props.items():
            setattr(n, k, v)
        return n

    def put(self, sock, value):
        if value is None:
            return
        if hasattr(value, 'is_output'):
            self.nt.links.new(value, sock)
        else:
            sock.default_value = value

    # --- math
    def m(self, op, a, b=None, c=None, clamp=False):
        n = self.node('ShaderNodeMath', operation=op, use_clamp=clamp)
        self.put(n.inputs[0], a)
        if b is not None:
            self.put(n.inputs[1], b)
        if c is not None:
            self.put(n.inputs[2], c)
        return n.outputs[0]

    def add(self, a, b): return self.m('ADD', a, b)
    def sub(self, a, b): return self.m('SUBTRACT', a, b)
    def mul(self, a, b): return self.m('MULTIPLY', a, b)
    def div(self, a, b): return self.m('DIVIDE', a, b)
    def mn(self, a, b): return self.m('MINIMUM', a, b)
    def mx(self, a, b): return self.m('MAXIMUM', a, b)
    def floor(self, a): return self.m('FLOOR', a)
    def fract(self, a): return self.m('FRACT', a)
    def absv(self, a): return self.m('ABSOLUTE', a)
    def mod(self, a, b): return self.m('FLOORED_MODULO', a, b)
    def cos(self, a): return self.m('COSINE', a)
    def sin(self, a): return self.m('SINE', a)
    def lt(self, a, b): return self.m('LESS_THAN', a, b)
    def gt(self, a, b): return self.m('GREATER_THAN', a, b)
    def pw(self, a, b): return self.m('POWER', a, b)
    def clamp01(self, a): return self.m('ADD', a, 0.0, clamp=True)

    def smooth(self, a, lo, hi, to_lo=0.0, to_hi=1.0):
        n = self.node('ShaderNodeMapRange', interpolation_type='SMOOTHSTEP', clamp=True)
        self.put(n.inputs['Value'], a)
        self.put(n.inputs['From Min'], lo)
        self.put(n.inputs['From Max'], hi)
        self.put(n.inputs['To Min'], to_lo)
        self.put(n.inputs['To Max'], to_hi)
        return n.outputs['Result']

    def lin(self, a, lo, hi, to_lo=0.0, to_hi=1.0):
        n = self.node('ShaderNodeMapRange', interpolation_type='LINEAR', clamp=True)
        self.put(n.inputs['Value'], a)
        self.put(n.inputs['From Min'], lo)
        self.put(n.inputs['From Max'], hi)
        self.put(n.inputs['To Min'], to_lo)
        self.put(n.inputs['To Max'], to_hi)
        return n.outputs['Result']

    def vec(self, x, y, z):
        n = self.node('ShaderNodeCombineXYZ')
        self.put(n.inputs[0], x); self.put(n.inputs[1], y); self.put(n.inputs[2], z)
        return n.outputs[0]

    def uv(self):
        tc = self.node('ShaderNodeTexCoord')
        sep = self.node('ShaderNodeSeparateXYZ')
        self.nt.links.new(tc.outputs['UV'], sep.inputs[0])
        return sep.outputs[0], sep.outputs[1]

    def objcoord(self):
        tc = self.node('ShaderNodeTexCoord')
        return tc.outputs['Object']

    # --- colour
    def mix(self, fac, a, b, blend='MIX'):
        n = self.node('ShaderNodeMix', data_type='RGBA', blend_type=blend, clamp_factor=True)
        self.put(n.inputs[0], fac)
        self.put(n.inputs[6], a)
        self.put(n.inputs[7], b)
        return n.outputs[2]

    def ramp(self, fac, stops, interp='LINEAR'):
        n = self.node('ShaderNodeValToRGB')
        cr = n.color_ramp
        cr.interpolation = interp
        while len(cr.elements) < len(stops):
            cr.elements.new(0.5)
        for el, (pos, col) in zip(cr.elements, stops):
            el.position = pos
            el.color = col
        self.put(n.inputs[0], fac)
        return n.outputs[0]

    def hsv(self, col, h=0.5, s=1.0, v=1.0):
        n = self.node('ShaderNodeHueSaturation')
        self.put(n.inputs['Hue'], h); self.put(n.inputs['Saturation'], s)
        self.put(n.inputs['Value'], v); self.put(n.inputs['Color'], col)
        return n.outputs[0]

    def bw(self, col):
        n = self.node('ShaderNodeRGBToBW')
        self.put(n.inputs[0], col)
        return n.outputs[0]

    # --- seamless (torus-mapped) noise. u, v in 0..1 -> tiles at the edges.
    def _torus(self, u, v, su, sv, seed):
        ru, rv = su / TAU, sv / TAU
        au, av = self.mul(u, TAU), self.mul(v, TAU)
        x = self.add(self.mul(self.cos(au), ru), seed * 17.31)
        y = self.add(self.mul(self.sin(au), ru), seed * 5.13)
        z = self.add(self.mul(self.cos(av), rv), seed * 11.7)
        w = self.add(self.mul(self.sin(av), rv), seed * 3.9)
        return self.vec(x, y, z), w

    def noise(self, u, v, su, sv=None, detail=4.0, rough=0.55, distort=0.0, seed=0, out='Fac'):
        sv = su if sv is None else sv
        p, w = self._torus(u, v, su, sv, seed)
        n = self.node('ShaderNodeTexNoise', noise_dimensions='4D')
        self.put(n.inputs['Vector'], p); self.put(n.inputs['W'], w)
        n.inputs['Scale'].default_value = 1.0
        n.inputs['Detail'].default_value = detail
        n.inputs['Roughness'].default_value = rough
        n.inputs['Distortion'].default_value = distort
        if out != 'Fac':
            return n.outputs[out]
        # 4D fBm clusters tightly around 0.5; stretch it to use the full 0..1
        return self.lin(n.outputs['Fac'], 0.32, 0.68)

    def voronoi(self, u, v, su, sv=None, feature='F1', seed=0, out='Distance', rand=1.0):
        sv = su if sv is None else sv
        p, w = self._torus(u, v, su, sv, seed)
        n = self.node('ShaderNodeTexVoronoi', voronoi_dimensions='4D', feature=feature)
        self.put(n.inputs['Vector'], p); self.put(n.inputs['W'], w)
        n.inputs['Scale'].default_value = 1.0
        n.inputs['Randomness'].default_value = rand
        return n.outputs[out]

    def white(self, a, b, seed=0.0):
        n = self.node('ShaderNodeTexWhiteNoise', noise_dimensions='3D')
        self.put(n.inputs['Vector'], self.vec(a, b, seed))
        return n.outputs['Value']

    # --- running-bond bricks that tile: returns (edge, brick_rand, lu, lv)
    #     edge = distance (in brick-local 0..0.5 units) to the nearest mortar line
    def bricks(self, u, v, cols, rows, seed=0.0, stagger=0.5):
        rowf = self.mul(v, rows)
        row = self.floor(rowf)
        off = self.mul(self.mod(row, 2.0), stagger)
        colf = self.add(self.mul(u, cols), off)
        col = self.mod(self.floor(colf), cols)
        lu, lv = self.fract(colf), self.fract(rowf)
        eu = self.mn(lu, self.sub(1.0, lu))
        # scale the vertical edge by the brick aspect so the mortar is even
        ev = self.mul(self.mn(lv, self.sub(1.0, lv)), (cols / rows))
        edge = self.mn(eu, ev)
        rnd = self.white(col, self.mod(row, rows), seed)
        return edge, rnd, lu, lv

    # --- final surface
    def surface(self, color, height=None, rough=0.8, metal=0.0, bump=0.5):
        bsdf = self.node('ShaderNodeBsdfPrincipled')
        self.put(bsdf.inputs['Base Color'], color)
        self.put(bsdf.inputs['Roughness'], rough)
        self.put(bsdf.inputs['Metallic'], metal)
        if height is not None:
            b = self.node('ShaderNodeBump')
            b.inputs['Strength'].default_value = bump
            b.inputs['Distance'].default_value = 0.02
            self.put(b.inputs['Height'], height)
            self.nt.links.new(b.outputs['Normal'], bsdf.inputs['Normal'])
        out = self.node('ShaderNodeOutputMaterial')
        self.nt.links.new(bsdf.outputs[0], out.inputs['Surface'])
        return bsdf

    def image_target(self, img):
        n = self.node('ShaderNodeTexImage')
        n.image = img
        self.nt.nodes.active = n
        n.select = True
        return n


# ------------------------------------------------------------------ baking

def new_image(name, size, alpha=False, non_color=False, float_buf=False):
    if name in bpy.data.images:
        bpy.data.images.remove(bpy.data.images[name])
    img = bpy.data.images.new(name, size, size, alpha=alpha, float_buffer=float_buf)
    if non_color:
        img.colorspace_settings.name = 'Non-Color'
    return img


def set_bake_target(obj, img):
    for slot in obj.material_slots:
        nt = slot.material.node_tree
        n = nt.nodes.get('__bake__') or nt.nodes.new('ShaderNodeTexImage')
        n.name = '__bake__'
        n.image = img
        for other in nt.nodes:
            other.select = False
        n.select = True
        nt.nodes.active = n


def bake(obj, kind, img, samples=4, margin=4, passes=None, uv_layer=None):
    scn = bpy.context.scene
    scn.cycles.samples = samples
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    set_bake_target(obj, img)
    bk = scn.render.bake
    bk.margin = margin
    bk.use_clear = True
    bk.target = 'IMAGE_TEXTURES'
    if uv_layer:
        obj.data.uv_layers.active = obj.data.uv_layers[uv_layer]
    kw = dict(type=kind, margin=margin, use_clear=True)
    if kind == 'DIFFUSE':
        f = passes or {'COLOR'}
        kw['pass_filter'] = f
    if kind == 'NORMAL':
        kw['normal_space'] = 'TANGENT'
    bpy.ops.object.bake(**kw)


def save_raw(img, path, quality=92):
    """Write the pixel buffer as-is (no view transform), e.g. lightmaps."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.filepath_raw = path
    img.file_format = 'JPEG'
    bpy.context.scene.render.image_settings.quality = quality
    img.save(filepath=path, quality=quality)
    print('wrote', os.path.relpath(path, REPO))


def save_image(img, path, fmt='JPEG', quality=88):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    scn = bpy.context.scene
    s = scn.render.image_settings
    s.file_format = fmt
    s.quality = quality
    s.color_mode = 'RGB' if fmt == 'JPEG' else s.color_mode
    if fmt == 'PNG':
        s.color_mode = 'RGBA' if img.alpha_mode != 'NONE' and img.depth == 32 else 'RGB'
        s.compression = 90
    img.save_render(path, scene=scn)
    print('wrote', os.path.relpath(path, REPO))


# ------------------------------------------------------------------ mesh helpers

def mesh_object(name, verts, faces, uvs=None, mat=None):
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    if uvs is not None:
        layer = me.uv_layers.new(name='UVMap')
        for poly in me.polygons:
            for li in poly.loop_indices:
                layer.data[li].uv = uvs[li]
    me.update()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    if mat:
        ob.data.materials.append(mat)
    return ob


def plane(name, size=2.0, mat=None):
    s = size / 2
    verts = [(-s, -s, 0), (s, -s, 0), (s, s, 0), (-s, s, 0)]
    uvs = [(0, 0), (1, 0), (1, 1), (0, 1)]
    return mesh_object(name, verts, [(0, 1, 2, 3)], uvs, mat)


def apply_all(ob):
    bpy.ops.object.select_all(action='DESELECT')
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob
    for mod in list(ob.modifiers):
        bpy.ops.object.modifier_apply(modifier=mod.name)


def export_glb(path, objects=None, animations=False, selected=True):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.ops.object.select_all(action='DESELECT')
    for o in objects or []:
        o.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format='GLB',
        use_selection=selected and objects is not None,
        export_apply=True,
        export_yup=True,
        export_texcoords=True,
        export_normals=True,
        export_materials='EXPORT',
        export_image_format='JPEG',
        export_jpeg_quality=86,
        export_animations=animations,
        export_extras=True,
    )
    print('wrote', os.path.relpath(path, REPO), f'{os.path.getsize(path) / 1024:.0f} KB')
