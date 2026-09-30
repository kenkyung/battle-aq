# Portraits for the appearance menu (M19): one small JPEG per skin.
#   blender -b --factory-startup -P art/blender/build_skin_portraits.py
# reads web/public/assets/models/skin_<id>.glb -> web/public/assets/ui/skins/<id>.jpg
import os, sys, math, bpy
from mathutils import Vector
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import PUBLIC

IDS = ['phoenix', 'leet', 'arctic', 'guerilla', 'seal', 'gsg9', 'sas', 'gign']
OUT = os.path.join(PUBLIC, 'ui', 'skins')
os.makedirs(OUT, exist_ok=True)

for sid in IDS:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scn = bpy.context.scene
    scn.render.engine = 'CYCLES'; scn.cycles.samples = 32; scn.cycles.use_denoising = True
    scn.view_settings.view_transform = 'Standard'
    scn.render.resolution_x, scn.render.resolution_y = 180, 250
    scn.render.image_settings.file_format = 'JPEG'; scn.render.image_settings.quality = 86
    bpy.ops.import_scene.gltf(filepath=os.path.join(PUBLIC, 'models', f'skin_{sid}.glb'))
    arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
    act = bpy.data.actions.get('idle') or next(a for a in bpy.data.actions if a.name.startswith('idle'))
    for t in arm.animation_data.nla_tracks: t.mute = True
    arm.animation_data.action = act
    scn.frame_set(1)
    for o in bpy.data.objects:
        if o.type == 'MESH' and 'lod' in o.name.lower(): o.hide_render = True
    # model is Y-up after import: feet at 0, head ~72 (gltf importer converts to Z-up)
    ctr = Vector((0, 0, 40))
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam')); scn.collection.objects.link(cam); scn.camera = cam
    cam.data.type = 'ORTHO'; cam.data.ortho_scale = 84
    d = Vector((-0.45, 1.0, 0.12)).normalized()
    cam.location = ctr + d * 300; cam.rotation_euler = (-d).to_track_quat('-Z', 'Y').to_euler()
    cam.data.clip_end = 2000
    sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN')); sun.data.energy = 3.8
    sun.rotation_euler = (math.radians(50), 0, math.radians(155)); scn.collection.objects.link(sun)
    w = bpy.data.worlds.new('w'); scn.world = w; w.use_nodes = True
    w.node_tree.nodes['Background'].inputs['Color'].default_value = (0.10, 0.11, 0.12, 1)
    scn.render.filepath = os.path.join(OUT, f'{sid}.jpg')
    bpy.ops.render.render(write_still=True)
    print('wrote', scn.render.filepath)
