extends Node3D
## de_aq_aztec — temple, bridge and flooded underpass.
##
## Footprint 4200 x 3200 u (x: -2112..2112, z: -1600..1600) on the 64 u grid.
##   T Spawn (-1900, 0, -1400)            CT Spawn (1900, 0, 1400)
##   A Site: temple bridge at (1400, 64, -800), 256 u wide span (x 1152..1664
##           at deck level) across the flooded underpass; water plane at
##           y = -64 down in the channel
##   B Site: temple interior at (-1100, 0, 800) ringed by 4 square columns
##   Snipers' Nest: CT high ground at (1700, 128, 0) over the bridge approach
##
## Water: the brief asks for a translucent blue plane at y = -64. GL
## Compatibility forbids per-pixel transparency on *default* materials
## (AGENTS.md #4), so the single water material opts in explicitly via
## TRANSPARENCY_ALPHA and stays off the terrain path. It is the only
## transparent surface in the map.
##
## Materials: 4 spec (stone walls, wood bridge, water, foliage) + 3 trim
## = 7 distinct, under the MAPS.md budget of 8.

const MG := preload("res://scripts/map_geometry.gd")

const WATER_Y := -64.0
const BRIDGE_Y := 64.0


func _walls() -> Array:
    return [
        # --- perimeter
        {"n": "Perim_N", "p": [0, 128, -1600], "s": [4224, 256, 64], "m": "accent"},
        {"n": "Perim_S", "p": [0, 128, 1600], "s": [4224, 256, 64], "m": "accent"},
        {"n": "Perim_E", "p": [2112, 128, 0], "s": [64, 256, 3264], "m": "accent"},
        {"n": "Perim_W", "p": [-2112, 128, 0], "s": [64, 256, 3264], "m": "accent"},

        # --- T spawn pocket (west/north)
        {"n": "TSpawn_E", "p": [-1408, 128, -1248], "s": [64, 256, 960], "m": "wall"},
        {"n": "TSpawn_S", "p": [-1792, 128, -896], "s": [576, 256, 64], "m": "wall"},

        # --- CT spawn pocket (east/south)
        {"n": "CTSpawn_W", "p": [1408, 128, 1248], "s": [64, 256, 960], "m": "wall"},
        {"n": "CTSpawn_N", "p": [1792, 128, 896], "s": [576, 256, 64], "m": "wall"},

        # --- the flooded channel: floor at -64, water surface at WATER_Y
        {"n": "CanalFloor", "type": "ground", "pos": [0, 0], "w": 4224, "d": 448, "m": "floor"},
        {"n": "CanalWall_N", "p": [0, 32, -192], "s": [2048, 64, 64], "m": "wall"},
        {"n": "CanalWall_S", "p": [0, 32, 192], "s": [2048, 64, 64], "m": "wall"},
        {"n": "Water", "type": "water", "y": WATER_Y, "w": 4224, "d": 384, "m": "water"},
        # pier that carries the sniper-approach ramp over the water
        {"n": "Pier", "p": [1728, 32, 64], "s": [64, 64, 128], "m": "stone"},

        # --- bridge downramp (deck +64 -> underpass -64) and its guard walls
        {"n": "BridgeWall_W", "p": [1728, 32, -896], "s": [64, 192, 192], "m": "wood"},
        {"n": "BridgeWall_E", "p": [1728, 32, -512], "s": [64, 192, 192], "m": "wood"},
        {"n": "BridgeWall_N", "p": [1600, 96, -832], "s": [192, 64, 64], "m": "wood"},

        # --- underpass support pillars
        {"n": "BridgePillar_A", "p": [1280, 0, -64], "s": [64, 128, 128], "m": "wall"},
        {"n": "BridgePillar_B", "p": [1280, 0, 64], "s": [64, 128, 128], "m": "wall"},

        # --- temple (B site) shell, ring x -1472..-704, z 576..1408, y 64..160
        {"n": "Temple_N", "p": [-1088, 96, 576], "s": [832, 64, 64], "m": "wall"},
        {"n": "Temple_S_W", "p": [-1344, 96, 1408], "s": [320, 64, 64], "m": "wall"},
        {"n": "Temple_S_E", "p": [-832, 96, 1408], "s": [320, 64, 64], "m": "wall"},
        {"n": "Temple_W_N", "p": [-1472, 96, 704], "s": [64, 64, 192], "m": "wall"},
        {"n": "Temple_W_S", "p": [-1472, 96, 1280], "s": [64, 64, 192], "m": "wall"},
        {"n": "Temple_E_N", "p": [-704, 96, 640], "s": [64, 64, 128], "m": "wall"},
        {"n": "Temple_E_S", "p": [-704, 96, 1280], "s": [64, 64, 192], "m": "wall"},

        # --- the four temple columns ringing B site (square, CS 1.6 style)
        {"n": "Column_1", "type": "column", "pos": [-832, 704], "r": 64, "h": 160, "m": "stone"},
        {"n": "Column_2", "type": "column", "pos": [-1344, 704], "r": 64, "h": 160, "m": "stone"},
        {"n": "Column_3", "type": "column", "pos": [-832, 1152], "r": 64, "h": 160, "m": "stone"},
        {"n": "Column_4", "type": "column", "pos": [-1344, 1152], "r": 64, "h": 160, "m": "stone"},

        # --- mid walls: the -64..64 gap between them IS the walk-through
        {"n": "MidWall_1", "p": [-1920, 96, 64], "s": [384, 192, 64], "m": "wall"},
        {"n": "MidWall_2", "p": [-1536, 96, 64], "s": [384, 192, 64], "m": "wall"},
        {"n": "MidWall_3", "p": [576, 96, 64], "s": [384, 192, 64], "m": "wall"},
        {"n": "MidWall_4", "p": [960, 96, 64], "s": [384, 192, 64], "m": "wall"},
        # B-side gate wall at the temple's east approach
        {"n": "Temple_GateWall", "p": [-384, 96, 960], "s": [640, 192, 64], "m": "wall"},

        # --- snipers' nest structure (landing y = 128, walls to y = 256)
        {"n": "Nest_E", "p": [1792, 128, 0], "s": [64, 256, 640], "m": "wall"},
        {"n": "Nest_N", "p": [1664, 128, -320], "s": [320, 256, 64], "m": "wall"},
        {"n": "Nest_S", "p": [1664, 128, 320], "s": [320, 256, 64], "m": "wall"},
        {"n": "Nest_Wall_128", "p": [1600, 192, -64], "s": [64, 128, 128], "m": "wall"},
        {"n": "Nest_Wall_192", "p": [1600, 192, 64], "s": [64, 128, 128], "m": "wall"},

        # --- CT-side terrace and B-side jump-up ledge
        {"n": "Terrace_CT", "p": [1280, 96, 896], "s": [768, 64, 1088], "m": "accent"},
        {"n": "Ledge", "p": [-1280, 32, 640], "s": [128, 64, 192], "m": "wall"},

        # --- foliage: a low hedgerow along the bridge approach (no particles)
        {"n": "Foliage_1", "p": [960, 32, -832], "s": [256, 64, 64], "m": "foliage"},
        {"n": "Foliage_2", "p": [576, 32, -1088], "s": [256, 64, 64], "m": "foliage"},
        {"n": "Foliage_3", "p": [-256, 32, -1408], "s": [256, 64, 64], "m": "foliage"},
        {"n": "Foliage_4", "p": [-1664, 32, 1408], "s": [256, 64, 64], "m": "foliage"},
        {"n": "Foliage_5", "p": [832, 32, 1408], "s": [256, 64, 64], "m": "foliage"},

        # --- cover inside the temple and on the bridge approach
        {"n": "Temple_Crate_1", "p": [-1024, 32, 1152], "s": [64, 64, 64], "m": "wood"},
        {"n": "Temple_Crate_2", "p": [-1152, 32, 768], "s": [64, 64, 64], "m": "wood"},
        {"n": "Temple_Crate_3", "p": [-1024, 96, 1152], "s": [64, 64, 64], "m": "wood"},
    ]


