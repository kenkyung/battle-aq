# Builds every weapon model plus the first-person hands.
#
#   blender -b --factory-startup -P art/blender/build_weapons.py
#
# -> web/public/assets/models/weapons.glb
#
# One node per weapon, named by its id in shared/constants.js (ak47, m4a1, ...),
# in game units (inches), barrel along +Y (three.js: -Z, the view direction).
# Child empties:
#   <id>_muzzle   where the flash and tracers start
#   <id>_grip     the firing hand's grip axis (+Z along the grip, raked)
#   <id>_lhand    the support hand (+Y along the handguard)
# hand_r_t / hand_r_ct: right gloved hand closed around a grip (origin on the
#   grip axis, grip along +Z), index finger on the trigger, forearm + sleeve.
# hand_l_t / hand_l_ct: support hand cupping a handguard (origin on its axis,
#   handguard along +Y), fingers over the far side, thumb along the near side.
#
# Every model bakes three maps from its procedural materials: albedo, a
# tangent-space normal map (Cycles Bevel node -> rounded edges on low-poly
# geometry, plus bump detail) and roughness. Edge wear comes from Cycles'
# Pointiness, so corners are polished bright the way real guns wear.

import os, sys, math
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy
from mathutils import Vector, Euler, Matrix
from lib import G, reset_scene, rgb, new_image, bake, PUBLIC
from prims import PARTS, box, limb, cyl, dome, capsule, arc_tube

OUT = os.path.join(PUBLIC, 'models')


# ------------------------------------------------------------------ materials

def material(name, build):
    """build(g, co, x, y, z, edge) -> (color, roughness, height or None, bevel radius)"""
    m = bpy.data.materials.new(name)
    g = G(m)
    co = g.objcoord()
    sep = g.node('ShaderNodeSeparateXYZ')
    g.nt.links.new(co, sep.inputs[0])
    geo = g.node('ShaderNodeNewGeometry')
    edge = g.smooth(geo.outputs['Pointiness'], 0.56, 0.68)   # only real corners
    col, rough, height, bevel = build(g, co, sep.outputs[0], sep.outputs[1], sep.outputs[2], edge)
    bsdf = g.node('ShaderNodeBsdfPrincipled')
    g.put(bsdf.inputs['Base Color'], col)
    g.put(bsdf.inputs['Roughness'], rough)
    bev = g.node('ShaderNodeBevel', samples=8)
    bev.inputs['Radius'].default_value = bevel
    normal = bev.outputs['Normal']
    if height is not None:
        b = g.node('ShaderNodeBump')
        b.inputs['Strength'].default_value = 0.35
        b.inputs['Distance'].default_value = 0.02
        g.put(b.inputs['Height'], height)
        g.nt.links.new(normal, b.inputs['Normal'])
        normal = b.outputs['Normal']
    g.nt.links.new(normal, bsdf.inputs['Normal'])
    out = g.node('ShaderNodeOutputMaterial')
    g.nt.links.new(bsdf.outputs[0], out.inputs['Surface'])
    return m


def n3(g, co, scale, detail=4, seed=0, distort=0.0, aniso=None):
    if aniso:
        vm = g.node('ShaderNodeVectorMath', operation='MULTIPLY')
        g.put(vm.inputs[0], co)
        vm.inputs[1].default_value = aniso
        co = vm.outputs[0]
    n = g.node('ShaderNodeTexNoise', noise_dimensions='4D')
    g.put(n.inputs['Vector'], co)
    n.inputs['W'].default_value = seed * 1.7
    n.inputs['Scale'].default_value = scale
    n.inputs['Detail'].default_value = detail
    n.inputs['Distortion'].default_value = distort
    return g.lin(n.outputs['Fac'], 0.32, 0.68)


def metal(base, wear=(0.55, 0.56, 0.58), rough=0.42, scratch=0.5):
    def f(g, co, x, y, z, edge):
        n = n3(g, co, 1.2, 6, 21)
        col = g.mix(g.mul(n, 0.3), rgb(*base), rgb(base[0] * 0.6, base[1] * 0.6, base[2] * 0.6))
        sc = g.smooth(n3(g, co, 1.5, 2, 22, aniso=(0.5, 7.0, 0.5)), 0.84, 0.95)
        col = g.mix(g.mul(sc, scratch), col, rgb(*wear))
        col = g.mix(g.mul(edge, 0.4), col, rgb(*wear))               # polished edges
        r = g.sub(rough, g.mul(g.add(edge, g.mul(sc, 0.5)), 0.25))
        return col, r, g.mul(n, 0.3), 0.06
    return f


def polymer(base, rough=0.62):
    def f(g, co, x, y, z, edge):
        n = n3(g, co, 6.0, 3, 31)
        stip = g.smooth(n3(g, co, 18.0, 2, 32), 0.45, 0.6)          # moulded stipple
        col = g.mix(g.mul(n, 0.25), rgb(*base), rgb(base[0] * 1.5, base[1] * 1.5, base[2] * 1.5))
        col = g.mix(g.mul(edge, 0.2), col, rgb(base[0] * 2.4, base[1] * 2.4, base[2] * 2.4))
        return col, rough, g.mul(stip, 0.4), 0.05
    return f


def paint(base, chips=(0.16, 0.16, 0.16), rough=0.55):
    def f(g, co, x, y, z, edge):
        n = n3(g, co, 0.9, 5, 41)
        col = g.mix(g.mul(n, 0.28), rgb(*base), rgb(base[0] * 0.65, base[1] * 0.65, base[2] * 0.65))
        chip = g.smooth(n3(g, co, 2.6, 4, 42), 0.72, 0.8)
        worn = g.mx(chip, g.mul(edge, 0.9))
        col = g.mix(worn, col, rgb(*chips))
        return col, g.add(rough, g.mul(worn, -0.15)), g.mul(chip, -0.2), 0.05
    return f


def wood(base=(0.40, 0.21, 0.10), rough=0.45):
    def f(g, co, x, y, z, edge):
        grain = n3(g, co, 1.6, 6, 51, distort=1.2, aniso=(9.0, 0.35, 9.0))
        ring = g.fract(g.mul(grain, 9.0))
        col = g.mix(g.smooth(ring, 0.1, 0.9), rgb(base[0] * 0.45, base[1] * 0.4, base[2] * 0.38), rgb(*base))
        fine = n3(g, co, 12.0, 2, 53, aniso=(6.0, 0.4, 6.0))
        col = g.mix(g.mul(fine, 0.35), col, rgb(base[0] * 0.55, base[1] * 0.5, base[2] * 0.45))
        dirt = n3(g, co, 0.7, 4, 52)
        col = g.mix(g.mul(g.smooth(dirt, 0.6, 0.8), 0.45), col, rgb(base[0] * 0.5, base[1] * 0.45, base[2] * 0.4))
        col = g.mix(g.mul(edge, 0.35), col, rgb(min(1, base[0] * 1.45), min(1, base[1] * 1.4), min(1, base[2] * 1.3)))
        return col, rough, g.mul(g.smooth(ring, 0.8, 1.0), 0.25), 0.06
    return f


def chrome():
    def f(g, co, x, y, z, edge):
        n = n3(g, co, 1.0, 4, 61, aniso=(1.0, 9.0, 1.0))
        col = g.mix(n, rgb(0.55, 0.56, 0.58), rgb(0.82, 0.83, 0.84))
        return col, g.lin(n, 0, 1, 0.18, 0.32), None, 0.05
    return f


def leather(base, pads=None):
    """Glove: grained leather, darker creases, stitched seams along the
    fingers; optional knuckle pad colour on raised edges."""
    def f(g, co, x, y, z, edge):
        grain = n3(g, co, 9.0, 3, 71)
        crease = g.smooth(n3(g, co, 3.0, 4, 72, aniso=(1.0, 1.0, 3.0)), 0.62, 0.7)
        col = g.mix(g.mul(grain, 0.3), rgb(*base), rgb(base[0] * 0.6, base[1] * 0.6, base[2] * 0.6))
        col = g.mix(g.mul(crease, 0.6), col, rgb(base[0] * 0.45, base[1] * 0.45, base[2] * 0.45))
        seam = g.smooth(g.absv(g.sin(g.mul(g.add(x, g.mul(z, 0.3)), 2.4))), 0.985, 1.0)
        col = g.mix(g.mul(seam, 0.3), col, rgb(base[0] * 1.5 + 0.05, base[1] * 1.5 + 0.05, base[2] * 1.5 + 0.05))
        if pads:
            col = g.mix(g.mul(edge, 0.8), col, rgb(*pads))
        else:
            col = g.mix(g.mul(edge, 0.5), col, rgb(base[0] * 1.5, base[1] * 1.5, base[2] * 1.5))
        return col, 0.62, g.add(g.mul(grain, 0.3), g.mul(crease, -0.4)), 0.12
    return f


def fabric(c1, c2, c3=None, scale=0.35, seed=81):
    def f(g, co, x, y, z, edge):
        a = n3(g, co, scale, 3, seed, distort=0.5)
        col = g.mix(g.smooth(a, 0.45, 0.52), rgb(*c1), rgb(*c2))
        if c3:
            b = n3(g, co, scale * 1.4, 3, seed + 5, distort=0.5)
            col = g.mix(g.smooth(b, 0.58, 0.64), col, rgb(*c3))
        weave = g.mul(g.add(g.sin(g.mul(x, 30.0)), g.sin(g.mul(z, 30.0))), 0.25)
        col = g.mix(g.add(weave, 0.5), g.hsv(col, v=0.9), col)
        fold = g.smooth(n3(g, co, 1.2, 3, seed + 9, aniso=(0.5, 3.0, 0.5)), 0.55, 0.75)
        col = g.mix(g.mul(fold, 0.4), col, rgb(c1[0] * 0.5, c1[1] * 0.5, c1[2] * 0.5))
        return col, 0.9, g.add(g.mul(fold, 0.5), g.mul(weave, 0.1)), 0.15
    return f


