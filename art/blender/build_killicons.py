# Kill-feed weapon icons, CS style: a flat silhouette of every gun seen
# from the side, rendered from weapons.glb into one atlas.
#   blender -b --factory-startup -P art/blender/build_killicons.py
# -> web/public/assets/ui/killicons.png + killicons.json ({ id: [x, y, w, h] })

import os, sys, json, math
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy
from mathutils import Vector
from lib import PUBLIC, reset_scene

IDS = ['knife', 'glock', 'usp', 'p228', 'deagle', 'elites', 'fiveseven', 'm3', 'xm1014', 'mp5', 'tmp', 'mac10', 'ump45', 'p90',
       'galil', 'famas', 'ak47', 'm4a1', 'scout', 'sg552', 'aug', 'awp', 'g3sg1', 'sg550', 'm249', 'hegrenade', 'flashbang',
       'smokegrenade', 'c4', 'm4a1_s', 'usp_s']
CELL_W, CELL_H, COLS = 192, 64, 4
OUT = os.path.join(PUBLIC, 'ui')

reset_scene()
bpy.ops.import_scene.gltf(filepath=os.path.join(PUBLIC, 'models', 'weapons.glb'))
scn = bpy.context.scene
scn.render.engine = 'BLENDER_WORKBENCH'
sh = scn.display.shading
sh.light = 'FLAT'; sh.color_type = 'SINGLE'; sh.single_color = (1, 1, 1)
sh.show_object_outline = False
scn.render.film_transparent = True
scn.view_settings.view_transform = 'Standard'
scn.render.resolution_x, scn.render.resolution_y = CELL_W, CELL_H
cam_data = bpy.data.cameras.new('cam'); cam_data.type = 'ORTHO'
cam = bpy.data.objects.new('cam', cam_data); scn.collection.objects.link(cam); scn.camera = cam

roots = {o.name: o for o in bpy.data.objects if o.parent is None and o.type in ('MESH', 'EMPTY')}
rects, tiles = {}, []
os.makedirs(OUT, exist_ok=True)
for n, gid in enumerate(IDS):
    ob = roots.get(gid)
    if not ob:
        print('missing', gid); continue
    for o in bpy.data.objects:
        o.hide_render = True
    parts = [ob] + [c for c in ob.children_recursive]
    for o in parts:
        o.hide_render = False
    # hands parented to empties are not in weapons.glb roots: only gun meshes show
    mesh = [o for o in parts if o.type == 'MESH']
    pts = [o.matrix_world @ Vector(c) for o in mesh for c in o.bound_box]
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    c = (lo + hi) / 2
    # side view: look along -X at the gun's length (Blender Y) and height (Z), muzzle to the right
    L, H = hi.y - lo.y, hi.z - lo.z
    cam.location = (c.x + 100, c.y, c.z)
    cam.rotation_euler = (math.pi / 2, 0, math.pi / 2)
    cam_data.ortho_scale = max(L, H * CELL_W / CELL_H) * 1.08
    path = os.path.join(OUT, f'_ki_{gid}.png')
    scn.render.filepath = path
    bpy.ops.render.render(write_still=True)
    tiles.append((gid, path, n))

# atlas
rows = (len(tiles) + COLS - 1) // COLS
W, Hh = CELL_W * COLS, CELL_H * rows
atlas = bpy.data.images.new('killicons', W, Hh, alpha=True)
buf = [0.0] * (W * Hh * 4)
for gid, path, n in tiles:
    img = bpy.data.images.load(path)
    px = list(img.pixels)
    col, row = n % COLS, n // COLS
    ox, oy = col * CELL_W, (rows - 1 - row) * CELL_H          # Blender images are bottom-up
    for y in range(CELL_H):
        src = y * CELL_W * 4
        dst = ((oy + y) * W + ox) * 4
        buf[dst:dst + CELL_W * 4] = px[src:src + CELL_W * 4]
    rects[gid] = [col * CELL_W, row * CELL_H, CELL_W, CELL_H]
    os.remove(path)
atlas.pixels = buf
atlas.filepath_raw = os.path.join(OUT, 'killicons.png')
atlas.file_format = 'PNG'
atlas.save()
json.dump({'size': [W, Hh], 'icons': rects}, open(os.path.join(OUT, 'killicons.json'), 'w'))
print('wrote', os.path.join(OUT, 'killicons.png'), len(rects), 'icons')
