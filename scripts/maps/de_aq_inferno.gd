extends Node3D
## de_aq_inferno — Banana curve + Apartments, cs_inferno analogue.
##
## Footprint 3800 x 3000 u (x: -1920..1920, z: -1536..1536) on the 64 u grid.
##   T Spawn (-1600, 0, -1200)            CT Spawn (1500, 0, 1100)
##   A Site  (1500, 0, -800) with the balcony overhang (x 1280..1728,
##           y 128..192) reached by a stair tower at x = 1024
##   B Site  (-1200, 0, 1000), entered through the Apartments block
##   Banana  curved corridor, T Spawn -> Mid, ~200 u wide
##   Apartments two-storey building at (-400, 0, 400): ground floor (y 0..128)
##           plus a 64 u upper level (deck y = 128)
##
## Materials: 4 spec (cobblestone, plaster, wood beams, terracotta tile)
## + 3 trim = 7 distinct, under the MAPS.md budget of 8.

const MG := preload("res://scripts/map_geometry.gd")

const APT_ORIGIN := Vector2(-512.0, 256.0)  # building SW corner, snapped
const APT_SIZE := Vector2(768.0, 768.0)


func _walls() -> Array:
    return [
        # --- perimeter
        {"n": "Perim_N", "p": [0, 128, -1536], "s": [3840, 256, 64], "m": "accent"},
        {"n": "Perim_S", "p": [0, 128, 1536], "s": [3840, 256, 64], "m": "accent"},
        {"n": "Perim_E", "p": [1920, 128, 0], "s": [64, 256, 3136], "m": "accent"},
        {"n": "Perim_W", "p": [-1920, 128, 0], "s": [64, 256, 3136], "m": "accent"},

        # --- T spawn pocket (backs onto -z)
        {"n": "TSpawn_S", "p": [-1664, 128, -768], "s": [512, 256, 64], "m": "wall"},
        {"n": "TSpawn_E", "p": [-1408, 128, -1216], "s": [64, 256, 896], "m": "wall"},

        # --- CT spawn pocket (backs onto +z)
        {"n": "CTSpawn_N", "p": [1536, 128, 896], "s": [768, 256, 64], "m": "wall"},

        # --- banana arc (concave toward mid), stepped in 64 u columns
        {"n": "ArcW_1", "p": [-1792, 128, -256], "s": [64, 256, 640], "m": "wall"},
        {"n": "ArcW_2", "p": [-1728, 128, 192], "s": [64, 256, 256], "m": "wall"},
        {"n": "ArcW_3", "p": [-1600, 128, 384], "s": [64, 256, 192], "m": "wall"},
        {"n": "ArcW_4", "p": [-1536, 128, 576], "s": [64, 256, 128], "m": "wall"},
        {"n": "ArcW_5", "p": [-1408, 128, 704], "s": [64, 256, 128], "m": "wall"},
        {"n": "ArcW_6", "p": [-1280, 128, 832], "s": [64, 256, 144], "m": "wall"},
        {"n": "ArcW_7", "p": [-1152, 128, 960], "s": [64, 256, 112], "m": "wall"},
        # north side of banana
        {"n": "ArcN_1", "p": [-960, 128, -128], "s": [832, 256, 64], "m": "wall"},
        {"n": "ArcN_2", "p": [-704, 128, -64], "s": [256, 256, 64], "m": "wall"},

        # --- mid connector to the apartments block
        {"n": "AptApproach_S", "p": [-896, 128, 192], "s": [448, 256, 64], "m": "wall"},

        # --- apartments: ground shell (x -512..256, z 256..1024, y 0..128)
        {"n": "Apt_N", "p": [-128, 64, 256], "s": [768, 128, 64], "m": "wall"},
        {"n": "Apt_S_W", "p": [-384, 64, 1024], "s": [256, 128, 64], "m": "wall"},
        {"n": "Apt_S_E", "p": [128, 64, 1024], "s": [256, 128, 64], "m": "wall"},
        {"n": "Apt_E_N", "p": [256, 64, 384], "s": [64, 128, 256], "m": "wall"},
        {"n": "Apt_E_S", "p": [256, 64, 896], "s": [64, 128, 256], "m": "wall"},
        {"n": "Apt_W_N", "p": [-512, 64, 320], "s": [64, 128, 128], "m": "wall"},
        {"n": "Apt_W_M", "p": [-512, 64, 640], "s": [64, 128, 128], "m": "wall"},
        {"n": "Apt_W_S", "p": [-512, 64, 896], "s": [64, 128, 128], "m": "wall"},
        # upper storey walls (y 128..256), same footprint, window gaps
        {"n": "AptUp_N", "p": [-128, 192, 256], "s": [768, 128, 64], "m": "wall"},
        {"n": "AptUp_S", "p": [-128, 192, 1024], "s": [768, 128, 64], "m": "wall"},
        {"n": "AptUp_E_Win", "p": [256, 192, 384], "s": [64, 128, 256], "m": "wall"},
        {"n": "AptUp_E_Sol", "p": [256, 192, 896], "s": [64, 128, 256], "m": "wall"},
        {"n": "AptUp_W_1", "p": [-512, 192, 320], "s": [64, 128, 128], "m": "wall"},
        {"n": "AptUp_W_2", "p": [-512, 192, 640], "s": [64, 128, 128], "m": "wall"},
        {"n": "AptUp_W_3", "p": [-512, 192, 896], "s": [64, 128, 128], "m": "wall"},
        # stair tower: landings at +128 / +192, roof at +256
        {"n": "Tower_S", "p": [384, 64, 608], "s": [64, 128, 128], "m": "wall"},
        {"n": "Tower_N", "p": [384, 64, 320], "s": [64, 128, 128], "m": "wall"},
        {"n": "TowerWall_128", "p": [320, 192, 256], "s": [64, 128, 64], "m": "wall"},
        {"n": "Tower_Wall192", "p": [256, 192, 512], "s": [64, 128, 64], "m": "wall"},
        {"n": "Landing_128", "type": "ground", "pos": [96, 480], "w": 128, "d": 192, "m": "wood"},
        {"n": "Landing_192", "type": "ground", "pos": [-192, 512], "w": 128, "d": 192, "m": "wood"},

        # --- B site pocket and its CT-side wall
        {"n": "B_Wall", "p": [-1248, 64, 480], "s": [576, 128, 64], "m": "wall"},
        {"n": "B_BackWall", "p": [-1408, 128, 1216], "s": [896, 256, 64], "m": "wall"},
        {"n": "B_CTWall", "p": [-192, 128, 1280], "s": [1344, 256, 64], "m": "wall"},
        # divider keeping the A lane separate from the apartments approach
        {"n": "A_Lane_S", "p": [896, 128, -128], "s": [1408, 256, 64], "m": "wall"},

        # --- A site walls
        {"n": "ASite_W", "p": [1024, 128, -704], "s": [64, 256, 768], "m": "wall"},
        {"n": "ASite_N", "p": [1536, 128, -1152], "s": [1024, 256, 64], "m": "wall"},
        {"n": "ASite_S_E", "p": [1664, 128, -448], "s": [640, 256, 64], "m": "wall"},
        # balcony mass at A (overhang deck at y = 128, seen over the site)
        {"n": "Balcony_Fill", "p": [1408, 64, -448], "s": [768, 128, 128], "m": "wall"},
        {"n": "Balcony_Rail", "p": [1504, 160, -384], "s": [384, 64, 64], "m": "wood"},
        {"n": "BalconyWall_S", "p": [1408, 224, -448], "s": [832, 64, 64], "m": "wood"},
        {"n": "BalconyWall_W", "p": [1024, 224, -352], "s": [64, 64, 256], "m": "wood"},
        {"n": "BalconyWall_E", "p": [1792, 224, -352], "s": [64, 64, 256], "m": "wood"},

        # --- terraces colouring the skyline (non-walkable roofs)
        {"n": "Terrace_W", "p": [-1664, 96, -1152], "s": [256, 64, 768], "m": "accent"},
        {"n": "Terrace_Mid", "p": [704, 96, 512], "s": [128, 64, 1024], "m": "accent"},
        {"n": "Terrace_B", "p": [-512, 96, 1344], "s": [1024, 64, 64], "m": "accent"},
    ]


