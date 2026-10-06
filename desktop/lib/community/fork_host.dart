import 'dart:async';

import 'package:flutter/material.dart';

import '../core/harness_file_store.dart';
import '../core/test_run.dart';
import '../core/models.dart';
import '../state/app_state.dart';
import 'fork_controller.dart';
import 'fork_inbox.dart';
import 'fork_project.dart';

final communityForkInbox = ForkInbox(HarnessFileStore.shared);
Future<void>? _inboxReady;

/// Mounted around every native screen, so links survive setup and sign-in.
class CommunityLinkHost extends StatefulWidget {
  const CommunityLinkHost({super.key, required this.child});
  final Widget child;
  @override
  State<CommunityLinkHost> createState() => _CommunityLinkHostState();
}

class _CommunityLinkHostState extends State<CommunityLinkHost> {
  @override
  void initState() {
    super.initState();
    if (!kUnderTest) _inboxReady ??= communityForkInbox.initialize();
  }

  @override
  Widget build(BuildContext context) => widget.child;
}

class CommunityForkHost extends StatefulWidget {
  const CommunityForkHost({super.key, required this.app, required this.child});
  final AppNotifier app;
  final Widget child;
  @override
  State<CommunityForkHost> createState() => _CommunityForkHostState();
}

class _CommunityForkHostState extends State<CommunityForkHost> {
  late final ForkController controller;
  String? attempted;
  bool running = false;
  @override
  void initState() {
    super.initState();
    controller = ForkController(
      widget.app,
      ForkProjectImporter(),
      HarnessFileStore.shared,
    )..addListener(_changed);
    communityForkInbox.addListener(_schedule);
    widget.app.addListener(_schedule);
    _schedule();
  }

  void _changed() {
    if (mounted) setState(() {});
  }

  void _schedule() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) unawaited(_next());
    });
    WidgetsBinding.instance.ensureVisualUpdate();
  }

  Future<void> _next({bool retry = false}) async {
    if (!mounted ||
        running ||
        communityForkInbox.pending.isEmpty ||
        widget.app.status != AppStatus.authenticated) {
      return;
    }
    if (!retry &&
        widget.app.localMachineState?.connectionStatus !=
            ConnectionStatus.connected) {
      return;
    }
    final link = communityForkInbox.pending.first;
    if (!retry && attempted == link.key) return;
    running = true;
    attempted = link.key;
    try {
      if (await controller.open(link) && mounted) {
        await communityForkInbox.complete(link);
        if (mounted) {
          setState(() {
            attempted = null;
          });
        }
      }
    } finally {
      running = false;
    }
    if (mounted && attempted == null) _schedule();
  }

  @override
  void dispose() {
    communityForkInbox.removeListener(_schedule);
    widget.app.removeListener(_schedule);
    controller.removeListener(_changed);
    controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Column(
    children: [
      if (attempted != null)
        Material(
          color: Theme.of(context).colorScheme.surfaceContainer,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 10),
            child: Row(
              children: [
                if (controller.busy)
                  const Padding(
                    padding: EdgeInsets.only(right: 12),
                    child: SizedBox(
                      width: 14,
                      height: 14,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    ),
                  ),
                Expanded(
                  child: Text(
                    controller.error ??
                        controller.message ??
                        'Opening your fork…',
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ),
                if (!controller.busy) ...[
                  TextButton(
                    onPressed: () => unawaited(_next(retry: true)),
                    child: const Text('Retry'),
                  ),
                  TextButton(
                    onPressed: () async {
                      if (communityForkInbox.pending.isNotEmpty) {
                        await communityForkInbox.complete(
                          communityForkInbox.pending.first,
                        );
                      }
                      if (mounted) {
                        setState(() {
                          attempted = null;
                        });
                      }
                      _schedule();
                    },
                    child: const Text('Dismiss'),
                  ),
                ],
              ],
            ),
          ),
        ),
      Expanded(child: widget.child),
    ],
  );
}
