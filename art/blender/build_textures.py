# Bakes the tileable surface textures the maps use.
#
#   blender -b --factory-startup -P art/blender/build_textures.py -- [id ...]
#
# Each texture is a procedural Cycles node graph evaluated on a unit plane
# (UV 0..1) with torus-mapped 4D noise, so every result tiles seamlessly.
# Two maps per surface are baked to web/public/assets/tex/:
#   <id>.jpg     albedo (base colour)
#   <id>_n.jpg   tangent-space normal map (from the graph's height output)
# 512 px — CS 1.6 shipped 256 px wall textures, so this is ~4x the detail.

import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy
from lib import G, reset_scene, rgb, hexcol, new_image, bake, save_image, plane, args, PUBLIC

SIZE = 512
OUT = os.path.join(PUBLIC, 'tex')


# Each recipe: (g, u, v) -> (color, height, roughness)

def sandstone(g, u, v, cols=2, rows=4, base=(0.80, 0.70, 0.52), dark=0.62, seed=0):
    edge0, rnd, lu, lv = g.bricks(u, v, cols, rows, seed=seed)
    warp = g.noise(u, v, 18, detail=5, seed=seed + 9)
    edge = g.add(edge0, g.mul(g.sub(warp, 0.5), 0.05))   # ragged, hand-cut edges
    mortar = g.smooth(edge, 0.006, 0.03)                  # 0 in mortar, 1 on block
    bevel = g.smooth(edge, 0.0, 0.08)
    grain = g.noise(u, v, 26, detail=10, rough=0.65, seed=seed + 1)
    big = g.noise(u, v, 3, detail=4, seed=seed + 2)
    stain = g.smooth(g.noise(u, v, 2, 5, detail=6, seed=seed + 4), 0.5, 0.75)
    pits = g.voronoi(u, v, 36, seed=seed + 3)
    pit = g.smooth(pits, 0.08, 0.16)                     # 0 inside chips/pores
    chips = g.smooth(g.voronoi(u, v, 9, seed=seed + 5), 0.1, 0.2)
    lo = rgb(base[0] * 0.78, base[1] * 0.74, base[2] * 0.68)
    hi = rgb(min(1, base[0] * 1.1), min(1, base[1] * 1.07), min(1, base[2] * 1.02))
    tint = g.mix(g.add(g.mul(rnd, 0.7), g.mul(big, 0.3)), lo, hi)
    col = g.mix(g.lin(grain, 0.3, 0.72, 0.45, 0.0), tint, rgb(base[0] * 0.5, base[1] * 0.45, base[2] * 0.38))
    col = g.mix(g.mul(stain, 0.55), col, rgb(base[0] * 0.55, base[1] * 0.48, base[2] * 0.38))
    col = g.mix(g.sub(1.0, pit), col, rgb(base[0] * 0.42, base[1] * 0.37, base[2] * 0.3))
    col = g.mix(g.mul(g.sub(1.0, chips), 0.6), col, rgb(base[0] * 0.62, base[1] * 0.56, base[2] * 0.46))
    # worn, darker rims just inside the mortar
    col = g.mix(g.mul(g.sub(1.0, bevel), 0.45), col, rgb(base[0] * 0.6, base[1] * 0.54, base[2] * 0.44))
    mcol = rgb(base[0] * dark, base[1] * dark, base[2] * dark * 0.92)
    col = g.mix(mortar, mcol, col)
    height = g.add(g.mul(bevel, 0.65), g.mul(grain, 0.4))
    height = g.sub(height, g.mul(g.sub(1.0, pit), 0.25))
    height = g.sub(height, g.mul(g.sub(1.0, chips), 0.15))
    return col, height, 0.92


def big_blocks(g, u, v):
    return sandstone(g, u, v, cols=2, rows=3, base=(0.66, 0.56, 0.40), dark=0.55, seed=7)


