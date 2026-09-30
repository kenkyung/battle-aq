# Builds the player models: four skins per team (M19) + the hostage.
#
#   blender -b --factory-startup -P art/blender/build_characters.py [-- phoenix gign H ...]
#
# -> web/public/assets/models/skin_<name>.glb, hostage.glb
#
# Low-poly, CS 1.6-style: ~1.5k triangles each, rigidly skinned to an 11-bone
# rig (every part follows exactly one bone, like the GoldSrc models), textured
# by baking procedural cloth / camo / webbing / face materials into one 1024 px
# atlas. Clips: idle, walk, run, crouch_idle, crouch_walk, jump, death.
#
# Units are game units (1 u ~ 1 inch). Blender is Z-up and the model faces +Y,
# which the glTF exporter turns into three.js Y-up facing -Z (the game's yaw-0
# forward). The rest pose is already "rifle up", so the upper body only needs
# pitch at runtime (the client rotates `spine` and `chest`).

import os, sys, math
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy, bmesh
from mathutils import Vector, Matrix, Euler
from lib import G, reset_scene, rgb, new_image, bake, export_glb, PUBLIC

OUT = os.path.join(PUBLIC, 'models')
FPS = 30

BONES = {
    # name: (head, tail, parent)
    'root':    ((0, 0, 0), (0, 0, 8), None),
    'hips':    ((0, 0, 35), (0, 0, 40), 'root'),
    'spine':   ((0, 0, 40), (0, 0, 49), 'hips'),
    'chest':   ((0, 0, 49), (0, 0, 60), 'spine'),
    'head':    ((0, 0, 60), (0, 0, 72), 'chest'),
    'thigh.L': ((-4.5, 0, 35), (-4.5, 0.5, 19), 'hips'),
    'shin.L':  ((-4.5, 0.5, 19), (-4.5, -0.5, 3.5), 'thigh.L'),
    'foot.L':  ((-4.5, -0.5, 3.5), (-4.5, 6, 1), 'shin.L'),
    'thigh.R': ((4.5, 0, 35), (4.5, 0.5, 19), 'hips'),
    'shin.R':  ((4.5, 0.5, 19), (4.5, -0.5, 3.5), 'thigh.R'),
    'foot.R':  ((4.5, -0.5, 3.5), (4.5, 6, 1), 'shin.R'),
}

# arms are rigid with the chest in this rig (rifle held at the chest)


from prims import PARTS, box, limb, cyl, dome, capsule, n3, weave, cloth, camo, webbing, plain, face


# ------------------------------------------------------------------ materials
#
# Every material returns colour + roughness + a height signal; the height and
# a Cycles Bevel (rounded edges on the low-poly parts) are baked into a
# tangent-space normal map, so seams, weave, MOLLE loops and creases catch the
# light without extra triangles.

def material(name, build, height=None, bevel=0.35, bump=0.45):
    m = bpy.data.materials.new(name)
    g = G(m)
    co = g.objcoord()
    sep = g.node('ShaderNodeSeparateXYZ')
    g.nt.links.new(co, sep.inputs[0])
    x, y, z = sep.outputs[0], sep.outputs[1], sep.outputs[2]
    col, rough = build(g, co, x, y, z)
    bsdf = g.node('ShaderNodeBsdfPrincipled')
    g.put(bsdf.inputs['Base Color'], col)
    g.put(bsdf.inputs['Roughness'], rough)
    bev = g.node('ShaderNodeBevel', samples=8)
    bev.inputs['Radius'].default_value = bevel
    normal = bev.outputs['Normal']
    if height is not None:
        b = g.node('ShaderNodeBump')
        b.inputs['Strength'].default_value = bump
        b.inputs['Distance'].default_value = 0.04
        g.put(b.inputs['Height'], height(g, co, x, y, z))
        g.nt.links.new(normal, b.inputs['Normal'])
        normal = b.outputs['Normal']
    g.nt.links.new(normal, bsdf.inputs['Normal'])
    out = g.node('ShaderNodeOutputMaterial')
    g.nt.links.new(bsdf.outputs[0], out.inputs['Surface'])
    return m


def h_fabric(scale=0.35):
    """woven fabric + soft creases"""
    def h(g, co, x, y, z):
        folds = n3(g, co, scale, 3, 21, distort=0.8)
        return g.add(g.mul(weave(g, x, z, 6.0), 0.25), folds)
    return h


def h_molle(g, co, x, y, z):
    """horizontal webbing rows (MOLLE) with stitch dimples"""
    rows = g.smooth(g.absv(g.sin(g.mul(z, 2.4))), 0.15, 0.4)
    stitch = g.smooth(g.absv(g.sin(g.mul(x, 3.3))), 0.0, 0.25)
    return g.add(rows, g.mul(stitch, 0.2))


def h_knit(g, co, x, y, z):
    return g.add(g.mul(g.absv(g.sin(g.mul(x, 9.0))), 0.6), g.mul(g.absv(g.sin(g.mul(z, 12.0))), 0.4))


def h_grain(scale=1.2):
    def h(g, co, x, y, z):
        return n3(g, co, scale, 5, 31)
    return h


def h_tread(g, co, x, y, z):
    return g.smooth(g.absv(g.sin(g.mul(y, 2.2))), 0.3, 0.6)


# ------------------------------------------------------------------ body
#
# Blender coords: +Y forward, Z up, feet at 0, head top ~72. The hands stay at
# the grip points the client's weapon attachment expects (GRIP in remotes.js).

HAND_R = (3.8, 13.4, 49.4)
HAND_L = (-0.4, 20.4, 51.3)


def glove(tag, c, fwd, m, bone='chest'):
    """palm + four curled fingers + thumb around a grip running along +Y"""
    cx, cy, cz = c
    box('palm' + tag, (cx, cy, cz), (3.2, 3.4, 3.6), bone, m, bevel=0.6)
    side = 1 if tag == 'R' else -1
    for k in range(4):
        fy = cy + 1.4 - k * 0.95
        capsule(f'fing{tag}{k}', (cx - side * 1.2, fy, cz + 1.2), (cx - side * 2.0, fy, cz - 1.6), 0.5, bone, m, segs=6)
    capsule('thumb' + tag, (cx - side * 0.6, cy + 1.6, cz + 1.4), (cx - side * 1.6, cy + 3.0, cz + 1.0), 0.55, bone, m, segs=6)
    capsule('cuffg' + tag, (cx, cy - 2.4, cz), (cx, cy - 1.2, cz), 2.0, bone, m, segs=8)


