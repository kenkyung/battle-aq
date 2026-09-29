# Review helper: tiles images into one PNG (2x2 repeats each, to show seams).
#   blender -b --factory-startup -P art/blender/contact_sheet.py -- out.png img1 img2 ...
import sys, os, bpy, numpy as np
a = sys.argv[sys.argv.index('--') + 1:]
out, files = a[0], a[1:]
cell = 256
cols = min(4, len(files)); rows = (len(files) + cols - 1) // cols
sheet = np.zeros((rows * cell, cols * cell, 4), dtype=np.float32); sheet[..., 3] = 1
for i, f in enumerate(files):
    img = bpy.data.images.load(f)
    w, h = img.size
    px = np.array(img.pixels[:], dtype=np.float32).reshape(h, w, 4)
    tile = np.tile(px, (2, 2, 1))
    step = tile.shape[0] // cell
    small = tile[::step, ::step][:cell, :cell]
    r, c = divmod(i, cols)
    y0 = (rows - 1 - r) * cell
    sheet[y0:y0 + cell, c * cell:(c + 1) * cell] = small
res = bpy.data.images.new('sheet', cols * cell, rows * cell)
res.pixels = sheet.ravel()
res.filepath_raw = out; res.file_format = 'PNG'; res.save()