def sand(g, u, v):
    n1 = g.noise(u, v, 6, detail=6, seed=11)
    n2 = g.noise(u, v, 48, detail=4, seed=12)
    peb = g.voronoi(u, v, 30, seed=13)
    pebm = g.smooth(peb, 0.12, 0.05)                  # 1 inside pebbles
    peb2 = g.voronoi(u, v, 70, seed=14)
    pebm2 = g.smooth(peb2, 0.1, 0.04)
    base = g.ramp(n1, [(0.25, rgb(0.62, 0.53, 0.37)), (0.55, rgb(0.74, 0.65, 0.47)), (0.8, rgb(0.80, 0.72, 0.54))])
    col = g.mix(g.lin(n2, 0.4, 0.75, 0.0, 0.4), base, rgb(0.55, 0.46, 0.32))
    pcol = g.mix(g.voronoi(u, v, 30, seed=13, out='Color'), rgb(0.55, 0.5, 0.42), rgb(0.85, 0.8, 0.7))
    col = g.mix(g.mul(pebm, 0.8), col, pcol)
    col = g.mix(g.mul(pebm2, 0.5), col, rgb(0.5, 0.43, 0.32))
    height = g.add(g.add(g.mul(n1, 0.3), g.mul(n2, 0.25)), g.add(g.mul(pebm, 0.6), g.mul(pebm2, 0.3)))
    return col, height, 0.97


def cobbles(g, u, v):
    edge = g.voronoi(u, v, 7, feature='DISTANCE_TO_EDGE', seed=21, rand=0.8)
    ccol = g.voronoi(u, v, 7, seed=21, out='Color', rand=0.8)
    stone = g.smooth(edge, 0.02, 0.06)
    dome = g.smooth(edge, 0.0, 0.18)
    grain = g.noise(u, v, 32, detail=6, seed=22)
    tint = g.bw(ccol)
    col = g.ramp(tint, [(0.0, rgb(0.42, 0.40, 0.37)), (0.5, rgb(0.55, 0.52, 0.47)), (1.0, rgb(0.62, 0.57, 0.50))])
    col = g.mix(g.lin(grain, 0.3, 0.7, 0.3, 0.0), col, rgb(0.3, 0.28, 0.25))
    col = g.mix(stone, rgb(0.22, 0.2, 0.17), col)
    height = g.add(g.mul(dome, 0.8), g.mul(grain, 0.2))
    return col, height, 0.9


def plaster(g, u, v):
    n = g.noise(u, v, 4, detail=6, seed=31)
    fine = g.noise(u, v, 40, detail=5, seed=32)
    patch = g.noise(u, v, 3, detail=4, rough=0.6, seed=33)
    hole = g.smooth(patch, 0.64, 0.68)                # 1 where plaster fell off
    rim = g.sub(g.smooth(patch, 0.60, 0.64), hole)
    edge, rnd, lu, lv = g.bricks(u, v, 6, 16, seed=34)
    brickm = g.smooth(edge, 0.03, 0.07)
    bcol = g.mix(rnd, rgb(0.52, 0.27, 0.18), rgb(0.66, 0.36, 0.24))
    bcol = g.mix(brickm, rgb(0.4, 0.36, 0.3), bcol)
    pcol = g.ramp(n, [(0.3, rgb(0.72, 0.64, 0.52)), (0.7, rgb(0.82, 0.75, 0.62))])
    pcol = g.mix(g.lin(fine, 0.45, 0.7, 0.0, 0.25), pcol, rgb(0.6, 0.52, 0.42))
    pcol = g.mix(g.mul(rim, 0.6), pcol, rgb(0.55, 0.48, 0.38))
    col = g.mix(hole, pcol, bcol)
    height = g.add(g.mul(g.sub(1.0, hole), 0.6), g.add(g.mul(brickm, g.mul(hole, 0.3)), g.mul(fine, 0.1)))
    return col, height, 0.93


def brick_red(g, u, v):
    edge, rnd, lu, lv = g.bricks(u, v, 7, 16, seed=41)
    m = g.smooth(edge, 0.03, 0.08)
    grain = g.noise(u, v, 28, detail=6, seed=42)
    col = g.ramp(rnd, [(0.0, rgb(0.46, 0.20, 0.13)), (0.5, rgb(0.60, 0.29, 0.19)), (1.0, rgb(0.70, 0.38, 0.26))])
    col = g.mix(g.lin(grain, 0.3, 0.7, 0.35, 0.0), col, rgb(0.3, 0.14, 0.1))
    col = g.mix(m, rgb(0.5, 0.46, 0.4), col)
    height = g.add(g.mul(g.smooth(edge, 0.0, 0.1), 0.7), g.mul(grain, 0.2))
    return col, height, 0.9


