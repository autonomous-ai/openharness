import 'dart:async';

import 'package:flutter/material.dart';

import '../state/app_state.dart';
import 'message_link.dart';
import 'message_link_swarms.dart';

/// The native URL channel queues message links before sign-in. This host opens
/// them once the person is signed in, and only says "Message unavailable" when
/// they cannot be opened, whatever the reason.
class SwarmMessageLinkHost extends StatefulWidget {
  const SwarmMessageLinkHost({
    super.key,
    required this.app,
    required this.child,
    this.open = openSwarmMessageLink,
  });
  final AppNotifier app;
  final Widget child;
  final Future<bool> Function(AppNotifier, SwarmMessageLink) open;

  @override
  State<SwarmMessageLinkHost> createState() => _SwarmMessageLinkHostState();
}

class _SwarmMessageLinkHostState extends State<SwarmMessageLinkHost> {
  bool _opening = false;

  @override
  void initState() {
    super.initState();
    swarmMessageLinkInbox.addListener(_schedule);
    widget.app.addListener(_schedule);
    _schedule();
  }

  void _schedule() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) unawaited(_next());
    });
    WidgetsBinding.instance.ensureVisualUpdate();
  }

  Future<void> _next() async {
    final app = widget.app;
    if (!mounted ||
        _opening ||
        swarmMessageLinkInbox.pending.isEmpty ||
        app.status != AppStatus.authenticated ||
        app.currentUser?.id == null) {
      return;
    }
    final link = swarmMessageLinkInbox.pending.first;
    _opening = true;
    try {
      // A link is forgotten once tried, so the dialog below never repeats it.
      final opened = await widget
          .open(app, link)
          .whenComplete(() => swarmMessageLinkInbox.complete(link));
      if (mounted && !opened) await _unavailable();
    } finally {
      _opening = false;
      if (mounted) _schedule();
    }
  }

  Future<void> _unavailable() => showDialog<void>(
    context: context,
    builder: (context) => AlertDialog(
      content: const Text('Message unavailable'),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('Close'),
        ),
      ],
    ),
  );

  @override
  void dispose() {
    swarmMessageLinkInbox.removeListener(_schedule);
    widget.app.removeListener(_schedule);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => widget.child;
}
