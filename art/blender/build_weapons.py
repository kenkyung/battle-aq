# Builds every weapon model plus the first-person arms.
#
#   blender -b --factory-startup -P art/blender/build_weapons.py
#
# -> web/public/assets/models/weapons.glb
#
# One node per weapon, named by its id in shared/constants.js (ak47, m4a1, ...).
# Each is modelled from bevelled parts in game units (inches), origin at the
# firing hand's grip, barrel along +Y (glTF/three.js: -Z, the view direction).
# Child empties:
#   <id>_muzzle   where the flash and tracers start
#   <id>_lhand    where the support hand holds it (absent on pistols/knife)
# Each weapon's parts are joined and its procedural materials (parkerized
# steel, walnut, polymer, olive drab, chrome) baked into a 512 px texture.
# arm_t / arm_ct: gloved hand + sleeve, origin at the palm, forearm along -Y.

import os, sys, math
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy, bmesh
from mathutils import Vector, Matrix
from lib import G, reset_scene, rgb, new_image, bake, PUBLIC
from prims import PARTS, box, limb, cyl, dome, mat, n3, plain, camo, cloth

OUT = os.path.join(PUBLIC, 'models')


# ------------------------------------------------------------------ materials

def aniso(g, co, sx, sy, sz):
    vm = g.node('ShaderNodeVectorMath', operation='MULTIPLY')
    g.put(vm.inputs[0], co)
    vm.inputs[1].default_value = (sx, sy, sz)
    return vm.outputs[0]


def wood_f(base=(0.40, 0.22, 0.11)):
    def f(g, co, x, y, z):
        grain = n3(g, aniso(g, co, 5.0, 0.35, 5.0), 1.0, 5, 3, distort=0.8)
        ring = g.fract(g.mul(grain, 6.0))
        col = g.mix(g.smooth(ring, 0.2, 0.9), rgb(base[0] * 0.7, base[1] * 0.65, base[2] * 0.6), rgb(*base))
        wear = n3(g, co, 0.8, 4, 9)
        col = g.mix(g.mul(g.smooth(wear, 0.6, 0.8), 0.5), col, rgb(base[0] * 1.35, base[1] * 1.3, base[2] * 1.2))
        return col, 0.55
    return f


def steel_f(base=(0.13, 0.135, 0.15), wear_col=(0.42, 0.43, 0.45)):
    def f(g, co, x, y, z):
        n = n3(g, co, 0.6, 4, 21)
        col = g.mix(g.mul(n, 0.25), rgb(*base), rgb(base[0] * 0.7, base[1] * 0.7, base[2] * 0.7))
        scratch = n3(g, aniso(g, co, 0.6, 5.0, 0.6), 1.0, 2, 22)
        col = g.mix(g.mul(g.smooth(scratch, 0.86, 0.96), 0.35), col, rgb(*wear_col))
        return col, 0.45
    return f


def paint_f(base, chips=(0.18, 0.18, 0.18)):
    def f(g, co, x, y, z):
        n = n3(g, co, 0.9, 5, 31)
        col = g.mix(g.mul(n, 0.3), rgb(*base), rgb(base[0] * 0.6, base[1] * 0.6, base[2] * 0.6))
        chip = g.smooth(n3(g, co, 3.0, 3, 32), 0.78, 0.84)
        col = g.mix(chip, col, rgb(*chips))
        return col, 0.7
    return f


def chrome_f():
    def f(g, co, x, y, z):
        n = n3(g, aniso(g, co, 1.0, 8.0, 1.0), 1.0, 4, 41)
        col = g.mix(n, rgb(0.52, 0.53, 0.55), rgb(0.78, 0.79, 0.8))
        return col, 0.25
    return f


MATS = {}


def M(name):
    if name in MATS:
        return MATS[name]
    table = {
        'steel': steel_f(),
        'blued': steel_f((0.07, 0.075, 0.09), (0.3, 0.31, 0.34)),
        'wood': wood_f(),
        'wood_dark': wood_f((0.27, 0.14, 0.08)),
        'poly': paint_f((0.075, 0.075, 0.08), (0.2, 0.2, 0.2)),
        'olive': paint_f((0.25, 0.29, 0.18), (0.12, 0.12, 0.1)),
        'grey': paint_f((0.26, 0.27, 0.28), (0.12, 0.12, 0.12)),
        'chrome': chrome_f(),
        'glass': plain((0.05, 0.1, 0.14), 0.1, 0.1),
        'brass': plain((0.62, 0.48, 0.2), 0.35, 0.3),
        'blade': chrome_f(),
    }
    MATS[name] = mat(name, table[name])
    return MATS[name]


