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
import 'model.dart' show SuperTabAgent;

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

/// [line] split the way a shell splits words: whitespace, single and double
/// quotes and backslash escapes, no expansion. Null for an unclosed quote or a
/// trailing backslash. The inverse of [launchArgsLine].
List<String>? splitLaunchArgs(String line) {
  final words = <String>[];
  final word = StringBuffer();
  var inWord = false;
  String? quote;
  for (var i = 0; i < line.length; i++) {
    final ch = line[i];
    if (quote == "'") {
      if (ch == "'") {
        quote = null;
      } else {
        word.write(ch);
      }
    } else if (quote == '"') {
      if (ch == '"') {
        quote = null;
      } else if (ch == r'\') {
        if (i + 1 >= line.length) return null;
        final next = line[i + 1];
        if (next == '"' || next == r'\') {
          word.write(next);
          i++;
        } else {
          word.write(ch);
        }
      } else {
        word.write(ch);
      }
    } else if (ch == "'" || ch == '"') {
      quote = ch;
      inWord = true;
    } else if (ch == r'\') {
      if (i + 1 >= line.length) return null;
      word.write(line[++i]);
      inWord = true;
    } else if (RegExp(r'\s').hasMatch(ch)) {
      if (inWord) words.add(word.toString());
      word.clear();
      inWord = false;
    } else {
      word.write(ch);
      inWord = true;
    }
  }
  if (quote != null) return null;
  if (inWord) words.add(word.toString());
  return words;
}

/// The reader's Buddy behind their Buddy chat in [projectId]: the main Buddy
/// that chat names, so with several Buddies (#3818) it is that chat's, not
/// another's; else the reader's Buddy in [projectId].
SuperTabAgent? readerBuddy(SuperTabController c, String projectId) {
  final snapshot = c.snapshot;
  final named = c
      .buddyChat(projectId)
      ?.agentIds
      .map((id) => snapshot?.agent(id))
      .whereType<SuperTabAgent>()
      .where((a) => a.isMainBuddy && a.buddyOf == c.accountId)
      .firstOrNull;
  return named ?? c.buddy(projectId);
}

/// The machine's agent behind the reader's Buddy in [projectId], if loaded.
Agent? buddyMachineAgent(
  SuperTabController c,
  String projectId,
  AppNotifier? app,
) {
  final buddy = readerBuddy(c, projectId);
  if (buddy == null) return null;
  return app
      ?.stateOf(buddy.machineId)
      ?.agents
      .where((a) => a.id == buddy.harnessId)
      .firstOrNull;
}

enum BuddyRestartOutcome { done, ignored, refused, notStarted, failed }

class BuddyRestartResult {
  const BuddyRestartResult(this.outcome, [this.message]);
  final BuddyRestartOutcome outcome;

  /// The exact line to show; null on [BuddyRestartOutcome.done].
  final String? message;
}

/// Restart (or resume) the reader's Buddy in [projectId] with the flags in
/// [text]; [saved] is the line the machine holds now.
Future<BuddyRestartResult> restartBuddyWithFlags(
  SuperTabController c,
  String projectId,
  AppNotifier app, {
  required String text,
  required String saved,
}) async {
  final buddy = readerBuddy(c, projectId);
  if (buddy == null) {
    return const BuddyRestartResult(
      BuddyRestartOutcome.failed,
      'Restart is not available here.',
    );
  }
  // Nothing to clear and nothing to add is a plain restart, which an older
  // daemon does as well as a new one.
  final result = await app.restartAgent(
    buddy.machineId,
    buddy.harnessId,
    // Every press is a new intent: an earlier attempt that never confirmed
    // must not turn this one into a status check without the flags.
    attempt: app.restartAttempt(buddy.machineId, buddy.harnessId, fresh: true),
    launchArgs: text.isEmpty && saved.isEmpty ? null : text,
  );
  if (result.error == null && !result.launchArgsIgnored) {
    return const BuddyRestartResult(BuddyRestartOutcome.done);
  }
  if (result.launchArgsIgnored) {
    final machine = buddyMachineName(c, buddy.machineId, app: app);
    return BuddyRestartResult(
      BuddyRestartOutcome.ignored,
      'Update Harness on $machine to use launch flags.',
    );
  }
  if (result.launchArgsRefused) {
    return BuddyRestartResult(BuddyRestartOutcome.refused, result.error);
  }
  if (result.engineNotStarted) {
    return const BuddyRestartResult(
      BuddyRestartOutcome.notStarted,
      "The Buddy didn't start with these flags. Fix or clear them and "
      'restart.',
    );
  }
  return BuddyRestartResult(BuddyRestartOutcome.failed, result.error);
}

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

  Agent? get _machineAgent => buddyMachineAgent(c, widget.projectId, app);

  late final _flags = TextEditingController(
    text: launchArgsLine(_machineAgent?.launchArgs ?? const []),
  );
  late final String _saved = launchArgsLine(
    _machineAgent?.launchArgs ?? const [],
  );
  bool _busy = false;
  String? _error;

  /// Flags an older Harness ignored: a warning, as the Buddy card colours it.
  bool _warning = false;

  @override
  void dispose() {
    _flags.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final app = this.app;
    if (_busy) return;
    if (app == null) {
      setState(() {
        _error = 'Restart is not available here.';
        _warning = false;
      });
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    final result = await restartBuddyWithFlags(
      c,
      widget.projectId,
      app,
      text: _flags.text.trim(),
      saved: _saved,
    );
    if (!mounted) return;
    if (result.outcome == BuddyRestartOutcome.done) {
      Navigator.pop(context);
      return;
    }
    setState(() {
      _busy = false;
      _error = result.message;
      _warning = result.outcome == BuddyRestartOutcome.ignored;
    });
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final buddy = readerBuddy(c, widget.projectId);
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
                  // The Buddy card's colours for the same results.
                  style: DesktopChrome.control(
                    color: _warning
                        ? grid.AppPalette.warn
                        : grid.AppPalette.dangerFill,
                  ),
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
