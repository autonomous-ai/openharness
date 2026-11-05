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
  String? missing,
}) => showAppDialog<void>(
  context: context,
  barrierDismissible: false,
  builder: (context) => _TeamAccountSetup(
    app: app,
    asked: asked,
    missing: missing,
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
          'Your system is asking for your password. After that, setup goes on '
          'in the background: this computer\'s row in Machines shows how far it is, '
          'and Harness tells you when it is ready.',
      exists: _computerExists,
      update: _computerUpdate,
      cannot: _computerCannot,
      unreachable: _computerUnreachable,
      noPrompt: 'Run harness team setup in a terminal on this computer.',
      lead: _computerLead,
      waiting:
          'Your system is asking for your password. After that, setup goes on '
          'in the background and you can keep working.',
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
          'Windows is asking for permission. After that, setup goes on '
          'in the background: this computer\'s row in Machines shows how far it is, '
          'and Harness tells you when it is ready.',
      exists: _computerExists,
      update: _computerUpdate,
      cannot: _computerCannot,
      unreachable: _computerUnreachable,
      lead: _computerLead,
      waiting:
          'Windows is asking for permission. After that, setup goes on '
          'in the background and you can keep working.',
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
          'After that, setup goes on in the background: this Mac\'s row in '
          'Machines shows how far it is, and Harness tells you when it is ready.',
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
          'After that, setup goes on in the background and you can keep working.',
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

  /// The dialog's title when it repairs (#2765): "Repair Harness Team on this Mac".
  String get repairTitle => title.replaceFirst('Set up', 'Repair');

  /// What it says first when it repairs: what is missing, and that Repair runs the setup again.
  String unfinished(String missing) => missing.isEmpty
      ? 'Harness Team is not finished on $here. Repair runs its setup again.'
      : 'Harness Team is not finished on $here: $missing. Repair runs its setup again.';

  /// Once Remove was refused: Not now is the way on, and it says so instead
  /// of asking for Remove again.
  String get notNowWhy =>
      'Choose Not now to go on without it. You can set up Harness Team on '
      '$here later from Machines.';

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

  /// The line under the password wait: how long it has waited.
  static String sofar(Duration elapsed) {
    final seconds = elapsed.inSeconds;
    final time = seconds < 60
        ? '$seconds s'
        : '${seconds ~/ 60} min ${seconds % 60} s';
    return '$time so far.';
  }

  /// [cancelled] for a notice, which says first that setup did not finish:
  /// "The password window was closed."
  String get closed => cancelled.replaceFirst(' before setup finished', '');

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
    this.missing,
  });

  final AppNotifier app;
  final bool asked;
  final _Words words;

  /// The account is there and these parts are not (cli/src/team/autoSetup.ts `missingDetail`, #2765): the dialog
  /// repairs instead of setting up. Empty for a part it could not name.
  final String? missing;

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
      final state = await widget.app.setUpTeamAccount();
      // The row and the notice follow it from here (#3169): the dialog's OK
      // leaves the person free while it runs.
      if (state == 'started' || state == 'running') {
        TeamSetupWatch.of(widget.app)?.follow(restart: state == 'started');
      }
      outcome = switch (state) {
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
    final missing = widget.missing;
    return AlertDialog(
      key: const Key('team-account-setup'),
      title: Text(missing == null ? words.title : words.repairTitle),
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
                    missing == null ? words.account : words.unfinished(missing),
                    style: body,
                  ),
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
                child: Text(missing == null ? 'Continue' : 'Repair'),
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

String _sentence(String text) =>
    RegExp(r'[.!?]$').hasMatch(text) ? text : '$text.';

/// The four steps a person reads (#3169 mockup: "step 2 of 4"), from the
/// steps setup says (cli/src/team/script.ts `step`, ./command.ts `progress`):
/// the account, Harness and its engines, starting it, its privacy check. Null
/// for the password, and for a step this app does not know.
int? teamSetupPhase(String? step) => switch (step) {
  'account' || 'home' || 'privacy' => 1,
  'runtime' || 'copy-engines' || 'engines' => 2,
  'sign-in' || 'daemon' => 3,
  'report' => 4,
  _ => null,
};

/// What each step usually takes, from this Mac's real setup of 2026-11-04
/// (#3169): the account, homes and privacy about 8 s, Harness 3 s, the npm
/// download of Claude Code and Codex 4 min 18 s (`engines`), the start and
/// its check about 5 s. `copy-engines`, which took over from the download
/// where the Mac has both, took 1.4 to 9.9 s.
const _stepTimes = <String, Duration>{
  'account': Duration(seconds: 4),
  'home': Duration(seconds: 2),
  'privacy': Duration(seconds: 2),
  'runtime': Duration(seconds: 5),
  'copy-engines': Duration(seconds: 10),
  'engines': Duration(seconds: 240),
  'sign-in': Duration(seconds: 2),
  'daemon': Duration(seconds: 3),
  'report': Duration(seconds: 5),
};

/// How long setup has left, at [step] after [inStep] on it; null for a step
/// this app does not know. A step past its usual time keeps a quarter of it
/// (at least 10 s), so a slow download never reads as done. The download is
/// counted only once it runs: a Mac that copies its engines never has one.
Duration? teamSetupLeft(String? step, Duration inStep) {
  final usual = _stepTimes[step];
  if (usual == null) return null;
  final floor = usual ~/ 4 > const Duration(seconds: 10)
      ? usual ~/ 4
      : const Duration(seconds: 10);
  var left = usual - inStep < floor ? floor : usual - inStep;
  final steps = _stepTimes.keys.toList();
  for (final later in steps.skip(steps.indexOf(step!) + 1)) {
    if (later != 'engines') left += _stepTimes[later]!;
  }
  return left;
}

/// This Mac's row while setup runs (#3169): "Harness Team: setting up · step
/// 2 of 4 · about 4 min left".
String teamSetupLine(String? step, Duration inStep) {
  final phase = teamSetupPhase(step);
  final left = teamSetupLeft(step, inStep);
  if (phase == null || left == null) return 'Harness Team: setting up';
  final time = left < const Duration(minutes: 1)
      ? 'less than a minute left'
      : 'about ${(left.inSeconds / 60).round()} min left';
  return 'Harness Team: setting up · step $phase of 4 · $time';
}

/// How a setup [TeamSetupWatch] followed ended.
enum TeamSetupEndKind { ready, failed, cancelled }

class TeamSetupEnd {
  const TeamSetupEnd(this.kind, {this.lock = '', this.notice = ''});

  final TeamSetupEndKind kind;

  /// What the lock says when it holds the app ([TeamAccountSetupLock]).
  final String lock;

  /// What the notice says otherwise.
  final String notice;
}

/// This computer's Harness Team setup, followed while it runs (#3169): one
/// per app, made and ended by [TeamAccountSetupLock], which sits above every
/// route for the app's whole life. It reads the daemon's status every 2 s,
/// only while setup runs, and ends with [ended]: ready (the lock is let go),
/// failed or cancelled, with words for the lock and for a notice. The machine
/// row draws [line].
class TeamSetupWatch extends ChangeNotifier {
  TeamSetupWatch._(this.app, this._words, this._now);

  static final _watches = Expando<TeamSetupWatch>('team setup watch');

  /// [app]'s watch, while its lock is in the window; null otherwise.
  static TeamSetupWatch? of(AppNotifier app) => _watches[app];

  final AppNotifier app;
  final _Words _words;
  final DateTime Function() _now;
  final _ended = StreamController<TeamSetupEnd>.broadcast();
  Timer? _read;
  int _generation = 0;
  bool _disposed = false;
  DateTime? _since, _stepSince;

  /// Each end of a setup it followed.
  Stream<TeamSetupEnd> get ended => _ended.stream;

  bool running = false;

  /// The step setup said last, and how long it has run.
  String? step;
  Duration? elapsed;

  /// Setup is past the password: the person may go on working.
  bool get afterPassword => running && step != null && step != 'password';

  /// The row's line while it runs after the password; null otherwise.
  String? get line {
    final since = _stepSince;
    if (!afterPassword || since == null) return null;
    return teamSetupLine(step, _now().difference(since));
  }

  /// Follows a setup started here or found running. One already followed is
  /// left as it is, unless [restart]: a setup just started again.
  void follow({bool restart = false}) {
    if (_disposed || (running && !restart)) return;
    _generation++;
    running = true;
    step = null;
    elapsed = Duration.zero;
    _since = _stepSince = _now();
    notifyListeners();
    _schedule();
  }

  void _schedule() {
    _read?.cancel();
    final generation = _generation;
    _read = Timer(_setupRead, () => unawaited(_readNow(generation)));
  }

  Future<void> _readNow(int generation) async {
    _read = null;
    final setup = await app.teamSetupProgress();
    if (_disposed || !running || generation != _generation) return;
    final words = _words;
    final detail = setup?.detail?.trim();
    switch (setup?.state) {
      case 'exists':
        return _end(const TeamSetupEnd(TeamSetupEndKind.ready));
      case 'failed' when detail != null && _refusedPassword.hasMatch(detail):
        return _end(
          TeamSetupEnd(
            TeamSetupEndKind.failed,
            lock: words.rejected,
            notice: _failed(words.rejected.replaceFirst(' Try again.', '')),
          ),
        );
      case 'failed':
        final said = detail == null || detail.isEmpty
            ? null
            : _sentence(detail);
        return _end(
          TeamSetupEnd(
            TeamSetupEndKind.failed,
            lock: said == null
                ? 'Setup did not finish. Try again.'
                : 'Setup did not finish: $said',
            notice: _failed(said),
          ),
        );
      case 'declined':
        return _end(
          TeamSetupEnd(
            TeamSetupEndKind.cancelled,
            lock: words.cancelled,
            notice: _failed(words.closed),
          ),
        );
      // It ended with the account there and a part not (#2765): said, and Try again repairs it.
      case 'incomplete':
        final missing = detail == null || detail.isEmpty
            ? null
            : _sentence(detail);
        return _end(
          TeamSetupEnd(
            TeamSetupEndKind.failed,
            lock: missing == null
                ? 'Setup ended, but Harness Team is not finished. Try again.'
                : 'Setup ended, but Harness Team is not finished: $missing Try again.',
            notice: missing == null
                ? 'Harness Team setup ended, but it is not finished.'
                : 'Harness Team setup ended, but it is not finished: $missing',
          ),
        );
      case 'running':
        final next = setup?.step;
        if (next != step) _stepSince = _now();
        step = next;
        final since = _since;
        elapsed =
            setup?.elapsed ?? (since == null ? null : _now().difference(since));
        notifyListeners();
      case null:
        // No answer (the daemon restarting): read again, until the limit.
        break;
      default:
        // Anything else once it stopped running ('none': it ended with no
        // account and nothing remembered, or the daemon restarted): the
        // wait is over, and it says so (Scholes, 2026-11-04).
        return _end(
          TeamSetupEnd(
            TeamSetupEndKind.failed,
            lock: 'Setup stopped before the Harness Team account was made. Try again.',
            notice: _failed('It stopped before the account was made.'),
          ),
        );
    }
    final since = _since;
    if (since != null && _now().difference(since) > _setupLimit) {
      return _end(
        TeamSetupEnd(
          TeamSetupEndKind.failed,
          lock: 'Setup did not finish. Try again.',
          notice: _failed('It ran out of time.'),
        ),
      );
    }
    _schedule();
  }

  static String _failed(String? why) => why == null
      ? 'Harness Team setup did not finish.'
      : 'Harness Team setup did not finish. $why';

  Future<void> _end(TeamSetupEnd end) async {
    _read?.cancel();
    _read = null;
    running = false;
    step = null;
    elapsed = null;
    notifyListeners();
    // Ready lets the lock go before anyone hears of it, so a notice never
    // sits under a lock that is about to end.
    if (end.kind == TeamSetupEndKind.ready) await app.teamAccountMade();
    if (!_disposed) _ended.add(end);
  }

  @override
  void dispose() {
    _disposed = true;
    _read?.cancel();
    unawaited(_ended.close());
    if (identical(_watches[app], this)) _watches[app] = null;
    super.dispose();
  }
}

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

  late TeamSetupWatch _watch;
  StreamSubscription<TeamSetupEnd>? _ends;

  @override
  void initState() {
    super.initState();
    widget.app.addListener(_changed);
    _makeWatch();
  }

  void _makeWatch() {
    _watch = TeamSetupWatch._(widget.app, _words, DateTime.now)
      ..addListener(_changed);
    TeamSetupWatch._watches[widget.app] = _watch;
    _ends = _watch.ended.listen(_setupEnded);
  }

  void _dropWatch() {
    unawaited(_ends?.cancel());
    _watch
      ..removeListener(_changed)
      ..dispose();
  }

  @override
  void didUpdateWidget(TeamAccountSetupLock old) {
    super.didUpdateWidget(old);
    if (!identical(old.app, widget.app)) {
      old.app.removeListener(_changed);
      widget.app.addListener(_changed);
      _dropWatch();
      _makeWatch();
    }
  }

  @override
  void dispose() {
    widget.app.removeListener(_changed);
    _dropWatch();
    super.dispose();
  }

  void _changed() {
    if (!mounted) return;
    setState(() {
      if (!widget.app.teamSetupLocked) _reset();
    });
  }

  void _reset() {
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

  /// A setup the watch followed ended. Where the lock holds the app, it says
  /// why on the lock again, with Try again; otherwise a notice says it, with
  /// Retry on a failure (#3169).
  void _setupEnded(TeamSetupEnd end) {
    if (!mounted) return;
    if (end.kind != TeamSetupEndKind.ready && widget.app.teamSetupLocked) {
      _show(
        end.kind == TeamSetupEndKind.cancelled
            ? _LockStep.cancelled
            : _LockStep.retry,
        end.lock,
      );
      return;
    }
    final messenger = ScaffoldMessenger.maybeOf(context);
    if (messenger == null) return;
    final here = _words.here.replaceFirst('this ', '');
    final ready = end.kind == TeamSetupEndKind.ready;
    messenger.showSnackBar(
      SnackBar(
        key: const Key('team-setup-notice'),
        duration: Duration(seconds: ready ? 8 : 20),
        showCloseIcon: true,
        content: Text(
          ready
              ? 'Harness Team is ready on this $here. Teammates\' agents can run here now.'
              : end.notice,
        ),
        action: ready
            ? null
            : SnackBarAction(
                key: const Key('team-setup-notice-retry'),
                label: 'Retry',
                onPressed: () => unawaited(_retry()),
              ),
      ),
    );
  }

  /// The notice's Retry: the system's prompt again, followed as before.
  Future<void> _retry() async {
    try {
      final state = await widget.app.setUpTeamAccount();
      if (state == 'started' || state == 'running') {
        _watch.follow(restart: state == 'started');
      }
    } catch (_) {
      if (!mounted) return;
      ScaffoldMessenger.maybeOf(context)
          ?.showSnackBar(SnackBar(content: Text(_words.unreachable)));
    }
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
          _show(_LockStep.waiting, words.waiting);
          _watch.follow(restart: true);
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

  /// Try again while it waits: reads the status first, and starts setup
  /// again only when none is running.
  Future<void> _tryAgainWaiting() async {
    setState(() {
      _busy = true;
      _removeError = null;
    });
    final setup = await widget.app.teamSetupProgress();
    if (!mounted || _step != _LockStep.waiting) return;
    switch (setup?.state) {
      case 'running':
        setState(() => _busy = false);
      case 'exists':
        await widget.app.teamAccountMade();
        if (mounted) setState(() => _busy = false);
      default:
        await _start();
    }
  }

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

  Future<void> _notNow() async {
    setState(() => _busy = true);
    await widget.app.declineTeamSetupLock();
    if (mounted) setState(() => _busy = false);
  }

  @override
  Widget build(BuildContext context) {
    // Past the password, setup goes on behind the person's work (#3169): the
    // lock still holds, and comes back if setup fails.
    final locked = widget.app.teamSetupLocked && !_watch.afterPassword;
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
    // Remove was refused: the one way left, so nobody is held without an
    // administrator's password (Diego, 2026-11-03).
    final notNow = TextButton(
      key: const Key('team-account-lock-not-now'),
      onPressed: _busy ? null : _notNow,
      child: const Text('Not now'),
    );
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
                  if (_step == _LockStep.waiting && _watch.elapsed != null) ...[
                    const SizedBox(height: 8),
                    Text(
                      _Words.sofar(_watch.elapsed!),
                      key: const Key('team-account-lock-elapsed'),
                      style: muted,
                    ),
                  ],
                  if (_confirming) ...[
                    const SizedBox(height: 12),
                    Text(
                      words.confirmRemove(_confirmSwarms),
                      key: const Key('team-account-lock-confirm'),
                      style: body,
                    ),
                  ] else if (removeError != null &&
                      (_step == _LockStep.cancelled ||
                          _step == _LockStep.cannot)) ...[
                    const SizedBox(height: 12),
                    Text(
                      words.notNowWhy,
                      key: const Key('team-account-lock-not-now-why'),
                      style: muted,
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
                  // Never without a way on (Scholes, 2026-11-04): Remove
                  // asks first, and Try again starts nothing while setup
                  // runs.
                  _LockStep.waiting => [
                    remove,
                    FilledButton(
                      key: const Key('team-account-lock-retry'),
                      autofocus: true,
                      onPressed: _busy ? null : _tryAgainWaiting,
                      child: const Text('Try again'),
                    ),
                  ],
                  _LockStep.retry => [retry],
                  _LockStep.cancelled => [
                    if (removeError != null) notNow,
                    remove,
                    retry,
                  ],
                  _LockStep.cannot => [if (removeError != null) notNow, remove],
                },
        ),
      ),
    );
  }
}
