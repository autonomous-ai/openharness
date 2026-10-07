import 'package:flutter/widgets.dart';

import 'terminal_p2p_plugin.dart';

/// Coming back to the tab usually means the network changed, which is exactly
/// when a waiting P2P retry should fire and a TURN link may now go direct —
/// what the phone does on returning to the foreground.
class P2pResumeRetry extends StatefulWidget {
  const P2pResumeRetry({super.key, required this.plugins, required this.child});

  final TerminalP2pPlugins plugins;
  final Widget child;

  @override
  State<P2pResumeRetry> createState() => _P2pResumeRetryState();
}

class _P2pResumeRetryState extends State<P2pResumeRetry> {
  late final AppLifecycleListener _lifecycle;

  @override
  void initState() {
    super.initState();
    _lifecycle = AppLifecycleListener(
      onResume: () => widget.plugins.kickRetry(),
    );
  }

  @override
  void dispose() {
    _lifecycle.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => widget.child;
}