def empty(name, loc):
    e = bpy.data.objects.new(name, None)
    e.empty_display_size = 1
    e.location = loc
    bpy.context.scene.collection.objects.link(e)
    return e


def blade(name, y0, y1, h, thick, bone, m):
    """Knife blade: flat, spine along the top, tip rising to a point."""
    verts = [
        (-thick, y0, h * 0.5), (thick, y0, h * 0.5), (thick, y0, -h * 0.5), (-thick, y0, -h * 0.5),
        (-thick, y1 - h, h * 0.45), (thick, y1 - h, h * 0.45), (thick, y1 - h * 1.4, -h * 0.5), (-thick, y1 - h * 1.4, -h * 0.5),
        (0, y1, h * 0.3),
    ]
    faces = [(0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7), (0, 3, 2, 1), (4, 5, 8), (5, 6, 8), (6, 7, 8), (7, 4, 8)]
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    me.update()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    ob.data.materials.append(m)
    PARTS.append((ob, bone))
    return ob


# ------------------------------------------------------------------ guns
# Each builder adds parts (registered in PARTS) and returns (muzzle, lhand).

def pistol_grip(y, z, mt, length=4.3, w=1.25, d=2.0, rake=1.4):
    limb('grip', (0, y, z), (0, y - rake, z - length), w, d, 'g', mt, bevel=0.25, taper=1.05)
    box('guard', (0, y + 1.6, z - 0.9), (0.3, 2.3, 0.3), 'g', M('steel'), bevel=0.05)
    box('trigger', (0, y + 1.0, z - 0.6), (0.25, 0.3, 1.0), 'g', M('steel'), bevel=0.05)


def ak47():
    box('recv', (0, 2.2, 3.2), (1.7, 10.5, 2.6), 'g', M('steel'), bevel=0.2)
    box('cover', (0, 1.8, 4.75), (1.5, 9.4, 0.7), 'g', M('steel'), bevel=0.3)
    box('rsight', (0, 7.8, 4.7), (1.1, 1.6, 0.9), 'g', M('steel'), bevel=0.1)
    box('hguard_lo', (0, 11.6, 2.75), (2.0, 7.0, 2.1), 'g', M('wood'), bevel=0.5, taper=(0.95, 1.0))
    cyl('hguard_up', (0, 9.0, 4.25), (0, 15.3, 4.25), 0.8, 'g', M('wood'), verts=10)
    box('gasblock', (0, 16.2, 3.8), (1.0, 1.4, 1.8), 'g', M('steel'), bevel=0.1)
    cyl('barrel', (0, 8.0, 3.2), (0, 24.0, 3.2), 0.38, 'g', M('blued'), verts=10)
    cyl('gastube', (0, 16.8, 4.25), (0, 18.6, 4.25), 0.45, 'g', M('steel'), verts=8)
    box('fsight', (0, 22.4, 4.05), (0.9, 0.7, 1.3), 'g', M('steel'), bevel=0.1)
    cyl('brake', (0, 24.0, 3.2), (0, 25.6, 3.2), 0.5, 'g', M('steel'), verts=10)
    limb('mag1', (0, 5.2, 1.9), (0, 6.6, -3.2), 1.25, 3.0, 'g', M('blued'), bevel=0.2)
    limb('mag2', (0, 6.6, -3.2), (0, 9.2, -7.6), 1.25, 3.0, 'g', M('blued'), bevel=0.2, taper=0.95)
    pistol_grip(-0.2, 2.0, M('wood_dark'))
    limb('stock', (0, -3.4, 3.2), (0, -14.5, 1.3), 1.55, 2.4, 'g', M('wood'), bevel=0.4, taper=1.5)
    box('buttplate', (0, -14.7, 1.3), (1.6, 0.4, 3.9), 'g', M('steel'), bevel=0.1)
    return (0, 25.8, 3.2), (0, 11.6, 1.5)