def planks(g, u, v, dark=False):
    boards = 6
    bu = g.mul(u, boards)
    idx = g.floor(bu)
    lu = g.fract(bu)
    rnd = g.white(idx, 1.0, 51.0)
    gap = g.smooth(g.mn(lu, g.sub(1.0, lu)), 0.01, 0.04)
    grain = g.noise(g.add(u, g.mul(rnd, 0.37)), v, 60, 3, detail=6, rough=0.6, distort=0.4, seed=52)
    ring = g.fract(g.mul(grain, 7.0))
    knots = g.voronoi(u, v, 9, 3, seed=53)
    knot = g.smooth(knots, 0.06, 0.02)
    if dark:
        lo, hi = rgb(0.30, 0.19, 0.11), rgb(0.45, 0.30, 0.18)
    else:
        lo, hi = rgb(0.47, 0.33, 0.20), rgb(0.66, 0.50, 0.33)
    col = g.mix(g.add(g.mul(rnd, 0.45), g.mul(g.smooth(ring, 0.2, 0.8), 0.55)), lo, hi)
    col = g.mix(g.mul(g.smooth(ring, 0.85, 1.0), 0.6), col, rgb(0.25, 0.15, 0.08))
    col = g.mix(g.mul(knot, 0.8), col, rgb(0.22, 0.14, 0.08))
    col = g.mix(gap, rgb(0.08, 0.05, 0.03), col)
    # nail heads near the ends of each board
    nail = g.mn(g.voronoi(u, v, boards, 2, seed=54), 1.0)
    nm = g.smooth(nail, 0.03, 0.015)
    col = g.mix(nm, col, rgb(0.2, 0.2, 0.2))
    height = g.add(g.mul(gap, 0.6), g.mul(ring, 0.12))
    return col, height, 0.85


def planks_dark(g, u, v):
    return planks(g, u, v, dark=True)


def crate(g, u, v):
    # one crate face per 0..1 (the maps UV crates per face, not world-tiled)
    f = 0.13
    du = g.mn(u, g.sub(1.0, u))
    dv = g.mn(v, g.sub(1.0, v))
    frame = g.sub(1.0, g.smooth(g.mn(du, dv), f - 0.008, f + 0.008))
    diag = g.sub(1.0, g.smooth(g.absv(g.sub(u, v)), f * 0.72 - 0.008, f * 0.72 + 0.008))
    top = g.mx(frame, diag)
    slats = g.fract(g.mul(v, 5.0))
    slat_gap = g.smooth(g.mn(slats, g.sub(1.0, slats)), 0.01, 0.035)
    grain = g.noise(u, g.mul(v, 1.0), 40, 5, detail=6, distort=0.3, seed=61)
    grain2 = g.noise(v, u, 40, 5, detail=6, distort=0.3, seed=62)
    wood_lo, wood_hi = rgb(0.45, 0.31, 0.17), rgb(0.62, 0.46, 0.28)
    back = g.mix(grain, wood_lo, wood_hi)
    back = g.mix(slat_gap, rgb(0.12, 0.08, 0.05), back)
    front = g.mix(grain2, rgb(0.55, 0.41, 0.24), rgb(0.72, 0.56, 0.36))
    col = g.mix(top, back, front)
    # outline shadows around the raised boards
    fe = g.smooth(g.absv(g.sub(g.mn(du, dv), f)), 0.0, 0.012)
    de = g.smooth(g.absv(g.sub(g.absv(g.sub(u, v)), f * 0.72)), 0.0, 0.012)
    col = g.mix(g.mul(g.sub(1.0, g.mul(fe, de)), 0.7), col, rgb(0.1, 0.07, 0.04))
    # corner bolts
    bolt = g.voronoi(g.mul(u, 0.5), g.mul(v, 0.5), 1, seed=0, rand=0.0)
    col = g.mix(g.smooth(bolt, 0.05, 0.035), col, rgb(0.25, 0.25, 0.25))
    height = g.add(g.mul(top, 0.8), g.mul(slat_gap, 0.3))
    return col, height, 0.8