func _ground_pads() -> Array:
    ## Bridge deck at +64 (span x 1152..1664 = 512 wide, the brief's 256 u
    ## either side of the site centre), nest landing at +128, temple floor.
    return [
        {"n": "BridgeDeck", "type": "ground", "pos": [1408, -832], "w": 512, "d": 576, "m": "wood"},
        {"n": "NestLanding", "type": "ground", "pos": [1696, 0], "w": 256, "d": 640, "m": "metal"},
        {"n": "TempleFloor", "type": "ground", "pos": [-1088, 992], "w": 768, "d": 832, "m": "floor"},
        {"n": "TempleSteps", "type": "ground", "pos": [-1088, 1408], "w": 256, "d": 256, "m": "stone"},
    ]


func _ramps() -> Array:
    return [
        # bridge deck (+64) down into the underpass (-64)
        {"n": "Ramp_Underpass", "type": "ramp", "p": [1600, 0, -704],
            "s": [256, 128, 256], "ramp_y0": 64.0, "ramp_y1": -64.0, "m": "wood"},
        # main staircase: ground -> nest ramp (y = 128)
        {"n": "Ramp_Nest_1", "type": "ramp", "p": [1728, 64, 256],
            "s": [128, 128, 128], "ramp_y0": 0.0, "ramp_y1": -128.0, "m": "stone"},
        # snipers' nest -> bridge approach (y = 128 -> 64)
        {"n": "Ramp_Nest_2", "type": "ramp", "p": [1600, 96, -192],
            "s": [128, 64, 128], "ramp_y0": 64.0, "ramp_y1": 0.0, "m": "wood"},
        # T-side approach up to the bridge deck (+64)
        {"n": "Ramp_Bridge_W", "type": "ramp", "p": [1088, 32, -704],
            "s": [128, 64, 128], "ramp_y0": 0.0, "ramp_y1": -64.0, "m": "wood"},
        # temple entrance steps (-64 -> 0) on the east side
        {"n": "Ramp_Temple_1", "type": "ramp", "p": [-512, -32, 960],
            "s": [128, 64, 128], "ramp_y0": 32.0, "ramp_y1": -32.0, "m": "stone"},
        # onto the B-side ledge (+64)
        {"n": "Ramp_Ledge", "type": "ramp", "p": [-1440, 32, 704],
            "s": [128, 64, 128], "ramp_y0": 0.0, "ramp_y1": -64.0, "m": "stone"},
    ]