func _ground_pads() -> Array:
    return [
        {"n": "AptFloor64", "type": "ground", "pos": [-128, 640], "w": 768, "d": 768, "m": "floor"},
        {"n": "AptUpper128", "type": "ground", "pos": [-128, 640], "w": 768, "d": 768, "m": "wood"},
        {"n": "AptRoof256", "type": "ground", "pos": [-128, 640], "w": 768, "d": 768, "m": "accent"},
        {"n": "Ceiling64", "type": "ground", "pos": [-128, 640], "w": 768, "d": 768, "m": "accent"},
        {"n": "BFloor", "type": "ground", "pos": [-1152, 896], "w": 640, "d": 640, "m": "floor"},
        {"n": "Grate_Mid", "type": "ground", "pos": [512, -806.4], "w": 320, "d": 102.4, "m": "metal"},
    ]


func _ramps() -> Array:
    return [
        # banana entry curve: two wedges give the corridor its bend
        {"n": "Ramp_Banana_1", "type": "ramp", "p": [-1792, 32, -576],
            "s": [128, 64, 128], "ramp_y0": -32.0, "ramp_y1": 32.0, "m": "floor"},
        {"n": "Ramp_Banana_2", "type": "ramp", "p": [-1536, 32, 384],
            "s": [128, 64, 128], "ramp_y0": 32.0, "ramp_y1": -32.0, "m": "floor"},
        # apartments ground floor entry, then the stair tower landings
        {"n": "Ramp_AptDoor", "type": "ramp", "p": [320, 32, 1024],
            "s": [128, 64, 128], "ramp_y0": 0.0, "ramp_y1": -32.0, "m": "wood"},
        {"n": "Ramp_Stair_1", "type": "ramp", "p": [384, 64, 480],
            "s": [128, 128, 128], "ramp_y0": 0.0, "ramp_y1": -128.0, "m": "wood"},
        {"n": "Ramp_Stair_2", "type": "ramp", "p": [320, 128, 576],
            "s": [128, 128, 128], "ramp_y0": 0.0, "ramp_y1": -128.0, "m": "wood"},
        {"n": "Ramp_Stair_3", "type": "ramp", "p": [192, 192, 448],
            "s": [128, 128, 128], "ramp_y0": 0.0, "ramp_y1": -128.0, "m": "wood"},
        # B pit entry from the banana, and the A +64 lip
        {"n": "Ramp_B", "type": "ramp", "p": [-1088, 32, 576],
            "s": [128, 64, 128], "ramp_y0": 0.0, "ramp_y1": -32.0, "m": "wood"},
        {"n": "Ramp_A", "type": "ramp", "p": [1088, 32, -896],
            "s": [128, 64, 128], "ramp_y0": 0.0, "ramp_y1": -32.0, "m": "wood"},
    ]


