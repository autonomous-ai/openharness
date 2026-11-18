// Ambient (the mockup's `.am`): the clock and the date on the left, the pets relaxing in the middle, the bar's mood on
// the right ("All quiet", "Not connected", "No agents yet"), over the drifting specks. A tap wakes the bar.
import 'package:flutter/scheduler.dart';
import 'package:flutter/widgets.dart';

import '../../model/bar_model.dart';
import '../../model/types.dart';
import '../ambient/aurora.dart';
import '../ambient/clock_face.dart';
import '../attention/pet_fit.dart';
import '../pet.dart';
import '../tokens.dart';

class AmbientPage extends StatefulWidget {
  const AmbientPage({super.key, required this.model});
  final BarModel model;

  @override
  State<AmbientPage> createState() => _AmbientPageState();
}

/// The specks start a second into their drift, so the page opens on trails rather than on bare dots.
const double _warmMs = 1000;

class _AmbientPageState extends State<AmbientPage> with SingleTickerProviderStateMixin {
  late final Ticker _ticker = createTicker(_tick);
  final AuroraField _field = AuroraField(kCanvas)..runTo(_warmMs, catchUp: 60);

  /// The specks' clock in ms (the painter repaints on it), and the whole seconds (the clock rebuilds on them).
  final ValueNotifier<double> _ms = ValueNotifier(_warmMs);
  final ValueNotifier<int> _second = ValueNotifier(0);

  BarModel get model => widget.model;

  @override
  void initState() {
    super.initState();
    _ticker.start();
  }

  @override
  void dispose() {
    _ticker.dispose();
    _ms.dispose();
    _second.dispose();
    super.dispose();
  }

  void _tick(Duration elapsed) {
    final ms = elapsed.inMicroseconds / 1000;
    _ms.value = _warmMs + ms;
    _second.value = ms ~/ 1000;
  }

  @override
  Widget build(BuildContext context) => GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: model.wake,
        child: Stack(fit: StackFit.expand, children: [
          RepaintBoundary(child: CustomPaint(painter: AuroraPainter(_field, _ms))),
          Row(children: [
            SizedBox(
              width: 520,
              child: Padding(
                padding: const EdgeInsets.only(left: 64),
                child: Align(
                  alignment: Alignment.centerLeft,
                  child: RepaintBoundary(
                    child: ValueListenableBuilder<int>(
                      valueListenable: _second,
                      builder: (context, s, _) => ClockFace(time: model.now(), colonLit: s.isEven),
                    ),
                  ),
                ),
              ),
            ),
            const Expanded(child: _Pets()),
            SizedBox(width: 340, child: ListenableBuilder(listenable: model, builder: (context, _) => _mood())),
          ]),
        ]),
      );

  Widget _mood() {
    final words = switch (model.mood) {
      AmbientMood.quiet => 'All quiet',
      AmbientMood.notConnected => 'Not connected',
      AmbientMood.noAgents => 'No agents yet',
    };
    return Padding(
      padding: const EdgeInsets.only(right: 56),
      child: Column(mainAxisAlignment: MainAxisAlignment.center, crossAxisAlignment: CrossAxisAlignment.end, children: [
        Text(words, textAlign: TextAlign.right, style: Face.s(30, weight: FontWeight.w600, color: Ink.words)),
        // Only a bar with a computer and agents has someone to talk to.
        if (model.mood == AmbientMood.quiet) ...[
          const SizedBox(height: 8),
          Text('Tap to talk', textAlign: TextAlign.right, style: Face.s(22, color: Ink.rest)),
        ],
      ]),
    );
  }
}

/// Claude and the Muse relaxing and Codex idling, standing on one line 22 px off the foot, 56 px apart.
class _Pets extends StatelessWidget {
  const _Pets();

  static const _pets = [('claude', 'relax', Size(150, 220)), ('muse', 'relax', Size(150, 250)), ('codex', 'idle', Size(120, 140))];

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: 22),
        child: Row(mainAxisAlignment: MainAxisAlignment.center, crossAxisAlignment: CrossAxisAlignment.end, children: [
          for (var i = 0; i < _pets.length; i++) ...[
            if (i > 0) const SizedBox(width: 56),
            RepaintBoundary(
              child: PetView(
                  engine: _pets[i].$1, scene: _pets[i].$2, size: petFit(_pets[i].$1, _pets[i].$2, _pets[i].$3)),
            ),
          ],
        ]),
      );
}
