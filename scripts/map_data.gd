extends Node
class_name MapData
## Per-map environment + identity data. One `MapData` child sits in every map
## scene under `scenes/maps/`; `world.gd` reads it (`apply_map_data`) and pushes
## the values onto the WorldEnvironment + DirectionalLight3D.
##
## Contract: MAPS.md § "Map module contract".
## Godot 4 GL Compatibility only — fog is `Environment.fog_enabled` with a
## linear depth fog, the sky is a ProceduralSkyMaterial gradient (no SDFGI, no
## volumetric fog, no MSAA).

@export var map_id: String
@export var display_name: String
@export var fog_color: Color = Color(0.7, 0.65, 0.55)
## Brightness multiplier for ambient (sky) light. CS 1.6 maps are bright; 0.7-0.8.
@export var ambient_light: float = 0.7
@export var sky_top_color: Color = Color(0.55, 0.65, 0.75)
@export var sky_bottom_color: Color = Color(0.85, 0.78, 0.65)
## Linear depth-fog density. World units: fog starts at 0 and fully occludes
## around 1/density. 0.001 is ~1000 u of visibility, the 1.6 look.
@export var fog_density: float = 0.001
@export var skybox_path: String = ""