def metal_plate(g, u, v):
    pu, pv = g.fract(g.mul(u, 2.0)), g.fract(g.mul(v, 2.0))
    seam = g.smooth(g.mn(g.mn(pu, g.sub(1.0, pu)), g.mn(pv, g.sub(1.0, pv))), 0.004, 0.012)
    # rivets along each plate edge
    ru = g.fract(g.mul(u, 12.0)); rv = g.fract(g.mul(v, 12.0))
    rdist = g.pw(g.add(g.pw(g.sub(ru, 0.5), 2.0), g.pw(g.sub(rv, 0.5), 2.0)), 0.5)
    near_edge = g.lt(g.mn(g.mn(pu, g.sub(1.0, pu)), g.mn(pv, g.sub(1.0, pv))), 0.05)
    rivet = g.mul(g.smooth(rdist, 0.22, 0.15), near_edge)
    n = g.noise(u, v, 5, detail=6, seed=71)
    rust = g.mul(g.smooth(g.noise(u, v, 4, detail=8, rough=0.65, seed=72), 0.7, 0.85), 0.75)
    scratch = g.noise(u, v, 90, 6, detail=3, seed=73)
    sc = g.smooth(scratch, 0.8, 0.9)
    col = g.mix(n, rgb(0.33, 0.36, 0.34), rgb(0.43, 0.46, 0.44))
    col = g.mix(g.mul(sc, 0.5), col, rgb(0.62, 0.64, 0.62))
    col = g.mix(rust, col, g.mix(n, rgb(0.30, 0.17, 0.09), rgb(0.44, 0.26, 0.13)))
    col = g.mix(g.sub(1.0, seam), col, rgb(0.08, 0.08, 0.08))
    col = g.mix(rivet, col, rgb(0.55, 0.56, 0.55))
    height = g.add(g.add(g.mul(seam, 0.5), g.mul(rivet, 0.6)), g.mul(rust, 0.15))
    rough = g.lin(rust, 0.0, 1.0, 0.45, 0.9)
    return col, height, rough


def jungle_ground(g, u, v):
    n = g.noise(u, v, 5, detail=6, seed=81)
    grass = g.smooth(g.noise(u, v, 3, detail=5, seed=82), 0.45, 0.6)
    blades = g.noise(u, v, 160, 30, detail=2, seed=83)
    peb = g.smooth(g.voronoi(u, v, 26, seed=84), 0.1, 0.04)
    dirt = g.ramp(n, [(0.3, rgb(0.36, 0.30, 0.22)), (0.7, rgb(0.50, 0.42, 0.31))])
    gr = g.mix(blades, rgb(0.23, 0.35, 0.15), rgb(0.40, 0.52, 0.24))
    col = g.mix(grass, dirt, gr)
    col = g.mix(g.mul(peb, g.sub(1.0, grass)), col, rgb(0.55, 0.52, 0.46))
    height = g.add(g.mul(n, 0.3), g.add(g.mul(g.mul(blades, grass), 0.4), g.mul(peb, 0.4)))
    return col, height, 0.97


def aztec_stone(g, u, v, carved=False):
    edge, rnd, lu, lv = g.bricks(u, v, 3 if not carved else 2, 4 if not carved else 3, seed=91)
    m = g.smooth(edge, 0.015, 0.04)
    bevel = g.smooth(edge, 0.0, 0.1)
    n = g.noise(u, v, 20, detail=7, seed=92)
    moss = g.smooth(g.noise(u, v, 3.5, detail=6, rough=0.6, seed=93), 0.55, 0.68)
    col = g.mix(rnd, rgb(0.50, 0.49, 0.44), rgb(0.64, 0.62, 0.55))
    col = g.mix(g.lin(n, 0.3, 0.7, 0.35, 0.0), col, rgb(0.32, 0.31, 0.28))
    height = g.add(g.mul(bevel, 0.7), g.mul(n, 0.25))
    if carved:
        # stepped-fret relief: concentric squares inside each block
        cu = g.absv(g.sub(lu, 0.5)); cv = g.absv(g.sub(lv, 0.5))
        ring = g.fract(g.mul(g.mx(cu, g.mul(cv, 1.0)), 6.0))
        relief = g.smooth(ring, 0.45, 0.55)
        col = g.mix(g.mul(relief, 0.35), col, rgb(0.36, 0.35, 0.31))
        height = g.add(height, g.mul(relief, 0.35))
    col = g.mix(g.mul(moss, 0.85), col, g.mix(n, rgb(0.20, 0.30, 0.13), rgb(0.33, 0.43, 0.2)))
    col = g.mix(m, rgb(0.24, 0.24, 0.2), col)
    return col, height, 0.93


def aztec_carved(g, u, v):
    return aztec_stone(g, u, v, carved=True)