# ------------------------------------------------------------------ skins (M19)
#
# Four looks per side, CS 1.6 style. Readability first: Terrorists wear warm /
# earth tones and soft headgear (wraps, beanies, hoods, headbands); CTs wear
# cool blues, greys and black with hard helmets or a gas mask and a plate
# carrier. Both carry a bright team armband on each upper arm (orange T,
# blue CT) that reads at any range.

ARMBAND = {'T': (0.95, 0.42, 0.06), 'CT': (0.10, 0.42, 0.95)}

SKINS = {
    # --- Terrorists
    'phoenix': dict(team='T', torso='jacket', head='wrap',
                    top=('cloth', (0.42, 0.37, 0.27), (0.24, 0.20, 0.14)),
                    legs=('camo', (0.62, 0.55, 0.42), (0.49, 0.41, 0.30), (0.35, 0.30, 0.22), (0.22, 0.19, 0.15)),
                    rig=(0.39, 0.36, 0.24), skin=(0.72, 0.55, 0.42), balaclava=(0.09, 0.09, 0.09),
                    hat=((0.58, 0.50, 0.37), (0.36, 0.30, 0.22)), boots=(0.14, 0.10, 0.08)),
    'leet':    dict(team='T', torso='leather', head='beanie',
                    top=('leather', (0.30, 0.16, 0.09), (0.16, 0.08, 0.05)),
                    legs=('cloth', (0.33, 0.27, 0.20), (0.20, 0.16, 0.11)),
                    rig=(0.22, 0.14, 0.09), skin=(0.70, 0.52, 0.40), balaclava=(0.34, 0.07, 0.05),
                    hat=((0.14, 0.12, 0.11), (0.08, 0.07, 0.07)), boots=(0.10, 0.07, 0.05)),
    'arctic':  dict(team='T', torso='parka', head='hood',
                    top=('cloth', (0.84, 0.83, 0.79), (0.64, 0.63, 0.59)),
                    legs=('camo', (0.86, 0.85, 0.82), (0.72, 0.71, 0.68), (0.54, 0.53, 0.50), (0.38, 0.37, 0.35)),
                    rig=(0.52, 0.44, 0.32), skin=(0.78, 0.60, 0.48), balaclava=None,
                    hat=((0.60, 0.48, 0.34), (0.40, 0.31, 0.21)), boots=(0.20, 0.15, 0.11)),
    'guerilla': dict(team='T', torso='tee', head='headband',
                    top=('cloth', (0.34, 0.33, 0.19), (0.21, 0.21, 0.12)),
                    legs=('camo', (0.36, 0.31, 0.18), (0.26, 0.27, 0.14), (0.18, 0.13, 0.08), (0.08, 0.07, 0.06)),
                    rig=(0.33, 0.26, 0.16), skin=(0.56, 0.39, 0.28), balaclava=None,
                    hat=((0.70, 0.12, 0.08), (0.45, 0.07, 0.05)), boots=(0.16, 0.11, 0.07)),
    # --- Counter-Terrorists
    'seal':    dict(team='CT', torso='plate', head='goggles',
                    top=('camo', (0.33, 0.37, 0.43), (0.23, 0.26, 0.32), (0.45, 0.48, 0.52), (0.14, 0.15, 0.18)),
                    legs=('camo', (0.33, 0.37, 0.43), (0.23, 0.26, 0.32), (0.45, 0.48, 0.52), (0.14, 0.15, 0.18)),
                    rig=(0.14, 0.16, 0.19), skin=(0.80, 0.62, 0.50), balaclava=None,
                    hat=(0.15, 0.18, 0.21), boots=(0.07, 0.07, 0.08)),
    'gsg9':    dict(team='CT', torso='plate', head='visor_up',
                    top=('cloth', (0.27, 0.33, 0.37), (0.17, 0.21, 0.24)),
                    legs=('cloth', (0.27, 0.33, 0.37), (0.17, 0.21, 0.24)),
                    rig=(0.09, 0.11, 0.13), skin=(0.82, 0.64, 0.52), balaclava=None,
                    hat=(0.22, 0.27, 0.30), boots=(0.06, 0.06, 0.07)),
    'sas':     dict(team='CT', torso='plate', head='gasmask',
                    top=('cloth', (0.08, 0.08, 0.10), (0.04, 0.04, 0.05)),
                    legs=('cloth', (0.08, 0.08, 0.10), (0.04, 0.04, 0.05)),
                    rig=(0.13, 0.14, 0.16), skin=(0.80, 0.62, 0.50), balaclava=(0.06, 0.06, 0.07),
                    hat=(0.06, 0.06, 0.07), boots=(0.05, 0.05, 0.05)),
    'gign':    dict(team='CT', torso='plate', head='faceshield',
                    top=('cloth', (0.12, 0.16, 0.30), (0.07, 0.09, 0.18)),
                    legs=('cloth', (0.12, 0.16, 0.30), (0.07, 0.09, 0.18)),
                    rig=(0.07, 0.09, 0.16), skin=(0.80, 0.62, 0.50), balaclava=(0.05, 0.06, 0.09),
                    hat=(0.09, 0.11, 0.20), boots=(0.05, 0.05, 0.06)),
}


def fabric(spec, seed, scale=None):
    kind, *cols = spec
    if kind == 'camo':
        return camo(*cols, scale=scale or (0.11 if cols[0][2] > cols[0][0] else 0.09), seed=seed)
    return cloth(*cols, seed=seed)


