# Review helper: renders GLBs from a 3/4 view with Cycles.
#   blender -b --factory-startup -P art/blender/preview.py -- out.png file.glb[:action:frame] ...
# Several files are laid out side by side.
import sys, os, math, bpy
from mathutils import Vector
a = sys.argv[sys.argv.index('--') + 1:]
out, specs = a[0], a[1:]
bpy.ops.wm.read_factory_settings(use_empty=True)
scn = bpy.context.scene
scn.render.engine = 'CYCLES'; scn.cycles.samples = 24; scn.cycles.use_denoising = True
scn.view_settings.view_transform = 'Standard'
scn.render.resolution_x = 420 * len(specs); scn.render.resolution_y = 520
x = 0
tops = []
for spec in specs:
    parts = spec.split(':')
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=parts[0])
    new = [o for o in bpy.data.objects if o not in before]
    arm = next((o for o in new if o.type == 'ARMATURE'), None)
    if arm and len(parts) > 1 and arm.animation_data:
        print("ACTIONS", [ac.name for ac in bpy.data.actions])
        act = bpy.data.actions.get(parts[1]) or next((ac for ac in bpy.data.actions if ac.name.startswith(parts[1])), None)
        if act:
            for t in arm.animation_data.nla_tracks: t.mute = True
            arm.animation_data.action = act
        scn.frame_set(int(parts[2]) if len(parts) > 2 else 1)
    roots = [o for o in new if o.parent is None]
    for i, r in enumerate(roots):
        if len(roots) > 1:
            r.location.x += x + (i % 4) * 55
            r.location.z += -(i // 4) * 16
        else:
            r.location.x += x
    x += 60
bpy.context.view_layer.update()
mn = Vector((1e9,)*3); mx = Vector((-1e9,)*3)
for o in bpy.data.objects:
    if o.type == 'MESH':
        for c in o.bound_box:
            w = o.matrix_world @ Vector(c); mn = Vector(map(min, mn, w)); mx = Vector(map(max, mx, w))
ctr = (mn + mx) / 2; size = max(mx - mn)
cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam')); scn.collection.objects.link(cam); scn.camera = cam
cam.data.type = 'ORTHO'; cam.data.ortho_scale = size * 1.25
d = Vector(tuple(float(v) for v in os.environ.get('PREVIEW_DIR', '0.6,1.0,0.18').split(','))).normalized()
cam.location = ctr + d * size * 3; cam.rotation_euler = (-d).to_track_quat('-Z', 'Y').to_euler()
cam.data.clip_end = size * 10
sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN')); sun.data.energy = 3.5
sun.rotation_euler = (math.radians(50), 0, math.radians(30)); scn.collection.objects.link(sun)
w = bpy.data.worlds.new('w'); scn.world = w; w.use_nodes = True
w.node_tree.nodes['Background'].inputs['Color'].default_value = (0.35, 0.38, 0.42, 1)
scn.render.filepath = out; bpy.ops.render.render(write_still=True)