def hedge(g, u, v):
    leaves = g.voronoi(u, v, 40, seed=101)
    lc = g.voronoi(u, v, 40, seed=101, out='Color')
    n = g.noise(u, v, 6, detail=5, seed=102)
    leaf = g.sub(1.0, g.smooth(leaves, 0.15, 0.75))
    col = g.mix(g.bw(lc), rgb(0.12, 0.25, 0.08), rgb(0.30, 0.48, 0.16))
    col = g.mix(g.lin(n, 0.3, 0.7), g.mix(0.5, col, rgb(0.05, 0.1, 0.03)), col)
    col = g.mix(leaf, rgb(0.04, 0.08, 0.02), col)
    height = g.add(g.mul(leaf, 0.7), g.mul(n, 0.3))
    return col, height, 1.0


def water(g, u, v):
    n = g.noise(u, v, 6, detail=4, distort=0.6, seed=111)
    r = g.noise(u, v, 18, 6, detail=3, seed=112)
    col = g.ramp(n, [(0.3, rgb(0.07, 0.24, 0.30)), (0.7, rgb(0.14, 0.38, 0.44))])
    col = g.mix(g.smooth(r, 0.62, 0.7, 0.0, 0.3), col, rgb(0.6, 0.75, 0.78))
    return col, g.add(g.mul(n, 0.5), g.mul(r, 0.3)), 0.1


def window_shutter(g, u, v):
    # closed wooden shutters in a stone frame (0..1 per window)
    f = 0.1
    du = g.mn(u, g.sub(1.0, u)); dv = g.mn(v, g.sub(1.0, v))
    frame = g.sub(1.0, g.smooth(g.mn(du, dv), f - 0.01, f + 0.01))
    mid = g.sub(1.0, g.smooth(g.absv(g.sub(u, 0.5)), 0.012, 0.022))
    lv = g.fract(g.mul(v, 14.0))
    louvre = g.smooth(lv, 0.1, 0.9)
    paint = g.noise(u, v, 8, detail=6, seed=121)
    peel = g.smooth(g.noise(u, v, 5, detail=7, seed=122), 0.62, 0.7)
    wood = g.mix(paint, rgb(0.20, 0.36, 0.40), rgb(0.28, 0.46, 0.50))
    wood = g.mix(peel, wood, rgb(0.42, 0.32, 0.22))
    wood = g.mix(g.mul(g.sub(1.0, louvre), 0.7), wood, rgb(0.06, 0.08, 0.08))
    stone = g.mix(paint, rgb(0.62, 0.56, 0.45), rgb(0.72, 0.66, 0.54))
    col = g.mix(frame, wood, stone)
    col = g.mix(g.mul(mid, g.sub(1.0, frame)), col, rgb(0.05, 0.06, 0.06))
    height = g.add(g.mul(frame, 0.8), g.mul(g.mul(louvre, g.sub(1.0, frame)), 0.3))
    return col, height, 0.85


def door_wood(g, u, v):
    f = 0.07
    du = g.mn(u, g.sub(1.0, u)); dv = g.mn(v, g.sub(1.0, v))
    frame = g.sub(1.0, g.smooth(g.mn(du, dv), f - 0.01, f + 0.01))
    bu = g.fract(g.mul(u, 5.0))
    gap = g.smooth(g.mn(bu, g.sub(1.0, bu)), 0.02, 0.06)
    grain = g.noise(u, v, 50, 3, detail=6, distort=0.3, seed=131)
    band = g.mul(g.sub(1.0, g.smooth(g.absv(g.sub(g.fract(g.mul(v, 3.0)), 0.5)), 0.44, 0.47)), 1.0)
    wood = g.mix(grain, rgb(0.36, 0.22, 0.12), rgb(0.52, 0.34, 0.19))
    wood = g.mix(gap, rgb(0.08, 0.05, 0.03), wood)
    wood = g.mix(g.mul(band, 0.85), wood, rgb(0.18, 0.17, 0.16))
    handle = g.pw(g.add(g.pw(g.sub(u, 0.78), 2.0), g.pw(g.sub(v, 0.48), 2.0)), 0.5)
    wood = g.mix(g.smooth(handle, 0.03, 0.02), wood, rgb(0.55, 0.48, 0.3))
    stone = g.mix(grain, rgb(0.55, 0.5, 0.42), rgb(0.66, 0.6, 0.5))
    col = g.mix(frame, wood, stone)
    height = g.add(g.mul(frame, 0.7), g.add(g.mul(gap, 0.3), g.mul(band, 0.3)))
    return col, height, 0.85