MATS = {}


def M(name):
    if name in MATS:
        return MATS[name]
    table = {
        'steel':   metal((0.11, 0.115, 0.13)),
        'blued':   metal((0.06, 0.065, 0.08), (0.36, 0.37, 0.40), 0.35),
        'bright':  metal((0.40, 0.41, 0.43), (0.7, 0.7, 0.72), 0.3, 0.3),
        'wood':    wood(),
        'wood_dark': wood((0.24, 0.12, 0.06)),
        'poly':    polymer((0.055, 0.055, 0.06)),
        'polygrey': polymer((0.18, 0.19, 0.2)),
        'olive':   paint((0.25, 0.29, 0.17)),
        'grey':    paint((0.26, 0.27, 0.28)),
        'chrome':  chrome(),
        'glass':   (lambda g, co, x, y, z, e: (rgb(0.03, 0.07, 0.10), 0.05, None, 0.02)),
        'brass':   metal((0.62, 0.45, 0.16), (0.9, 0.75, 0.4), 0.3, 0.2),
        'rubber':  polymer((0.03, 0.03, 0.03), 0.85),
        'c4clay':  paint((0.62, 0.60, 0.50), (0.45, 0.43, 0.36), 0.8),
        'tape':    paint((0.12, 0.14, 0.12), (0.3, 0.3, 0.3), 0.7),
        'screen':  (lambda g, co, x, y, z, e: (rgb(0.05, 0.25, 0.08), 0.2, None, 0.02)),
        'wire_r':  (lambda g, co, x, y, z, e: (rgb(0.6, 0.05, 0.04), 0.5, None, 0.02)),
        'wire_b':  (lambda g, co, x, y, z, e: (rgb(0.05, 0.1, 0.5), 0.5, None, 0.02)),
        'glove_t': leather((0.30, 0.20, 0.12)),
        'glove_ct': leather((0.06, 0.06, 0.065), pads=(0.24, 0.25, 0.27)),
        'sleeve_t': fabric((0.36, 0.30, 0.20), (0.46, 0.39, 0.27), None, 0.4),
        'sleeve_ct': fabric((0.24, 0.27, 0.33), (0.36, 0.40, 0.46), (0.13, 0.14, 0.17), 0.5),
        # per-skin sleeves (M19 skins, first person): same colours as the models
        'sleeve_phoenix': fabric((0.36, 0.30, 0.20), (0.46, 0.39, 0.27), None, 0.4),
        'sleeve_leet': leather((0.26, 0.13, 0.07)),
        'sleeve_arctic': fabric((0.74, 0.74, 0.71), (0.88, 0.88, 0.85), None, 0.45),
        'sleeve_seal': fabric((0.24, 0.27, 0.33), (0.36, 0.40, 0.46), (0.13, 0.14, 0.17), 0.5),
        'sleeve_gsg9': fabric((0.19, 0.24, 0.27), (0.29, 0.35, 0.39), None, 0.5),
        'sleeve_sas': fabric((0.045, 0.045, 0.055), (0.1, 0.1, 0.12), None, 0.5),
        'sleeve_gign': fabric((0.07, 0.1, 0.21), (0.13, 0.17, 0.33), None, 0.5),
        'skin':    (lambda g, co, x, y, z, e: (g.mix(n3(g, co, 3.0, 3, 91), rgb(0.72, 0.52, 0.40), rgb(0.62, 0.43, 0.32)), 0.55, g.mul(n3(g, co, 20.0, 2, 92), 0.1), 0.1)),
    }
    MATS[name] = material(name, table[name])
    return MATS[name]


def empty(name, loc, rot=(0, 0, 0)):
    e = bpy.data.objects.new(name, None)
    e.empty_display_size = 1
    e.location = loc
    e.rotation_euler = Euler(rot)
    bpy.context.scene.collection.objects.link(e)
    return e


def blade(name, y0, y1, h, thick, m):
    verts = [
        (-thick, y0, h * 0.5), (thick, y0, h * 0.5), (thick, y0, -h * 0.5), (-thick, y0, -h * 0.5),
        (-thick * 0.6, y1 - h, h * 0.45), (thick * 0.6, y1 - h, h * 0.45), (0.02, y1 - h * 1.4, -h * 0.5), (-0.02, y1 - h * 1.4, -h * 0.5),
        (0, y1, h * 0.3),
    ]
    faces = [(0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7), (0, 3, 2, 1), (4, 5, 8), (5, 6, 8), (6, 7, 8), (7, 4, 8)]
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    me.update()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    ob.data.materials.append(m)
    PARTS.append((ob, 'g'))
    return ob


# ------------------------------------------------------------------ shared parts

GRIP = {}


def pistol_grip(gid, y, z, mt, length=4.3, w=1.25, d=2.0, rake=1.4, guard=True):
    """Raked grip from (0,y,z) down; records the hand's grip axis."""
    top, bot = Vector((0, y, z)), Vector((0, y - rake, z - length))
    limb('grip', top, bot, w, d, 'g', mt, bevel=0.3, taper=1.06)
    for k in range(5):  # finger grooves / checkering bands
        t = 0.25 + k * 0.14
        p = top.lerp(bot, t)
        box('ck%d' % k, (0.0, p.y + d * 0.5, p.z), (w * 0.9, 0.12, 0.35), 'g', mt, bevel=0.05)
    box('heel', (0, bot.y - 0.1, bot.z - 0.1), (w * 1.05, d * 1.05, 0.35), 'g', mt, bevel=0.1)
    if guard:
        arc_tube('guard', (0, y + 1.55, z - 0.35), 0.95, 0.13, 180, 360, 'g', M('steel'), axis='X', segs=8)
        limb('trigger', (0, y + 1.2, z + 0.15), (0, y + 1.45, z - 0.75), 0.22, 0.32, 'g', M('bright'), bevel=0.05)
    mid = top.lerp(bot, 0.5)
    ax = (top - bot).normalized()
    GRIP[gid] = ((mid.x, mid.y, mid.z), (-math.asin(max(-1, min(1, ax.y))), 0, 0))


def rivets(xs, y0, y1, zs, n, mt):
    for x in xs:
        for zz in zs:
            for k in range(n):
                yy = y0 + (y1 - y0) * (k + 0.5) / n
                cyl('rv', (x, yy, zz), (x + (0.06 if x > 0 else -0.06), yy, zz), 0.12, 'g', mt, verts=8)


# ------------------------------------------------------------------ guns
# Each returns (muzzle, lhand, lhand_rot) in gun space.

def ak47():
    box('recv', (0, 2.2, 3.2), (1.7, 10.5, 2.6), 'g', M('blued'), bevel=0.15)
    box('cover', (0, 1.6, 4.72), (1.55, 9.2, 0.75), 'g', M('blued'), bevel=0.3)
    for k in range(6):
        box('rib%d' % k, (0, -1.5 + k * 1.2, 5.12), (1.3, 0.25, 0.1), 'g', M('blued'), bevel=0.04)
    box('rsight', (0, 7.8, 4.65), (1.1, 1.8, 0.95), 'g', M('blued'), bevel=0.1)
    box('rleaf', (0, 8.2, 5.25), (0.7, 1.4, 0.25), 'g', M('steel'), bevel=0.05)
    rivets([0.86, -0.86], -2.0, 6.0, [2.2, 3.8], 4, M('steel'))
    box('selector', (0.9, 1.5, 3.9), (0.12, 4.2, 0.55), 'g', M('steel'), bevel=0.05)
    box('hguard_lo', (0, 11.6, 2.75), (2.05, 7.0, 2.15), 'g', M('wood'), bevel=0.55, taper=(0.95, 1.0))
    for k in range(3):
        box('hgv%d' % k, (1.03, 10.0 + k * 1.6, 2.75), (0.05, 0.9, 0.9), 'g', M('wood_dark'), bevel=0.02)
    cyl('hguard_up', (0, 9.0, 4.25), (0, 15.3, 4.25), 0.82, 'g', M('wood'), verts=14)
    box('gasblock', (0, 16.2, 3.8), (1.0, 1.4, 1.9), 'g', M('blued'), bevel=0.12)
    cyl('barrel', (0, 8.0, 3.2), (0, 24.0, 3.2), 0.38, 'g', M('blued'), verts=14)
    cyl('rod', (0, 15.0, 2.45), (0, 23.4, 2.45), 0.12, 'g', M('steel'), verts=8)
    cyl('gastube', (0, 16.8, 4.25), (0, 18.6, 4.25), 0.45, 'g', M('blued'), verts=10)
    box('fsight', (0, 22.4, 4.05), (0.9, 0.7, 1.35), 'g', M('blued'), bevel=0.1)
    cyl('fpost', (0, 22.4, 4.6), (0, 22.4, 5.1), 0.08, 'g', M('steel'), verts=6)
    cyl('brake', (0, 24.0, 3.2), (0, 25.6, 3.2), 0.52, 'g', M('blued'), verts=14, r2=0.48)
    limb('mag1', (0, 5.2, 1.9), (0, 6.6, -3.2), 1.25, 3.0, 'g', M('blued'), bevel=0.2)
    limb('mag2', (0, 6.6, -3.2), (0, 9.2, -7.6), 1.25, 3.0, 'g', M('blued'), bevel=0.2, taper=0.95)
    for k in range(3):
        limb('mrib%d' % k, (0.64, 5.6 + k * 0.9, 0.6 - k * 2.4), (0.64, 6.2 + k * 1.0, -1.0 - k * 2.2), 0.06, 0.5, 'g', M('steel'), bevel=0.02)
    pistol_grip('ak47', -0.2, 2.0, M('wood_dark'))
    limb('stock', (0, -3.4, 3.2), (0, -14.5, 1.3), 1.55, 2.4, 'g', M('wood'), bevel=0.45, taper=1.5)
    box('buttplate', (0, -14.75, 1.3), (1.65, 0.45, 3.95), 'g', M('blued'), bevel=0.1)
    cyl('swivel', (-0.8, -9.0, 0.6), (-0.95, -9.0, 0.6), 0.35, 'g', M('steel'), verts=10)
    return (0, 25.8, 3.2), (0, 11.6, 2.75), (0, 0, 0)


