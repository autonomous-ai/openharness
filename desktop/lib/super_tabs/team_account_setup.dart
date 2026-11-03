import 'dart:async';

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
    required this.lead,
    required this.waiting,
    required this.rejected,
    required this.cancelled,
    required this.removeWhy,
    required this.removeOnly,
    required this.remove,
    required this.here,
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
      lead: _computerLead,
      waiting:
          'Your system is asking for your password. '
          'Setup then takes a minute or two, and Harness opens when it is done.',
      rejected: 'Your system did not accept that password. Try again.',
      cancelled: 'The password window was closed before setup finished.',
      removeWhy:
          'No administrator password for this computer? Remove it from the Swarm. '
          'You can add it again from Machines.',
      removeOnly: _computerRemoveOnly,
      remove: _computerRemove,
      here: 'this computer',
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
      lead: _computerLead,
      waiting:
          'Windows is asking for permission. '
          'Setup then takes a minute or two, and Harness opens when it is done.',
      rejected: 'Windows did not give permission. Try again.',
      cancelled: 'The permission window was closed before setup finished.',
      removeWhy:
          'No administrator permission on this computer? Remove it from the Swarm. '
          'You can add it again from Machines.',
      removeOnly: _computerRemoveOnly,
      remove: _computerRemove,
      here: 'this computer',
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
      lead:
          'This Mac joined a Swarm, so it needs Harness Team before you go on.',
      waiting:
          'macOS is asking for your password in a window titled “osascript”. '
          'Setup then takes a minute or two, and Harness opens when it is done.',
      rejected: 'macOS did not accept that password. Try again.',
      cancelled: 'The password window was closed before setup finished.',
      removeWhy:
          'No administrator password for this Mac? Remove it from the Swarm. '
          'You can add it again from Machines.',
      removeOnly: 'To go on, remove this Mac from the Swarm. You can add it again from Machines.',
      remove: 'Remove this Mac from the Swarm',
      here: 'this Mac',
    ),
  };

  static const _computerLead =
      'This computer joined a Swarm, so it needs Harness Team before you go on.';
  static const _computerRemoveOnly =
      'To go on, remove this computer from the Swarm. You can add it again from Machines.';
  static const _computerRemove = 'Remove this computer from the Swarm';

  static const _computerAccount =
      'Teammates\' agents in your Swarms run on this computer in a separate '
      'account, Harness Team. They cannot read your files or use your GitHub login. '
      'They use this computer\'s Claude Code and Codex subscriptions, so nobody signs in again.';
  static const _computerExists =
      'Harness Team is already set up on this computer.';
  static const _computerUpdate =
      'This computer\'s Harness is too old to set it up from here. Update Harness, '
      'or run harness team setup in a terminal.';
  static const _computerCannot =
      'Harness Team cannot be set up on this computer right now.';
  static const _computerUnreachable =
      'Could not reach Harness on this computer. Try again.';

  final String title,
      account,
      prompt,
      started,
      exists,
      update,
      cannot,
      unreachable;

  /// The lock's ([TeamAccountSetupLock]): why the app waits, setup under way,
  /// the password refused, the system's window closed, and the one way out.
  final String lead,
      waiting,
      rejected,
      cancelled,
      removeWhy,
      removeOnly,
      remove;

  /// "this Mac", or "this computer": what Remove takes out of the Swarms.
  final String here;

  /// What Remove asks before it removes anything (security review of #2779):
  /// it deletes this computer from each Swarm in [swarms], which it names.
  String confirmRemove(List<String> swarms) {
    final names = switch (swarms.length) {
      0 => 'the Swarm',
      1 => swarms.single,
      _ =>
        '${swarms.sublist(0, swarms.length - 1).join(', ')} and ${swarms.last}',
    };
    return 'Remove $here from $names? Its agents there stop, and teammates\' '
        'work no longer runs on it. You can add it again from Machines.';
  }

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

/// Holds the whole app while this computer's Harness Team account must be set
/// up ([AppNotifier.teamSetupLocked]): from the moment it joins a Swarm, or is
/// added to one, until setup succeeds (Scholes, 2026-11-03). It sits above the
/// Navigator (app_shell.dart), so every route, dialog and menu is under it,
/// and nothing there takes a click, a key, focus or a screen reader. There is
/// no close. Where setup can never finish here (no administrator password, a
/// Harness too old, a system that cannot ask), the one way out is removing
/// this computer from the Swarm.
///
/// The password is asked only by the system's own prompt, through the same
/// daemon actions as Set up on the machine row.
///
/// Nothing in it may need an Overlay (no tooltips): there is none above the
/// Navigator.
class TeamAccountSetupLock extends StatefulWidget {
  const TeamAccountSetupLock({
    super.key,
    required this.app,
    required this.child,
    this.operatingSystem,
  });

