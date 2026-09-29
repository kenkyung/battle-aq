# Modelling primitives + material helpers shared by the character and weapon
# builds. Every primitive registers itself in PARTS as (object, bone) so a
# caller can skin or join them afterwards.

import math
import bpy, bmesh
from mathutils import Vector, Matrix
from lib import G, rgb

# ------------------------------------------------------------------ primitives

PARTS = []   # (object, bone)


def _finish(ob, bone, mat, bevel):
    if bevel:
        bm = bmesh.new(); bm.from_mesh(ob.data)
        bmesh.ops.bevel(bm, geom=list(bm.edges), offset=bevel, segments=1, affect='EDGES', clamp_overlap=True)
        bm.to_mesh(ob.data); bm.free()
    ob.data.materials.append(mat)
    PARTS.append((ob, bone))
    return ob


def box(name, center, size, bone, mat, bevel=0.5, taper=None):
    """Axis-aligned box; `taper` = (sx, sy) scale of the top face."""
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        if taper and v.co.z > 0:
            v.co.x *= taper[0]; v.co.y *= taper[1]
        v.co.x *= size[0]; v.co.y *= size[1]; v.co.z *= size[2]
        v.co += Vector(center)
    bm.to_mesh(me); bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return _finish(ob, bone, mat, bevel)


def limb(name, a, b, w, d, bone, mat, bevel=0.5, taper=1.0, up=(0, 1, 0)):
    """Box running from point a to point b, cross-section w x d."""
    a, b = Vector(a), Vector(b)
    L = (b - a).length
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        t = v.co.z + 0.5                       # 0 at a, 1 at b
        s = 1.0 + (taper - 1.0) * t
        v.co.x *= w * s; v.co.y *= d * s; v.co.z = t * L
    q = (b - a).normalized().to_track_quat('Z', 'Y')
    m = Matrix.Translation(a) @ q.to_matrix().to_4x4()
    for v in bm.verts:
        v.co = m @ v.co
    bm.to_mesh(me); bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return _finish(ob, bone, mat, bevel)


def cyl(name, a, b, r, bone, mat, verts=8, r2=None, caps=True):
    a, b = Vector(a), Vector(b)
    L = (b - a).length
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=caps, segments=verts, radius1=r, radius2=r if r2 is None else r2, depth=L)
    q = (b - a).normalized().to_track_quat('Z', 'Y')
    m = Matrix.Translation((a + b) / 2) @ q.to_matrix().to_4x4()
    for v in bm.verts:
        v.co = m @ v.co
    bm.to_mesh(me); bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return _finish(ob, bone, mat, 0)


def dome(name, center, radius, bone, mat, scale=(1, 1, 1), segs=10):
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=segs, v_segments=6, radius=radius)
    for v in list(bm.verts):
        if v.co.z < -0.01:
            bm.verts.remove(v)
    for v in bm.verts:
        v.co.x *= scale[0]; v.co.y *= scale[1]; v.co.z *= scale[2]
        v.co += Vector(center)
    bm.to_mesh(me); bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return _finish(ob, bone, mat, 0)


# ------------------------------------------------------------------ materials

def mat(name, build):
    m = bpy.data.materials.new(name)
    g = G(m)
    co = g.objcoord()
    sep = g.node('ShaderNodeSeparateXYZ')
    g.nt.links.new(co, sep.inputs[0])
    x, y, z = sep.outputs[0], sep.outputs[1], sep.outputs[2]
    col, rough = build(g, co, x, y, z)
    g.surface(col, rough=rough)
    return m


def n3(g, co, scale, detail=4, seed=0, distort=0.0):
    n = g.node('ShaderNodeTexNoise', noise_dimensions='4D')
    g.put(n.inputs['Vector'], co)
    n.inputs['W'].default_value = seed * 1.7
    n.inputs['Scale'].default_value = scale
    n.inputs['Detail'].default_value = detail
    n.inputs['Distortion'].default_value = distort
    return g.lin(n.outputs['Fac'], 0.32, 0.68)


def weave(g, x, z, freq=3.0):
    return g.mul(g.add(g.sin(g.mul(x, freq)), g.sin(g.mul(z, freq))), 0.25)


def cloth(base, dark, scale=0.12, seed=0):
    def f(g, co, x, y, z):
        n = n3(g, co, scale, 6, seed)
        fine = n3(g, co, 1.8, 3, seed + 1)
        col = g.mix(n, rgb(*dark), rgb(*base))
        col = g.mix(g.mul(fine, 0.35), col, rgb(*dark))
        col = g.mix(g.add(weave(g, x, z, 4.0), 0.5), g.hsv(col, v=0.93), col)
        return col, 0.9
    return f