func _cover_zones() -> Array:
    return [
        [-1856, -1024, -1408, -768],   # T spawn exits
        [-1600, 640, -1088, 1152],     # B site
        [-896, 192, -576, 1024],       # west of apartments
        [384, -1024, 896, -640],       # A lane
        [1152, -1024, 1792, -512],     # A site
        [1216, -256, 1792, 768],       # mid
        [-128, -256, 640, 128],        # mid connector
    ]


func _ready() -> void:
    var mats := MG.inferno_materials()
    var geo := Node3D.new()
    geo.name = "Geometry"
    add_child(geo)

    var spec: Array = []
    spec.append_array(_ground_pads())
    spec.append_array(_walls())
    spec.append_array(_ramps())
    MG.build(geo, spec, mats)

    MG.add_spawn_points(self, Vector3(-1600, 0, -1216))
    MG.add_bomb_sites(self, Vector3(1536, 0, -768), Vector3(-1152, -64, 896))
    MG.add_cover_crates(self, _cover_zones(), 30, mats[MG.MAT_COVER], 0x1NF)
    MG.add_nav_region(self, 0.0, 3840.0, 3136.0, mats[MG.MAT_FLOOR])
    MG.add_map_data(self, "de_aq_inferno",
        Color(0.55, 0.5, 0.45), 0.6,
        Color(0.45, 0.5, 0.6), Color(0.65, 0.55, 0.45))
