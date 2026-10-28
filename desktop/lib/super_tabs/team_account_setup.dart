import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../state/app_state.dart';
import 'controller.dart';

/// The Harness Team account explained before macOS asks for the password (cli/src/team/autoSetup.ts). macOS's own
/// prompt is titled "osascript" with a script icon, and on 2026-10-27 people met it with no idea it was Harness's.
///
/// [asked]: Harness offered it (a join, this Mac added to a Swarm, or the app opening); "Not now" is then remembered so
/// it is not offered again on its own. Otherwise the person pressed Set up on this Mac's row, and Cancel forgets nothing.
Future<void> showTeamAccountSetup(
  BuildContext context,
  AppNotifier app, {
  bool asked = false,
}) => showAppDialog<void>(
  context: context,
  barrierDismissible: false,
  builder: (context) => _TeamAccountSetup(app: app, asked: asked),
);

class _TeamAccountSetup extends StatefulWidget {
  const _TeamAccountSetup({required this.app, required this.asked});

  final AppNotifier app;
  final bool asked;

  @override
  State<_TeamAccountSetup> createState() => _TeamAccountSetupState();
}

class _TeamAccountSetupState extends State<_TeamAccountSetup> {
  bool _busy = false;

  /// What happened once the person pressed Continue; null before.
  String? _outcome;

  Future<void> _continue() async {
    setState(() => _busy = true);
    String outcome;
    try {
      outcome = switch (await widget.app.setUpTeamAccount()) {
        'started' || 'running' =>
          'macOS is asking for your password in a window titled “osascript”. '
              'Setup then takes a minute or two. This Mac\'s row updates when it is ready.',
        'exists' => 'Harness Team is already set up on this Mac.',
        'update' =>
          'This Mac\'s Harness is too old to set it up from here. Update Harness, '
              'or run harness team setup in Terminal.',
        _ => 'Harness Team cannot be set up on this Mac right now.',
      };
    } on SuperTabFailure catch (failure) {
      outcome = failure.message;
    } catch (_) {
      outcome = 'Could not reach Harness on this Mac. Try again.';
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
    return AlertDialog(
      key: const Key('team-account-setup'),
      title: const Text('Set up Harness Team on this Mac'),
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
                  Text(
                    'Teammates\' agents in your Swarms run on this Mac in a separate macOS '
                    'account, Harness Team. They cannot read your files or use your GitHub login. '
                    'They use this Mac\'s Claude Code and Codex subscriptions, so nobody signs in again.',
                    style: body,
                  ),
                  const SizedBox(height: 12),
                  Text(
                    'macOS asks for your password once, in a window titled “osascript”. '
                    'That is the macOS tool Harness uses to ask.',
                    style: body,
                  ),
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
