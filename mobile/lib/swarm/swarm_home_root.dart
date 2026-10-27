import 'package:flutter/widgets.dart';

import '../phone/out_of_sight.dart';
import '../settings/experimental_features.dart';

/// What the root of the phone's stack shows. While Settings ▸ Experimental ▸
/// Swarm is on, Swarm Home, until the person goes to Harness from its drawer
/// (or something opens an agent); while it is off, the terminal, as it always
/// was. Turning Swarm on makes Swarm Home the root again.
///
/// The shell's, for its lifetime: the root is built once, inside the
/// navigator's `onGenerateRoute`, so it listens rather than being handed a
/// value.
class SwarmHomeChoice extends ChangeNotifier {
  SwarmHomeChoice(this.features) : _on = features.isOn(PhoneExperiment.swarm) {
    features.addListener(_switched);
  }

  final ExperimentalFeaturesStore features;
  bool _on, _harness = false;

  /// Swarm Home is the root.
  bool get swarm => _on && !_harness;

  /// Harness is the root, with Swarm Home to go back to.
  bool get harnessOverSwarm => _on && _harness;

  void showHarness() {
    if (_harness) return;
    _harness = true;
    notifyListeners();
  }

  void showSwarm() {
    if (!_harness) return;
    _harness = false;
    notifyListeners();
  }

  void _switched() {
    final on = features.isOn(PhoneExperiment.swarm);
    if (on == _on) return;
    _on = on;
    _harness = false;
    notifyListeners();
  }

  @override
  void dispose() {
    features.removeListener(_switched);
    super.dispose();
  }
}

/// The root of the phone's stack: Swarm Home or [harness], as [choice] says.
///
/// [harness] (the terminal home) is built the first time it is shown, and
/// then kept, out of sight, while Swarm Home is up: a terminal is slow to
/// open, and the person comes back to it as they left it. Out of sight it
/// paints and builds nothing, takes no touches or focus, and its animations
/// and its listening to the app stop ([OutOfSight]). With
/// Swarm off it is all there is, exactly as before Swarm Home.
class SwarmHomeRoot extends StatefulWidget {
  const SwarmHomeRoot({
    super.key,
    required this.choice,
    required this.harness,
    required this.swarm,
  });

  final SwarmHomeChoice choice;
  final Widget harness;

  /// Swarm Home; made again each time it is shown.
  final WidgetBuilder swarm;

  @override
  State<SwarmHomeRoot> createState() => _SwarmHomeRootState();
}

class _SwarmHomeRootState extends State<SwarmHomeRoot> {
  /// Keeps the terminal's state when Swarm Home comes and goes beside it.
  final _harness = GlobalKey(debugLabel: 'harness');

  /// The terminal as last shown: handed back unchanged while it is out of sight, so a rebuild of
  /// this root (the shell rebuilding the stack under a page pushed over Swarm Home) leaves it alone.
  /// Null until it is first shown.
  Widget? _harnessShown;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.choice,
    builder: (context, _) {
      final swarm = widget.choice.swarm;
      if (!swarm) _harnessShown = widget.harness;
      return Stack(
        fit: StackFit.expand,
        children: [
          // Out of sight it neither paints nor builds: its listeners stop ([OutOfSight]) and its
          // terminal holds its output in the buffer, drawing it once shown (xterm's own
          // `renderingEnabled`, off with the tickers).
          if (_harnessShown case final harness?)
            KeyedSubtree(
              key: _harness,
              child: Offstage(
                offstage: swarm,
                child: TickerMode(
                  enabled: !swarm,
                  child: ExcludeFocus(
                    excluding: swarm,
                    child: OutOfSight(hidden: swarm, child: harness),
                  ),
                ),
              ),
            ),
          if (swarm) widget.swarm(context),
        ],
      );
    },
  );
}