def m4a1():
    box('lower', (0, 1.2, 2.5), (1.4, 8.2, 2.1), 'g', M('poly'), bevel=0.2)
    box('upper', (0, 2.6, 4.05), (1.5, 9.0, 1.5), 'g', M('poly'), bevel=0.2)
    box('handle', (0, 2.6, 5.85), (0.8, 5.6, 0.8), 'g', M('poly'), bevel=0.2)
    for yy in (0.4, 4.9):
        box('post', (0, yy, 5.2), (0.7, 0.9, 1.2), 'g', M('poly'), bevel=0.1)
    cyl('hguard', (0, 7.1, 3.9), (0, 15.2, 3.9), 1.05, 'g', M('poly'), verts=12, r2=0.95)
    for k in range(7):
        cyl('rib%d' % k, (0, 8 + k * 1.0, 3.9), (0, 8.35 + k * 1.0, 3.9), 1.12, 'g', M('grey'), verts=12)
    box('fsight', (0, 15.9, 5.0), (0.55, 0.8, 2.3), 'g', M('poly'), bevel=0.1, taper=(0.6, 0.8))
    cyl('barrel', (0, 15.2, 3.9), (0, 21.2, 3.9), 0.35, 'g', M('blued'), verts=10)
    cyl('hider', (0, 21.2, 3.9), (0, 22.8, 3.9), 0.46, 'g', M('steel'), verts=6)
    limb('mag', (0, 4.6, 1.5), (0, 5.9, -5.2), 1.0, 2.6, 'g', M('steel'), bevel=0.2)
    pistol_grip(-0.3, 1.8, M('poly'), rake=1.2)
    cyl('buffer', (0, -2.4, 3.9), (0, -9.0, 3.9), 0.62, 'g', M('poly'), verts=10)
    box('stock', (0, -9.6, 3.1), (1.5, 5.2, 3.1), 'g', M('poly'), bevel=0.4, taper=(1.0, 1.0))
    box('ejport', (0.78, 3.2, 4.1), (0.05, 2.4, 0.8), 'g', M('grey'), bevel=0.0)
    return (0, 23.0, 3.9), (0, 11.2, 2.7)


def mp5():
    box('recv', (0, 3.0, 3.3), (1.6, 11.5, 2.2), 'g', M('poly'), bevel=0.4)
    box('hguard', (0, 11.2, 2.9), (2.1, 5.2, 2.4), 'g', M('poly'), bevel=0.6, taper=(0.9, 1.0))
    cyl('barrel', (0, 13.6, 3.3), (0, 16.4, 3.3), 0.42, 'g', M('blued'), verts=10)
    cyl('fsight', (0, 12.9, 4.9), (0, 13.9, 4.9), 0.55, 'g', M('steel'), verts=8)
    box('rsight', (0, -0.8, 4.8), (1.0, 1.0, 0.9), 'g', M('steel'), bevel=0.1)
    cyl('cockingtube', (0, 5.0, 4.5), (0, 12.0, 4.5), 0.35, 'g', M('steel'), verts=8)
    limb('mag', (0, 6.2, 2.1), (0, 7.8, -5.3), 0.9, 2.1, 'g', M('steel'), bevel=0.15)
    pistol_grip(-0.2, 2.2, M('poly'), rake=1.1)
    for zz in (4.1, 2.5):
        cyl('rod', (0.55, -2.4, zz), (0.55, -9.4, zz), 0.22, 'g', M('steel'), verts=6)
        cyl('rod2', (-0.55, -2.4, zz), (-0.55, -9.4, zz), 0.22, 'g', M('steel'), verts=6)
    box('butt', (0, -9.7, 3.2), (1.7, 0.7, 3.2), 'g', M('poly'), bevel=0.2)
    return (0, 16.6, 3.3), (0, 11.2, 1.6)