def build_body(name):
    PARTS.clear()
    S = SKINS[name]
    t = S['team'] == 'T'
    M = {}
    leather = S['top'][0] == 'leather'
    M['top'] = material('top', cloth(S['top'][1], S['top'][2], scale=0.25, seed=1) if leather else fabric(S['top'], 1),
                        h_grain(1.0) if leather else h_fabric(), bump=0.3 if leather else 0.45)
    M['legs'] = material('pants', fabric(S['legs'], 2), h_fabric(0.3))
    M['rig'] = material('rig', webbing(S['rig']), h_molle, bump=0.7)
    M['head'] = material('face', face(S['skin'], balaclava=S['balaclava']), h_knit if S['balaclava'] else h_grain(2.0),
                         bump=0.25 if S['balaclava'] else 0.1)
    M['skin'] = material('skin', face(S['skin']), h_grain(2.0), bump=0.1)
    if t:
        M['hat'] = material('hat', cloth(*S['hat'], scale=0.3, seed=4), h_knit if S['head'] == 'beanie' else h_fabric(0.6), bump=0.6)
        M['pad'] = M['legs']
    else:
        M['hat'] = material('helmet', plain(S['hat'], rough=0.55, grit=0.35), h_grain(0.8), bump=0.2, bevel=0.6)
        M['pad'] = material('pads', plain((0.07, 0.07, 0.08), rough=0.5), h_grain(1.5), bump=0.2, bevel=0.5)
    M['band'] = material('armband', plain(ARMBAND[S['team']], rough=0.6, grit=0.1), h_fabric(0.5), bump=0.3)
    M['boots'] = material('boots', plain(S['boots'], rough=0.55), h_grain(2.5), bump=0.25)
    M['sole'] = material('sole', plain((0.05, 0.05, 0.05), rough=0.9), h_tread, bump=0.8)
    M['gloves'] = material('gloves', plain((0.08, 0.08, 0.08), rough=0.65), h_grain(2.0), bump=0.3)
    M['belt'] = material('belt', plain((0.17, 0.14, 0.10), rough=0.6), h_molle, bump=0.3)
    M['metal'] = material('buckle', plain((0.5, 0.48, 0.42), 0.35), bevel=0.1)
    M['brass'] = material('brass', plain((0.62, 0.48, 0.20), 0.3, 0.1), bevel=0.1)
    M['black'] = material('black', plain((0.04, 0.045, 0.05), 0.35, 0.1), bevel=0.2)
    M['lens'] = material('lens', plain((0.05, 0.08, 0.1), 0.15, 0.05), bevel=0.2)
    torso, head = S['torso'], S['head']

    # ---- legs: rounded thigh/shin, knee, boots with sole + toe cap + laces
    for s, x in (('L', -4.5), ('R', 4.5)):
        o = -1 if s == 'L' else 1
        capsule('thigh' + s, (x, 0.2, 35.5), (x, 0.4, 20), 4.3, 'thigh.' + s, M['legs'], segs=10, r2=3.3)
        capsule('shin' + s, (x, 0.4, 19.5), (x, -0.3, 6.5), 3.3, 'shin.' + s, M['legs'], segs=10, r2=2.7)
        box('cargo' + s, (x + o * 4.0, 0.6, 27.5), (1.6, 5.2, 6.2), 'thigh.' + s, M['legs'], bevel=0.5)
        box('flap' + s, (x + o * 4.3, 0.6, 30.4), (1.4, 5.4, 1.4), 'thigh.' + s, M['legs'], bevel=0.3)
        if not t or torso == 'jacket':
            box('kneepad' + s, (x, 3.3, 19.2), (5.2, 1.8, 5.2), 'shin.' + s, M['pad'], bevel=0.7)
        box('boot' + s, (x, 1.6, 3.2), (6.0, 9.6, 4.4), 'foot.' + s, M['boots'], bevel=0.9, taper=(0.94, 0.82))
        dome('toe' + s, (x, 5.4, 1.2), 3.0, 'foot.' + s, M['boots'], scale=(1.0, 1.1, 1.0), segs=10)
        box('sole' + s, (x, 1.9, 0.6), (6.4, 11.4, 1.2), 'foot.' + s, M['sole'], bevel=0.3)
        box('upper' + s, (x, -0.2, 7.2), (6.2, 6.4, 4.8), 'shin.' + s, M['boots'], bevel=0.6)
        box('laces' + s, (x, 2.9, 6.4), (2.0, 0.6, 6.0), 'shin.' + s, M['black'], bevel=0.1)

    # ---- pelvis, belt, gear on the belt
    box('pelvis', (0, 0, 37.3), (14.2, 8.8, 6.4), 'hips', M['legs'], bevel=1.2)
    box('belt', (0, 0, 40.3), (15.0, 9.4, 2.2), 'hips', M['belt'], bevel=0.4)
    box('buckle', (0, 4.8, 40.3), (2.4, 0.7, 1.8), 'hips', M['metal'], bevel=0.15)
    box('dump', (-6.8, -2.2, 38.2), (2.6, 5.0, 5.4), 'hips', M['rig'], bevel=0.6)
    if not t:
        # drop-leg holster with a pistol in it on the right thigh
        box('holster', (8.9, 0.8, 29.5), (2.2, 5.0, 8.0), 'thigh.R', M['rig'], bevel=0.5)
        box('pgrip', (8.9, -0.8, 34.2), (1.6, 2.6, 3.2), 'thigh.R', M['black'], bevel=0.3)
        limb('legstrap', (8.9, 0.8, 26.5), (4.5, 4.3, 26.5), 1.4, 0.4, 'thigh.R', M['belt'], bevel=0.1)
    else:
        box('satchel', (7.3, -1.2, 36.5), (3.0, 6.2, 6.2), 'hips', M['hat'] if torso == 'jacket' else M['rig'], bevel=1.0)
    if torso == 'parka':
        # parka skirt hanging over the belt
        box('skirt', (0, 0, 39.0), (16.4, 10.6, 6.0), 'hips', M['top'], bevel=1.4, taper=(1.0, 1.05))

    # ---- torso: rounded abdomen + chest, broader at the shoulders
    bulk = 1.1 if torso == 'parka' else 1.0
    capsule('abdomen', (0, 0, 42.5), (0, 0, 47.5), 6.6 * bulk, 'spine', M['top'], segs=12)
    box('torso', (0, -0.2, 54.0), (15.4 * bulk, 9.4 * bulk, 10.6), 'chest', M['top'], bevel=2.0, taper=(1.08, 0.96))
    for s, x in (('L', -8.2), ('R', 8.2)):
        dome('delt' + s, (x * bulk, 0, 56.4), 3.4 * bulk, 'chest', M['top'], scale=(1.0, 1.1, 1.0), segs=12)
    box('collar', (0, -0.6, 59.6), (8.2, 7.0, 1.6 if torso != 'leather' else 3.2), 'chest', M['top'], bevel=0.6)
    if torso in ('jacket', 'parka'):
        # open jacket over a chest rig with AK mag pouches
        box('zipper', (0, 5.0 * bulk, 53.5), (0.6, 0.4, 10.5), 'chest', M['metal'], bevel=0.1)
        box('chestrig', (0, 4.8 * bulk, 49.5), (13.4, 2.4, 6.6), 'spine', M['rig'], bevel=0.6)
        for k, px in enumerate((-4.4, 0.0, 4.4)):
            box(f'akmag{k}', (px, 6.4 * bulk, 49.2), (3.4, 1.8, 5.8), 'spine', M['rig'], bevel=0.4)
            box(f'akflap{k}', (px, 6.5 * bulk, 52.4), (3.6, 2.0, 1.2), 'spine', M['rig'], bevel=0.3)
        limb('strapL', (-5.2, 4.7 * bulk, 59.2), (-4.2, 5.4 * bulk, 52.2), 1.7, 0.6, 'chest', M['rig'], bevel=0.1)
        limb('strapR', (5.2, 4.7 * bulk, 59.2), (4.2, 5.4 * bulk, 52.2), 1.7, 0.6, 'chest', M['rig'], bevel=0.1)
        limb('sling', (-6.5, 4.2 * bulk, 59), (6.8, 4.8 * bulk, 42), 1.3, 0.5, 'chest', M['belt'], bevel=0.1)
        box('backrig', (0, -5.4 * bulk, 49.5), (12.0, 1.4, 5.0), 'spine', M['rig'], bevel=0.4)
        if torso == 'jacket':
            capsule('shemagh', (-2.6, 0.5, 60.0), (2.6, 0.5, 60.0), 2.5, 'chest', M['hat'], segs=10)
    elif torso == 'leather':
        # closed leather jacket: lapels, zipper, shoulder holster under the left arm
        box('zipper', (0, 4.9, 52.5), (0.6, 0.4, 12.0), 'chest', M['metal'], bevel=0.1)
        for s, x in (('L', -2.6), ('R', 2.6)):
            limb('lapel' + s, (x * 1.6, 4.4, 59.6), (x * 0.4, 5.0, 54.0), 2.4, 0.5, 'chest', M['top'], bevel=0.2)
        limb('hstrap', (5.0, 4.6, 58.6), (-7.2, 3.0, 50.4), 1.3, 0.4, 'chest', M['belt'], bevel=0.1)
        box('shholster', (-7.8, 2.0, 50.4), (2.2, 5.2, 4.0), 'chest', M['belt'], bevel=0.4)
        box('shpistol', (-7.8, 1.0, 52.4), (1.6, 2.4, 2.6), 'chest', M['black'], bevel=0.3)
        box('hem', (0, 0, 44.0), (14.6, 9.4, 2.0), 'spine', M['top'], bevel=0.6)
    elif torso == 'tee':
        # olive tee, crossed ammo bandolier with brass rounds, bare forearms
        box('backrig', (0, -5.4, 49.5), (12.0, 1.4, 5.0), 'spine', M['rig'], bevel=0.4)
        limb('bando', (-6.8, 4.6, 59.2), (6.0, 5.4, 43.5), 2.6, 0.9, 'chest', M['rig'], bevel=0.2)
        for k in range(7):
            f = (k + 0.5) / 7
            px, pz = -6.8 + 12.8 * f, 59.2 - 15.7 * f
            box(f'round{k}', (px, 6.1 + 0.8 * f, pz), (1.0, 0.9, 2.2), 'chest', M['brass'], bevel=0.2)
        capsule('neckscarf', (-2.6, 0.5, 60.0), (2.6, 0.5, 60.0), 2.3, 'chest', M['hat'], segs=10)
    else:
        # plate carrier: front + back plates, cummerbund, mags, admin, radio
        box('plateF', (0, 5.0, 52.6), (12.6, 2.6, 12.2), 'chest', M['rig'], bevel=0.9)
        box('plateB', (0, -5.4, 52.6), (12.6, 2.4, 12.6), 'chest', M['rig'], bevel=0.9)
        box('cummer', (0, 0, 46.3), (15.0, 10.0, 4.4), 'spine', M['rig'], bevel=0.8)
        for k, px in enumerate((-4.2, 0.0, 4.2)):
            box(f'mag{k}', (px, 7.0, 48.6), (3.2, 2.0, 5.6), 'chest', M['rig'], bevel=0.35)
            box(f'magtop{k}', (px, 7.1, 51.6), (3.0, 1.4, 0.8), 'chest', M['black'], bevel=0.2)
        box('admin', (0, 6.8, 55.4), (7.0, 1.4, 4.0), 'chest', M['rig'], bevel=0.3)
        box('patch', (0, 7.55, 56.0), (3.4, 0.2, 1.8), 'chest', M['band'], bevel=0.05)
        for s, x in (('L', -5.0), ('R', 5.0)):
            limb('shstrap' + s, (x, 4.0, 58.8), (x, -4.4, 58.8), 3.0, 1.2, 'chest', M['rig'], bevel=0.3)
        box('radio', (5.6, -7.0, 54.0), (3.0, 2.2, 5.6), 'chest', M['black'], bevel=0.4)
        cyl('antenna', (6.0, -7.0, 56.8), (6.5, -7.6, 69), 0.25, 'chest', M['black'], verts=5)
        box('hydro', (0, -7.6, 50.5), (9.0, 2.2, 11.0), 'chest', M['rig'], bevel=1.0)
        if name == 'gign':
            # big ballistic shoulder guards
            for s, x in (('L', -9.2), ('R', 9.2)):
                dome('guard' + s, (x, 0.2, 56.0), 4.0, 'chest', M['pad'], scale=(0.9, 1.2, 0.9), segs=10)

    # ---- arms (rigid with the chest: the rifle is held up, as in CS)
    fore = M['skin'] if torso == 'tee' else M['top']
    capsule('uarmR', (8.6, 0.3, 56.8), (9.8, 5.0, 48.8), 2.9 * bulk, 'chest', M['top'], segs=10, r2=2.5 * bulk)
    capsule('farmR', (9.8, 5.0, 48.8), (4.6, 11.0, 49.3), 2.5 * bulk, 'chest', fore, segs=10, r2=2.0)
    capsule('uarmL', (-8.6, 0.3, 56.8), (-8.8, 7.5, 50.2), 2.9 * bulk, 'chest', M['top'], segs=10, r2=2.5 * bulk)
    capsule('farmL', (-8.8, 7.5, 50.2), (-1.4, 18.0, 51.3), 2.5 * bulk, 'chest', fore, segs=10, r2=2.0)
    # team armbands, a third of the way down each upper arm
    capsule('bandR', (8.9, 1.6, 54.6), (9.2, 2.9, 52.4), 3.15 * bulk, 'chest', M['band'], segs=10)
    capsule('bandL', (-8.65, 2.0, 54.9), (-8.7, 3.8, 53.2), 3.15 * bulk, 'chest', M['band'], segs=10)
    if not t:
        dome('elbowR', (9.9, 4.6, 48.6), 2.4, 'chest', M['pad'], scale=(1.1, 0.8, 1.0), segs=8)
        dome('elbowL', (-9.0, 7.2, 49.9), 2.4, 'chest', M['pad'], scale=(1.1, 0.8, 1.0), segs=8)
    elif torso == 'tee':
        capsule('sleeveR', (8.9, 1.5, 55.0), (9.4, 3.2, 51.8), 3.1, 'chest', M['top'], segs=8)
        capsule('sleeveL', (-8.6, 2.0, 55.0), (-8.7, 4.2, 52.6), 3.1, 'chest', M['top'], segs=8)
    else:
        capsule('sleeveR', (6.2, 8.4, 49.2), (5.4, 9.5, 49.3), 2.35 * bulk, 'chest', M['top'], segs=8)
        capsule('sleeveL', (-4.2, 14.2, 51.0), (-3.2, 15.6, 51.1), 2.35 * bulk, 'chest', M['top'], segs=8)
    glove('R', HAND_R, (0, 1, 0), M['gloves'])
    glove('L', HAND_L, (0, 1, 0), M['gloves'])

    # ---- neck + head (the face shader paints features at these heights)
    capsule('neck', (0, 0, 59.5), (0, 0.4, 63.0), 2.5, 'head', M['head'], segs=10)
    dome('skull', (0, 0.4, 66.4), 4.2, 'head', M['head'], scale=(0.95, 1.08, 1.45), segs=16)
    box('jaw', (0, 1.1, 64.6), (5.6, 6.0, 4.0), 'head', M['head'], bevel=1.3, taper=(1.3, 1.15))
    box('nose', (0, 4.9, 66.5), (1.2, 1.3, 1.9), 'head', M['head'], bevel=0.4, taper=(0.8, 0.6))
    for s, x in (('L', -4.0), ('R', 4.0)):
        box('ear' + s, (x, 0.2, 66.8), (0.8, 1.8, 2.6), 'head', M['head'], bevel=0.3)
    if head == 'wrap':
        dome('wrap', (0, 0.3, 69.4), 4.7, 'head', M['hat'], scale=(1.02, 1.12, 0.8), segs=14)
        capsule('band', (-4.2, 0.3, 69.2), (4.2, 0.3, 69.2), 1.2, 'head', M['hat'], segs=8)
        limb('tail', (0, -3.9, 68.6), (0.8, -5.6, 60.5), 3.0, 0.8, 'head', M['hat'], bevel=0.2)
    elif head == 'beanie':
        dome('beanie', (0, 0.2, 69.2), 4.8, 'head', M['hat'], scale=(1.0, 1.1, 1.0), segs=14)
        capsule('cuff', (-4.3, 0.2, 69.3), (4.3, 0.2, 69.3), 1.4, 'head', M['hat'], segs=8)
        box('shades', (0, 4.7, 70.4), (6.4, 1.0, 1.2), 'head', M['lens'], bevel=0.3)
    elif head == 'hood':
        # fur-trimmed parka hood around the face, snow goggles
        dome('hood', (0, -1.2, 67.6), 5.4, 'head', M['top'], scale=(1.12, 1.05, 1.3), segs=14)
        box('hoodback', (0, -3.6, 63.8), (10.4, 4.0, 7.0), 'head', M['top'], bevel=1.6)
        for s, x in (('L', -4.9), ('R', 4.9)):
            capsule('fur' + s, (x, 2.8, 62.6), (x * 0.9, 2.8, 70.8), 1.5, 'head', M['hat'], segs=8)
        capsule('furtop', (-4.4, 2.6, 71.6), (4.4, 2.6, 71.6), 1.5, 'head', M['hat'], segs=8)
        box('goggles', (0, 4.3, 68.0), (7.2, 0.9, 1.7), 'head',
            material('amber', plain((0.36, 0.20, 0.05), 0.12, 0.05), bevel=0.2), bevel=0.4)
        box('gstrap', (0, 0.3, 68.0), (9.6, 8.4, 0.6), 'head', M['black'], bevel=0.1)
    elif head == 'headband':
        M['hair'] = material('hair', plain((0.07, 0.05, 0.04), rough=0.9, grit=0.5), h_knit, bump=0.4)
        dome('hair', (0, 0.0, 68.8), 4.6, 'head', M['hair'], scale=(1.0, 1.12, 0.9), segs=14)
        box('beard', (0, 2.6, 63.8), (5.8, 3.6, 3.2), 'head', M['hair'], bevel=1.2, taper=(0.9, 0.8))
        capsule('hband', (-4.5, 0.2, 69.4), (4.5, 0.2, 69.4), 1.1, 'head', M['hat'], segs=8)
        limb('knot', (0, -4.4, 69.2), (0.6, -6.2, 66.0), 1.4, 0.4, 'head', M['hat'], bevel=0.2)
    else:
        # CT: hard helmet (the SAS wear a black hood under theirs is replaced
        # by the gas mask look)
        if head != 'gasmask':
            dome('helmet', (0, 0.1, 68.4), 5.4 if head != 'faceshield' else 5.8, 'head', M['hat'], scale=(1.0, 1.1, 0.98), segs=16)
            for s, x in (('L', -5.3), ('R', 5.3)):
                box('rail' + s, (x * 0.93, 0.4, 69.6), (0.5, 5.0, 1.0), 'head', M['black'], bevel=0.15)
                cyl('earcup' + s, (x * 0.88, 0.2, 66.4), (x * 1.08, 0.2, 66.4), 2.1, 'head', M['black'], verts=12)
                limb('chin' + s, (x * 0.8, 0.6, 64.8), (0, 3.2, 62.2), 0.8, 0.4, 'head', M['black'], bevel=0.05)
        else:
            dome('hoodcap', (0, 0.1, 68.2), 4.9, 'head', M['head'], scale=(1.0, 1.1, 1.05), segs=14)
            capsule('maskstrap', (-4.6, 0.0, 68.6), (4.6, 0.0, 68.6), 0.6, 'head', M['black'], segs=6)
        if head == 'goggles':
            box('goggles', (0, 5.1, 70.6), (7.0, 1.4, 1.9), 'head', M['lens'], bevel=0.4)
            box('gstrap', (0, 0.3, 70.4), (9.9, 10.9, 0.7), 'head', M['black'], bevel=0.1)
            box('nvgmount', (0, 5.5, 72.2), (2.2, 1.2, 1.6), 'head', M['black'], bevel=0.3)
        elif head == 'visor_up':
            box('visor', (0, 4.6, 72.4), (9.0, 1.2, 3.0), 'head',
                material('smoke', plain((0.12, 0.16, 0.18), 0.1, 0.05), bevel=0.2), bevel=0.4)
            for s, x in (('L', -4.9), ('R', 4.9)):
                cyl('pivot' + s, (x * 0.95, 1.6, 70.2), (x * 1.08, 1.6, 70.2), 0.9, 'head', M['black'], verts=8)
        elif head == 'faceshield':
            box('shield', (0, 5.5, 67.6), (8.8, 0.6, 5.6), 'head',
                material('clear', plain((0.10, 0.15, 0.21), 0.06, 0.02), bevel=0.2), bevel=0.5, taper=(1.0, 0.85))
            box('brim', (0, 5.0, 70.8), (10.2, 2.0, 1.2), 'head', M['hat'], bevel=0.4)
        elif head == 'gasmask':
            box('mask', (0, 4.6, 65.8), (6.6, 2.0, 5.6), 'head', M['black'], bevel=1.2, taper=(0.85, 0.8))
            for s, x in (('L', -1.8), ('R', 1.8)):
                cyl('eye' + s, (x, 5.2, 67.8), (x, 6.0, 67.8), 1.35, 'head', M['lens'], verts=12)
            cyl('filter', (0.8, 5.4, 64.0), (2.2, 8.2, 63.0), 1.7, 'head', M['black'], verts=12)
    return M


