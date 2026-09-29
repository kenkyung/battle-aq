extends Control
## Main menu: Host / Join / Quit.
##
## All three actions go through the `Net` autoload (scripts/main.gd), which
## owns the peer and survives scene changes. This scene is `run/main_scene`,
## so with no CLI flags the player lands here.

@onready var host_button: Button = $VBox/Host
@onready var join_button: Button = $VBox/Join
@onready var quit_button: Button = $VBox/Quit
@onready var address_field: LineEdit = $VBox/Address
@onready var status_label: Label = $VBox/Status


func _ready() -> void:
	host_button.pressed.connect(_on_host_pressed)
	join_button.pressed.connect(_on_join_pressed)
	quit_button.pressed.connect(_on_quit_pressed)
	address_field.text_submitted.connect(_on_address_submitted)
	# Default target: this machine, so "Join" alone is a local test.
	address_field.placeholder_text = "Server address (LAN or Tailscale IP)"
	_set_status("Ready. Host, or enter an address and Join.")
	# Auto-focus the address box so a joiner can type immediately.
	address_field.grab_focus()


func _on_host_pressed() -> void:
	_set_status("Hosting...")
	var net := get_node_or_null("/root/Net")
	if net == null:
		_set_status("ERROR: Net autoload missing")
		return
	net.host_game()


func _on_join_pressed() -> void:
	_join_with(address_field.text.strip_edges())


func _on_address_submitted(text: String) -> void:
	_join_with(text.strip_edges())


func _join_with(address: String) -> void:
	if address.is_empty():
		address = "127.0.0.1"
	_set_status("Connecting to %s..." % address)
	var net := get_node_or_null("/root/Net")
	if net == null:
		_set_status("ERROR: Net autoload missing")
		return
	net.join_game(address)


func _on_quit_pressed() -> void:
	get_tree().quit()


func _set_status(text: String) -> void:
	if status_label != null:
		status_label.text = text
