# Builds the two player models (Terrorist, Counter-Terrorist).
#
#   blender -b --factory-startup -P art/blender/build_characters.py
#
# -> web/public/assets/models/soldier_t.glb, soldier_ct.glb
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


from prims import PARTS, box, limb, cyl, dome, mat, n3, weave, cloth, camo, webbing, plain, face


# ------------------------------------------------------------------ body

def build_body(team):
    PARTS.clear()
    t = team == 'T'
    M = {}
    if t:
        M['top'] = mat('jacket', cloth((0.44, 0.38, 0.27), (0.25, 0.21, 0.15), seed=1))
        M['legs'] = mat('pants', camo((0.64, 0.56, 0.42), (0.50, 0.42, 0.30), (0.36, 0.30, 0.22), (0.22, 0.19, 0.15), seed=2))
        M['rig'] = mat('rig', webbing((0.40, 0.36, 0.24)))
        M['head'] = mat('face', face((0.72, 0.55, 0.42), balaclava=(0.09, 0.09, 0.09)))
        M['hat'] = mat('wrap', cloth((0.55, 0.47, 0.35), (0.35, 0.29, 0.21), scale=0.3, seed=4))
    else:
        M['top'] = mat('shirt', camo((0.34, 0.38, 0.44), (0.24, 0.27, 0.33), (0.45, 0.48, 0.52), (0.14, 0.15, 0.18), scale=0.11, seed=5))
        M['legs'] = mat('pants', camo((0.34, 0.38, 0.44), (0.24, 0.27, 0.33), (0.45, 0.48, 0.52), (0.14, 0.15, 0.18), scale=0.11, seed=6))
        M['rig'] = mat('vest', webbing((0.13, 0.15, 0.18)))
        M['head'] = mat('face', face((0.80, 0.62, 0.50)))
        M['hat'] = mat('helmet', plain((0.14, 0.17, 0.20), rough=0.55, grit=0.35))
    M['boots'] = mat('boots', plain((0.13, 0.10, 0.08) if t else (0.07, 0.07, 0.08), rough=0.6))
    M['gloves'] = mat('gloves', plain((0.08, 0.08, 0.08), rough=0.7))
    M['belt'] = mat('belt', plain((0.18, 0.15, 0.10), rough=0.6))

    # legs
    for s, x in (('L', -4.5), ('R', 4.5)):
        limb('thigh' + s, (x, 0, 36), (x, 0.5, 18.5), 7.0, 7.5, 'thigh.' + s, M['legs'], taper=0.82)
        limb('shin' + s, (x, 0.5, 19.5), (x, -0.5, 3.5), 5.8, 6.2, 'shin.' + s, M['legs'], taper=0.85)
        limb('knee' + s, (x, 3.4, 21), (x, 3.4, 16.5), 4.6, 1.4, 'shin.' + s, M['rig'] if not t else M['legs'], bevel=0.3)
        box('boot' + s, (x, 1.8, 2.1), (6.4, 10.5, 4.2), 'foot.' + s, M['boots'], bevel=0.8, taper=(0.95, 0.8))
        box('cuff' + s, (x, -0.3, 5.5), (6.4, 6.6, 3.0), 'shin.' + s, M['boots'], bevel=0.4)

    # pelvis + belt
    box('pelvis', (0, 0, 37.5), (14.5, 9.0, 6.0), 'hips', M['legs'], bevel=0.8)
    box('belt', (0, 0, 40.4), (15.2, 9.6, 2.0), 'hips', M['belt'], bevel=0.3)
    box('buckle', (0, 4.9, 40.4), (2.2, 0.6, 1.6), 'hips', mat('buckle', plain((0.55, 0.5, 0.35), 0.4)), bevel=0.1)

    # torso: tapered, broader at the shoulders
    box('abdomen', (0, 0, 45), (14, 8.6, 9.5), 'spine', M['top'], bevel=0.8, taper=(1.08, 1.05))
    box('torso', (0, 0, 54.5), (15.5, 9.5, 10.5), 'chest', M['top'], bevel=1.0, taper=(1.1, 0.95))
    # vest / chest rig
    box('vest', (0, 0.4, 52), (16.2, 10.4, 12.5), 'chest', M['rig'], bevel=0.8, taper=(1.02, 0.96))
    for k, px in enumerate((-4.6, -1.5, 1.5, 4.6)):
        box(f'pouch{k}', (px, 5.9, 48.2), (2.7, 1.8, 4.2), 'spine', M['rig'], bevel=0.35)
    if t:
        limb('strapL', (-5, 5.2, 59), (4, 5.4, 45), 1.6, 0.6, 'chest', M['belt'], bevel=0.1)
        box('bag', (-6.5, -2, 40), (4, 6, 6), 'hips', M['hat'], bevel=0.8)
    else:
        box('backplate', (0, -5.3, 52.5), (12, 1.2, 11.5), 'chest', M['rig'], bevel=0.4)
        box('radio', (5.2, -6.2, 55), (3, 2.2, 5), 'chest', M['rig'], bevel=0.4)
        cyl('antenna', (5.8, -6.2, 57), (6.2, -6.8, 70), 0.25, 'chest', M['gloves'], verts=4)
    # shoulders
    for s, x in (('L', -8.4), ('R', 8.4)):
        box('shoulder' + s, (x, 0, 57.5), (5.4, 6.8, 5.2), 'chest', M['top'], bevel=1.0)

    # arms (rigid with chest): holding a rifle at the chest, muzzle forward (+Y)
    # right: shoulder -> elbow -> hand on the grip; left: -> the handguard
    limb('uarmR', (8.6, 0.5, 58), (9.8, 5.0, 48.5), 4.8, 4.8, 'chest', M['top'], taper=0.9)
    limb('farmR', (9.8, 5.0, 48.5), (4.2, 12.5, 49.5), 4.2, 4.0, 'chest', M['top'], taper=0.85)
    box('handR', (3.8, 13.4, 49.4), (3.4, 3.6, 3.8), 'chest', M['gloves'], bevel=0.6)
    limb('uarmL', (-8.6, 0.5, 58), (-8.8, 7.5, 50), 4.8, 4.8, 'chest', M['top'], taper=0.9)
    limb('farmL', (-8.8, 7.5, 50), (-1.0, 19.5, 51.3), 4.2, 4.0, 'chest', M['top'], taper=0.85)
    box('handL', (-0.4, 20.4, 51.3), (3.4, 3.6, 3.6), 'chest', M['gloves'], bevel=0.6)

    # neck + head
    cyl('neck', (0, 0, 59.5), (0, 0.4, 63.5), 2.6, 'head', M['head'], verts=8)
    box('head', (0, 0.5, 67.3), (7.6, 8.4, 9.2), 'head', M['head'], bevel=1.4, taper=(0.95, 0.95))
    box('nose', (0, 4.8, 66.6), (1.2, 1.2, 1.8), 'head', M['head'], bevel=0.3)
    if t:
        # shemagh wrap on top of the balaclava
        dome('wrap', (0, 0.3, 69.8), 4.6, 'head', M['hat'], scale=(1.02, 1.1, 0.75))
        limb('tail', (0, -3.8, 69), (0.6, -5.2, 61), 3.2, 0.8, 'head', M['hat'], bevel=0.2)
    else:
        dome('helmet', (0, 0.2, 69.4), 5.3, 'head', M['hat'], scale=(1.0, 1.08, 0.95), segs=12)
        box('brim', (0, 0.2, 69.4), (10.4, 11.2, 1.0), 'head', M['hat'], bevel=0.3)
        box('goggles', (0, 4.5, 71.2), (7.2, 1.2, 1.9), 'head', mat('goggles', plain((0.05, 0.07, 0.09), 0.2, 0.1)), bevel=0.3)
        box('nvgmount', (0, 5.0, 73.0), (1.8, 1.4, 1.4), 'head', M['gloves'], bevel=0.2)
    return M


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
    img.filepath_raw = os.path.join(OUT, f'soldier_{team.lower()}_tex.png')
    img.file_format = 'PNG'
    img.save()
    img.reload()

    final = bpy.data.materials.new('soldier_' + team)
    final.use_nodes = True
    nt = final.node_tree
    bsdf = nt.nodes['Principled BSDF']
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.image = img
    nt.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
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

