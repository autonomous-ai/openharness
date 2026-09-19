extends Node2D
## A small, complete game. All art is drawn here; no external assets or network.
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

func _ready() -> void:
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
    queue_redraw()

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
    queue_redraw()

func publish() -> void:
    if not OS.has_feature("web"): return
    var state := {"collected":collected.size(),"total":SEEDS.size(),"won":won,"paused":paused,"seconds":snappedf(elapsed,0.1),"cooldown":snappedf(cooldown,0.1),"x":snappedf(pos.x,0.1),"y":snappedf(pos.y,0.1)}
    JavaScriptBridge.eval("window.lumen.update(" + JSON.stringify(state) + ")", true)

func _draw() -> void:
    var mint := Color("bcf2ce")
    var amber := Color("eaca8e")
    var ink := Color("133239")
    draw_rect(Rect2(0,0,1200,700), Color("071218"))
    for i in range(150):
        var star := Vector2(fmod(i * 137.508,1200), fmod(i * 211.37,700))
        draw_circle(star, 0.6 + float(i % 3) * 0.35, Color(0.5,0.8,0.75,0.08+float(i%4)*0.025))
    for radius in range(100,580,80): draw_arc(Vector2(600,350),radius,0,TAU,120,Color("102930"),1,true)
    draw_line(Vector2(45,350),Vector2(1155,350),ink,1,true)
    draw_line(Vector2(600,65),Vector2(600,635),ink,1,true)
    draw_arc(Vector2(600,350),285,0,TAU,100,Color("295047"),1,true)
    for i in SEEDS.size():
        var seed: Vector2 = SEEDS[i]
        var lit := i in collected
        var color: Color = mint if lit else amber
        var sway := sin(elapsed * 1.2 + i) * 0.07
        for petal in range(7):
            var angle := TAU * petal / 7.0 + sway
            var center := seed + Vector2.from_angle(angle) * 21
            draw_arc(center,21,angle-1.9,angle+1.9,24,Color(color,color.a * (0.45 if lit else 0.18)),1.3,true)
        draw_circle(seed,7 if lit else 5,color)
        draw_arc(seed,15 + sin(elapsed*2+i)*2,0,TAU,36,Color(color,0.3),1,true)
        draw_string(ThemeDB.fallback_font,seed+Vector2(-5,70),str(i+1).pad_zeros(2),HORIZONTAL_ALIGNMENT_LEFT,-1,12,Color(color,0.6))
    for i in range(trail.size()-1,0,-1):
        draw_circle(trail[i],maxf(1,7-i*0.19),Color(mint,(1-float(i)/30)*0.22))
    for burst in bursts:
        draw_arc(burst.pos,15+burst.age*80,0,TAU,60,Color(mint,1-burst.age),1.5,true)
    for radius in range(28,7,-4): draw_circle(pos,radius,Color(mint,0.025))
    draw_circle(pos,8,mint)
    draw_arc(pos,13,0,TAU,40,Color(mint,0.55),1.2,true)
    draw_line(pos+direction*16,pos+direction*24,amber,2,true)
    if moving_to_target and not won:
        draw_arc(target,9,0,TAU,30,Color(mint,0.35),1,true)
    draw_string(ThemeDB.fallback_font,Vector2(40,40),"THE QUIET GARDEN   /   01",HORIZONTAL_ALIGNMENT_LEFT,-1,13,Color("6a938e"))
    draw_string(ThemeDB.fallback_font,Vector2(40,675),"GATHER LIGHT. LEAVE A TRAIL.",HORIZONTAL_ALIGNMENT_LEFT,-1,12,Color("6a938e"))
    if won or paused:
        draw_rect(Rect2(360,280,480,140),Color(0.02,0.06,0.08,0.94))
        draw_string(ThemeDB.fallback_font,Vector2(390,336),"The garden is awake." if won else "A moment of stillness.",HORIZONTAL_ALIGNMENT_LEFT,-1,29,mint)
        draw_string(ThemeDB.fallback_font,Vector2(390,378),"Press R to begin again" if won else "Press P to return",HORIZONTAL_ALIGNMENT_LEFT,-1,17,Color("90ada6"))
