import 'dart:async';

import 'package:flutter/widgets.dart';

/// Calls [read] every [every] while the app can be seen. While it is hidden (minimized, another app's window in front, or
/// paused) nothing is read: a GitHub read spends its person's rate limit and this computer's time. Back in sight, it reads at
/// once and goes on.
class SwarmForegroundRefresh with WidgetsBindingObserver {
  SwarmForegroundRefresh(this.every, this.read) {
    WidgetsBinding.instance.addObserver(this);
    _seen = _visible(WidgetsBinding.instance.lifecycleState);
    if (_seen) _start();
  }

  final Duration every;
  final VoidCallback read;
  Timer? _timer;
  late bool _seen;

  /// Inactive is a window without focus, still in sight (beside another app's): it keeps reading.
  static bool _visible(AppLifecycleState? state) =>
      state == null ||
      state == AppLifecycleState.resumed ||
      state == AppLifecycleState.inactive;

  void _start() {
    _timer?.cancel();
    _timer = Timer.periodic(every, (_) => read());
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final seen = _visible(state);
    if (seen == _seen) return;
    _seen = seen;
    if (seen) {
      read();
      _start();
    } else {
      _timer?.cancel();
      _timer = null;
    }
  }

  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _timer?.cancel();
  }
}