def gait(arm_ob, name, frames, swing, knee, bob, crouch=False):
    new_action(arm_ob, name)
    n = 8
    for i in range(n + 1):
        f = 1 + i * frames / n
        ph = i / n * math.tau
        s = math.sin(ph)
        th = swing * s
        kl = knee * max(0.0, math.sin(ph + 1.2))
        kr = knee * max(0.0, -math.sin(ph + 1.2))
        base = {}
        if crouch:
            base = dict(hips_loc=(0, CROUCH_DROP + abs(math.cos(ph)) * bob, 0))
            pose(arm_ob, f, thigh_L=(CROUCH_THIGH - th * 0.5, 0, 0), shin_L=(CROUCH_SHIN + kl * 0.3, 0, 0), foot_L=(CROUCH_FOOT, 0, 0),
                 thigh_R=(CROUCH_THIGH + th * 0.5, 0, 0), shin_R=(CROUCH_SHIN + kr * 0.3, 0, 0), foot_R=(CROUCH_FOOT, 0, 0),
                 spine=(14, 0, 0), chest=(5, 0, 0), head=(-14, 0, 0), **base)
        else:
            base = dict(hips_loc=(0, abs(math.cos(ph)) * bob - bob * 0.5, 0))
            pose(arm_ob, f, thigh_L=(-th, 0, 0), shin_L=(kl, 0, 0), foot_L=(-kl * 0.3, 0, 0),
                 thigh_R=(th, 0, 0), shin_R=(kr, 0, 0), foot_R=(-kr * 0.3, 0, 0),
                 # counter-swing is a TWIST about the bone's own axis (Y), not a side lean
                 hips=(0, s * 5, 0), spine=(2, -s * 3, 0), chest=(1, -s * 3, 0), **base)


