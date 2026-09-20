extends Node2D
## Retained procedural artwork. Draw each primitive once, then animate CanvasItem
## transforms/modulation. Re-tessellating everything per tick stalls WebGL drivers.
const MINT := Color("bcf2ce")
const AMBER := Color("eaca8e")

class Ink extends Node2D:
    var paint: Callable
    func _draw() -> void:
        paint.call(self)

var flowers: Array[Node2D] = []
var trail_dots: Array[Node2D] = []
var burst_rings: Array[Node2D] = []
var player: Node2D
var destination: Node2D
var pause_card: Node2D
var win_card: Node2D

func layer(parent: Node, paint: Callable) -> Node2D:
    var ink := Ink.new()
    ink.paint = paint
    parent.add_child(ink)
    return ink

func create(seeds: Array) -> void:
    layer(self, func(ink: Node2D):
        ink.draw_rect(Rect2(0,0,1200,700), Color("071218"))
        for i in range(150):
            var star := Vector2(fmod(i * 137.508,1200), fmod(i * 211.37,700))
            ink.draw_circle(star,0.6+float(i%3)*0.35,Color(0.5,0.8,0.75,0.08+float(i%4)*0.025))
        for radius in range(100,580,80):
            ink.draw_arc(Vector2(600,350),radius,0,TAU,120,Color("102930"),1,true)
        ink.draw_line(Vector2(45,350),Vector2(1155,350),Color("133239"),1,true)
        ink.draw_line(Vector2(600,65),Vector2(600,635),Color("133239"),1,true)
        ink.draw_arc(Vector2(600,350),285,0,TAU,100,Color("295047"),1,true)
        ink.draw_string(ThemeDB.fallback_font,Vector2(40,40),"THE QUIET GARDEN   /   01",HORIZONTAL_ALIGNMENT_LEFT,-1,13,Color("6a938e"))
        ink.draw_string(ThemeDB.fallback_font,Vector2(40,675),"GATHER LIGHT. LEAVE A TRAIL.",HORIZONTAL_ALIGNMENT_LEFT,-1,12,Color("6a938e"))
    )
    for i in seeds.size():
        var flower := Node2D.new()
        flower.position = seeds[i]
        add_child(flower)
        flowers.append(flower)
        layer(flower, func(ink: Node2D):
            for petal in range(7):
                var angle := TAU * petal / 7.0
                ink.draw_arc(Vector2.from_angle(angle)*21,21,angle-1.9,angle+1.9,24,Color(1,1,1,0.45),1.3,true)
        )
        layer(flower, func(ink: Node2D): ink.draw_circle(Vector2.ZERO,5,Color.WHITE))
        layer(flower, func(ink: Node2D): ink.draw_arc(Vector2.ZERO,15,0,TAU,36,Color(1,1,1,0.3),1,true))
        var number := str(i+1).pad_zeros(2)
        layer(flower, func(ink: Node2D): ink.draw_string(ThemeDB.fallback_font,Vector2(-5,70),number,HORIZONTAL_ALIGNMENT_LEFT,-1,12,Color(1,1,1,0.6)))
    for i in range(30):
        var dot := layer(self, func(ink: Node2D): ink.draw_circle(Vector2.ZERO,7,MINT))
        dot.visible = false
        trail_dots.append(dot)
    # At most six simultaneous pickups; reuse the rings across restarts.
    for i in seeds.size():
        var ring := layer(self, func(ink: Node2D): ink.draw_arc(Vector2.ZERO,15,0,TAU,60,MINT,1.5,true))
        ring.visible = false
        burst_rings.append(ring)
    player = layer(self, func(ink: Node2D):
        for radius in range(28,7,-4): ink.draw_circle(Vector2.ZERO,radius,Color(MINT,0.025))
        ink.draw_circle(Vector2.ZERO,8,MINT)
        ink.draw_arc(Vector2.ZERO,13,0,TAU,40,Color(MINT,0.55),1.2,true)
        ink.draw_line(Vector2(16,0),Vector2(24,0),AMBER,2,true)
    )
    destination = layer(self, func(ink: Node2D): ink.draw_arc(Vector2.ZERO,9,0,TAU,30,Color(MINT,0.35),1,true))
    pause_card = card("A moment of stillness.","Press P to return")
    win_card = card("The garden is awake.","Press R to begin again")

func card(title: String, detail: String) -> Node2D:
    return layer(self, func(ink: Node2D):
        ink.draw_rect(Rect2(360,280,480,140),Color(0.02,0.06,0.08,0.94))
        ink.draw_string(ThemeDB.fallback_font,Vector2(390,336),title,HORIZONTAL_ALIGNMENT_LEFT,-1,29,MINT)
        ink.draw_string(ThemeDB.fallback_font,Vector2(390,378),detail,HORIZONTAL_ALIGNMENT_LEFT,-1,17,Color("90ada6"))
    )

func animate(pos: Vector2, direction: Vector2, elapsed: float, collected: Array[int], trail: Array[Vector2], bursts: Array, target: Vector2, moving: bool, paused: bool, won: bool) -> void:
    for i in flowers.size():
        var flower := flowers[i]
        var lit := i in collected
        flower.modulate = MINT if lit else AMBER
        flower.get_child(0).rotation = sin(elapsed*1.2+i)*0.07
        flower.get_child(0).modulate.a = 1.0 if lit else 0.4
        flower.get_child(1).scale = Vector2.ONE * (1.4 if lit else 1.0)
        flower.get_child(2).scale = Vector2.ONE * (1.0+sin(elapsed*2+i)*2.0/15.0)
    for i in trail_dots.size():
        var dot := trail_dots[i]
        dot.visible = i > 0 and i < trail.size()
        if dot.visible:
            dot.position = trail[i]
            dot.scale = Vector2.ONE * maxf(1,7-i*0.19)/7.0
            dot.modulate.a = (1.0-float(i)/30)*0.22
    for i in burst_rings.size():
        var ring := burst_rings[i]
        ring.visible = i < bursts.size()
        if ring.visible:
            ring.position = bursts[i].pos
            ring.scale = Vector2.ONE * (1.0+bursts[i].age*80.0/15.0)
            ring.modulate.a = 1.0-bursts[i].age
    player.position = pos
    player.rotation = direction.angle()
    destination.position = target
    destination.visible = moving and not won
    pause_card.visible = paused and not won
    win_card.visible = won