def build_civilian():
    """Hostage: office worker, white shirt + tie, slacks, dress shoes, hands
    zip-tied in front (arms rigid with the chest, like the soldiers')."""
    PARTS.clear()
    M = {}
    M['shirt'] = material('shirt', cloth((0.86, 0.86, 0.84), (0.66, 0.67, 0.68), scale=0.2, seed=41), h_fabric(0.5), bump=0.6)
    M['legs'] = material('slacks', cloth((0.26, 0.27, 0.30), (0.16, 0.17, 0.19), scale=0.2, seed=42), h_fabric(0.4))
    M['tie'] = material('tie', cloth((0.45, 0.10, 0.12), (0.30, 0.06, 0.08), scale=0.5, seed=43), bevel=0.1)
    M['shoes'] = material('shoes', plain((0.12, 0.07, 0.04), rough=0.35, grit=0.15), h_grain(2.0), bump=0.15)
    M['head'] = material('face', face((0.78, 0.60, 0.48)), h_grain(2.0), bump=0.1)
    M['hair'] = material('hair', plain((0.42, 0.40, 0.38), rough=0.9, grit=0.5), h_knit, bump=0.4)
    M['belt'] = material('belt', plain((0.10, 0.07, 0.05), rough=0.4), bevel=0.2)
    M['skin'] = M['head']
    M['tieW'] = material('zip', plain((0.9, 0.9, 0.88), 0.5), bevel=0.05)
    for s, x in (('L', -4.3), ('R', 4.3)):
        capsule('thigh' + s, (x, 0.2, 35.5), (x, 0.4, 20), 4.0, 'thigh.' + s, M['legs'], segs=10, r2=3.2)
        capsule('shin' + s, (x, 0.4, 19.5), (x, -0.3, 4.5), 3.1, 'shin.' + s, M['legs'], segs=10, r2=2.8)
        box('shoe' + s, (x, 1.8, 1.8), (4.6, 9.8, 3.4), 'foot.' + s, M['shoes'], bevel=1.1, taper=(0.9, 0.75))
    box('pelvis', (0, 0, 37.3), (13.6, 8.4, 6.4), 'hips', M['legs'], bevel=1.2)
    box('belt', (0, 0, 40.2), (14.2, 8.8, 1.6), 'hips', M['belt'], bevel=0.3)
    capsule('abdomen', (0, 0, 42.5), (0, 0, 47.5), 6.4, 'spine', M['shirt'], segs=12)
    box('torso', (0, -0.2, 54.0), (14.4, 8.8, 10.6), 'chest', M['shirt'], bevel=2.2, taper=(1.06, 0.96))
    for s, x in (('L', -7.6), ('R', 7.6)):
        dome('delt' + s, (x, 0, 56.4), 3.1, 'chest', M['shirt'], scale=(1.0, 1.1, 1.0), segs=12)
    box('collarH', (0, 0.4, 59.8), (6.4, 6.4, 1.6), 'chest', M['shirt'], bevel=0.5)
    box('knot', (0, 4.2, 58.6), (1.4, 0.8, 1.4), 'chest', M['tie'], bevel=0.3)
    box('tie', (0, 4.7, 53.0), (2.0, 0.4, 10.0), 'chest', M['tie'], bevel=0.2, taper=(0.7, 1.0))
    for k, zz in enumerate((56.0, 52.0, 48.0, 44.0)):
        box(f'button{k}', (1.6, 4.5 if zz > 46 else 6.2, zz), (0.5, 0.3, 0.5), 'chest' if zz > 46 else 'spine', M['tieW'], bevel=0.05)
    # arms down, forearms forward, wrists tied together at the belly
    capsule('uarmR', (7.8, 0.0, 56.8), (8.8, 2.0, 46.5), 2.6, 'chest', M['shirt'], segs=10, r2=2.3)
    capsule('farmR', (8.8, 2.0, 46.5), (1.8, 7.8, 43.0), 2.3, 'chest', M['shirt'], segs=10, r2=1.9)
    capsule('uarmL', (-7.8, 0.0, 56.8), (-8.8, 2.0, 46.5), 2.6, 'chest', M['shirt'], segs=10, r2=2.3)
    capsule('farmL', (-8.8, 2.0, 46.5), (-1.8, 7.8, 43.0), 2.3, 'chest', M['shirt'], segs=10, r2=1.9)
    box('handR', (1.4, 8.6, 42.6), (2.4, 3.2, 3.4), 'chest', M['skin'], bevel=0.9)
    box('handL', (-1.4, 8.6, 42.6), (2.4, 3.2, 3.4), 'chest', M['skin'], bevel=0.9)
    box('ziptie', (0, 7.4, 43.2), (5.8, 2.6, 0.7), 'chest', M['tieW'], bevel=0.1)
    capsule('neck', (0, 0, 59.5), (0, 0.4, 63.0), 2.4, 'head', M['head'], segs=10)
    dome('skull', (0, 0.4, 66.4), 4.1, 'head', M['head'], scale=(0.95, 1.08, 1.45), segs=16)
    box('jaw', (0, 1.1, 64.6), (5.4, 5.8, 4.0), 'head', M['head'], bevel=1.3, taper=(1.3, 1.15))
    box('nose', (0, 4.8, 66.5), (1.2, 1.4, 2.0), 'head', M['head'], bevel=0.4, taper=(0.8, 0.6))
    for s, x in (('L', -3.9), ('R', 3.9)):
        box('ear' + s, (x, 0.2, 66.8), (0.8, 1.8, 2.6), 'head', M['head'], bevel=0.3)
        box('side' + s, (x * 0.98, -0.8, 68.4), (1.0, 6.0, 3.0), 'head', M['hair'], bevel=0.5)
    box('back', (0, -3.6, 68.0), (7.4, 1.4, 4.0), 'head', M['hair'], bevel=0.6)
    box('glasses', (0, 4.35, 67.8), (6.0, 0.4, 1.4), 'head', material('frames', plain((0.06, 0.06, 0.06), 0.3), bevel=0.05), bevel=0.1)
    return M