def sniper(long=True):
    body = M('olive') if long else M('grey')
    L = 1.0 if long else 0.82
    box('recv', (0, 2.0, 3.2), (1.7, 11.5, 2.3), 'g', M('steel'), bevel=0.2)
    box('stock', (0, -9.0 * L, 2.4), (1.8, 11.5 * L, 3.8), 'g', body, bevel=0.6, taper=(0.95, 0.9))
    box('thumbhole', (1.0, -4.8, 2.4), (0.2, 3.5, 1.4), 'g', M('poly'), bevel=0.0)
    box('forend', (0, 13.5 * L, 2.6), (1.9, 12.5 * L, 2.3), 'g', body, bevel=0.6, taper=(0.85, 1.0))
    cyl('barrel', (0, 18.0 * L, 3.35), (0, 41.0 * L, 3.35), 0.48 if long else 0.38, 'g', M('blued'), verts=10, r2=0.38 if long else 0.32)
    if long:
        cyl('brake', (0, 41.0, 3.35), (0, 43.2, 3.35), 0.62, 'g', M('steel'), verts=8)
    cyl('scope', (0, -1.5, 6.2), (0, 9.5 * L, 6.2), 0.62 if long else 0.52, 'g', M('blued'), verts=12)
    cyl('objective', (0, 9.0 * L, 6.2), (0, 12.2 * L, 6.2), 1.15 if long else 0.9, 'g', M('blued'), verts=14, r2=1.2 if long else 0.95)
    cyl('lens', (0, 12.2 * L, 6.2), (0, 12.3 * L, 6.2), 1.0 if long else 0.8, 'g', M('glass'), verts=14)
    cyl('eyepiece', (0, -3.8, 6.2), (0, -1.3, 6.2), 0.92 if long else 0.75, 'g', M('blued'), verts=12, r2=0.7)
    cyl('turret', (0, 4.0, 6.6), (0, 4.0, 7.7), 0.45, 'g', M('blued'), verts=8)
    cyl('turret2', (0.6, 4.0, 6.2), (1.6, 4.0, 6.2), 0.4, 'g', M('blued'), verts=8)
    for yy in (0.8, 6.0):
        box('mount', (0, yy, 5.0), (1.0, 1.0, 1.6), 'g', M('steel'), bevel=0.1)
    limb('bolt', (0.8, -0.8, 4.0), (2.3, -1.3, 3.3), 0.35, 0.35, 'g', M('steel'), bevel=0.05)
    dome('knob', (2.4, -1.35, 3.0), 0.55, 'g', M('steel'), scale=(1, 1, 1.4))
    box('mag', (0, 3.5, 1.2), (1.2, 2.6, 2.2), 'g', M('steel'), bevel=0.15)
    pistol_grip(-0.8, 1.8, body, length=3.6, rake=1.6)
    box('butt', (0, -15.3 * L, 2.2), (1.9, 0.8, 4.3), 'g', M('poly'), bevel=0.2)
    return (0, (43.4 if long else 41.2 * L), 3.35), (0, 13.0 * L, 1.3)


def awp(): return sniper(True)
def scout(): return sniper(False)


def deagle():
    box('slide', (0, 3.9, 3.35), (1.2, 10.2, 1.5), 'g', M('chrome'), bevel=0.15)
    box('rib', (0, 4.8, 4.2), (0.35, 7.8, 0.3), 'g', M('chrome'), bevel=0.05)
    box('frame', (0, 3.2, 2.15), (1.1, 7.0, 1.0), 'g', M('chrome'), bevel=0.15)
    for k in range(6):
        box('serr%d' % k, (0.61, -0.4 + k * 0.35, 3.35), (0.05, 0.15, 1.2), 'g', M('steel'), bevel=0)
    box('hammer', (0, -1.3, 3.6), (0.5, 0.6, 0.8), 'g', M('steel'), bevel=0.05)
    pistol_grip(-0.3, 2.1, M('poly'), length=4.2, w=1.3, d=2.2, rake=1.5)
    box('fsight', (0, 8.6, 4.25), (0.3, 0.4, 0.4), 'g', M('steel'), bevel=0)
    return (0, 9.1, 3.5), None


def glock():
    box('slide', (0, 2.8, 3.0), (1.0, 7.2, 1.15), 'g', M('poly'), bevel=0.15)
    box('frame', (0, 2.7, 2.0), (0.95, 6.3, 0.9), 'g', M('grey'), bevel=0.15)
    for k in range(5):
        box('serr%d' % k, (0.51, -0.3 + k * 0.3, 3.0), (0.05, 0.12, 0.9), 'g', M('steel'), bevel=0)
    pistol_grip(-0.2, 1.8, M('grey'), length=3.9, w=1.15, d=2.0, rake=1.0)
    box('fsight', (0, 6.1, 3.7), (0.25, 0.3, 0.3), 'g', M('steel'), bevel=0)
    return (0, 6.5, 3.0), None


def usp():
    box('slide', (0, 3.1, 3.05), (1.05, 7.8, 1.2), 'g', M('blued'), bevel=0.15)
    box('frame', (0, 2.9, 2.0), (1.0, 6.8, 0.95), 'g', M('poly'), bevel=0.15)
    box('rail', (0, 5.0, 1.45), (0.8, 2.4, 0.35), 'g', M('poly'), bevel=0.05)
    pistol_grip(-0.2, 1.8, M('poly'), length=4.0, w=1.2, d=2.0, rake=1.1)
    box('fsight', (0, 6.8, 3.8), (0.25, 0.3, 0.3), 'g', M('steel'), bevel=0)
    return (0, 7.2, 3.05), None


