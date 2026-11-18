// The dial's pets as the mockup plays them (PET_ART: per engine and scene, frames and timed steps of layers).
import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

import '../model/types.dart';
import 'tokens.dart';

/// One frame drawn by a step, at (x, y) in the scene's units.
class PetLayer {
  const PetLayer(this.frame, this.x, this.y);
  final int frame;
  final double x, y;
}

/// One step of a scene: the frames it draws, how long it holds, and the relaxing scenes' balls drawn over them.
class PetStep {
  const PetStep(this.layers, this.ms, this.shapes);
  final List<PetLayer> layers;
  final int ms;
  final List<({Path path, Color color})> shapes;
}

/// A scene's art: its canvas in its own units, whether it is pixel art (drawn nearest-neighbour), its frames and steps.
class PetScene {
  const PetScene({required this.w, required this.h, required this.pix, required this.frames, required this.steps});
  final double w, h;
  final bool pix;
  final List<ui.Image> frames;
  final List<PetStep> steps;

  /// The mockup's petInit: the scene scaled to fit [box] whole.
  Size fit(Size box) {
    final z = math.min(box.width / w, box.height / h);
    return Size(w * z, h * z);
  }
}

final Map<String, PetScene> _scenes = {};
Future<void>? _loading;

/// Loads the pets' art (assets/pets/pets.json and its frames) before the first frame, so a page never opens on an
/// empty pet (the mockup decodes every frame up front for the same reason). Await it before runApp; in widget tests,
/// inside tester.runAsync. Loading twice loads once.
Future<void> preloadPets([AssetBundle? bundle]) => _loading ??= _load(bundle ?? rootBundle);

Future<void> _load(AssetBundle bundle) async {
  final art = jsonDecode(await bundle.loadString('assets/pets/pets.json')) as Map<String, dynamic>;
  final loads = <Future<void>>[];
  for (final engine in art.entries) {
    for (final scene in (engine.value as Map<String, dynamic>).entries) {
      loads.add(_scene(bundle, scene.value as Map<String, dynamic>)
          .then((s) => _scenes['${engine.key}/${scene.key}'] = s));
    }
  }
  await Future.wait(loads);
}

Future<PetScene> _scene(AssetBundle bundle, Map<String, dynamic> j) async {
  final frames = await Future.wait([for (final p in j['imgs'] as List) _image(bundle, p as String)]);
  return PetScene(
    w: (j['w'] as num).toDouble(),
    h: (j['h'] as num).toDouble(),
    pix: j['pix'] as bool,
    frames: frames,
    steps: [for (final s in j['steps'] as List) _step(s as Map<String, dynamic>)],
  );
}

Future<ui.Image> _image(AssetBundle bundle, String path) async {
  final data = await bundle.load(path);
  final codec = await ui.instantiateImageCodec(data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes));
  final frame = await codec.getNextFrame();
  codec.dispose();
  return frame.image;
}

double _d(Object? v) => (v as num).toDouble();

PetStep _step(Map<String, dynamic> j) => PetStep(
      [
        for (final l in j['l'] as List) PetLayer((l as List)[0] as int, _d(l[1]), _d(l[2])),
      ],
      j['d'] as int,
      [for (final s in (j['s'] as List?) ?? const []) _shape(s as List)],
    );

/// The mockup's petDraw shapes, in the scene's units: ["disc", x, y, r, rgb] and ["arc", cx, cy, r, w, mid, half, rgb]
/// (a ring's slice r wide w, from mid - half to mid + half degrees, clockwise from +x as the canvas turns).
({Path path, Color color}) _shape(List s) {
  final rgb = s.last as List;
  final color = Color.fromARGB(255, rgb[0] as int, rgb[1] as int, rgb[2] as int);
  if (s[0] == 'disc') {
    return (path: Path()..addOval(Rect.fromCircle(center: Offset(_d(s[1]), _d(s[2])), radius: _d(s[3]))), color: color);
  }
  final c = Offset(_d(s[1]), _d(s[2]));
  final r = _d(s[3]), w = _d(s[4]), mid = _d(s[5]), half = _d(s[6]);
  final a0 = (mid - half) * math.pi / 180, sweep = 2 * half * math.pi / 180;
  final outer = r + w / 2, inner = math.max(0.0, r - w / 2);
  final path = Path()..arcTo(Rect.fromCircle(center: c, radius: outer), a0, sweep, true);
  if (inner > 0) {
    path.arcTo(Rect.fromCircle(center: c, radius: inner), a0 + sweep, -sweep, false);
  } else {
    path.lineTo(c.dx, c.dy);
  }
  path.close();
  return (path: path, color: color);
}

/// A loaded scene ("claude", "work"), null before preloadPets or for a scene the engine has no art for. Every engine
/// other than claude and codex plays the Muse's art.
PetScene? petScene(String engine, String scene) => _scenes['${petEngineOf(engine)}/$scene'];

