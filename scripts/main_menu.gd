extends Control
## Minimal main menu. Three buttons: Host, Join, Quit. Wired to main.gd.

@onready var host_button: Button = $VBox/Host
@onready var join_button: Button = $VBox/Join
@onready var quit_button: Button = $VBox/Quit
@onready var address_field: LineEdit = $VBox/Address


func _ready() -> void:
    host_button.pressed.connect(_on_host_pressed)
    join_button.pressed.connect(_on_join_pressed)
    quit_button.pressed.connect(_on_quit_pressed)


func _on_host_pressed() -> void:
    var main := get_tree().root.get_node("Main")
    if main and main.has_method("host_game"):
        main.host_game()


func _on_join_pressed() -> void:
    var address := address_field.text.strip_edges()
    if address.is_empty():
        address = "127.0.0.1"
    var main := get_tree().root.get_node("Main")
    if main and main.has_method("join_game"):
        main.join_game(address)


func _on_quit_pressed() -> void:
    get_tree().quit()