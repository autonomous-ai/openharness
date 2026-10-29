import 'dart:async';

import 'package:flutter/material.dart';

import '../state/app_state.dart';
import 'controller.dart';
import 'message_link.dart';

/// How a message link reaches the other Swarms of the account: the controller
/// of one the account lists, and the way to open a link there.
abstract interface class SwarmLinkSwarms {
  /// [tabId]'s controller once it is loaded, else null: [loading] while a
  /// Swarm the account lists is being loaded ([onLoaded] says when it is), not
  /// while it is one the account does not list.
  ({SuperTabController? controller, bool loading}) controllerFor(
    String tabId,
    VoidCallback onLoaded,
  );

  /// Opens [link]'s Swarm and asks it for the message; false when it cannot.
  Future<bool> open(SwarmMessageLink link);
}

/// The account's Swarms as the app lists them.
class AppLinkSwarms implements SwarmLinkSwarms {
  AppLinkSwarms(this.app);
  final AppNotifier app;
  final _loading = <String>{};

  @override
  ({SuperTabController? controller, bool loading}) controllerFor(
    String tabId,
    VoidCallback onLoaded,
  ) {
    final loaded = app.superTabs.peek(tabId);
    if (loaded != null) return (controller: loaded, loading: false);
    if (!swarmListed(app, tabId)) return (controller: null, loading: false);
    if (_loading.add(tabId)) {
      unawaited(
        app.superTabs
            .open(tabId)
            .then((_) {}, onError: (Object _) {})
            .whenComplete(() {
              _loading.remove(tabId);
              onLoaded();
            }),
      );
    }
    return (controller: null, loading: true);
  }

  @override
  Future<bool> open(SwarmMessageLink link) => openSwarmMessageLink(app, link);
}

/// Whether the account lists the Swarm [tabId], open or closed here.
bool swarmListed(AppNotifier app, String tabId) =>
    app.swarms.any((s) => s.superTabId == tabId) ||
    app.closedSuperTabs.any((s) => s.id == tabId);

/// Brings the Swarm [link] names to the front and asks it to open the message.
/// False when the reader is not in that Swarm (or it cannot be read now): the
/// caller says only that the message is unavailable. A Swarm is opened only if
/// the account already lists it; the Swarm's own view then checks the
/// conversation and the message, so the link grants nothing.
Future<bool> openSwarmMessageLink(
  AppNotifier app,
  SwarmMessageLink link, {
  Future<SuperTabController> Function(String tabId)? controllerFor,
}) async {
  final tabId = link.tabId;
  final open = app.swarms.where((s) => s.superTabId == tabId).firstOrNull;
  final closed = app.closedSuperTabs.where((s) => s.id == tabId).firstOrNull;
  if (open == null && closed == null) return false;
  app.openSuperTab(tabId, open?.name ?? closed!.name);
  try {
    final controller = await (controllerFor ?? app.superTabs.open)(tabId);
    return controller.openMessageLink(link);
  } catch (_) {
    return false;
  }
}

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