def m4a1():
    box('lower', (0, 1.2, 2.5), (1.4, 8.2, 2.15), 'g', M('polygrey'), bevel=0.2)
    box('upper', (0, 2.6, 4.05), (1.5, 9.0, 1.55), 'g', M('polygrey'), bevel=0.2)
    box('handle', (0, 2.6, 5.9), (0.8, 5.6, 0.85), 'g', M('polygrey'), bevel=0.22)
    for yy in (0.4, 4.9):
        box('post', (0, yy, 5.2), (0.7, 0.9, 1.25), 'g', M('polygrey'), bevel=0.12)
    cyl('rdrum', (-0.45, 0.3, 6.1), (0.45, 0.3, 6.1), 0.3, 'g', M('steel'), verts=10)
    box('fassist', (0.85, 0.6, 4.0), (0.35, 0.7, 0.55), 'g', M('steel'), bevel=0.1)
    box('ejport', (0.78, 3.4, 4.1), (0.05, 2.4, 0.8), 'g', M('steel'), bevel=0.0)
    box('magwell', (0, 4.6, 1.6), (1.35, 3.0, 1.4), 'g', M('polygrey'), bevel=0.15)
    box('selector', (-0.72, 0.2, 3.0), (0.1, 0.55, 0.55), 'g', M('steel'), bevel=0.05)
    cyl('hguard', (0, 7.1, 3.9), (0, 15.2, 3.9), 1.05, 'g', M('poly'), verts=16, r2=0.95)
    for k in range(10):
        box('vent%d' % k, (0, 7.8 + k * 0.72, 4.9), (0.9, 0.3, 0.15), 'g', M('rubber'), bevel=0.05)
    cyl('dring', (0, 7.0, 3.9), (0, 7.3, 3.9), 1.2, 'g', M('steel'), verts=16)
    box('fsight', (0, 15.9, 5.0), (0.55, 0.8, 2.3), 'g', M('polygrey'), bevel=0.1, taper=(0.6, 0.8))
    cyl('barrel', (0, 15.2, 3.9), (0, 21.2, 3.9), 0.35, 'g', M('blued'), verts=14)
    cyl('hider', (0, 21.2, 3.9), (0, 22.8, 3.9), 0.48, 'g', M('blued'), verts=8)
    for k in range(4):
        box('slot%d' % k, (0.46 * math.cos(k * 1.57), 22.3, 3.9 + 0.46 * math.sin(k * 1.57)), (0.12, 0.9, 0.12), 'g', M('rubber'), bevel=0)
    limb('mag', (0, 4.6, 1.5), (0, 5.9, -5.2), 1.0, 2.6, 'g', M('steel'), bevel=0.2)
    pistol_grip('m4a1', -0.3, 1.8, M('poly'), rake=1.2)
    cyl('buffer', (0, -2.4, 3.9), (0, -9.0, 3.9), 0.62, 'g', M('poly'), verts=14)
    box('stock', (0, -9.6, 3.1), (1.5, 5.2, 3.15), 'g', M('poly'), bevel=0.45)
    box('lever', (0, -8.6, 1.4), (0.5, 1.4, 0.4), 'g', M('rubber'), bevel=0.1)
    box('butt', (0, -12.3, 3.0), (1.55, 0.35, 3.4), 'g', M('rubber'), bevel=0.12)
    return (0, 23.0, 3.9), (0, 11.2, 3.9), (0, 0, 0)


def mp5():
    box('recv', (0, 3.0, 3.3), (1.6, 11.5, 2.25), 'g', M('steel'), bevel=0.45)
    box('hguard', (0, 11.2, 2.9), (2.15, 5.2, 2.45), 'g', M('poly'), bevel=0.65, taper=(0.9, 1.0))
    for k in range(4):
        box('hgrip%d' % k, (0, 9.5 + k * 1.1, 1.62), (1.9, 0.25, 0.2), 'g', M('rubber'), bevel=0.05)
    cyl('barrel', (0, 13.6, 3.3), (0, 16.4, 3.3), 0.42, 'g', M('blued'), verts=14)
    cyl('fring', (0, 12.9, 4.9), (0, 13.9, 4.9), 0.58, 'g', M('steel'), verts=12)
    cyl('fpost', (0, 13.4, 4.6), (0, 13.4, 5.2), 0.07, 'g', M('steel'), verts=6)
    cyl('rdrum', (-0.55, -0.8, 4.9), (0.55, -0.8, 4.9), 0.45, 'g', M('steel'), verts=12)
    cyl('cockingtube', (0, 5.0, 4.5), (0, 12.0, 4.5), 0.35, 'g', M('steel'), verts=10)
    box('chandle', (-0.65, 11.2, 4.5), (0.5, 0.4, 0.4), 'g', M('poly'), bevel=0.1)
    limb('mag', (0, 6.2, 2.1), (0, 7.8, -5.3), 0.9, 2.1, 'g', M('steel'), bevel=0.15)
    pistol_grip('mp5', -0.2, 2.2, M('poly'), rake=1.1)
    for zz in (4.1, 2.5):
        cyl('rod', (0.55, -2.4, zz), (0.55, -9.4, zz), 0.22, 'g', M('steel'), verts=8)
        cyl('rod2', (-0.55, -2.4, zz), (-0.55, -9.4, zz), 0.22, 'g', M('steel'), verts=8)
    box('butt', (0, -9.7, 3.2), (1.75, 0.7, 3.25), 'g', M('poly'), bevel=0.25)
    return (0, 16.6, 3.3), (0, 11.2, 2.9), (0, 0, 0)


def ump45():
    box('recv', (0, 3.4, 3.2), (1.55, 13.0, 2.4), 'g', M('poly'), bevel=0.35)
    box('top', (0, 3.0, 4.55), (1.2, 10.5, 0.45), 'g', M('poly'), bevel=0.12)
    for k in range(9):
        box('rail%d' % k, (0, -1.4 + k * 1.1, 4.86), (0.95, 0.5, 0.18), 'g', M('steel'), bevel=0.04)
    box('rsight', (0, -1.6, 5.35), (1.0, 0.7, 0.8), 'g', M('poly'), bevel=0.1)
    box('fsight', (0, 9.2, 5.35), (0.9, 0.7, 0.8), 'g', M('poly'), bevel=0.1)
    box('handguard', (0, 8.3, 2.8), (1.75, 4.5, 2.0), 'g', M('poly'), bevel=0.45)
    for k in range(4):
        box('vent%d' % k, (0.88, 7.0 + k * 0.9, 3.1), (0.06, 0.5, 0.9), 'g', M('rubber'), bevel=0)
    cyl('barrel', (0, 10.3, 3.3), (0, 12.6, 3.3), 0.48, 'g', M('blued'), verts=14)
    cyl('crown', (0, 12.6, 3.3), (0, 12.9, 3.3), 0.36, 'g', M('rubber'), verts=12)
    box('chandle', (-0.95, 6.8, 4.0), (0.35, 0.4, 0.6), 'g', M('steel'), bevel=0.08)
    limb('mag', (0, 4.6, 2.0), (0, 5.0, -5.0), 1.05, 2.3, 'g', M('poly'), bevel=0.2)
    for k in range(3):
        box('mrib%d' % k, (0.55, 4.7 + k * 0.05, 0.6 - k * 2.2), (0.08, 1.8, 0.35), 'g', M('rubber'), bevel=0.03)
    pistol_grip('ump45', -0.5, 2.0, M('poly'), rake=1.3)
    box('stockarm', (1.0, -5.8, 3.2), (0.4, 8.5, 1.8), 'g', M('poly'), bevel=0.2)
    box('stockarm2', (-1.0, -5.8, 3.2), (0.4, 8.5, 1.8), 'g', M('poly'), bevel=0.2)
    box('butt', (0, -10.0, 3.0), (2.2, 0.8, 3.6), 'g', M('rubber'), bevel=0.3)
    box('hinge', (0, -1.6, 3.2), (2.4, 0.9, 1.3), 'g', M('steel'), bevel=0.15)
    return (0, 13.0, 3.3), (0, 8.3, 2.8), (0, 0, 0)


