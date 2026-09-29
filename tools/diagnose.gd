extends SceneTree
## Environment probe — prints what Godot actually resolved, which is hard to
## read out of the game log.
##
##   godot --headless --path . --script tools/diagnose.gd   # settings only
##   godot           --path . --script tools/diagnose.gd   # + real GPU/renderer
##
## Run the windowed form when you need to know which RENDERER is really in use:
## under --headless Godot substitutes a dummy renderer, so the adapter line tells
## you nothing.
func _initialize() -> void:
	print("=== battle-aq environment ===")
	print("godot                 : ", Engine.get_version_info().get("string", "?"))
	print("video adapter         : ", RenderingServer.get_video_adapter_name())
	print("video api             : ", RenderingServer.get_video_adapter_api_version())
	print("renderer (configured) : ", ProjectSettings.get_setting("rendering/renderer/rendering_method", "<unset>"))
	print("renderer .mobile      : ", ProjectSettings.get_setting("rendering/renderer/rendering_method.mobile", "<unset>"))
	print("main scene            : ", ProjectSettings.get_setting("application/run/main_scene", "<unset>"))
	print("icon                  : ", ProjectSettings.get_setting("application/config/icon", "<unset>"))
	for name in ["Net", "GameState"]:
		print("autoload %-13s: %s" % [name, ProjectSettings.get_setting("autoload/" + name, "<unset>")])
	quit()
