extends Node3D
## Bare-minimum FPS map. A flat arena with two opposing spawn clusters and a
## simple box geometry so raycasts have something to hit. Replace with a real
## level once art + nav are ready.

func _ready() -> void:
    # Floor
    var floor_mesh := MeshInstance3D.new()
    floor_mesh.mesh = BoxMesh.new()
    (floor_mesh.mesh as BoxMesh).size = Vector3(60, 0.2, 60)
    floor_mesh.position = Vector3(0, -0.1, 0)
    add_child(floor_mesh)

    # A few crates so the world isn't empty.
    for i in 12:
        var crate := MeshInstance3D.new()
        crate.mesh = BoxMesh.new()
        var s := 1.5 + randf() * 1.5
        (crate.mesh as BoxMesh).size = Vector3(s, s, s)
        crate.position = Vector3(randf_range(-20, 20), s * 0.5, randf_range(-20, 20))
        add_child(crate)

    # Two walls forming a simple chokepoint.
    var wall_a := MeshInstance3D.new()
    wall_a.mesh = BoxMesh.new()
    (wall_a.mesh as BoxMesh).size = Vector3(8, 4, 1)
    wall_a.position = Vector3(-6, 2, 4)
    add_child(wall_a)

    var wall_b := MeshInstance3D.new()
    wall_b.mesh = BoxMesh.new()
    (wall_b.mesh as BoxMesh).size = Vector3(8, 4, 1)
    wall_b.position = Vector3(6, 2, -4)
    add_child(wall_b)