def burlap(g, u, v):
    wu = g.sin(g.mul(u, 6.2832 * 64)); wv = g.sin(g.mul(v, 6.2832 * 64))
    weave = g.mul(g.add(wu, wv), 0.25)
    n = g.noise(u, v, 5, detail=5, seed=141)
    dirt = g.smooth(g.noise(u, v, 3, detail=6, seed=142), 0.55, 0.75)
    col = g.mix(n, rgb(0.52, 0.44, 0.30), rgb(0.66, 0.57, 0.40))
    col = g.mix(g.add(weave, 0.5), g.hsv(col, v=0.82), col)
    col = g.mix(g.mul(dirt, 0.5), col, rgb(0.35, 0.28, 0.18))
    return col, g.add(g.mul(weave, 0.5), g.mul(n, 0.3)), 0.95


def barrel_paint(g, u, v):
    n = g.noise(u, v, 6, detail=5, seed=151)
    rust = g.smooth(g.noise(u, v, 4, detail=8, rough=0.65, seed=152), 0.6, 0.72)
    streak = g.smooth(g.noise(u, v, 30, 2, detail=3, seed=153), 0.6, 0.8)
    band = g.smooth(g.absv(g.sub(g.fract(g.mul(v, 3.0)), 0.5)), 0.44, 0.47)
    col = g.mix(n, rgb(0.42, 0.10, 0.07), rgb(0.58, 0.16, 0.10))
    col = g.mix(g.mul(streak, 0.35), col, rgb(0.30, 0.10, 0.06))
    col = g.mix(rust, col, g.mix(n, rgb(0.30, 0.16, 0.08), rgb(0.46, 0.26, 0.12)))
    col = g.mix(g.mul(band, 0.7), col, rgb(0.22, 0.08, 0.05))
    return col, g.add(g.mul(band, 0.6), g.mul(rust, 0.2)), 0.6


def terracotta(g, u, v):
    n = g.noise(u, v, 5, detail=6, seed=161)
    fine = g.noise(u, v, 40, detail=3, seed=162)
    salt = g.smooth(g.noise(u, v, 3, 8, detail=5, seed=163), 0.62, 0.75)
    col = g.mix(n, rgb(0.62, 0.32, 0.20), rgb(0.74, 0.42, 0.27))
    col = g.mix(g.mul(fine, 0.3), col, rgb(0.5, 0.25, 0.15))
    col = g.mix(g.mul(salt, 0.6), col, rgb(0.82, 0.74, 0.62))
    return col, g.add(g.mul(n, 0.3), g.mul(fine, 0.2)), 0.85


def snow(g, u, v):
    n = g.noise(u, v, 4, detail=6, seed=171)
    fine = g.noise(u, v, 40, detail=4, seed=172)
    tracks = g.smooth(g.noise(u, v, 3, 12, detail=4, seed=173), 0.62, 0.72)
    col = g.mix(n, rgb(0.80, 0.83, 0.88), rgb(0.93, 0.95, 0.98))
    col = g.mix(g.mul(tracks, 0.4), col, rgb(0.68, 0.70, 0.74))
    col = g.mix(g.mul(fine, 0.2), col, rgb(0.75, 0.78, 0.84))
    return col, g.add(g.mul(n, 0.5), g.mul(fine, 0.2)), 0.8


def carpet(g, u, v):
    loops = g.noise(u, v, 90, detail=2, seed=181)
    n = g.noise(u, v, 5, detail=5, seed=182)
    tile = g.fract(g.mul(u, 2.0)); tv = g.fract(g.mul(v, 2.0))
    seam = g.sub(1.0, g.smooth(g.mn(g.mn(tile, g.sub(1.0, tile)), g.mn(tv, g.sub(1.0, tv))), 0.004, 0.012))
    col = g.mix(loops, rgb(0.26, 0.26, 0.30), rgb(0.38, 0.37, 0.42))
    col = g.mix(g.mul(n, 0.3), col, rgb(0.22, 0.21, 0.24))
    col = g.mix(g.mul(seam, 0.4), col, rgb(0.18, 0.18, 0.2))
    return col, g.add(g.mul(loops, 0.4), g.mul(seam, -0.3)), 0.98


