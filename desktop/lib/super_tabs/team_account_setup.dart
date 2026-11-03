import 'package:flutter/material.dart';

import '../core/runtime_platform.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../state/app_state.dart';
import 'controller.dart';

/// The Harness Team account explained before the system asks for the password (cli/src/team/autoSetup.ts). macOS's
/// own prompt is titled "osascript" with a script icon, and on 2026-10-27 people met it with no idea it was Harness's.
///
/// [asked]: Harness offered it (a join, this computer added to a Swarm, or the app opening); "Not now" is then
/// remembered so it is not offered again on its own. Otherwise the person pressed Set up on this computer's row, and
/// Cancel forgets nothing.
///
/// [operatingSystem]: whose words, by [RuntimePlatform.operatingSystem] (this computer's when null).
Future<void> showTeamAccountSetup(
  BuildContext context,
  AppNotifier app, {
  bool asked = false,
  String? operatingSystem,
}) => showAppDialog<void>(
  context: context,
  barrierDismissible: false,
  builder: (context) => _TeamAccountSetup(
    app: app,
    asked: asked,
    words: _Words.of(operatingSystem ?? RuntimePlatform.operatingSystem),
  ),
);

/// What the dialog says on one system. A Mac's prompt is macOS's "osascript" window; Linux asks through the system's
/// own password prompt (pkexec, or sudo in a terminal), Windows through User Account Control.
class _Words {
  const _Words({
    required this.title,
    required this.account,
    required this.prompt,
    required this.started,
    required this.exists,
    required this.update,
    required this.cannot,
    required this.unreachable,
    this.noPrompt,
  });

  factory _Words.of(String operatingSystem) => switch (operatingSystem) {
    'linux' => const _Words(
      title: 'Set up Harness Team on this computer',
      account: _computerAccount,
      prompt: 'Your system asks for your password once.',
      started:
          'Your system is asking for your password. '
          'Setup then takes a minute or two. This computer\'s row updates when it is ready.',
      exists: _computerExists,
      update: _computerUpdate,
      cannot: _computerCannot,
      unreachable: _computerUnreachable,
      noPrompt: 'Run harness team setup in a terminal on this computer.',
    ),
    'windows' => const _Words(
      title: 'Set up Harness Team on this computer',
      account: _computerAccount,
      prompt: 'Windows asks for permission once (User Account Control).',
      started:
          'Windows is asking for permission. '
          'Setup then takes a minute or two. This computer\'s row updates when it is ready.',
      exists: _computerExists,
      update: _computerUpdate,
      cannot: _computerCannot,
      unreachable: _computerUnreachable,
    ),
    _ => const _Words(
      title: 'Set up Harness Team on this Mac',
      account:
          'Teammates\' agents in your Swarms run on this Mac in a separate macOS '
          'account, Harness Team. They cannot read your files or use your GitHub login. '
          'They use this Mac\'s Claude Code and Codex subscriptions, so nobody signs in again.',
      prompt:
          'macOS asks for your password once, in a window titled “osascript”. '
          'That is the macOS tool Harness uses to ask.',
      started:
          'macOS is asking for your password in a window titled “osascript”. '
          'Setup then takes a minute or two. This Mac\'s row updates when it is ready.',
      exists: 'Harness Team is already set up on this Mac.',
      update:
          'This Mac\'s Harness is too old to set it up from here. Update Harness, '
          'or run harness team setup in Terminal.',
      cannot: 'Harness Team cannot be set up on this Mac right now.',
      unreachable: 'Could not reach Harness on this Mac. Try again.',
    ),
  };

  static const _computerAccount =
      'Teammates\' agents in your Swarms run on this computer in a separate '
      'account, Harness Team. They cannot read your files or use your GitHub login. '
      'They use this computer\'s Claude Code and Codex subscriptions, so nobody signs in again.';
  static const _computerExists = 'Harness Team is already set up on this computer.';
  static const _computerUpdate =
      'This computer\'s Harness is too old to set it up from here. Update Harness, '
      'or run harness team setup in a terminal.';
  static const _computerCannot = 'Harness Team cannot be set up on this computer right now.';
  static const _computerUnreachable = 'Could not reach Harness on this computer. Try again.';

  final String title, account, prompt, started, exists, update, cannot, unreachable;

  /// For the daemon's `no-prompt` (cli/src/team/autoSetup.ts): no desktop session to ask in, so the terminal is the
  /// way. Null where that never happens.
  final String? noPrompt;
}

class _TeamAccountSetup extends StatefulWidget {
  const _TeamAccountSetup({
    required this.app,
    required this.asked,
    required this.words,
  });

  final AppNotifier app;
  final bool asked;
  final _Words words;

  @override
  State<_TeamAccountSetup> createState() => _TeamAccountSetupState();
}

class _TeamAccountSetupState extends State<_TeamAccountSetup> {
  bool _busy = false;

  /// What happened once the person pressed Continue; null before.
  String? _outcome;

  Future<void> _continue() async {
    setState(() => _busy = true);
    final words = widget.words;
    String outcome;
    try {
      outcome = switch (await widget.app.setUpTeamAccount()) {
        'started' || 'running' => words.started,
        'exists' => words.exists,
        'update' => words.update,
        // The daemon's answer when no prompt can be shown here (Linux with no
        // desktop session in its environment): nothing ran.
        'no-prompt' when words.noPrompt != null => words.noPrompt!,
        _ => words.cannot,
      };
    } on SuperTabFailure catch (failure) {
      outcome = failure.code == 'NO_PROMPT'
          ? words.noPrompt ?? failure.message
          : failure.message;
    } catch (_) {
      outcome = words.unreachable;
    }
    if (mounted) {
      setState(() {
        _busy = false;
        _outcome = outcome;
      });
    }
  }

  Future<void> _notNow() async {
    if (widget.asked) await widget.app.declineTeamAccount();
    if (mounted) Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context) {
    final body = grid.AppType.body(height: 1.45);
    final muted = body.copyWith(color: Theme.of(context).hintColor);
    final outcome = _outcome;
    final words = widget.words;
    return AlertDialog(
      key: const Key('team-account-setup'),
      title: Text(words.title),
      content: SizedBox(
        width: 420,
        child: outcome != null
            ? Text(
                outcome,
                key: const Key('team-account-setup-outcome'),
                style: body,
              )
            : Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(words.account, style: body),
                  const SizedBox(height: 12),
                  Text(words.prompt, style: body),
                  const SizedBox(height: 12),
                  Text(
                    'Your home folder becomes private to you. Your own agents work as before. '
                    'To remove the account later, run harness team remove.',
                    style: muted,
                  ),
                ],
              ),
      ),
      actions: outcome != null
          ? [
              FilledButton(
                key: const Key('team-account-setup-done'),
                onPressed: () => Navigator.pop(context),
                child: const Text('OK'),
              ),
            ]
          : [
              TextButton(
                key: const Key('team-account-setup-later'),
                onPressed: _busy ? null : _notNow,
                child: Text(widget.asked ? 'Not now' : 'Cancel'),
              ),
              FilledButton(
                key: const Key('team-account-setup-continue'),
                onPressed: _busy ? null : _continue,
                child: const Text('Continue'),
              ),
            ],
    );
  }
}