def camo(c1, c2, c3, c4, scale=0.09, seed=0):
    def f(g, co, x, y, z):
        a = n3(g, co, scale, 3, seed, distort=0.6)
        b = n3(g, co, scale * 1.3, 3, seed + 5, distort=0.6)
        col = g.mix(g.smooth(a, 0.45, 0.5), rgb(*c1), rgb(*c2))
        col = g.mix(g.smooth(b, 0.55, 0.6), col, rgb(*c3))
        col = g.mix(g.smooth(a, 0.68, 0.72), col, rgb(*c4))
        fine = n3(g, co, 2.0, 3, seed + 9)
        col = g.mix(g.mul(fine, 0.3), col, rgb(0.1, 0.1, 0.08))
        return col, 0.92
    return f


def webbing(base):
    def f(g, co, x, y, z):
        loops = g.smooth(g.absv(g.sin(g.mul(z, 2.4))), 0.2, 0.35)
        col = g.mix(loops, rgb(base[0] * 0.55, base[1] * 0.55, base[2] * 0.55), rgb(*base))
        n = n3(g, co, 0.8, 4, 3)
        col = g.mix(g.mul(n, 0.3), col, rgb(0.1, 0.1, 0.1))
        return col, 0.85
    return f


def plain(c, rough=0.8, grit=0.25):
    def f(g, co, x, y, z):
        n = n3(g, co, 0.6, 5, 7)
        col = g.mix(g.mul(n, grit), rgb(*c), rgb(c[0] * 0.5, c[1] * 0.5, c[2] * 0.5))
        return col, rough
    return f


def face(skin, balaclava=None):
    """Skin with painted features on the +Y side of the head (eyes, brows,
    nose shadow, mouth). With `balaclava`, the head is knit fabric except for
    an eye slit."""
    def f(g, co, x, y, z):
        sk = rgb(*skin)
        n = n3(g, co, 1.2, 4, 11)
        col = g.mix(g.mul(n, 0.25), sk, rgb(skin[0] * 0.8, skin[1] * 0.7, skin[2] * 0.62))
        front = g.smooth(y, 2.5, 4.0)
        ax = g.absv(x)
        # eyes: dark almond shapes at |x|=1.7, z=67.8
        ed = g.pw(g.add(g.pw(g.div(g.sub(ax, 1.75), 1.0), 2.0), g.pw(g.div(g.sub(z, 67.8), 0.45), 2.0)), 0.5)
        eye = g.mul(g.smooth(ed, 1.0, 0.6), front)
        white = g.mul(g.smooth(ed, 1.25, 1.0), front)
        brow = g.mul(g.mul(g.smooth(g.absv(g.sub(z, 68.9)), 0.35, 0.15), g.smooth(g.absv(g.sub(ax, 1.8)), 1.3, 0.9)), front)
        mouth = g.mul(g.mul(g.smooth(g.absv(g.sub(z, 64.6)), 0.25, 0.1), g.smooth(ax, 1.4, 1.0)), front)
        nose = g.mul(g.mul(g.smooth(ax, 0.8, 0.3), g.smooth(g.absv(g.sub(z, 66.3)), 0.9, 0.5)), front)
        col = g.mix(g.mul(nose, 0.35), col, rgb(skin[0] * 0.6, skin[1] * 0.5, skin[2] * 0.42))
        col = g.mix(g.mul(white, 0.8), col, rgb(0.85, 0.82, 0.78))
        col = g.mix(eye, col, rgb(0.08, 0.06, 0.05))
        col = g.mix(brow, col, rgb(0.12, 0.08, 0.05))
        col = g.mix(g.mul(mouth, 0.7), col, rgb(skin[0] * 0.55, skin[1] * 0.35, skin[2] * 0.3))
        # stubble / jaw shadow
        jaw = g.mul(g.smooth(z, 65.5, 63.0), n3(g, co, 4.0, 2, 13))
        col = g.mix(g.mul(jaw, 0.35), col, rgb(0.2, 0.16, 0.12))
        if balaclava:
            slit = g.mul(g.mul(g.smooth(g.absv(g.sub(z, 67.9)), 1.1, 0.8), g.smooth(ax, 3.4, 3.0)), front)
            knit = g.mix(g.add(weave(g, x, z, 9.0), 0.5), rgb(*balaclava), rgb(balaclava[0] * 1.6, balaclava[1] * 1.6, balaclava[2] * 1.6))
            col = g.mix(slit, knit, col)
        return col, 0.7
    return f