def drywall(g, u, v):
    n = g.noise(u, v, 3, detail=5, seed=191)
    fine = g.noise(u, v, 60, detail=2, seed=192)
    base = g.smooth(v, 0.0, 0.08)                          # skirting at the bottom of a repeat
    scuff = g.smooth(g.noise(u, v, 8, 2, detail=4, seed=193), 0.66, 0.75)
    col = g.mix(n, rgb(0.74, 0.72, 0.66), rgb(0.82, 0.8, 0.74))
    col = g.mix(g.mul(fine, 0.12), col, rgb(0.6, 0.58, 0.54))
    col = g.mix(g.mul(scuff, 0.3), col, rgb(0.5, 0.48, 0.44))
    col = g.mix(g.sub(1.0, base), col, rgb(0.28, 0.24, 0.2))
    return col, g.add(g.mul(fine, 0.1), g.mul(g.sub(1.0, base), 0.4)), 0.9


def ceiling_tile(g, u, v):
    fu, fv = g.fract(g.mul(u, 2.0)), g.fract(g.mul(v, 2.0))
    grid = g.sub(1.0, g.smooth(g.mn(g.mn(fu, g.sub(1.0, fu)), g.mn(fv, g.sub(1.0, fv))), 0.01, 0.025))
    pits = g.smooth(g.voronoi(u, v, 60, seed=201), 0.05, 0.12)
    stain = g.smooth(g.noise(u, v, 3, detail=5, seed=202), 0.66, 0.78)
    col = g.mix(pits, rgb(0.6, 0.6, 0.57), rgb(0.86, 0.86, 0.83))
    col = g.mix(g.mul(stain, 0.35), col, rgb(0.66, 0.6, 0.48))
    col = g.mix(grid, col, rgb(0.72, 0.72, 0.72))
    return col, g.add(g.mul(grid, 0.6), g.mul(pits, 0.2)), 0.95


def concrete(g, u, v):
    n = g.noise(u, v, 4, detail=6, seed=211)
    fine = g.noise(u, v, 50, detail=3, seed=212)
    pores = g.smooth(g.voronoi(u, v, 45, seed=213), 0.04, 0.09)
    fu = g.fract(g.mul(u, 2.0))
    joint = g.sub(1.0, g.smooth(g.mn(fu, g.sub(1.0, fu)), 0.004, 0.01))
    stain = g.smooth(g.noise(u, v, 2, 5, detail=5, seed=214), 0.6, 0.78)
    col = g.mix(n, rgb(0.5, 0.5, 0.49), rgb(0.64, 0.64, 0.62))
    col = g.mix(g.mul(fine, 0.2), col, rgb(0.42, 0.42, 0.41))
    col = g.mix(g.sub(1.0, pores), col, rgb(0.34, 0.34, 0.33))
    col = g.mix(g.mul(stain, 0.35), col, rgb(0.36, 0.34, 0.3))
    col = g.mix(g.mul(joint, 0.6), col, rgb(0.3, 0.3, 0.3))
    return col, g.add(g.mul(fine, 0.25), g.mul(joint, -0.5)), 0.92


def corrugated(g, u, v):
    rib = g.mul(g.add(g.sin(g.mul(u, 6.2832 * 16)), 1.0), 0.5)
    n = g.noise(u, v, 5, detail=5, seed=221)
    rust = g.mul(g.smooth(g.noise(u, v, 4, detail=8, rough=0.65, seed=222), 0.64, 0.78), 0.8)
    streak = g.smooth(g.noise(u, v, 40, 2, detail=3, seed=223), 0.62, 0.8)
    col = g.mix(n, rgb(0.5, 0.54, 0.56), rgb(0.62, 0.66, 0.68))
    col = g.mix(g.mul(g.sub(1.0, rib), 0.35), col, rgb(0.34, 0.37, 0.39))
    col = g.mix(g.mul(streak, 0.3), col, rgb(0.42, 0.34, 0.26))
    col = g.mix(rust, col, g.mix(n, rgb(0.34, 0.18, 0.08), rgb(0.5, 0.28, 0.12)))
    return col, g.add(g.mul(rib, 0.9), g.mul(rust, 0.1)), g.lin(rust, 0, 1, 0.45, 0.85)


def asphalt(g, u, v):
    n = g.noise(u, v, 5, detail=6, seed=231)
    grit = g.noise(u, v, 120, detail=2, seed=232)
    crack = g.smooth(g.voronoi(u, v, 5, feature='DISTANCE_TO_EDGE', seed=233), 0.0, 0.015)
    patch = g.smooth(g.noise(u, v, 2, detail=4, seed=234), 0.62, 0.66)
    col = g.mix(n, rgb(0.24, 0.24, 0.25), rgb(0.33, 0.33, 0.34))
    col = g.mix(g.mul(grit, 0.4), col, rgb(0.45, 0.45, 0.44))
    col = g.mix(g.mul(patch, 0.6), col, rgb(0.19, 0.19, 0.2))
    col = g.mix(g.mul(g.sub(1.0, crack), 0.7), col, rgb(0.12, 0.12, 0.12))
    return col, g.add(g.mul(grit, 0.3), g.mul(g.sub(1.0, crack), -0.4)), 0.95