def mat_flag():
    def f(g, co, x, y, z):
        stripes = g.smooth(g.fract(g.mul(z, 1.4)), 0.45, 0.55)
        return g.mix(stripes, rgb(0.55, 0.12, 0.10), rgb(0.85, 0.83, 0.78)), 0.8
    return material('flag', f, bevel=0.05)


# ------------------------------------------------------------------ rig + skin

def build_armature():
    arm = bpy.data.armatures.new('rig')
    ob = bpy.data.objects.new('soldier', arm)
    bpy.context.scene.collection.objects.link(ob)
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.mode_set(mode='EDIT')
    for name, (h, tl, parent) in BONES.items():
        b = arm.edit_bones.new(name)
        b.head, b.tail = h, tl
        b.roll = 0
        if parent:
            b.parent = arm.edit_bones[parent]
            b.use_connect = False
    bpy.ops.object.mode_set(mode='OBJECT')
    return ob


def skin(parts, arm_ob):
    """Join every part into one mesh, each part weighted 100% to its bone."""
    for ob, bone in parts:
        vg = ob.vertex_groups.new(name=bone)
        vg.add(list(range(len(ob.data.vertices))), 1.0, 'REPLACE')
    bpy.ops.object.select_all(action='DESELECT')
    for ob, _ in parts:
        ob.select_set(True)
    bpy.context.view_layer.objects.active = parts[0][0]
    bpy.ops.object.join()
    body = bpy.context.view_layer.objects.active
    body.name = 'body'
    # flat-ish shading reads better at this polycount (CS models were faceted)
    bpy.ops.object.shade_auto_smooth(angle=math.radians(35))
    return body


