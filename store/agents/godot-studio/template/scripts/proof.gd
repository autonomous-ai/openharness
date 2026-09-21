extends SceneTree
## Exercise actual game methods, without JavaScript or a display.
func _initialize() -> void:
    call_deferred("run")

func require(condition: bool, message: String) -> void:
    if not condition:
        push_error(message)
        quit(1)
        assert(false, message)

func run() -> void:
    var game = load("res://scenes/Main.tscn").instantiate()
    root.add_child(game)
    game.set_physics_process(false)
    require(game.pos == game.START, "player spawn")
    game.advance(0.1, Vector2.RIGHT)
    require(game.pos.x > game.START.x, "movement changes player position")
    game.update_art()
    require(game.garden.player.position == game.pos, "retained artwork follows actual game state")
    var visual_count: int = game.garden.get_child_count()
    for i in range(120): game.update_art()
    require(game.garden.get_child_count() == visual_count, "animation reuses a bounded set of visual nodes")
    game.dash()
    var before: float = game.pos.x
    game.advance(0.05, Vector2.RIGHT)
    require(game.pos.x - before > 30, "dash increases speed")
    game.paused = true
    before = game.pos.x
    game.advance(0.2, Vector2.RIGHT)
    require(game.pos.x == before, "pause stops movement")
    game.paused = false
    game.advance(20, Vector2.RIGHT)
    require(game.pos.x <= 1155, "player stays inside arena")
    for seed in game.SEEDS:
        game.pos = seed
        game.advance(0, Vector2.ZERO)
    require(game.won and game.collected.size() == 6, "collecting all seeds wins")
    game.reset_game()
    require(not game.won and game.collected.is_empty() and game.pos == game.START, "restart clears game state")
    var output := OS.get_environment("HARNESS_BUILD_DIR")
    if output.is_empty(): output = "user://"
    var file := FileAccess.open(output.path_join("proof.json"), FileAccess.WRITE)
    require(file != null, "proof receipt is writable")
    file.store_string(JSON.stringify({"passed":true,"checks":["spawn","movement","artwork follows gameplay","bounded visual nodes","dash","pause","bounds","pickups and win","restart"]}))
    file.close()
    print("Lumen: all 9 gameplay and rendering assertions passed")
    game.free()
    quit(0)
