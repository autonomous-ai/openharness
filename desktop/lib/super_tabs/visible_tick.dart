import 'dart:async';

import 'package:flutter/widgets.dart';

/// A panel's timer that runs only while the panel is on screen: its subtree not muted (`Offstage`, a tab that isn't showing) and
/// the app not hidden. Coming back redraws at once, so an age is never stale on screen (Quiet Swarm, Speed). On a phone or a Mac
/// behind other windows that is nothing to redraw and nothing to read.
mixin VisibleTick<T extends StatefulWidget> on State<T>, WidgetsBindingObserver {
  Duration? _every;
  Timer? _tick;
  bool _registered = false;
  bool _appShown = true;
  bool _onScreen = false;
  bool _known = false;

  /// Whether the panel can be seen now.
  bool get onScreen => _onScreen;

  /// Ticks every [every] while on screen. [onTick] redraws unless told otherwise.
  void visibleTick(Duration every) {
    _every = every;
    _observe();
    _restart();
  }

  /// Told when the panel leaves or returns, for what else it does on a timer.
  void onScreenChanged(bool onScreen) {}

  void onTick() {
    if (mounted) setState(() {});
  }

  void _observe() {
    if (_registered) return;
    _registered = true;
    WidgetsBinding.instance.addObserver(this);
    final state = WidgetsBinding.instance.lifecycleState;
    _appShown = state == null || _shows(state);
  }

  static bool _shows(AppLifecycleState state) =>
      state == AppLifecycleState.resumed || state == AppLifecycleState.inactive;

  void _restart() {
    _tick?.cancel();
    _tick = null;
    final every = _every;
    if (every != null && _onScreen) {
      _tick = Timer.periodic(every, (_) => onTick());
    }
  }

  void _settle(bool Function() now) {
    final next = now();
    final moved = _known && next != _onScreen;
    _known = true;
    _onScreen = next;
    if (_every != null && (moved || _tick == null)) _restart();
    if (!moved) return;
    onScreenChanged(next);
    if (next && mounted) setState(() {});
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _observe();
    final enabled = TickerMode.of(context);
    _settle(() => enabled && _appShown);
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _appShown = _shows(state);
    if (!mounted) return;
    final enabled = TickerMode.of(context);
    _settle(() => enabled && _appShown);
  }

  @override
  void dispose() {
    _tick?.cancel();
    if (_registered) WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }
}