def m249():
    box('recv', (0, 2.5, 3.4), (1.9, 12.0, 2.9), 'g', M('steel'), bevel=0.25)
    box('feedcover', (0, 1.8, 5.2), (1.8, 7.5, 0.9), 'g', M('steel'), bevel=0.3)
    cyl('fclatch', (-0.95, -1.2, 5.2), (0.95, -1.2, 5.2), 0.22, 'g', M('bright'), verts=8)
    box('rsight', (0, -0.8, 6.0), (0.8, 1.0, 0.7), 'g', M('steel'), bevel=0.08)
    box('chandle', (0, 11.0, 6.0), (0.6, 5.0, 0.8), 'g', M('steel'), bevel=0.2)
    for yy in (9.0, 13.0):
        box('chpost', (0, yy, 5.2), (0.5, 0.6, 1.4), 'g', M('steel'), bevel=0.08)
    cyl('heatshield', (0, 8.5, 4.25), (0, 17.0, 4.25), 0.95, 'g', M('polygrey'), verts=16)
    for k in range(6):
        box('hsvent%d' % k, (0, 9.5 + k * 1.2, 5.15), (0.9, 0.5, 0.15), 'g', M('rubber'), bevel=0.05)
    box('handguard', (0, 11.0, 2.7), (2.1, 6.0, 1.8), 'g', M('poly'), bevel=0.4)
    cyl('barrel', (0, 8.5, 3.6), (0, 26.0, 3.6), 0.48, 'g', M('blued'), verts=14)
    cyl('gasblock', (0, 17.5, 2.9), (0, 19.0, 2.9), 0.55, 'g', M('steel'), verts=12)
    cyl('hider', (0, 26.0, 3.6), (0, 28.0, 3.6), 0.55, 'g', M('blued'), verts=8)
    box('fsight', (0, 24.8, 4.6), (0.5, 0.7, 1.6), 'g', M('steel'), bevel=0.08)
    # folded bipod under the barrel
    for x in (-0.35, 0.35):
        limb('bipod%d' % int(x * 10), (x, 20.0, 2.6), (x, 13.5, 2.35), 0.35, 0.35, 'g', M('steel'), bevel=0.05)
        box('foot%d' % int(x * 10), (x, 13.3, 2.3), (0.5, 0.6, 0.5), 'g', M('rubber'), bevel=0.08)
    # 200-round box magazine
    box('ammobox', (0, 4.0, -0.9), (4.2, 5.2, 4.8), 'g', M('olive'), bevel=0.35)
    box('boxlid', (0, 4.0, 1.55), (4.3, 5.3, 0.3), 'g', M('olive'), bevel=0.1)
    box('boxlatch', (2.12, 4.0, 0.2), (0.12, 1.4, 1.2), 'g', M('steel'), bevel=0.05)
    for k in range(4):
        box('belt%d' % k, (-1.0, 2.2 + k * 0.45, 2.9), (0.9, 0.35, 0.35), 'g', M('brass'), bevel=0.08)
    pistol_grip('m249', -0.6, 2.2, M('poly'), rake=1.2)
    box('stock', (0, -7.8, 3.0), (1.8, 9.5, 3.3), 'g', M('poly'), bevel=0.5, taper=(0.95, 0.9))
    box('butt', (0, -12.7, 2.9), (1.9, 0.6, 3.8), 'g', M('rubber'), bevel=0.2)
    return (0, 28.2, 3.6), (0, 11.0, 2.7), (0, 0, 0)


def sniper(gid, long=True):
    body = M('olive') if long else M('grey')
    L = 1.0 if long else 0.82
    box('recv', (0, 2.0, 3.2), (1.7, 11.5, 2.3), 'g', M('steel'), bevel=0.2)
    box('stock', (0, -9.0 * L, 2.4), (1.85, 11.5 * L, 3.9), 'g', body, bevel=0.65, taper=(0.95, 0.9))
    box('cheek', (0, -8.0 * L, 4.3), (1.6, 6.5 * L, 0.9), 'g', body, bevel=0.35)
    box('forend', (0, 13.5 * L, 2.6), (1.95, 12.5 * L, 2.35), 'g', body, bevel=0.65, taper=(0.85, 1.0))
    cyl('barrel', (0, 18.0 * L, 3.35), (0, 41.0 * L, 3.35), 0.5 if long else 0.4, 'g', M('blued'), verts=16, r2=0.38 if long else 0.32)
    if long:
        cyl('brake', (0, 41.0, 3.35), (0, 43.2, 3.35), 0.64, 'g', M('blued'), verts=12)
        for k in range(3):
            box('bport%d' % k, (0, 41.6 + k * 0.5, 3.35), (1.4, 0.2, 0.25), 'g', M('rubber'), bevel=0)
    so = 0.62 if long else 0.52
    cyl('scope', (0, -1.5, 6.2), (0, 9.5 * L, 6.2), so, 'g', M('blued'), verts=16)
    cyl('objective', (0, 9.0 * L, 6.2), (0, 12.2 * L, 6.2), 1.15 if long else 0.9, 'g', M('blued'), verts=18, r2=1.22 if long else 0.96)
    cyl('lens', (0, 12.2 * L, 6.2), (0, 12.28 * L, 6.2), 1.02 if long else 0.82, 'g', M('glass'), verts=18)
    cyl('eyepiece', (0, -3.8, 6.2), (0, -1.3, 6.2), 0.95 if long else 0.78, 'g', M('blued'), verts=16, r2=0.72)
    cyl('eyecup', (0, -4.2, 6.2), (0, -3.8, 6.2), 0.98 if long else 0.8, 'g', M('rubber'), verts=16)
    cyl('turret', (0, 4.0, 6.6), (0, 4.0, 7.8), 0.46, 'g', M('blued'), verts=12)
    cyl('turret2', (0.6, 4.0, 6.2), (1.7, 4.0, 6.2), 0.42, 'g', M('blued'), verts=12)
    for yy in (0.8, 6.0):
        box('mount', (0, yy, 5.0), (1.0, 1.0, 1.6), 'g', M('steel'), bevel=0.12)
        cyl('ring', (0, yy - 0.4, 6.2), (0, yy + 0.4, 6.2), so + 0.15, 'g', M('steel'), verts=16)
    limb('bolt', (0.8, -0.8, 4.0), (2.3, -1.3, 3.3), 0.35, 0.35, 'g', M('bright'), bevel=0.05)
    dome('knob', (2.4, -1.35, 3.0), 0.58, 'g', M('bright'), scale=(1, 1, 1.4))
    box('mag', (0, 3.5, 1.2), (1.2, 2.6, 2.2), 'g', M('steel'), bevel=0.15)
    pistol_grip(gid, -0.8, 1.8, body, length=3.6, rake=1.6)
    box('butt', (0, -15.3 * L, 2.2), (1.95, 0.8, 4.35), 'g', M('rubber'), bevel=0.25)
    cyl('bipod', (0, 20 * L, 1.5), (0, 20 * L, 1.2), 0.5, 'g', M('steel'), verts=10)
    return (0, (43.4 if long else 41.2 * L), 3.35), (0, 13.0 * L, 2.6), (0, 0, 0)


def awp(): return sniper('awp', True)
def scout(): return sniper('scout', False)


def pistol_support(gid):
    (gx, gy, gz), (rx, _, _) = GRIP[gid]
    # support hand cups the firing hand: below and to the left of the grip,
    # its "handguard" axis turned to run along the grip
    return (gx - 1.35, gy + 0.2, gz - 0.9), (math.pi / 2 + rx, 0, 0)


def deagle():
    box('slide', (0, 3.9, 3.35), (1.25, 10.2, 1.55), 'g', M('chrome'), bevel=0.18)
    box('rib', (0, 4.8, 4.2), (0.35, 7.8, 0.3), 'g', M('chrome'), bevel=0.05)
    box('frame', (0, 3.2, 2.15), (1.15, 7.0, 1.05), 'g', M('chrome'), bevel=0.18)
    for k in range(7):
        box('serr%d' % k, (0.63, -0.5 + k * 0.32, 3.35), (0.05, 0.14, 1.2), 'g', M('steel'), bevel=0)
        box('serl%d' % k, (-0.63, -0.5 + k * 0.32, 3.35), (0.05, 0.14, 1.2), 'g', M('steel'), bevel=0)
    box('hammer', (0, -1.35, 3.65), (0.5, 0.6, 0.85), 'g', M('steel'), bevel=0.06)
    box('slidestop', (-0.64, 2.2, 2.6), (0.12, 1.4, 0.35), 'g', M('steel'), bevel=0.04)
    cyl('muzzle', (0, 8.9, 3.4), (0, 9.0, 3.4), 0.3, 'g', M('rubber'), verts=10)
    pistol_grip('deagle', -0.3, 2.1, M('rubber'), length=4.2, w=1.3, d=2.2, rake=1.5)
    box('fsight', (0, 8.6, 4.28), (0.3, 0.45, 0.42), 'g', M('steel'), bevel=0)
    box('rsight', (0, -0.9, 4.25), (0.9, 0.4, 0.35), 'g', M('steel'), bevel=0.04)
    return (0, 9.1, 3.5), *pistol_support('deagle')


