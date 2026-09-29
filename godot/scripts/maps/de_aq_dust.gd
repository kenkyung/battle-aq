extends Node3D
## de_aq_dust — three-lane de_dust2 analogue.
##
## Footprint 4500 x 3500 u (x: -2304..2304, z: -1792..1792) on the CS 1.6 64 u
## grid. Layout per the M4 brief and MAPS.md:
##   T Spawn (-2200, 0, -1500)            CT Spawn (2200, 0, 1500)
##   A Site  (1900, 0, -1100) raised platform, +64 u
##   B Site  (-1100, 0, 1100) ground-level pit (y = -64, ramp west of the pit)
##   Mid door chokepoint (0, 0, 0), 128 u wide gap
##   Long A corridor T Ramp (-2200, 0, 800) north to A
##   Short A (Catwalk) upper path 3328..3840 T Spawn -> A
##
## Static blockout: geometry is built once in `_ready()` from the spec tables
## below. The per-frame cost is the CSG draw call set plus 30 crates — well
## inside ARCHITECTURE §7.
##
## Materials: 4 spec (sand floor, adobe walls, wood crates, metal grates)
## + 3 trim (T-side plaster, wooden roof, water) = 7 distinct, under the
## MAPS.md budget of 8.

const MG := preload("res://scripts/map_geometry.gd")

# ---------------------------------------------------------------- layout

func _walls() -> Array:
    ## Perimeter, spawn pockets, mid door frame, long/short dividers, the A
    ## platform mass, the pit walls and the west ramp into the pit.
    ## "L" = long-corridor stub, "m" = mid, "p" = pit, all trim/terrain mats.
    return [
        # --- perimeter (4500 x 3500 footprint)
        {"n": "Perim_N", "p": [0, 128, -1792], "s": [4544, 256, 64], "m": "accent"},
        {"n": "Perim_S", "p": [0, 128, 1792], "s": [4544, 256, 64], "m": "accent"},
        {"n": "Perim_E", "p": [2304, 128, 0], "s": [64, 256, 3584], "m": "accent"},
        {"n": "Perim_W", "p": [-2304, 128, 0], "s": [64, 256, 3584], "m": "accent"},

        # --- T spawn pocket (backs onto -z)
        {"n": "TSpawn_E", "p": [-1856, 128, -1248], "s": [64, 256, 896], "m": "wall"},
        {"n": "TSpawn_W", "p": [-2432, 128, -1216], "s": [64, 256, 960], "m": "wall"},
        {"n": "TSpawn_N", "p": [-2112, 128, -1440], "s": [576, 256, 64], "m": "wall"},

        # --- CT spawn pocket (backs onto +z)
        {"n": "CTSpawn_W", "p": [1856, 128, 1248], "s": [64, 256, 896], "m": "wall"},
        {"n": "CTSpawn_E", "p": [2432, 128, 1216], "s": [64, 256, 960], "m": "wall"},
        {"n": "CTSpawn_S", "p": [2112, 128, 1440], "s": [576, 256, 64], "m": "wall"},
        # CT-to-B wall with a 128 u door at z = 960
        {"n": "CT_B_Wall", "p": [-896, 128, 832], "s": [1088, 256, 64], "m": "wall"},
        # short CT-to-A wall, 256 u gap on the east approach
        {"n": "CT_A_Wall", "p": [1344, 128, 896], "s": [512, 256, 64], "m": "wall"},

        # --- mid door (128 u walkable gap at x = 0..128, z = -64..64)
        {"n": "MidWall_W", "p": [-896, 128, 0], "s": [1792, 256, 64], "m": "wall"},
        {"n": "MidWall_E", "p": [1152, 128, 0], "s": [2048, 256, 64], "m": "wall"},
        {"n": "MidFrame_W", "p": [-64, 64, 0], "s": [64, 128, 64], "m": "metal"},
        {"n": "MidFrame_E", "p": [192, 64, 0], "s": [64, 128, 64], "m": "metal"},
        {"n": "MidLintel", "p": [64, 160, 0], "s": [192, 64, 64], "m": "metal"},
        {"n": "MidDoorDeck", "p": [64, 64, 0], "s": [128, 64, 64], "m": "metal"},

        # --- long corridor divider (x -1920..-832, z 448..832)
        {"n": "LongDivider_N", "p": [-1376, 128, 448], "s": [1088, 256, 64], "m": "wall"},
        {"n": "LongDividerMid", "p": [-832, 128, 640], "s": [64, 256, 256], "m": "wall"},
        # long corridor east wall, 256 u gap into CT spawn at z = 1024
        {"n": "Long_E_Wall", "p": [-640, 128, 384], "s": [64, 256, 896], "m": "wall"},
        {"n": "Long_Screen", "p": [-2112, 128, 1664], "s": [256, 256, 192], "m": "wall"},
        # B site pocket walls (west of the pit)
        {"n": "B_West_Wall", "p": [-1856, 128, 1216], "s": [64, 256, 640], "m": "wall"},

        # --- A platform mass (+64 u deck) and its access
        {"n": "ASite_NE", "p": [1536, 32, -960], "s": [64, 192, 384], "m": "wall"},
        {"n": "ASite_N", "p": [1536, 32, -1152], "s": [1024, 192, 64], "m": "wall"},
        {"n": "ASite_W", "p": [1088, 32, -896], "s": [64, 192, 576], "m": "wall"},
        {"n": "ASite_S", "p": [1216, 32, -640], "s": [832, 192, 64], "m": "wall"},
        {"n": "CatwalkDivider", "p": [1024, 96, -1216], "s": [64, 256, 256], "m": "wall"},

        # --- pit walls on the three open sides
        {"n": "Pit_N", "p": [-1344, -32, 192], "s": [512, 64, 64], "m": "wall"},
        {"n": "Pit_S", "p": [-1088, -32, 768], "s": [896, 64, 64], "m": "wall"},
        {"n": "Pit_E", "p": [-768, -32, 480], "s": [64, 64, 320], "m": "wall"},

        # --- short A (catwalk path) screens: gaps at z = -1024 and z = -1408
        {"n": "ShortA_Screen1", "p": [-1280, 128, -704], "s": [192, 256, 192], "m": "wall"},
        {"n": "ShortA_Screen2", "p": [-704, 128, -1280], "s": [192, 256, 192], "m": "metal"},

        # --- long corridor cover
        {"n": "Long_Crate_1", "p": [-1728, 32, 704], "s": [64, 64, 64], "m": "cover"},
        {"n": "Long_Crate_2", "p": [-1600, 32, 1088], "s": [64, 64, 64], "m": "cover"},
        {"n": "Long_Crate_3", "p": [-1600, 96, 1088], "s": [64, 64, 64], "m": "cover"},
        {"n": "Long_Crate_4", "p": [-1472, 32, 512], "s": [64, 64, 64], "m": "cover"},
        # --- B approach cover (bare, non-instanced)
        {"n": "B_Crate_1", "p": [-1408, 32, 1280], "s": [64, 64, 64], "m": "cover"},
        {"n": "B_Crate_2", "p": [-1152, 96, 1344], "s": [64, 64, 64], "m": "cover"},
        {"n": "B_Crate_3", "p": [-1280, 32, 896], "s": [64, 64, 64], "m": "cover"},
        {"n": "Mid_Barrel_1", "p": [448, 32, 704], "s": [64, 64, 64], "m": "metal"},
        {"n": "Mid_Barrel_2", "p": [-576, 32, -576], "s": [64, 64, 64], "m": "metal"},
    ]