def bake_atlas(body, team):
    """Bake every procedural material into one texture, then swap them for a
    single image material."""
    bpy.context.view_layer.objects.active = body
    body.select_set(True)
    atlas_uv = body.data.uv_layers.new(name='UVMap')
    body.data.uv_layers.active = atlas_uv
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.01)
    bpy.ops.uv.pack_islands(margin=0.01, rotate=True)
    bpy.ops.object.mode_set(mode='OBJECT')
    img = new_image('soldier_' + team, 1024)
    bake(body, 'DIFFUSE', img, samples=8, margin=8)
    img.pack()
    nrm = new_image('soldier_n_' + team, 1024, non_color=True)
    bake(body, 'NORMAL', nrm, samples=8, margin=8)
    nrm.pack()

    final = bpy.data.materials.new('soldier_' + team)
    final.use_nodes = True
    nt = final.node_tree
    bsdf = nt.nodes['Principled BSDF']
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.image = img
    nt.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
    t_n = nt.nodes.new('ShaderNodeTexImage'); t_n.image = nrm
    nm = nt.nodes.new('ShaderNodeNormalMap')
    nt.links.new(t_n.outputs['Color'], nm.inputs['Color'])
    nt.links.new(nm.outputs['Normal'], bsdf.inputs['Normal'])
    bsdf.inputs['Roughness'].default_value = 0.85
    body.data.materials.clear()
    body.data.materials.append(final)
    for p in body.data.polygons:
        p.material_index = 0