def container_paint(g, u, v):
    rib = g.mul(g.add(g.sin(g.mul(u, 6.2832 * 8)), 1.0), 0.5)
    n = g.noise(u, v, 6, detail=5, seed=241)
    rust = g.mul(g.smooth(g.noise(u, v, 4, detail=8, rough=0.65, seed=242), 0.6, 0.74), 0.9)
    col = g.mix(n, rgb(0.46, 0.14, 0.08), rgb(0.6, 0.2, 0.12))
    col = g.mix(g.mul(g.sub(1.0, rib), 0.3), col, rgb(0.32, 0.1, 0.06))
    col = g.mix(rust, col, rgb(0.36, 0.2, 0.1))
    return col, g.add(g.mul(rib, 0.9), g.mul(rust, 0.15)), 0.6


def roof_tiles(g, u, v):
    rows = 8
    rv = g.mul(v, rows)
    row = g.floor(rv)
    off = g.mul(g.mod(row, 2.0), 0.5)
    cu = g.add(g.mul(u, 6.0), off)
    lu = g.fract(cu); lv = g.fract(rv)
    arch = g.pw(g.sin(g.mul(lu, 3.1416)), 0.6)            # rounded tile profile
    shadow = g.smooth(lv, 0.0, 0.25)
    rnd = g.white(g.mod(g.floor(cu), 6.0), g.mod(row, rows), 251.0)
    col = g.mix(rnd, rgb(0.55, 0.26, 0.15), rgb(0.7, 0.36, 0.22))
    col = g.mix(g.mul(g.sub(1.0, shadow), 0.7), col, rgb(0.22, 0.1, 0.06))
    col = g.mix(g.mul(g.sub(1.0, arch), 0.4), col, rgb(0.35, 0.16, 0.1))
    moss = g.smooth(g.noise(u, v, 3, detail=6, seed=252), 0.66, 0.78)
    col = g.mix(g.mul(moss, 0.4), col, rgb(0.34, 0.36, 0.22))
    return col, g.add(g.mul(arch, 0.6), g.mul(shadow, 0.4)), 0.8


RECIPES = {
    'dust_sandstone': sandstone,
    'dust_bigblock': big_blocks,
    'dust_sand': sand,
    'cobbles': cobbles,
    'plaster': plaster,
    'brick_red': brick_red,
    'planks': planks,
    'planks_dark': planks_dark,
    'crate': crate,
    'metal_plate': metal_plate,
    'jungle_ground': jungle_ground,
    'aztec_stone': aztec_stone,
    'aztec_carved': aztec_carved,
    'hedge': hedge,
    'water': water,
    'window_shutter': window_shutter,
    'door_wood': door_wood,
    'burlap': burlap,
    'barrel_paint': barrel_paint,
    'terracotta': terracotta,
    'snow': snow,
    'carpet': carpet,
    'drywall': drywall,
    'ceiling_tile': ceiling_tile,
    'concrete': concrete,
    'corrugated': corrugated,
    'asphalt': asphalt,
    'container_paint': container_paint,
    'roof_tiles': roof_tiles,
}


def build(tid):
    mat = bpy.data.materials.new(tid)
    g = G(mat)
    u, v = g.uv()
    col, height, rough = RECIPES[tid](g, u, v)
    g.surface(col, height, rough=rough, bump=0.6)
    ob = plane('tex_' + tid, 2.0, mat)

    albedo = new_image(tid, SIZE)
    bake(ob, 'DIFFUSE', albedo, samples=4, margin=0)
    save_image(albedo, os.path.join(OUT, tid + '.jpg'), quality=88)

    nrm = new_image(tid + '_n', SIZE, non_color=True)
    bake(ob, 'NORMAL', nrm, samples=4, margin=0)
    save_image(nrm, os.path.join(OUT, tid + '_n.jpg'), quality=90)

    bpy.data.objects.remove(ob)


def main():
    reset_scene()
    want = args() or list(RECIPES)
    for tid in want:
        build(tid)


main()