  final AppNotifier app;
  final Widget child;

  /// Whose words, by [RuntimePlatform.operatingSystem] (this computer's when
  /// null).
  final String? operatingSystem;

  @override
  State<TeamAccountSetupLock> createState() => _TeamAccountSetupLockState();
}

enum _LockStep { intro, waiting, retry, cancelled, cannot }

/// How long the system's prompt may stay open (cli/src/team/admin.ts, 15
/// minutes), with a minute for the setup after it.
const _setupLimit = Duration(minutes: 16);
const _setupRead = Duration(seconds: 2);

/// macOS's "The administrator user name or password was incorrect. (-60005)",
/// as the daemon hands it back inside its detail.
final _refusedPassword = RegExp(
  r'-60005|incorrect|not accepted|wrong password',
  caseSensitive: false,
);

class _TeamAccountSetupLockState extends State<TeamAccountSetupLock> {
  late final _Words _words = _Words.of(
    widget.operatingSystem ?? RuntimePlatform.operatingSystem,
  );
  _LockStep _step = _LockStep.intro;
  String? _outcome, _removeError;
  bool _busy = false;

  /// Remove was pressed: the panel asks before anything is removed, naming
  /// these Swarms.
  bool _confirming = false;
  List<String> _confirmSwarms = const [];
  Timer? _read;
  DateTime? _since;

  @override
  void initState() {
    super.initState();
    widget.app.addListener(_changed);
  }

  @override
  void didUpdateWidget(TeamAccountSetupLock old) {
    super.didUpdateWidget(old);
    if (!identical(old.app, widget.app)) {
      old.app.removeListener(_changed);
      widget.app.addListener(_changed);
    }
  }

  @override
  void dispose() {
    widget.app.removeListener(_changed);
    _read?.cancel();
    super.dispose();
  }

  void _changed() {
    if (!mounted) return;
    setState(() {
      if (!widget.app.teamSetupLocked) _reset();
    });
  }

  void _reset() {
    _read?.cancel();
    _read = null;
    _step = _LockStep.intro;
    _outcome = _removeError = null;
    _busy = false;
    _confirming = false;
  }

  void _show(_LockStep step, String outcome) {
    if (!mounted) return;
    setState(() {
      _busy = false;
      _step = step;
      _outcome = outcome;
    });
  }

  Future<void> _start() async {
    setState(() {
      _busy = true;
      _removeError = null;
    });
    final words = _words;
    try {
      switch (await widget.app.setUpTeamAccount()) {
        case 'started' || 'running':
          _since = DateTime.now();
          _show(_LockStep.waiting, words.waiting);
          _scheduleRead();
        case 'exists':
          await widget.app.teamAccountMade();
        case 'update':
          _show(_LockStep.cannot, words.update);
        case 'no-prompt' when words.noPrompt != null:
          _show(_LockStep.cannot, words.noPrompt!);
        case _:
          _show(_LockStep.cannot, words.cannot);
      }
    } on SuperTabFailure catch (failure) {
      if (failure.code == 'NO_PROMPT') {
        _show(_LockStep.cannot, words.noPrompt ?? failure.message);
      } else {
        _show(_LockStep.retry, failure.message);
      }
    } catch (_) {
      _show(_LockStep.retry, words.unreachable);
    }
  }

  /// The setup runs in this computer's daemon after the system's prompt;
  /// nothing tells the app when it ends, so its status is read while the
  /// prompt can still be open, and never after.
  void _scheduleRead() {
    _read?.cancel();
    _read = Timer(_setupRead, () => unawaited(_readSetup()));
  }

  Future<void> _readSetup() async {
    _read = null;
    final setup = await widget.app.teamSetupStatus();
    if (!mounted || _step != _LockStep.waiting) return;
    switch (setup?.state) {
      case 'exists':
        await widget.app.teamAccountMade();
        return;
      case 'failed':
        final detail = setup?.detail?.trim();
        if (detail != null && _refusedPassword.hasMatch(detail)) {
          _show(_LockStep.retry, _words.rejected);
        } else {
          _show(
            _LockStep.retry,
            detail == null || detail.isEmpty
                ? 'Setup did not finish. Try again.'
                : 'Setup did not finish: ${_sentence(detail)}',
          );
        }
        return;
      case 'declined':
        _show(_LockStep.cancelled, _words.cancelled);
        return;
    }
    final since = _since;
    if (since != null && DateTime.now().difference(since) > _setupLimit) {
      _show(_LockStep.retry, 'Setup did not finish. Try again.');
      return;
    }
    _scheduleRead();
  }

  static String _sentence(String text) =>
      RegExp(r'[.!?]$').hasMatch(text) ? text : '$text.';