# ------------------------------------------------------------------ animation

def pose(arm_ob, frame, **rots):
    """rots: bone=(rx, ry, rz) in degrees, or bone_loc=(x,y,z)."""
    for key, val in rots.items():
        if key.endswith('_loc'):
            pb = arm_ob.pose.bones[key[:-4].replace('_', '.')]
            pb.location = val
            pb.keyframe_insert('location', frame=frame)
        else:
            pb = arm_ob.pose.bones[key.replace('_', '.')]
            pb.rotation_mode = 'XYZ'
            # Sign convention for the poses below: +X leans the torso FORWARD,
            # -X swings a thigh FORWARD and +X bends a knee back. Blender's
            # bone axes run the other way, hence the flip.
            pb.rotation_euler = [math.radians(-a if i == 0 else a) for i, a in enumerate(val)]
            pb.keyframe_insert('rotation_euler', frame=frame)


def clear_pose(arm_ob):
    for pb in arm_ob.pose.bones:
        pb.rotation_mode = 'XYZ'
        pb.rotation_euler = (0, 0, 0)
        pb.location = (0, 0, 0)


# Crouch: hips drop 19 u (hips at 16), thighs nearly horizontal, shins back
# to the ground. Head top ends near 48 u (the server's crouched hit box).
CROUCH_DROP, CROUCH_THIGH, CROUCH_SHIN, CROUCH_FOOT = -19, -85, 129, -44

ALL = ['root', 'hips', 'spine', 'chest', 'head', 'thigh.L', 'shin.L', 'foot.L', 'thigh.R', 'shin.R', 'foot.R']


def key_rest(arm_ob, frame):
    for b in ALL:
        pb = arm_ob.pose.bones[b]
        pb.rotation_euler = (0, 0, 0)
        pb.keyframe_insert('rotation_euler', frame=frame)
        pb.location = (0, 0, 0)
        pb.keyframe_insert('location', frame=frame)


def new_action(arm_ob, name):
    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    arm_ob.animation_data_create()
    arm_ob.animation_data.action = act
    clear_pose(arm_ob)
    return act


# Bone-local axes: legs point down their bones, so a positive X rotation on a
# thigh swings the foot backwards; negative swings it forward. Bone locations
# are in bone-local space too (hips' Y axis is world up).

# Gait cycle (one clip = two steps). Phase 0: legs passing. The thigh swings
# forward while its knee is flexed (swing phase), lands nearly straight, and
# the hips are lowest when the legs are spread (contact) and highest while
# passing. The pelvis twists toward the forward leg and the chest counters
# it; the torso leans FORWARD a few degrees when running, never backwards or
# sideways. Stride per cycle ~ 2 x 2 x 35 x sin(swing): the client scales the
# playback rate by ground speed with these (STRIDE in remotes.js).
STRIDE = {}