def build_actions(arm_ob):
    bpy.context.scene.render.fps = FPS
    # idle: breathing
    new_action(arm_ob, 'idle')
    for i, f in enumerate((1, 31, 61)):
        a = 1.2 if i == 1 else 0
        pose(arm_ob, f, spine=(a * 0.5, 0, 0), chest=(a, 0, 0), head=(-a, 0, 0), hips_loc=(0, 0, 0))
    gait(arm_ob, 'walk', 30, 22, 30, 1.0)
    gait(arm_ob, 'run', 20, 34, 55, 2.2)
    gait(arm_ob, 'crouch_walk', 30, 18, 20, 0.6, crouch=True)
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
    build_body(team)
    parts = list(PARTS)
    arm_ob = build_armature()
    body = skin(parts, arm_ob)
    bake_atlas(body, team)
    body.parent = arm_ob
    mod = body.modifiers.new('rig', 'ARMATURE')
    mod.object = arm_ob
    build_actions(arm_ob)
    tris = sum(len(p.vertices) - 2 for p in body.data.polygons)
    print(f'soldier_{team}: {tris} triangles')
    path = os.path.join(OUT, f'soldier_{team.lower()}.glb')
    bpy.ops.object.select_all(action='DESELECT')
    arm_ob.select_set(True); body.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=path, export_format='GLB', use_selection=True, export_yup=True,
        export_animations=True, export_animation_mode='NLA_TRACKS', export_skins=True,
        export_image_format='JPEG', export_jpeg_quality=88, export_def_bones=False,
        export_force_sampling=True, export_frame_step=1,
    )
    os.remove(os.path.join(OUT, f'soldier_{team.lower()}_tex.png'))
    print('wrote', path, f'{os.path.getsize(path) / 1024:.0f} KB')


for team in ('T', 'CT'):
    build(team)
