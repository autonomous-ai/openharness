import 'package:flutter/widgets.dart';

import '../phone/out_of_sight.dart';
import '../settings/experimental_features.dart';

/// What the root of the phone's stack shows. While Settings ▸ Experimental ▸
/// Swarm is on, Swarm Home, until something opens an agent; while it is off,
/// the terminal, as it always was. Turning Swarm on makes Swarm Home the root
/// again.
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
/// Each is built the first time it is shown, and then kept, out of sight,
/// while the other is up: the person comes back to it as they left it — the
/// terminal attached, Home scrolled where it was. Out of sight it paints and
/// builds nothing, takes no touches or focus, and its animations and its
/// listening stop ([OutOfSight]). With Swarm off the terminal is all there is,
/// exactly as before Swarm Home.
class SwarmHomeRoot extends StatefulWidget {
  const SwarmHomeRoot({
    super.key,
    required this.choice,
    required this.harness,
    required this.swarm,
  });

  final SwarmHomeChoice choice;
  final Widget harness;

  /// Swarm Home; made the first time it is shown.
  final WidgetBuilder swarm;

  @override
  State<SwarmHomeRoot> createState() => _SwarmHomeRootState();
}

class _SwarmHomeRootState extends State<SwarmHomeRoot> {
  /// Keep each one's state while the other comes and goes beside it.
  final _harness = GlobalKey(debugLabel: 'harness');
  final _swarm = GlobalKey(debugLabel: 'swarm');

  /// Each as last shown: handed back unchanged while it is out of sight, so a
  /// rebuild of this root (the shell rebuilding the stack under a page pushed
  /// over it) leaves it alone. Null until it is first shown; Swarm Home's
  /// goes again with Swarm turned off.
  Widget? _harnessShown, _swarmShown;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.choice,
    builder: (context, _) {
      final choice = widget.choice;
      final swarm = choice.swarm;
      if (!swarm) _harnessShown = widget.harness;
      if (swarm) _swarmShown = widget.swarm(context);
      if (!swarm && !choice.harnessOverSwarm) _swarmShown = null;
      return Stack(
        fit: StackFit.expand,
        children: [
          // The terminal holds its output in its buffer while out of sight,
          // and draws it once shown (xterm's own `renderingEnabled`, off with
          // the tickers).
          if (_harnessShown case final harness?)
            _Kept(key: _harness, hidden: swarm, child: harness),
          if (_swarmShown case final home?)
            _Kept(key: _swarm, hidden: !swarm, child: home),
        ],
      );
    },
  );
}

/// [child] at the root, or kept out of sight while [hidden].
class _Kept extends StatelessWidget {
  const _Kept({super.key, required this.hidden, required this.child});

  final bool hidden;
  final Widget child;

  @override
  Widget build(BuildContext context) => Offstage(
    offstage: hidden,
    child: TickerMode(
      enabled: !hidden,
      child: ExcludeFocus(
        excluding: hidden,
        child: OutOfSight(hidden: hidden, child: child),
      ),
    ),
  );
}