def glock():
    box('slide', (0, 2.8, 3.0), (1.02, 7.2, 1.18), 'g', M('poly'), bevel=0.15)
    box('frame', (0, 2.7, 2.0), (0.97, 6.3, 0.92), 'g', M('polygrey'), bevel=0.15)
    for k in range(5):
        box('serr%d' % k, (0.52, -0.3 + k * 0.3, 3.0), (0.05, 0.12, 0.9), 'g', M('rubber'), bevel=0)
    box('ejport', (0.52, 3.6, 3.25), (0.05, 1.6, 0.55), 'g', M('steel'), bevel=0)
    box('rail', (0, 4.8, 1.45), (0.8, 2.0, 0.3), 'g', M('polygrey'), bevel=0.05)
    pistol_grip('glock', -0.2, 1.8, M('polygrey'), length=3.9, w=1.15, d=2.0, rake=1.0)
    box('fsight', (0, 6.1, 3.72), (0.25, 0.3, 0.3), 'g', M('steel'), bevel=0)
    box('rsight', (0, -0.5, 3.7), (0.8, 0.3, 0.3), 'g', M('steel'), bevel=0.03)
    return (0, 6.5, 3.0), *pistol_support('glock')


def usp():
    box('slide', (0, 3.1, 3.05), (1.07, 7.8, 1.22), 'g', M('blued'), bevel=0.16)
    box('frame', (0, 2.9, 2.0), (1.02, 6.8, 0.97), 'g', M('poly'), bevel=0.16)
    for k in range(6):
        box('serr%d' % k, (0.55, -0.4 + k * 0.28, 3.05), (0.05, 0.12, 0.95), 'g', M('steel'), bevel=0)
    box('rail', (0, 5.0, 1.45), (0.8, 2.4, 0.35), 'g', M('poly'), bevel=0.05)
    box('decock', (-0.58, -0.2, 2.5), (0.12, 0.9, 0.4), 'g', M('steel'), bevel=0.04)
    pistol_grip('usp', -0.2, 1.8, M('poly'), length=4.0, w=1.2, d=2.0, rake=1.1)
    box('fsight', (0, 6.8, 3.82), (0.25, 0.3, 0.32), 'g', M('steel'), bevel=0)
    box('rsight', (0, -0.6, 3.8), (0.85, 0.3, 0.32), 'g', M('steel'), bevel=0.03)
    return (0, 7.2, 3.05), *pistol_support('usp')


def knife():
    limb('handle', (0, -1.4, 0), (0, 3.2, 0.1), 1.0, 1.25, 'g', M('rubber'), bevel=0.3, taper=0.9)
    for k in range(4):
        box('hr%d' % k, (0, -0.6 + k * 0.9, 0.05), (1.05, 0.2, 1.3), 'g', M('rubber'), bevel=0.05)
    box('guard', (0, 3.4, 0.1), (0.5, 0.35, 2.0), 'g', M('steel'), bevel=0.06)
    blade('blade', 3.5, 11.0, 1.35, 0.1, M('bright'))
    box('pommel', (0, -1.6, 0), (0.9, 0.35, 1.1), 'g', M('steel'), bevel=0.1)
    GRIP['knife'] = ((0, 0.9, 0.05), (-math.pi / 2, 0, 0))
    return (0, 11.0, 0.3), None, None


def c4():
    # four clay blocks taped together, a keypad + display on top, wires
    for i, (x, z) in enumerate([(-1.0, 0.0), (1.0, 0.0), (-1.0, 1.05), (1.0, 1.05)]):
        box('blk%d' % i, (x, 0, z + 0.5), (1.95, 5.0, 1.0), 'g', M('c4clay'), bevel=0.12)
    for yy in (-1.6, 1.6):
        box('tape%d' % int(yy), (0, yy, 1.05), (4.1, 0.7, 2.2), 'g', M('tape'), bevel=0.1)
    box('pad', (0, 0.4, 2.35), (2.6, 2.6, 0.5), 'g', M('poly'), bevel=0.1)
    box('screen', (0, 1.25, 2.62), (1.9, 0.6, 0.05), 'g', M('screen'), bevel=0)
    for r in range(3):
        for cc in range(3):
            box('key%d%d' % (r, cc), (-0.6 + cc * 0.6, -0.25 + r * -0.45, 2.64), (0.4, 0.3, 0.08), 'g', M('polygrey'), bevel=0.03)
    limb('wire1', (1.3, 0.4, 2.3), (2.1, -1.0, 1.2), 0.12, 0.12, 'g', M('wire_r'), bevel=0.02)
    limb('wire2', (1.3, -0.3, 2.3), (2.1, 1.2, 0.6), 0.12, 0.12, 'g', M('wire_b'), bevel=0.02)
    GRIP['c4'] = ((2.2, -0.2, 0.9), (0, 0, 0))
    return (0, 0, 2.7), (-2.4, 0, 0.9), (0, 0, 0)


def grenade(gid, kind):
    if kind == 'he':
        dome('bodytop', (0, 0, 1.2), 1.25, 'g', M('olive'), scale=(1, 1, 1.25), segs=14)
        dome('bodybot', (0, 0, 1.2), 1.25, 'g', M('olive'), scale=(1, 1, -1.1), segs=14)
        for k in range(4):
            cyl('seg%d' % k, (0, 0, 0.3 + k * 0.55), (0, 0, 0.36 + k * 0.55), 1.27, 'g', M('tape'), verts=14)
        top = 2.6
    else:
        body = M('grey') if kind == 'flash' else M('grey')
        cyl('body', (0, 0, -0.2), (0, 0, 3.4), 0.95, 'g', body, verts=16)
        if kind == 'smoke':
            cyl('band', (0, 0, 2.2), (0, 0, 2.7), 0.97, 'g', M('olive'), verts=16)
            for k in range(6):
                a = k * math.pi / 3
                cyl('hole%d' % k, (0.95 * math.cos(a), 0.95 * math.sin(a), 0.4), (1.0 * math.cos(a), 1.0 * math.sin(a), 0.4), 0.18, 'g', M('rubber'), verts=6)
        else:
            for k in range(3):
                cyl('ring%d' % k, (0, 0, 0.5 + k * 1.1), (0, 0, 0.62 + k * 1.1), 0.98, 'g', M('bright'), verts=16)
        top = 3.4
    cyl('fuse', (0, 0, top - 0.1), (0, 0, top + 0.6), 0.45, 'g', M('steel'), verts=10)
    limb('spoon', (0.35, 0, top + 0.5), (1.15, 0, top - 2.0), 0.55, 0.12, 'g', M('bright'), bevel=0.03)
    arc_tube('pin', (-0.7, 0, top + 0.35), 0.45, 0.07, 0, 360, 'g', M('bright'), axis='Y', segs=10)
    GRIP[gid] = ((0, 0, 1.2), (0, 0, 0))
    return (0, 0, top + 0.6), None, None


def hegrenade(): return grenade('hegrenade', 'he')
def flashbang(): return grenade('flashbang', 'flash')
def smokegrenade(): return grenade('smokegrenade', 'smoke')




# ------------------------------------------------------------------ M9 arsenal

def suppressor(y0, z, r=0.62, length=6.5):
    cyl('sup', (0, y0, z), (0, y0 + length, z), r, 'g', M('steel'), verts=16)
    for k in range(3):
        cyl('supring%d' % k, (0, y0 + 0.4 + k * 2.6, z), (0, y0 + 0.7 + k * 2.6, z), r + 0.04, 'g', M('blued'), verts=16)
    cyl('supcap', (0, y0 + length, z), (0, y0 + length + 0.2, z), r * 0.75, 'g', M('rubber'), verts=14)
    return y0 + length + 0.2


def m4a1_s():
    muzzle, lh, lr = m4a1()
    # the suppressor screws on in place of the flash hider
    end = suppressor(21.0, 3.9, 0.66, 7.8)
    GRIP['m4a1_s'] = GRIP['m4a1']
    return (0, end, 3.9), lh, lr


def usp_s():
    muzzle, lh, lr = usp()
    end = suppressor(7.0, 3.05, 0.5, 5.2)
    GRIP['usp_s'] = GRIP['usp']
    return (0, end, 3.05), lh, lr


def p228():
    box('slide', (0, 3.0, 3.05), (1.05, 7.4, 1.25), 'g', M('blued'), bevel=0.18)
    box('frame', (0, 2.8, 2.0), (1.0, 6.4, 0.95), 'g', M('steel'), bevel=0.16)
    for k in range(6):
        box('serr%d' % k, (0.54, -0.4 + k * 0.28, 3.05), (0.05, 0.12, 0.95), 'g', M('steel'), bevel=0)
    box('decock', (-0.56, 0.4, 2.55), (0.12, 0.8, 0.35), 'g', M('steel'), bevel=0.04)
    box('hammer', (0, -1.0, 3.4), (0.45, 0.5, 0.7), 'g', M('steel'), bevel=0.05)
    pistol_grip('p228', -0.2, 1.8, M('poly'), length=4.0, w=1.2, d=2.0, rake=1.2)
    box('fsight', (0, 6.4, 3.8), (0.25, 0.3, 0.32), 'g', M('steel'), bevel=0)
    box('rsight', (0, -0.6, 3.78), (0.85, 0.3, 0.32), 'g', M('steel'), bevel=0.03)
    return (0, 6.8, 3.05), *pistol_support('p228')


def fiveseven():
    box('slide', (0, 3.1, 3.0), (1.0, 7.8, 1.15), 'g', M('polygrey'), bevel=0.2)
    box('frame', (0, 3.0, 2.0), (0.98, 6.9, 0.95), 'g', M('poly'), bevel=0.18)
    box('rail', (0, 5.2, 1.45), (0.8, 2.6, 0.3), 'g', M('poly'), bevel=0.05)
    for k in range(5):
        box('serr%d' % k, (0.51, -0.3 + k * 0.3, 3.0), (0.05, 0.12, 0.9), 'g', M('rubber'), bevel=0)
    pistol_grip('fiveseven', -0.2, 1.8, M('poly'), length=4.3, w=1.15, d=2.1, rake=1.0)
    box('fsight', (0, 6.8, 3.7), (0.25, 0.3, 0.3), 'g', M('steel'), bevel=0)
    return (0, 7.1, 3.0), *pistol_support('fiveseven')