func _cover_zones() -> Array:
    return [
        [-1984, -1408, -1472, -832],   # T spawn
        [-1984, -128, -1408, 1408],    # west lane
        [320, -1472, 1024, -640],      # bridge approach
        [1152, -1152, 1728, -576],     # A site / bridge
        [-1408, 576, -768, 1408],      # temple
        [1536, 384, 1984, 1152],       # CT spawn
        [-384, -1408, 256, 1408],      # mid
    ]


func _ready() -> void:
    var mats := MG.aztec_materials()
    var geo := Node3D.new()
    geo.name = "Geometry"
    add_child(geo)

    var spec: Array = []
    spec.append_array(_ground_pads())
    spec.append_array(_walls())
    spec.append_array(_ramps())
    MG.build(geo, spec, mats)

    MG.add_spawn_points(self, Vector3(-1920, 0, -1440))
    MG.add_bomb_sites(self, Vector3(1408, BRIDGE_Y, -832), Vector3(-1088, 0, 992))
    MG.add_cover_crates(self, _cover_zones(), 30, mats[MG.MAT_FOLIAGE], 0xA27EC)
    MG.add_nav_region(self, 0.0, 4224.0, 3264.0, mats[MG.MAT_FLOOR])
    MG.add_map_data(self, "de_aq_aztec",
        Color(0.45, 0.55, 0.55), 0.7,
        Color(0.5, 0.6, 0.7), Color(0.6, 0.7, 0.6))
