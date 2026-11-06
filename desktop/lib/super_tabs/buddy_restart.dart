import 'dart:async';

import 'package:flutter/material.dart';

import '../core/models.dart' show Agent;
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../state/app_state.dart';
import '../state/swarm_navigation.dart' show externalEngineName;
import '../widgets/desktop_chrome.dart';
import 'buddies.dart' show buddyMachineName;
import 'controller.dart';
import 'dialog_scope.dart';

/// Restart the reader's Buddy in [projectId] with extra launch flags, which the
/// machine keeps and applies on every later start of it (spec
/// 2026-11-06-buddy-launch-flags). The restart goes to the Buddy's machine
/// through [app]; the Buddy keeps its conversation.
Future<void> showRestartBuddy(
  BuildContext context,
  SuperTabController c,
  String projectId, {
  AppNotifier? app,
}) => showAppDialog<void>(
  context: context,
  builder: (context) {
    final swarm = projectId == SuperTabController.kSwarmBuddyKey;
    return SuperTabDialogScope(
      controller: c,
      projectId: swarm ? null : projectId,
      conversationId: swarm ? c.buddyChat(projectId)?.id : null,
      child: _RestartBuddyDialog(controller: c, projectId: projectId, app: app),
    );
  },
);

/// [words] as one line the daemon's parser reads back as the same words: a word
/// with a space, quote or backslash is single-quoted.
String launchArgsLine(Iterable<String> words) => words
    .map(
      (w) => w.isNotEmpty && !RegExp(r'''[\s'"\\]''').hasMatch(w)
          ? w
          : "'${w.replaceAll("'", r"'\''")}'",
    )
    .join(' ');

class _RestartBuddyDialog extends StatefulWidget {
  const _RestartBuddyDialog({
    required this.controller,
    required this.projectId,
    required this.app,
  });
  final SuperTabController controller;
  final String projectId;
  final AppNotifier? app;

  @override
  State<_RestartBuddyDialog> createState() => _RestartBuddyDialogState();
}

class _RestartBuddyDialogState extends State<_RestartBuddyDialog> {
  SuperTabController get c => widget.controller;
  AppNotifier? get app => widget.app;

  Agent? get _machineAgent {
    final buddy = c.buddy(widget.projectId);
    if (buddy == null) return null;
    return app
        ?.stateOf(buddy.machineId)
        ?.agents
        .where((a) => a.id == buddy.harnessId)
        .firstOrNull;
  }

  late final _flags = TextEditingController(
    text: launchArgsLine(_machineAgent?.launchArgs ?? const []),
  );
  late final String _saved = launchArgsLine(
    _machineAgent?.launchArgs ?? const [],
  );
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _flags.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final buddy = c.buddy(widget.projectId);
    final app = this.app;
    if (_busy) return;
    if (buddy == null || app == null) {
      setState(() => _error = 'Restart is not available here.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    final text = _flags.text.trim();
    // Nothing to clear and nothing to add is a plain restart, which an older
    // daemon does it as well as a new one.
    final result = await app.restartAgent(
      buddy.machineId,
      buddy.harnessId,
      // Every press is a new intent: an earlier attempt that never confirmed
      // must not turn this one into a status check without the flags.
      attempt: app.restartAttempt(
        buddy.machineId,
        buddy.harnessId,
        fresh: true,
      ),
      launchArgs: text.isEmpty && _saved.isEmpty ? null : text,
    );
    if (!mounted) return;
    if (result.error == null && !result.launchArgsIgnored) {
      Navigator.pop(context);
      return;
    }
    final machine = buddyMachineName(c, buddy.machineId, app: app);
    setState(() {
      _busy = false;
      _error = result.launchArgsIgnored
          ? 'Update Harness on $machine to use launch flags.'
          : result.launchArgsRefused
          ? result.error
          : !result.engineNotStarted
          ? result.error
          : "The Buddy didn't start with these flags. Fix or clear them and "
                'restart.';
    });
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final buddy = c.buddy(widget.projectId);
    final engine = externalEngineName(
      _machineAgent?.engine ?? buddy?.engine ?? '',
    );
    final machine = buddy == null
        ? 'its machine'
        : buddyMachineName(c, buddy.machineId, app: app);
    return AlertDialog(
      title: const Text('Restart Buddy'),
      content: SizedBox(
        width: 440,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              TextField(
                key: const ValueKey('super-buddy-launch-args'),
                controller: _flags,
                autofocus: true,
                readOnly: _busy,
                style: grid.AppType.mono(),
                decoration: const InputDecoration(
                  labelText: 'Extra launch flags',
                  hintText: '--chrome',
                ),
                onSubmitted: (_) => unawaited(_submit()),
              ),
              const SizedBox(height: 8),
              Text(
                "Added to $engine's command line each time this Buddy starts "
                'on $machine. Your Buddy runs with full permissions. Don\'t put '
                'secrets here: other people on that computer can see them. '
                'Clear the field to remove them.',
                style: DesktopChrome.control(color: DesktopChrome.muted),
              ),
              if (_error case final error?) ...[
                const SizedBox(height: 12),
                Text(
                  error,
                  key: const ValueKey('super-buddy-launch-args-error'),
                  style: DesktopChrome.control(),
                ),
              ],
            ],
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: _busy ? null : () => Navigator.pop(context),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: _busy ? null : () => unawaited(_submit()),
          child: _busy
              ? const SizedBox(
                  width: 16,
                  height: 16,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : const Text('Restart'),
        ),
      ],
    );
  }
}
