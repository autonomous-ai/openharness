import 'dart:ui' show AppExitResponse;

import 'package:flutter/widgets.dart';

import 'harness_stats.dart';

/// Writes [harnessStats] out when the app quits. Renders [child] unchanged.
///
/// Only `didRequestAppExit` is hooked, which covers ⌘Q, the app menu's Quit and
/// an OS log-out. Intercepting the window's close button needs
/// `windowManager.setPreventClose(true)` and a matching `destroy()` call — and
/// a bug on that path leaves a window the user cannot close.
class StatsLifecycle extends StatefulWidget {
  const StatsLifecycle({super.key, required this.child});

  final Widget child;

  @override
  State<StatsLifecycle> createState() => _StatsLifecycleState();
}

class _StatsLifecycleState extends State<StatsLifecycle>
    with WidgetsBindingObserver {
  bool _closed = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  Future<AppExitResponse> didRequestAppExit() async {
    if (!_closed) {
      _closed = true;
      // Awaited: a local file write that finishes in milliseconds, and the ONLY
      // place a turn still running at quit gets its time counted — the
      // debounce timer is cancelled by the process exiting, not fired by it.
      await harnessStats.flush();
    }
    return AppExitResponse.exit;
  }

  @override
  Widget build(BuildContext context) => widget.child;
}