def beretta(tag, x):
    box('slide' + tag, (x, 3.2, 3.05), (0.95, 7.8, 1.1), 'g', M('bright'), bevel=0.15)
    box('cut' + tag, (x, 4.2, 3.55), (0.97, 3.2, 0.3), 'g', M('steel'), bevel=0.04)   # the open-top slide
    cyl('bbl' + tag, (x, 4.0, 3.3), (x, 7.3, 3.3), 0.3, 'g', M('blued'), verts=10)
    box('frame' + tag, (x, 3.0, 2.0), (0.95, 6.6, 0.95), 'g', M('bright'), bevel=0.15)
    box('hammer' + tag, (x, -0.95, 3.35), (0.4, 0.5, 0.7), 'g', M('steel'), bevel=0.05)
    box('fs' + tag, (x, 6.9, 3.72), (0.22, 0.3, 0.28), 'g', M('steel'), bevel=0)


def elites():
    # two Berettas: the right one in the firing hand, the left in the support hand
    beretta('R', 0.0)
    pistol_grip('elites', -0.2, 1.8, M('wood_dark'), length=4.1, w=1.2, d=2.0, rake=1.2)
    xl = -7.0
    beretta('L', xl)
    limb('gripL', (xl, -0.2, 1.8), (xl, -1.4, -2.3), 1.2, 2.0, 'g', M('wood_dark'), bevel=0.3, taper=1.06)
    arc_tube('guardL', (xl, 1.35, 1.45), 0.95, 0.13, 180, 360, 'g', M('steel'), axis='X', segs=8)
    (gx, gy, gz), (rx, _, _) = GRIP['elites']
    return (0, 7.4, 3.3), (xl + gx, gy, gz), (math.pi / 2 + rx, 0, 0)


def shotgun(gid, auto=False):
    body = M('poly')
    box('recv', (0, 1.8, 3.1), (1.6, 9.0, 2.4), 'g', M('blued') if not auto else M('steel'), bevel=0.25)
    cyl('barrel', (0, 6.3, 3.75), (0, 26.0, 3.75), 0.52, 'g', M('blued'), verts=16)
    cyl('tube', (0, 6.3, 2.55), (0, 22.5, 2.55), 0.55, 'g', M('blued'), verts=14)
    cyl('tubecap', (0, 22.5, 2.55), (0, 23.1, 2.55), 0.5, 'g', M('steel'), verts=14)
    box('bead', (0, 25.7, 4.35), (0.18, 0.25, 0.2), 'g', M('bright'), bevel=0.05)
    if auto:
        box('forend', (0, 11.0, 2.7), (1.9, 7.0, 1.9), 'g', body, bevel=0.5)
        box('rail', (0, 1.8, 4.45), (0.9, 7.0, 0.35), 'g', M('steel'), bevel=0.05)
        for k in range(8):
            box('rs%d' % k, (0, -1.2 + k * 0.85, 4.66), (0.95, 0.35, 0.12), 'g', M('steel'), bevel=0.02)
        box('stock', (0, -8.0, 2.6), (1.7, 11.0, 3.6), 'g', body, bevel=0.6, taper=(0.95, 0.85))
        box('butt', (0, -13.6, 2.5), (1.8, 0.7, 4.0), 'g', M('rubber'), bevel=0.25)
    else:
        # pump forend with grip ridges
        cyl('pump', (0, 9.5, 2.6), (0, 15.5, 2.6), 1.05, 'g', body, verts=16)
        for k in range(8):
            cyl('ridge%d' % k, (0, 10.0 + k * 0.7, 2.6), (0, 10.25 + k * 0.7, 2.6), 1.12, 'g', body, verts=16)
        box('stock', (0, -7.6, 2.4), (1.7, 10.5, 3.9), 'g', body, bevel=0.6, taper=(0.95, 0.85))
        box('butt', (0, -12.9, 2.3), (1.8, 0.7, 4.3), 'g', M('rubber'), bevel=0.25)
        box('ghost', (0, -0.4, 4.7), (0.8, 0.8, 1.0), 'g', M('steel'), bevel=0.1)
    box('loadport', (0, 2.8, 1.85), (1.2, 3.6, 0.3), 'g', M('steel'), bevel=0.05)
    pistol_grip(gid, -0.6, 2.0, body, rake=1.4)
    return (0, 26.2, 3.75), (0, 12.5 if not auto else 11.0, 2.6), (0, 0, 0)


def m3(): return shotgun('m3', False)
def xm1014(): return shotgun('xm1014', True)


def tmp():
    box('recv', (0, 2.8, 3.2), (1.4, 8.8, 2.2), 'g', M('poly'), bevel=0.4)
    box('top', (0, 2.4, 4.4), (1.0, 7.0, 0.4), 'g', M('poly'), bevel=0.12)
    box('rsight', (0, -0.8, 4.8), (0.8, 0.6, 0.6), 'g', M('poly'), bevel=0.1)
    cyl('barrel', (0, 7.2, 3.3), (0, 9.2, 3.3), 0.4, 'g', M('blued'), verts=12)
    end = suppressor(9.2, 3.3, 0.72, 6.0)        # the TMP comes suppressed in CS
    # vertical foregrip
    limb('fgrip', (0, 5.8, 2.0), (0, 6.2, -1.6), 1.0, 1.3, 'g', M('poly'), bevel=0.3)
    limb('mag', (0, 1.1, 2.0), (0, 0.7, -5.5), 0.95, 1.8, 'g', M('steel'), bevel=0.15)
    pistol_grip('tmp', 0.2, 2.2, M('poly'), length=0.1, rake=0.0, guard=True)   # mag is the grip
    GRIP['tmp'] = ((0, 0.9, 0.2), (-0.05, 0, 0))
    return (0, end, 3.3), (0, 6.0, 0.4), (math.pi / 2, 0, 0)


def mac10():
    box('recv', (0, 2.2, 3.1), (1.6, 7.5, 2.8), 'g', M('steel'), bevel=0.2)
    box('top', (0, 2.2, 4.62), (1.3, 7.2, 0.3), 'g', M('steel'), bevel=0.08)
    box('chandle', (0, 3.2, 4.9), (0.5, 0.8, 0.5), 'g', M('steel'), bevel=0.1)
    cyl('barrel', (0, 5.9, 3.3), (0, 8.6, 3.3), 0.45, 'g', M('blued'), verts=12)
    cyl('thread', (0, 8.6, 3.3), (0, 9.1, 3.3), 0.38, 'g', M('steel'), verts=12)
    limb('mag', (0, 0.6, 1.8), (0, 0.4, -5.0), 0.95, 1.9, 'g', M('steel'), bevel=0.12)
    arc_tube('guard', (0, 1.9, 1.35), 0.95, 0.13, 180, 360, 'g', M('steel'), axis='X', segs=8)
    limb('strap', (0, 6.0, 2.0), (0, 6.6, 0.8), 0.3, 1.1, 'g', M('rubber'), bevel=0.05)
    cyl('stockrod', (0.7, -1.5, 3.4), (0.7, -6.5, 3.4), 0.18, 'g', M('steel'), verts=8)
    cyl('stockrod2', (-0.7, -1.5, 3.4), (-0.7, -6.5, 3.4), 0.18, 'g', M('steel'), verts=8)
    box('buttpad', (0, -6.6, 3.2), (1.8, 0.4, 1.4), 'g', M('steel'), bevel=0.08)
    GRIP['mac10'] = ((0, 0.5, -1.4), (-0.05, 0, 0))
    return (0, 9.2, 3.3), (0, 6.3, 1.3), (0, 0, 0)


def p90():
    # bullpup: grip hole ahead of the magazine, clear magazine on top
    box('body', (0, 2.0, 2.6), (1.9, 15.5, 3.8), 'g', M('polygrey'), bevel=0.8, taper=(0.9, 1.0))
    box('hole', (0, 5.4, 1.4), (2.0, 2.6, 1.8), 'g', M('poly'), bevel=0.6)
    box('thumbhole', (0, 6.8, 0.6), (1.95, 1.1, 1.6), 'g', M('poly'), bevel=0.4)
    box('mag', (0, 3.0, 5.0), (1.6, 11.0, 0.9), 'g', M('glass'), bevel=0.2)
    for k in range(10):
        box('rnd%d' % k, (0, -1.8 + k * 1.0, 5.0), (0.6, 0.35, 0.5), 'g', M('brass'), bevel=0.05)
    box('sight', (0, 3.0, 6.1), (1.0, 3.8, 1.2), 'g', M('poly'), bevel=0.25)
    cyl('lens', (0, 4.95, 6.2), (0, 5.0, 6.2), 0.42, 'g', M('glass'), verts=12)
    cyl('barrel', (0, 9.6, 3.2), (0, 11.6, 3.2), 0.4, 'g', M('blued'), verts=12)
    box('butt', (0, -5.9, 2.4), (2.0, 0.8, 4.2), 'g', M('rubber'), bevel=0.3)
    GRIP['p90'] = ((0, 4.6, 1.2), (-0.35, 0, 0))
    return (0, 11.8, 3.2), (0, 8.0, 1.4), (0, 0, 0)