def knife():
    limb('handle', (0, -1.4, 0), (0, 3.2, 0.1), 1.0, 1.25, 'g', M('poly'), bevel=0.25, taper=0.9)
    box('guard', (0, 3.4, 0.1), (0.5, 0.35, 2.0), 'g', M('steel'), bevel=0.05)
    blade('blade', 3.5, 11.0, 1.35, 0.1, 'g', M('blade'))
    box('pommel', (0, -1.6, 0), (0.9, 0.35, 1.1), 'g', M('steel'), bevel=0.1)
    return (0, 11.0, 0.3), None


GUNS = {
    'ak47': ak47, 'm4a1': m4a1, 'mp5': mp5, 'awp': awp, 'scout': scout,
    'deagle': deagle, 'glock': glock, 'usp': usp, 'knife': knife,
}


# ------------------------------------------------------------------ arms

def arm(team):
    t = team == 'T'
    sleeve = mat('sleeve_' + team, cloth((0.44, 0.38, 0.27), (0.25, 0.21, 0.15), seed=1) if t else
                 camo((0.34, 0.38, 0.44), (0.24, 0.27, 0.33), (0.45, 0.48, 0.52), (0.14, 0.15, 0.18), scale=0.3, seed=5))
    glove = mat('glove_' + team, plain((0.08, 0.08, 0.08) if not t else (0.30, 0.24, 0.17), 0.7))
    # palm/grip at the origin; fingers wrap the grip (+X side), forearm to -Y
    box('palm', (0, 0, 0), (2.4, 3.4, 3.6), 'g', glove, bevel=0.5)
    box('fingers', (0.9, 0.9, -0.2), (1.4, 2.0, 3.4), 'g', glove, bevel=0.45)
    limb('thumb', (-0.9, 0.8, 1.2), (-0.4, 2.6, 1.9), 0.9, 0.9, 'g', glove, bevel=0.2)
    box('cuff', (0, -2.4, 0), (2.9, 1.6, 3.2), 'g', glove, bevel=0.4)
    limb('forearm', (0, -2.2, 0), (0, -15.0, -0.6), 3.4, 3.5, 'g', sleeve, bevel=0.6, taper=1.25)
    limb('roll', (0, -9.0, -0.3), (0, -10.6, -0.4), 4.5, 4.6, 'g', sleeve, bevel=0.6)


# ------------------------------------------------------------------ assemble

def finish(name, tex_size=512):
    parts = [ob for ob, _ in PARTS]
    PARTS.clear()
    bpy.ops.object.select_all(action='DESELECT')
    for ob in parts:
        ob.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.join()
    ob = bpy.context.view_layer.objects.active
    ob.name = name
    bpy.ops.object.shade_auto_smooth(angle=math.radians(40))
    uv = ob.data.uv_layers.new(name='UVMap')
    ob.data.uv_layers.active = uv
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.012)
    bpy.ops.uv.pack_islands(margin=0.012, rotate=True)
    bpy.ops.object.mode_set(mode='OBJECT')
    img = new_image('tex_' + name, tex_size)
    bake(ob, 'DIFFUSE', img, samples=8, margin=6)
    img.pack()
    final = bpy.data.materials.new('mat_' + name)
    final.use_nodes = True
    nt = final.node_tree
    bsdf = nt.nodes['Principled BSDF']
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.image = img
    nt.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
    bsdf.inputs['Roughness'].default_value = 0.5
    bsdf.inputs['Metallic'].default_value = 0.0 if name.startswith('arm') else 0.35
    ob.data.materials.clear()
    ob.data.materials.append(final)
    tris = sum(len(p.vertices) - 2 for p in ob.data.polygons)
    print(f'{name}: {tris} tris')
    return ob


def main():
    reset_scene()
    roots = []
    for i, (gid, fn) in enumerate(GUNS.items()):
        muzzle, lhand = fn()
        ob = finish(gid)
        ob.location.x = i * 60  # spread out while baking; reset below
        for tag, loc in (('muzzle', muzzle), ('lhand', lhand)):
            if loc is None:
                continue
            e = empty(f'{gid}_{tag}', loc)
            e.parent = ob
        roots.append(ob)
    for team in ('T', 'CT'):
        arm(team)
        roots.append(finish('arm_' + team.lower(), 256))
    for ob in roots:
        ob.location = (0, 0, 0)
    bpy.ops.object.select_all(action='SELECT')
    path = os.path.join(OUT, 'weapons.glb')
    os.makedirs(OUT, exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_yup=True,
                              export_image_format='JPEG', export_jpeg_quality=88, export_animations=False)
    print('wrote', path, f'{os.path.getsize(path) / 1024:.0f} KB')


main()
