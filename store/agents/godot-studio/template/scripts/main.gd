extends Node2D
## A small, complete game. Procedural art is cached in garden.gd; no external assets.
const SEEDS := [Vector2(450,350), Vector2(700,200), Vector2(930,350), Vector2(750,525), Vector2(430,530), Vector2(230,190)]
const START := Vector2(270,350)
var pos := START
var target := START
var direction := Vector2.RIGHT
var collected: Array[int] = []
var trail: Array[Vector2] = []
var bursts: Array = []
var elapsed := 0.0
var cooldown := 0.0
var dash_left := 0.0
var won := false
var paused := false
var moving_to_target := false
var bridge_tick := 0.0
var input_bridge: JavaScriptObject
var command_callback: JavaScriptObject
var garden: Node2D

func _ready() -> void:
    garden = preload("res://scripts/garden.gd").new()
    add_child(garden)
    garden.create(SEEDS)
    reset_game()
    if OS.has_feature("web"):
        input_bridge = JavaScriptBridge.get_interface("lumen")
        command_callback = JavaScriptBridge.create_callback(_web_command)
        input_bridge.command = command_callback
        publish()

func _web_command(args: Array) -> void:
    if args[0] == "restart": reset_game()
    elif args[0] == "pause": paused = not paused
    elif args[0] == "dash": dash()
    publish()

func reset_game() -> void:
    pos = START
    target = START
    collected.clear()
    trail.clear()
    bursts.clear()
    elapsed = 0
    cooldown = 0
    dash_left = 0
    won = false
    paused = false
    moving_to_target = false
    update_art()

func dash() -> void:
    if cooldown <= 0 and not paused and not won:
        cooldown = 1.4
        dash_left = 0.18

func _unhandled_input(event: InputEvent) -> void:
    if event is InputEventKey and event.pressed and not event.echo:
        if event.keycode == KEY_R or event.keycode == KEY_ENTER: reset_game()
        if event.keycode == KEY_SPACE: dash()
        if event.keycode == KEY_P: paused = not paused
    if event is InputEventMouseButton and event.pressed and event.button_index == MOUSE_BUTTON_LEFT:
        target = get_global_mouse_position()
        moving_to_target = true
    if event is InputEventScreenTouch and event.pressed:
        target = event.position
        moving_to_target = true

func advance(delta: float, move: Vector2) -> void:
    if paused or won: return
    elapsed += delta
    cooldown = maxf(0, cooldown - delta)
    dash_left = maxf(0, dash_left - delta)
    if move.length_squared() > 0:
        direction = move.normalized()
        pos += move.limit_length() * (760.0 if dash_left > 0 else 260.0) * delta
    pos = pos.clamp(Vector2(45,65), Vector2(1155,635))
    for i in SEEDS.size():
        if i not in collected and pos.distance_to(SEEDS[i]) < 32:
            collected.append(i)
            bursts.append({"pos":SEEDS[i],"age":0.0})
    won = collected.size() == SEEDS.size()

func _physics_process(delta: float) -> void:
    var move := Vector2(float(Input.is_key_pressed(KEY_RIGHT) or Input.is_key_pressed(KEY_D)) - float(Input.is_key_pressed(KEY_LEFT) or Input.is_key_pressed(KEY_A)), float(Input.is_key_pressed(KEY_DOWN) or Input.is_key_pressed(KEY_S)) - float(Input.is_key_pressed(KEY_UP) or Input.is_key_pressed(KEY_W)))
    if move.length_squared() > 0: moving_to_target = false
    elif moving_to_target:
        if pos.distance_to(target) < 6: moving_to_target = false
        else: move = (target - pos).normalized() * minf(1, pos.distance_to(target) / (260 * delta))
    advance(delta, move)
    if not paused:
        trail.push_front(pos)
        if trail.size() > 30: trail.pop_back()
        for burst in bursts: burst.age += delta
        bursts = bursts.filter(func(b): return b.age < 1.0)
    bridge_tick += delta
    if bridge_tick > 0.1:
        publish()
        bridge_tick = 0
    update_art()

func update_art() -> void:
    garden.animate(pos, direction, elapsed, collected, trail, bursts, target, moving_to_target, paused, won)

func publish() -> void:
    if not OS.has_feature("web"): return
    var state := {"collected":collected.size(),"total":SEEDS.size(),"won":won,"paused":paused,"seconds":snappedf(elapsed,0.1),"cooldown":snappedf(cooldown,0.1),"x":snappedf(pos.x,0.1),"y":snappedf(pos.y,0.1)}
    JavaScriptBridge.eval("window.lumen.update(" + JSON.stringify(state) + ")", true)