def ar_body(gid, stock='fixed', furniture='poly', long=1.0):
    fm = M(furniture)
    box('recv', (0, 2.2, 3.3), (1.6, 10.0, 2.4), 'g', M('steel'), bevel=0.2)
    box('cover', (0, 1.8, 4.65), (1.45, 8.5, 0.6), 'g', M('steel'), bevel=0.2)
    box('hguard', (0, 10.8 * long, 3.2), (1.95, 7.5 * long, 2.1), 'g', fm, bevel=0.55)
    cyl('barrel', (0, 12.0 * long, 3.4), (0, 22.0 * long, 3.4), 0.38, 'g', M('blued'), verts=14)
    cyl('hider', (0, 22.0 * long, 3.4), (0, 23.4 * long, 3.4), 0.5, 'g', M('blued'), verts=10)
    box('fsight', (0, 15.2 * long, 4.4), (0.6, 0.7, 1.4), 'g', M('steel'), bevel=0.1)
    box('rsight', (0, -1.6, 5.1), (0.9, 1.0, 0.7), 'g', M('steel'), bevel=0.1)
    if stock == 'folding':
        limb('stock', (0.9, -2.6, 3.4), (0.9, -12.0, 2.6), 0.4, 1.4, 'g', M('steel'), bevel=0.1)
        limb('stock2', (0.9, -12.0, 2.6), (0.9, -12.2, 0.6), 0.4, 1.4, 'g', M('steel'), bevel=0.1)
        box('butt', (0.9, -12.3, 1.6), (0.9, 0.5, 3.2), 'g', M('rubber'), bevel=0.15)
    else:
        box('stock', (0, -8.0, 2.8), (1.7, 11.5, 3.3), 'g', fm, bevel=0.6, taper=(0.95, 0.85))
        box('butt', (0, -13.9, 2.7), (1.8, 0.6, 3.7), 'g', M('rubber'), bevel=0.2)
    pistol_grip(gid, -0.3, 2.0, fm, rake=1.3)
    return (0, 23.6 * long, 3.4)


def galil():
    muzzle = ar_body('galil', 'folding', 'wood', 1.0)
    limb('mag', (0, 5.0, 2.0), (0, 7.4, -5.8), 1.2, 2.8, 'g', M('steel'), bevel=0.2)
    box('bipodfold', (0, 13.0, 1.9), (0.9, 5.0, 0.5), 'g', M('steel'), bevel=0.08)
    return muzzle, (0, 10.8, 3.2), (0, 0, 0)


def famas():
    # bullpup with the long carrying handle
    box('body', (0, 1.5, 3.2), (1.9, 17.0, 3.2), 'g', M('olive') if False else M('grey'), bevel=0.7)
    box('handle', (0, 3.0, 6.0), (0.8, 12.0, 0.9), 'g', M('grey'), bevel=0.3)
    for yy in (-2.6, 8.4):
        box('hpost', (0, yy, 5.1), (0.6, 1.0, 1.6), 'g', M('grey'), bevel=0.15)
    box('guard', (0, 7.0, 1.5), (1.6, 3.4, 0.4), 'g', M('grey'), bevel=0.1)
    cyl('barrel', (0, 10.0, 3.4), (0, 16.0, 3.4), 0.36, 'g', M('blued'), verts=14)
    cyl('hider', (0, 16.0, 3.4), (0, 17.2, 3.4), 0.5, 'g', M('blued'), verts=10)
    limb('mag', (0, -3.2, 2.0), (0, -3.9, -3.2), 1.0, 2.4, 'g', M('steel'), bevel=0.15)
    box('butt', (0, -7.3, 3.0), (1.95, 0.6, 3.6), 'g', M('rubber'), bevel=0.2)
    box('bipod', (0, 11.5, 2.4), (0.8, 4.0, 0.5), 'g', M('steel'), bevel=0.08)
    pistol_grip('famas', 5.4, 1.9, M('poly'), rake=1.2)
    return (0, 17.3, 3.4), (0, 10.5, 3.0), (0, 0, 0)


def aug():
    # bullpup, green polymer, integral 1.5x scope
    box('body', (0, 0.5, 3.0), (2.0, 16.0, 3.4), 'g', M('olive'), bevel=0.9, taper=(0.9, 1.0))
    box('guard', (0, 6.4, 1.2), (2.0, 4.8, 1.1), 'g', M('olive'), bevel=0.4)
    limb('fgrip', (0, 10.2, 2.4), (0, 9.8, -1.6), 1.0, 1.3, 'g', M('olive'), bevel=0.3)
    cyl('scope', (0, 1.0, 6.0), (0, 8.0, 6.0), 0.75, 'g', M('olive'), verts=16, r2=0.85)
    cyl('slens', (0, 8.0, 6.0), (0, 8.1, 6.0), 0.75, 'g', M('glass'), verts=16)
    box('smount', (0, 4.5, 5.0), (1.2, 5.0, 1.0), 'g', M('olive'), bevel=0.3)
    cyl('barrel', (0, 8.4, 3.4), (0, 18.2, 3.4), 0.4, 'g', M('blued'), verts=14)
    cyl('hider', (0, 18.2, 3.4), (0, 19.6, 3.4), 0.5, 'g', M('blued'), verts=10)
    limb('mag', (0, -3.0, 1.6), (0, -3.6, -3.8), 0.95, 2.4, 'g', M('glass'), bevel=0.15)
    box('butt', (0, -7.4, 2.9), (2.0, 0.6, 3.7), 'g', M('rubber'), bevel=0.2)
    pistol_grip('aug', 4.9, 1.2, M('olive'), rake=0.9, guard=False)
    return (0, 19.8, 3.4), (0, 10.0, 0.4), (math.pi / 2, 0, 0)


def shifted(gid, fn, dy):
    """Build `fn` and move everything (mesh, grip, muzzle, left hand) dy along
    the gun's length: bullpups get their grip where a rifle's is, so the
    viewmodel holds them the same way."""
    n0 = len(PARTS)
    muzzle, lh, lr = fn()
    for ob, _ in PARTS[n0:]:
        ob.data.transform(Matrix.Translation((0, dy, 0)))
    (gx, gy, gz), rot = GRIP[gid]
    GRIP[gid] = ((gx, gy + dy, gz), rot)
    sh = lambda p: (p[0], p[1] + dy, p[2]) if p else p
    return sh(muzzle), sh(lh), lr


def sg552():
    muzzle = ar_body('sg552', 'folding', 'poly', 0.9)
    limb('mag', (0, 4.8, 2.0), (0, 6.4, -5.2), 1.0, 2.6, 'g', M('glass'), bevel=0.2)
    # compact scope on the rail
    cyl('scope', (0, -0.5, 6.4), (0, 6.2, 6.4), 0.62, 'g', M('blued'), verts=16)
    cyl('obj', (0, 6.0, 6.4), (0, 7.4, 6.4), 0.85, 'g', M('blued'), verts=16)
    for yy in (0.8, 4.8):
        box('mount', (0, yy, 5.4), (0.9, 0.8, 1.2), 'g', M('steel'), bevel=0.1)
    return muzzle, (0, 9.7, 3.2), (0, 0, 0)


def autosniper(gid):
    t = gid == 'g3sg1'
    muzzle = ar_body(gid, 'fixed', 'poly' if t else 'grey', 1.25)
    limb('mag', (0, 4.8, 2.0), (0, 5.8, -3.6), 1.1, 2.6, 'g', M('steel'), bevel=0.2)
    cyl('scope', (0, -2.5, 6.6), (0, 8.5, 6.6), 0.6, 'g', M('blued'), verts=16)
    cyl('obj', (0, 8.0, 6.6), (0, 10.8, 6.6), 1.05, 'g', M('blued'), verts=18, r2=1.12)
    cyl('lens', (0, 10.8, 6.6), (0, 10.88, 6.6), 0.95, 'g', M('glass'), verts=18)
    cyl('eye', (0, -4.4, 6.6), (0, -2.5, 6.6), 0.85, 'g', M('blued'), verts=16, r2=0.7)
    for yy in (0.0, 5.5):
        box('mount', (0, yy, 5.5), (0.9, 0.9, 1.3), 'g', M('steel'), bevel=0.1)
    box('cheek', (0, -8.5, 4.6), (1.5, 6.0, 0.8), 'g', M('poly'), bevel=0.3)
    if not t:
        for x in (-0.4, 0.4):
            limb('bipod%d' % int(x * 10), (x, 17.0, 2.1), (x, 11.0, 1.9), 0.3, 0.3, 'g', M('steel'), bevel=0.05)
    return muzzle, (0, 13.0, 3.2), (0, 0, 0)


def sg550(): return autosniper('sg550')
def g3sg1(): return autosniper('g3sg1')


GUNS = {
    'ak47': ak47, 'm4a1': m4a1, 'mp5': mp5, 'ump45': ump45, 'm249': m249, 'awp': awp, 'scout': scout,
    'deagle': deagle, 'glock': glock, 'usp': usp, 'knife': knife, 'c4': c4,
    'hegrenade': hegrenade, 'flashbang': flashbang, 'smokegrenade': smokegrenade,
    'p228': p228, 'fiveseven': fiveseven, 'elites': elites, 'm3': m3, 'xm1014': xm1014,
    'tmp': tmp, 'mac10': mac10, 'p90': lambda: shifted('p90', p90, -4.8), 'galil': galil,
    'famas': lambda: shifted('famas', famas, -5.6), 'aug': lambda: shifted('aug', aug, -5.1),
    'sg552': sg552, 'sg550': sg550, 'g3sg1': g3sg1, 'm4a1_s': m4a1_s, 'usp_s': usp_s,
}