/// The size a scene takes in [box]: the mockup's canvas, scaled to fit whole ([box] itself before the art is loaded).
/// Pages that lay a pet out as the mockup's flex does (centred with its label under it) size it by this.
Size petFit(String engine, String scene, Size box) => petScene(engine, scene)?.fit(box) ?? box;

/// Plays one scene of an engine's pet, fitted into [size] (bottom-centred, as the mockup's canvas sits in its slot).
/// Each step holds for its own time, then the next is drawn (the mockup's petLoop), looping.
class PetView extends StatefulWidget {
  const PetView({super.key, required this.engine, required this.scene, required this.size, this.animate = true});

  /// "claude", "codex" or "muse" (petEngineOf).
  final String engine;

  /// The scene, as the mockup's sceneFor: work, rest, relax, listen, idle, review, waiting.
  final String scene;
  final Size size;

  /// False holds the first step (the mockup's reduced motion).
  final bool animate;

  @override
  State<PetView> createState() => _PetViewState();
}

class _PetViewState extends State<PetView> {
  int _step = 0;
  Timer? _next;
  bool _ticking = true;

  PetScene? get _art => petScene(widget.engine, widget.scene);

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // A page that is not on the glass (TickerMode off) holds its pets still, as the mockup plays only the page shown.
    final ticking = TickerMode.valuesOf(context).enabled;
    if (ticking != _ticking) {
      _ticking = ticking;
      _schedule();
    }
  }

  @override
  void initState() {
    super.initState();
    _schedule();
  }

  @override
  void didUpdateWidget(PetView old) {
    super.didUpdateWidget(old);
    if (petEngineOf(old.engine) != petEngineOf(widget.engine) || old.scene != widget.scene) {
      _step = 0;   // a new scene starts from its first step, as the mockup's fresh canvas
      _schedule();
    } else if (old.animate != widget.animate) {
      _schedule();
    }
  }

  void _schedule() {
    _next?.cancel();
    _next = null;
    final art = _art;
    if (art == null || !widget.animate || !_ticking || art.steps.length < 2) return;
    if (_step >= art.steps.length) _step = 0;
    _next = Timer(Duration(milliseconds: art.steps[_step].ms), () {
      if (!mounted) return;
      setState(() => _step = (_step + 1) % art.steps.length);
      _schedule();
    });
  }

  @override
  void dispose() {
    _next?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final art = _art;
    if (art == null) return SizedBox.fromSize(size: widget.size);
    return RepaintBoundary(
      child: CustomPaint(size: widget.size, painter: PetPainter(art, _step.clamp(0, art.steps.length - 1))),
    );
  }
}

/// Draws one step of a scene as the mockup's petDraw: the scene scaled to fit, bottom-centred, its frames
/// nearest-neighbour when it is pixel art, then its shapes.
class PetPainter extends CustomPainter {
  const PetPainter(this.art, this.step);
  final PetScene art;

  /// The step drawn, an index into [PetScene.steps].
  final int step;

  @override
  void paint(Canvas canvas, Size size) {
    final fit = art.fit(size);
    final z = fit.width / art.w;
    canvas
      ..save()
      ..translate((size.width - fit.width) / 2, size.height - fit.height)
      ..clipRect(Offset.zero & fit)
      ..scale(z);
    final s = art.steps[step];
    // Pixel art keeps its pixels square at any zoom; the Muse's painted frames are smoothed, as the canvas does.
    final image = Paint()..filterQuality = art.pix ? FilterQuality.none : FilterQuality.low;
    for (final l in s.layers) {
      canvas.drawImage(art.frames[l.frame], Offset(l.x, l.y), image);
    }
    for (final shape in s.shapes) {
      canvas.drawPath(shape.path, Paint()..color = shape.color);
    }
    canvas.restore();
  }

  @override
  bool shouldRepaint(PetPainter old) => old.art != art || old.step != step;
}

/// The scene an agent's pet plays, as the mockup's sceneFor (after the dial's focus.c): a working agent its working
/// scene; one at rest with nothing to show relaxes (Codex has no relaxing art, so it stays on its idle loop); otherwise
/// the small pet (Codex: idle, review when done, waiting when it asks). [list]: a small place (a cell, a card).
String petSceneFor(Agent a, {bool list = false}) {
  final engine = petEngineOf(a.engine);
  if (a.state == AgentState.working) return 'work';
  if (!list && a.said.isEmpty && (a.state == AgentState.idle || a.state == AgentState.done) && engine != 'codex') {
    return 'relax';
  }
  if (engine == 'codex') {
    return switch (a.state) { AgentState.done => 'review', AgentState.asking => 'waiting', _ => 'idle' };
  }
  return 'rest';
}