def gait(arm_ob, name, frames, swing, knee, bob, lean=0.0, crouch=False):
    new_action(arm_ob, name)
    n = 16
    STRIDE[name] = round(4 * (16 if crouch else 35) * math.sin(math.radians(swing * (0.9 if crouch else 1))), 1)
    for i in range(n + 1):
        f = 1 + i * frames / n
        ph = i / n * math.tau
        s, c = math.sin(ph), math.cos(ph)
        # knee flex: big while the leg swings through, a little at contact
        kl = knee * max(0.0, c) ** 1.3 + 6 * max(0.0, -c)
        kr = knee * max(0.0, -c) ** 1.3 + 6 * max(0.0, c)
        drop = bob * 0.5 * math.cos(2 * ph)
        twist = dict(hips=(0, 6 * s, 0), spine=(lean * 0.6, -3 * s, 0), chest=(lean * 0.4, -3 * s, 0), head=(-lean, 0, 0))
        if crouch:
            pose(arm_ob, f, hips_loc=(0, CROUCH_DROP + drop * 0.5, 0),
                 thigh_L=(CROUCH_THIGH - swing * s, 0, 0), shin_L=(CROUCH_SHIN + kl * 0.25, 0, 0), foot_L=(CROUCH_FOOT, 0, 0),
                 thigh_R=(CROUCH_THIGH + swing * s, 0, 0), shin_R=(CROUCH_SHIN + kr * 0.25, 0, 0), foot_R=(CROUCH_FOOT, 0, 0),
                 hips=(0, 4 * s, 0), spine=(14, -2 * s, 0), chest=(5, -2 * s, 0), head=(-19, 0, 0))
        else:
            pose(arm_ob, f, hips_loc=(0, drop, 0),
                 thigh_L=(-swing * s - kl * 0.15, 0, 0), shin_L=(kl, 0, 0), foot_L=(-kl * 0.3 + 6 * s, 0, 0),
                 thigh_R=(swing * s - kr * 0.15, 0, 0), shin_R=(kr, 0, 0), foot_R=(-kr * 0.3 - 6 * s, 0, 0),
                 **twist)


def build_actions(arm_ob):
    bpy.context.scene.render.fps = FPS
    # idle: breathing
    new_action(arm_ob, 'idle')
    for i, f in enumerate((1, 31, 61)):
        a = 1.2 if i == 1 else 0
        pose(arm_ob, f, spine=(a * 0.5, 0, 0), chest=(a, 0, 0), head=(-a, 0, 0), hips_loc=(0, 0, 0))
    gait(arm_ob, 'walk', 30, 26, 38, 1.2, lean=1.5)
    gait(arm_ob, 'run', 18, 40, 70, 2.6, lean=7)
    gait(arm_ob, 'crouch_walk', 26, 28, 24, 0.8, crouch=True)
    print('STRIDE', STRIDE)
    new_action(arm_ob, 'crouch_idle')
    for f in (1, 31):
        pose(arm_ob, f, hips_loc=(0, CROUCH_DROP, 0), thigh_L=(CROUCH_THIGH, 0, 0), shin_L=(CROUCH_SHIN, 0, 0), foot_L=(CROUCH_FOOT, 0, 0),
             thigh_R=(CROUCH_THIGH + 10, 0, 0), shin_R=(CROUCH_SHIN - 10, 0, 0), foot_R=(CROUCH_FOOT, 0, 0),
             spine=(14, 0, 0), chest=(5, 0, 0), head=(-14, 0, 0))
    new_action(arm_ob, 'jump')
    for f in (1, 11):
        pose(arm_ob, f, thigh_L=(-45, 0, 0), shin_L=(70, 0, 0), thigh_R=(-10, 0, 0), shin_R=(40, 0, 0),
             spine=(4, 0, 0), hips_loc=(0, 0, 0))
    # death: knees buckle, fall backwards; root pivots at the feet
    new_action(arm_ob, 'death')
    pose(arm_ob, 1, root=(0, 0, 0), hips_loc=(0, 0, 0), spine=(0, 0, 0), chest=(0, 0, 0), head=(0, 0, 0),
         thigh_L=(0, 0, 0), shin_L=(0, 0, 0), thigh_R=(0, 0, 0), shin_R=(0, 0, 0))
    pose(arm_ob, 8, root=(0, 0, 0), hips_loc=(0, -6, 0), spine=(-12, 0, 8), chest=(-10, 0, 0), head=(20, 0, 0),
         thigh_L=(-25, 0, 0), shin_L=(50, 0, 0), thigh_R=(-15, 0, 0), shin_R=(35, 0, 0))
    pose(arm_ob, 20, root=(-84, 0, 6), hips_loc=(0, -4, 0), spine=(-8, 0, 10), chest=(-6, 0, -6), head=(25, 0, 12),
         thigh_L=(-35, 0, 0), shin_L=(40, 0, 0), thigh_R=(-5, 0, 0), shin_R=(10, 0, 0))
    pose(arm_ob, 26, root=(-90, 0, 6), hips_loc=(0, -2, 0), spine=(-4, 0, 10), chest=(-4, 0, -6), head=(10, 0, 20),
         thigh_L=(-30, 0, 0), shin_L=(35, 0, 0), thigh_R=(-5, 0, 0), shin_R=(8, 0, 0))
    # push every action to the NLA so the exporter writes them all
    arm_ob.animation_data.action = None
    for act in bpy.data.actions:
        tr = arm_ob.animation_data.nla_tracks.new()
        tr.name = act.name
        tr.strips.new(act.name, 1, act)
        tr.mute = True


def build(team):
    reset_scene()
    if team == 'H':
        build_civilian()
    else:
        build_body(team)
    parts = list(PARTS)
    arm_ob = build_armature()
    body = skin(parts, arm_ob)
    bake_atlas(body, team)
    # LOD: the same body decimated to ~35 %, sharing the atlas and the
    # skin weights; the client swaps it in at distance (M17)
    lod = body.copy()
    lod.data = body.data.copy()
    lod.name = 'body_lod'
    bpy.context.scene.collection.objects.link(lod)
    dec = lod.modifiers.new('lod', 'DECIMATE')
    dec.ratio = 0.35
    bpy.ops.object.select_all(action='DESELECT')
    bpy.context.view_layer.objects.active = lod
    lod.select_set(True)
    bpy.ops.object.modifier_apply(modifier='lod')
    for ob in (body, lod):
        ob.parent = arm_ob
        mod = ob.modifiers.new('rig', 'ARMATURE')
        mod.object = arm_ob
    build_actions(arm_ob)
    tris = sum(len(p.vertices) - 2 for p in body.data.polygons)
    ltris = sum(len(p.vertices) - 2 for p in lod.data.polygons)
    print(f'soldier_{team}: {tris} triangles (LOD {ltris})')
    path = os.path.join(OUT, 'hostage.glb' if team == 'H' else f'skin_{team}.glb')
    bpy.ops.object.select_all(action='DESELECT')
    arm_ob.select_set(True); body.select_set(True); lod.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=path, export_format='GLB', use_selection=True, export_yup=True,
        export_animations=True, export_animation_mode='NLA_TRACKS', export_skins=True,
        export_image_format='JPEG', export_jpeg_quality=88, export_def_bones=False,
        export_force_sampling=True, export_frame_step=1,
    )
    print('wrote', path, f'{os.path.getsize(path) / 1024:.0f} KB')


for team in (sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else None) or (*SKINS, 'H'):
    build(team)