# ------------------------------------------------------------------ hands

def finger(tag, pts, radii, mat):
    for k in range(len(pts) - 1):
        capsule(f'{tag}{k}', pts[k], pts[k + 1], radii[k], 'g', mat, segs=10, r2=radii[k + 1] if k + 1 < len(radii) else radii[k] * 0.9)


# first-person gloves + sleeves: per skin (M19), else per team
HAND_GLOVE = {'leet': 'glove_ct'}
HAND_SLEEVE = {'guerilla': 'skin'}            # bare forearms


def hand_mats(team, skin=None):
    t = team == 'T'
    if skin:
        return M(HAND_GLOVE.get(skin, 'glove_t' if t else 'glove_ct')), M(HAND_SLEEVE.get(skin, 'sleeve_' + skin))
    return M('glove_t' if t else 'glove_ct'), M('sleeve_t' if t else 'sleeve_ct')


def hand_right(team, skin=None):
    gl, sl = hand_mats(team, skin)
    # palm + back of the hand on the grip's right side, knuckle ridge in front
    box('palm', (1.05, -0.35, -0.15), (0.9, 2.9, 3.6), 'g', gl, bevel=0.42, taper=(1.0, 0.94))
    capsule('knuckles', (1.08, 0.95, 1.55), (1.08, 0.85, -1.75), 0.44, 'g', gl, segs=10)
    # middle / ring / little fingers wrapped round the grip
    for tag, z, r in (('m', 0.55, 0.37), ('r', -0.35, 0.35), ('l', -1.2, 0.31)):
        finger(tag, [(1.0, 1.05, z), (0.35, 1.7, z), (-0.45, 1.6, z), (-0.98, 1.0, z - 0.05)], [r, r * 0.93, r * 0.86, r * 0.8], gl)
    # index finger on the trigger
    finger('i', [(1.0, 1.05, 1.45), (0.5, 1.95, 1.55), (0.12, 2.65, 1.35), (-0.05, 3.0, 0.95)], [0.37, 0.34, 0.31, 0.28], gl)
    # thumb over the top of the grip
    finger('t', [(0.9, -0.9, 1.1), (0.2, -0.4, 1.9), (-0.6, 0.25, 1.95), (-0.95, 0.95, 1.75)], [0.46, 0.41, 0.37, 0.33], gl)
    # wrist, cuff, forearm in a rolled sleeve
    capsule('wrist', (1.2, -1.4, -0.9), (1.9, -3.4, -1.8), 1.05, 'g', gl, segs=12, r2=1.12)
    capsule('cuff', (1.8, -3.0, -1.6), (2.2, -4.2, -2.1), 1.3, 'g', gl, segs=12)
    capsule('forearm', (2.0, -3.6, -1.9), (4.8, -15.0, -7.0), 1.45, 'g', sl, segs=14, r2=1.85)
    capsule('roll', (2.35, -5.0, -2.5), (2.6, -6.3, -3.0), 1.75, 'g', sl, segs=14)


def hand_left(team, skin=None):
    gl, sl = hand_mats(team, skin)
    # palm under the handguard, fingers over the far (+X) side, thumb on the near side
    box('palm', (0.05, -0.25, -1.62), (2.7, 3.0, 0.85), 'g', gl, bevel=0.4)
    capsule('knuckles', (1.3, 1.25, -1.4), (1.3, -1.7, -1.35), 0.44, 'g', gl, segs=10)
    for tag, y, r in (('i', 1.1, 0.36), ('m', 0.3, 0.37), ('r', -0.5, 0.35), ('l', -1.25, 0.31)):
        finger(tag, [(1.25, y, -1.4), (1.62, y, -0.5), (1.4, y, 0.45), (0.85, y - 0.05, 1.05)], [r, r * 0.93, r * 0.86, r * 0.8], gl)
    finger('t', [(-1.1, -0.9, -1.3), (-1.55, -0.2, -0.45), (-1.45, 0.6, 0.25), (-1.1, 1.3, 0.65)], [0.46, 0.41, 0.37, 0.33], gl)
    capsule('wrist', (0.0, -1.6, -1.9), (-0.6, -3.6, -2.8), 1.02, 'g', gl, segs=12, r2=1.1)
    capsule('cuff', (-0.5, -3.2, -2.6), (-0.9, -4.3, -3.2), 1.28, 'g', gl, segs=12)
    capsule('forearm', (-0.7, -3.8, -2.9), (-5.5, -14.0, -8.5), 1.4, 'g', sl, segs=14, r2=1.8)
    capsule('roll', (-1.2, -5.2, -3.6), (-1.6, -6.4, -4.2), 1.72, 'g', sl, segs=14)


# ------------------------------------------------------------------ assemble

def finish(name, size=1024, metallic=0.35):
    parts = [ob for ob, _ in PARTS]
    PARTS.clear()
    bpy.ops.object.select_all(action='DESELECT')
    for ob in parts:
        ob.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.join()
    ob = bpy.context.view_layer.objects.active
    ob.name = name
    bpy.ops.object.shade_auto_smooth(angle=math.radians(38))
    uv = ob.data.uv_layers.new(name='UVMap')
    ob.data.uv_layers.active = uv
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(58), island_margin=0.008)
    bpy.ops.uv.pack_islands(margin=0.006, rotate=True)
    bpy.ops.object.mode_set(mode='OBJECT')

    albedo = new_image('col_' + name, size)
    bake(ob, 'DIFFUSE', albedo, samples=6, margin=6)
    albedo.pack()
    nrm = new_image('nrm_' + name, size, non_color=True)
    bake(ob, 'NORMAL', nrm, samples=8, margin=6)
    nrm.pack()
    rough = new_image('rgh_' + name, size // 2, non_color=True)
    bake(ob, 'ROUGHNESS', rough, samples=2, margin=6)
    rough.pack()

    final = bpy.data.materials.new('mat_' + name)
    final.use_nodes = True
    nt = final.node_tree
    bsdf = nt.nodes['Principled BSDF']
    t_col = nt.nodes.new('ShaderNodeTexImage'); t_col.image = albedo
    nt.links.new(t_col.outputs['Color'], bsdf.inputs['Base Color'])
    t_n = nt.nodes.new('ShaderNodeTexImage'); t_n.image = nrm
    nm = nt.nodes.new('ShaderNodeNormalMap')
    nt.links.new(t_n.outputs['Color'], nm.inputs['Color'])
    nt.links.new(nm.outputs['Normal'], bsdf.inputs['Normal'])
    t_r = nt.nodes.new('ShaderNodeTexImage'); t_r.image = rough
    nt.links.new(t_r.outputs['Color'], bsdf.inputs['Roughness'])
    bsdf.inputs['Metallic'].default_value = metallic
    ob.data.materials.clear()
    ob.data.materials.append(final)
    tris = sum(len(p.vertices) - 2 for p in ob.data.polygons)
    print(f'{name}: {tris} tris')
    return ob


SKIN_TEAMS = {'phoenix': 'T', 'leet': 'T', 'arctic': 'T', 'guerilla': 'T', 'seal': 'CT', 'gsg9': 'CT', 'sas': 'CT', 'gign': 'CT'}


def main_hands():
    """--hands: hands.glb, a pair per skin (hand_r_<skin> / hand_l_<skin>),
    loaded after startup; weapons.glb keeps the per-team pair as fallback."""
    reset_scene()
    roots = []
    for skin, team in SKIN_TEAMS.items():
        hand_right(team, skin)
        roots.append(finish('hand_r_' + skin, 512, 0.0))
        hand_left(team, skin)
        roots.append(finish('hand_l_' + skin, 512, 0.0))
    for ob in roots:
        ob.location = (0, 0, 0)
    bpy.ops.object.select_all(action='SELECT')
    path = os.path.join(OUT, 'hands.glb')
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_yup=True,
                              export_image_format='JPEG', export_jpeg_quality=86, export_animations=False)
    print('wrote', path, f'{os.path.getsize(path) / 1024:.0f} KB')


def main():
    if '--hands' in sys.argv:
        return main_hands()
    reset_scene()
    roots = []
    for gid, fn in GUNS.items():
        muzzle, lhand, lrot = fn()
        # full-res textures for the guns seen most, 512 px for the rest (download size)
        ob = finish(gid, 1024 if gid in ('ak47', 'm4a1', 'm4a1_s', 'awp', 'deagle', 'usp', 'usp_s', 'glock') else 512)
        e = empty(f'{gid}_muzzle', muzzle); e.parent = ob
        if gid in GRIP:
            loc, rot = GRIP[gid]
            e = empty(f'{gid}_grip', loc, rot); e.parent = ob
        if lhand is not None:
            e = empty(f'{gid}_lhand', lhand, lrot or (0, 0, 0)); e.parent = ob
        roots.append(ob)
    for team in ('T', 'CT'):
        hand_right(team)
        roots.append(finish('hand_r_' + team.lower(), 1024, 0.0))
        hand_left(team)
        roots.append(finish('hand_l_' + team.lower(), 1024, 0.0))
    for ob in roots:
        ob.location = (0, 0, 0)
    bpy.ops.object.select_all(action='SELECT')
    path = os.path.join(OUT, 'weapons.glb')
    os.makedirs(OUT, exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_yup=True,
                              export_image_format='JPEG', export_jpeg_quality=88, export_animations=False)
    print('wrote', path, f'{os.path.getsize(path) / 1024:.0f} KB')


main()