func _ramps() -> Array:
    ## ramp_y0 / ramp_y1 are the two ends' Y within the local prism profile, so
    ## the pair must differ by the height delta the walker climbs.
    return [
        # up to the A platform (0 -> 64), approached from the west
        {"n": "Ramp_A", "type": "ramp", "p": [960, 32, -1152],
            "s": [192, 64, 256], "ramp_y0": -32.0, "ramp_y1": 32.0, "m": "metal"},
        # into the B pit (0 -> -64), approached from the west
        {"n": "Ramp_B_Pit", "type": "ramp", "p": [-1440, -32, 480],
            "s": [128, 64, 256], "ramp_y0": 32.0, "ramp_y1": -32.0, "m": "wood"},
    ]


func _ground_pads() -> Array:
    ## B pit floor at -64, the upper catwalk deck at +64, the two metal grate
    ## bridges, and the A platform deck.
    return [
        {"n": "BPitFloor", "type": "ground", "pos": [-1088, 480], "w": 640, "d": 640, "m": "floor"},
        {"n": "CatwalkDeck", "type": "ground", "pos": [0, -832], "w": 2048, "d": 256, "m": "metal"},
        {"n": "Grate_W", "type": "ground", "pos": [-1024, 0], "w": 256, "d": 128, "m": "metal"},
        {"n": "Grate_E", "type": "ground", "pos": [1152, 0], "w": 256, "d": 128, "m": "metal"},
        {"n": "AsideDeck", "type": "ground", "pos": [1600, -832], "w": 832, "d": 640, "m": "floor"},
    ]


# ---------------------------------------------------------------- cover zones

func _cover_zones() -> Array:
    ## [x_min, z_min, x_max, z_max] — 30 crates are scattered across these.
    return [
        [-2176, -1344, -1344, -768],   # T -> B
        [-2176, 512, -1664, 1536],     # long A
        [-1664, 1088, -768, 1536],     # B site approach
        [-640, -1088, 384, -192],      # short A / catwalk
        [1216, -512, 2112, 640],       # mid -> A
        [-704, 704, 896, 1408],        # mid -> CT
        [1280, 1024, 2112, 1408],      # CT -> A
    ]


# ---------------------------------------------------------------- build

func _ready() -> void:
    var mats := MG.dust_materials()
    var geo := Node3D.new()
    geo.name = "Geometry"
    add_child(geo)

    var spec: Array = []
    spec.append_array(_ground_pads())
    spec.append_array(_walls())
    spec.append_array(_ramps())
    MG.build(geo, spec, mats)

    # Spawns, bomb sites, cover, nav.
    MG.add_spawn_points(self, Vector3(-2176, 0, -1472))
    MG.add_bomb_sites(self, Vector3(1856, 64, -1088), Vector3(-1088, -64, 480))
    MG.add_cover_crates(self, _cover_zones(), 30, mats[MG.MAT_COVER], 0xD057)
    MG.add_nav_region(self, 0.0, 4608.0, 3584.0, mats[MG.MAT_FLOOR])
    MG.add_map_data(self, "de_aq_dust",
        Color(0.78, 0.72, 0.55), 0.75,
        Color(0.55, 0.65, 0.75), Color(0.85, 0.78, 0.65))