  Future<void> _askRemove() async {
    setState(() {
      _busy = true;
      _removeError = null;
    });
    final swarms = await widget.app.readTeamSetupLockSwarmNames();
    if (!mounted) return;
    setState(() {
      _busy = false;
      _confirming = true;
      _confirmSwarms = swarms;
    });
  }

  Future<void> _remove() async {
    setState(() {
      _busy = true;
      _removeError = null;
    });
    final why = await widget.app.removeLockedMachine();
    if (!mounted) return;
    setState(() {
      _busy = false;
      _confirming = false;
      _removeError = why;
    });
  }

  @override
  Widget build(BuildContext context) {
    final locked = widget.app.teamSetupLocked;
    // One tree shape locked or not, so the app below is never remounted.
    return Stack(
      fit: StackFit.expand,
      children: [
        // The barrier takes every click and hides the app from a screen
        // reader; keys follow focus, which nothing under it may hold.
        ExcludeFocus(excluding: locked, child: widget.child),
        if (locked) ...[
          ModalBarrier(dismissible: false, color: dialogVeilTintOf(context)),
          _panel(context),
        ],
      ],
    );
  }

  Widget _panel(BuildContext context) {
    final words = _words;
    final body = grid.AppType.body(height: 1.45);
    final muted = body.copyWith(color: Theme.of(context).hintColor);
    final outcome = _outcome;
    final retry = FilledButton(
      key: const Key('team-account-lock-retry'),
      autofocus: true,
      onPressed: _busy ? null : _start,
      child: const Text('Try again'),
    );
    // It deletes this computer from the Swarms: never focused, so no Enter
    // presses it, and it asks first (security review of #2779).
    final remove = TextButton(
      key: const Key('team-account-lock-remove'),
      onPressed: _busy ? null : () => unawaited(_askRemove()),
      child: Text(words.remove),
    );
    final confirming = [
      TextButton(
        key: const Key('team-account-lock-remove-back'),
        autofocus: true,
        onPressed: _busy ? null : () => setState(() => _confirming = false),
        child: const Text('Back'),
      ),
      FilledButton(
        key: const Key('team-account-lock-remove-confirm'),
        style: FilledButton.styleFrom(
          backgroundColor: Theme.of(context).colorScheme.error,
          foregroundColor: Theme.of(context).colorScheme.onError,
        ),
        onPressed: _busy ? null : _remove,
        child: const Text('Remove'),
      ),
    ];
    final removeError = _removeError;
    return Center(
      key: const Key('team-account-lock'),
      child: FocusScope(
        autofocus: true,
        child: AlertDialog(
          title: Text(words.title),
          content: SizedBox(
            width: 420,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (_step == _LockStep.intro) ...[
                  Text(words.lead, style: body),
                  const SizedBox(height: 12),
                  Text(words.account, style: body),
                  const SizedBox(height: 12),
                  Text(words.prompt, style: body),
                  const SizedBox(height: 12),
                  Text(
                    'Your home folder becomes private to you. Your own agents work as before. '
                    'To remove the account later, run harness team remove.',
                    style: muted,
                  ),
                ] else ...[
                  Row(
                    children: [
                      if (_step == _LockStep.waiting) ...[
                        const SizedBox.square(
                          dimension: 14,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        ),
                        const SizedBox(width: 10),
                      ],
                      Expanded(
                        child: Text(
                          outcome ?? '',
                          key: const Key('team-account-lock-outcome'),
                          style: body,
                        ),
                      ),
                    ],
                  ),
                  if (_confirming) ...[
                    const SizedBox(height: 12),
                    Text(
                      words.confirmRemove(_confirmSwarms),
                      key: const Key('team-account-lock-confirm'),
                      style: body,
                    ),
                  ] else if (_step == _LockStep.cancelled) ...[
                    const SizedBox(height: 12),
                    Text(words.removeWhy, style: muted),
                  ] else if (_step == _LockStep.cannot) ...[
                    const SizedBox(height: 12),
                    Text(words.removeOnly, style: muted),
                  ],
                ],
                if (removeError != null) ...[
                  const SizedBox(height: 12),
                  Text(
                    removeError,
                    style: body.copyWith(
                      color: Theme.of(context).colorScheme.error,
                    ),
                  ),
                ],
              ],
            ),
          ),
          actions: _confirming
              ? confirming
              : switch (_step) {
                  _LockStep.intro => [
                    FilledButton(
                      key: const Key('team-account-lock-continue'),
                      autofocus: true,
                      onPressed: _busy ? null : _start,
                      child: const Text('Continue'),
                    ),
                  ],
                  _LockStep.waiting => const [],
                  _LockStep.retry => [retry],
                  _LockStep.cancelled => [remove, retry],
                  _LockStep.cannot => [remove],
                },
        ),
      ),
    );
  }
}
