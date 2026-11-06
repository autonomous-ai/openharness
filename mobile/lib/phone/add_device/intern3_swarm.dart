import 'dart:async';

import 'package:flutter/foundation.dart';

import '../../swarm/swarm_buddy.dart';
import '../../swarm/swarm_home_top.dart' show swarmHomeOffers;
import '../../swarm/swarm_inbox.dart';
import '../../swarm/swarm_lead_start.dart'
    show swarmPersonalName, swarmPersonalOperation;
import '../../swarm/swarm_reader.dart';
import '../../swarm/swarm_request.dart';
import '../../swarm/swarm_session.dart';
import '../../swarm/swarm_start.dart';

/// What Start does after Set up Intern 3, with Swarm on, in order.
enum Intern3SwarmStep {
  /// The person's Swarm: the one Home shows, or a new one when they have none.
  swarm,

  /// Intern 3 in it, with Claude Code installed there first when it has none.
  machine,

  /// Claude Code signed in on Intern 3, by the person on this phone: the run waits on them here ([awaitingSignIn]).
  signIn,

  /// The person's Buddy: started on Intern 3, or the one already running kept.
  buddy,
}

/// After Set up Intern 3, with Swarm on (owner, 2026-11-05): Start puts Intern 3 in the person's Swarm — their Personal
/// Swarm, made as Desktop makes it, when they have none — has Claude Code installed there (the OS ships none, cli superTabs/contribution.ts
/// `installEngine`), and starts their Buddy on it. A Buddy already running elsewhere is kept, and its chat opens instead.
///
/// One run at a time; a run that fails says why in [error] and can be run again: each step is the same request again (the
/// Swarm's operation id is the computer's, the setup's is kept until it settles).
class Intern3Swarm extends ChangeNotifier {
  Intern3Swarm({
    required this.session,
    required this.computers,
    required this.machineId,
    required this.machineName,
    this.swarmId,
    this.pause = const Duration(seconds: 2),
  });

  /// The Swarm the person picked on Set up Intern 3, when they have two or more (owner, 2026-11-06); null for the one
  /// [targetOf] chooses.
  final String? swarmId;

  final SwarmSession session;
  final SwarmComputers computers;

  /// Intern 3, as the account's computers list it.
  final String machineId;
  String machineName;
  final Duration pause;

  /// The step under way, or the one that failed; null before the first run.
  Intern3SwarmStep? step;

  /// Why the last run stopped, as a sentence to show; null while none did.
  String? error;

  bool get busy => _busy;
  bool _busy = false, _disposed = false;

  /// Done: the Swarm it went to, and its reader, for its Buddy chat to open.
  SwarmReader? reader;

  /// Claude Code is not signed in on Intern 3: the run stops at [Intern3SwarmStep.signIn] until the person signs in
  /// ([openSignIn]), with no terminal and no code to copy (owner, 2026-11-05).
  bool needsSignIn = false;

  /// Waiting on the person to sign in to Claude.
  bool get awaitingSignIn =>
      step == Intern3SwarmStep.signIn && needsSignIn && !_busy && !done;

  /// Claude Code's first-run questions are still to answer on Intern 3 (cli superTabs/contribution.ts `firstRun`): answered
  /// before the Buddy starts ([_answerFirstRun]). A CLI from before says nothing.
  bool _needsFirstRun = false;

  /// Claude's sign-in page was opened.
  bool signInOpened = false;

  /// The page opened is Claude's code page (an Intern 3 whose login handed BROWSER no localhost page): the code it
  /// shows is asked for next ([sendCode]). Otherwise this phone catches the sign-in itself ([sendCallback]).
  bool needsCode = false;

  /// The Swarm and the engine, between the run and the sign-in that finishes it.
  SwarmReader? _reader;
  String? _engine;

  /// The sign-in on Intern 3 (cli superTabs/claudeSignIn.ts), kept while its login waits for the code.
  String? _signInId;

  /// The Buddy that runs is one started before, on another computer.
  bool keptBuddy = false;

  bool get done => reader != null;

  /// The setup of Intern 3 for the Swarm, kept until it settles so a retry joins it.
  String? _setupId;

  /// The Swarm Intern 3 joins: the one the person picked ([swarmId]), else the one Home shows, else the first listed; null
  /// when the person has none, and a new one is made.
  SwarmListing? get target =>
      choicesOf(session).where((s) => s.id == swarmId).firstOrNull ??
      targetOf(session);

  /// The Swarms Intern 3 can join: every one the person reads, as Home offers them. Any member adds a computer of their
  /// own (backend superTabs/commands.ts `machine.contribute`: the machine's owner), so none is left out for its role.
  static List<SwarmListing> choicesOf(SwarmSession session) => [
    for (final swarm in session.inbox.swarms)
      if (swarmHomeOffers(session.inbox, swarm.id)) swarm,
  ];

  /// [target] with nothing picked: the one Home shows, else the first.
  static SwarmListing? targetOf(SwarmSession session) {
    final swarms = choicesOf(session);
    if (swarms.isEmpty) return null;
    final shown = session.home.swarmId;
    return swarms.where((s) => s.id == shown).firstOrNull ?? swarms.first;
  }

  Future<void> run() => _go(() async {
    // Waiting on the person's sign-in: only it goes on from here.
    if (_reader != null && needsSignIn) return;
    _at(Intern3SwarmStep.swarm);
    final reader = _reader = await _swarm();
    _at(Intern3SwarmStep.machine);
    _engine = await _machine(reader);
    if (needsSignIn) {
      _at(Intern3SwarmStep.signIn);
      return;
    }
    await _startBuddy();
  });

  /// Claude Code's first-run questions on Intern 3 answered for the person, never shown (owner, 2026-11-06): its theme Dark
  /// mode, as its screen first offers, and full mode accepted, which a Swarm's agents run in (cli engines/launchPrep.ts
  /// answerFirstRun). A Harness from before has no such answer: its Buddy's screen asks, as before.
  Future<void> _answerFirstRun() async {
    if (!_needsFirstRun) return;
    try {
      final answer = await computers.ask(machineId, {
        'action': 'claudeFirstRun',
        'theme': 'dark',
        'acceptFullMode': true,
      });
      if (answer['ok'] == true) _needsFirstRun = false;
    } catch (_) {
      // Its Buddy's screen asks instead, and the Swarm's own start records the same answers (core/agents/create.ts).
    }
  }

  /// Opens Claude's sign-in for Intern 3: `claude auth login` starts there, and its page comes back for this phone to
  /// open. Null when it did not ([error] says why).
  Future<String?> openSignIn() async {
    String? page;
    await _go(() async {
      // A new login each time the page is asked for: the one before may have taken a code already.
      final id = _signInId =
          'claude-sign-in-${DateTime.now().microsecondsSinceEpoch}';
      final deadline = DateTime.now().add(const Duration(seconds: 60));
      while (page == null) {
        final answer = await _signIn({'operationId': id});
        if (answer['state'] == 'page') {
          page = answer['url'] as String?;
          needsCode = page != null && page == answer['codeUrl'];
        }
        if (page != null) break;
        if (DateTime.now().isAfter(deadline)) {
          throw SuperTabFailure(
            'SIGN_IN_PENDING',
            'Claude\'s sign-in did not open on $machineName. Try again.',
          );
        }
        await Future<void>.delayed(const Duration(seconds: 1));
      }
      signInOpened = true;
    });
    return page;
  }

  /// The sign-in this phone caught on its own localhost, handed to the login waiting on Intern 3; once Claude takes it,
  /// the Buddy starts. True when it did.
  Future<bool> sendCallback(String caught) async {
    await _finishSignIn({'callback': caught});
    return !needsSignIn;
  }

  /// The code Claude's page showed, into the login waiting on Intern 3; once Claude takes it, the Buddy starts.
  Future<void> sendCode(String code) => code.trim().isEmpty
      ? Future.value()
      : _finishSignIn({'code': code.trim()});

  Future<void> _finishSignIn(Map<String, dynamic> sent) => _go(() async {
    final id = _signInId;
    if (id == null) return;
    var answer = await _signIn({'operationId': id, ...sent});
    final deadline = DateTime.now().add(const Duration(minutes: 2));
    while (answer['state'] != 'done') {
      if (DateTime.now().isAfter(deadline)) {
        throw const SuperTabFailure(
          'SIGN_IN_PENDING',
          'Claude did not answer yet. Try again.',
        );
      }
      await Future<void>.delayed(const Duration(seconds: 1));
      answer = await _signIn({'operationId': id});
    }
    _signInId = null;
    needsSignIn = false;
    await _startBuddy();
  });

  /// One question to Intern 3's sign-in; its refusal (a code Claude did not take) throws, and the next page asked for
  /// starts a new login.
  Future<Map<String, dynamic>> _signIn(Map<String, dynamic> payload) async {
    final answer = await computers.ask(machineId, {
      'action': 'claudeSignIn',
      ...payload,
    });
    if (answer['error'] != null) {
      _signInId = null;
      signInOpened = false;
      needsCode = false;
      throw SuperTabFailure(
        answer['error'] as String,
        answer['detail'] as String? ??
            'Update Harness on $machineName, then try again.',
      );
    }
    return answer;
  }

  Future<void> _startBuddy() async {
    final reader = _reader!;
    _at(Intern3SwarmStep.buddy);
    await _answerFirstRun();
    await _buddy(reader, _engine ?? 'claude');
    if (_disposed) return;
    this.reader = reader;
  }

  /// One action at a time; what went wrong goes in [error].
  Future<void> _go(Future<void> Function() act) async {
    if (_busy || _disposed || done) return;
    _busy = true;
    error = null;
    notifyListeners();
    try {
      await act();
    } on SuperTabFailure catch (failure) {
      error = failure.message;
    } catch (_) {
      error = 'Something went wrong. Try again.';
    } finally {
      _busy = false;
      if (!_disposed) notifyListeners();
    }
  }

  /// When [step] began, for the install's bar.
  DateTime stepSince = DateTime.now();

  void _at(Intern3SwarmStep next) {
    if (_disposed) throw const SuperTabFailure('GONE', '');
    step = next;
    stepSince = DateTime.now();
    notifyListeners();
  }

  /// The Swarm, read: made first when the person has none. One per computer, so a retry is the same one.
  Future<SwarmReader> _swarm() async {
    final inbox = session.inbox;
    if (!inbox.loaded) await inbox.refreshAll();
    var id = target?.id;
    if (id == null) {
      final created = await inbox.request(
        'POST',
        '/api/super-tabs',
        body: {
          // The Personal Swarm, as Desktop makes it: the same one whichever app makes it first (owner, 2026-11-06).
          'operationId': swarmPersonalOperation,
          'name': swarmPersonalName,
        },
      );
      id = created is Map ? created['id'] as String? : null;
      if (id == null || id.isEmpty) {
        throw const SuperTabFailure(
          'INVALID_RESPONSE',
          'Could not make your Swarm. Try again.',
        );
      }
    }
    final deadline = DateTime.now().add(const Duration(seconds: 45));
    while (true) {
      final reader = inbox.reader(id);
      if (reader != null && reader.snapshot == null) await reader.refresh();
      if (reader?.snapshot != null) return reader!;
      if (DateTime.now().isAfter(deadline)) {
        throw const SuperTabFailure(
          'SWARM_UNREAD',
          'Your Swarm did not answer yet. Try again.',
        );
      }
      await inbox.refreshAll();
      await Future<void>.delayed(pause);
    }
  }

  /// Intern 3 prepared for the Swarm — Claude Code installed there when neither engine is — and in it. Answers the engine
  /// the Buddy runs on.
  Future<String> _machine(SwarmReader reader) async {
    final prepared = await _prepare(reader.tabId);
    final engines = [
      for (final e in prepared['engines'] as List? ?? const [])
        if (e == 'claude' || e == 'codex') e as String,
    ];
    if (engines.isEmpty) {
      // A CLI from before `installEngine` installs nothing.
      throw SuperTabFailure(
        'NO_SWARM_ENGINE',
        'Update Harness on $machineName, then try again.',
      );
    }
    final engine = engines.contains('claude') ? 'claude' : engines.first;
    final signedIn = prepared['signedIn'];
    // A CLI from before `signedIn` does not say: the Buddy's terminal does.
    needsSignIn = signedIn is List && !signedIn.contains(engine);
    final firstRun = prepared['firstRun'];
    _needsFirstRun = firstRun is List && firstRun.contains(engine);
    final listed = reader.snapshot?.machines.any(
      (m) => m['machineId'] == machineId && m['hostMachineId'] == null,
    );
    if (listed != true) {
      final offered = prepared['maxAgents'];
      await _command(reader, {
        'type': 'machine.contribute',
        'machineId': machineId,
        'name': machineName,
        'cwd': prepared['cwd'],
        'scope': 'swarm',
        'engines': engines,
        'maxAgents': offered is num ? offered.toInt().clamp(1, 1024) : 4,
        // Free memory is checked at each start, as when a computer joins.
        'agents': 'memory',
      });
      try {
        await computers.ask(machineId, {'action': 'wake'});
      } catch (_) {
        // Its host finds the Swarm on its next read anyway.
      }
      await reader.refresh();
    }
    return engine;
  }

  /// `prepareContribution` on Intern 3, asked again while it prepares: installing Claude Code takes minutes on a slow
  /// Wi-Fi (the Dell, 2026-11-05: over 5). Intern 3 just came online, so one that does not answer yet is asked again for a
  /// while; once it has answered, a question lost on the way is only asked again (the Dell's answers came and went while
  /// it installed). Until it settles the setup is kept, so Try again joins the install under way rather than starting one.
  Future<Map<String, dynamic>> _prepare(String tabId) async {
    final id = _setupId ??=
        'intern3-setup-${DateTime.now().microsecondsSinceEpoch}';
    final deadline = DateTime.now().add(const Duration(minutes: 25));
    final reachBy = DateTime.now().add(const Duration(minutes: 2));
    var answered = false;
    while (true) {
      Map<String, dynamic>? prepared;
      try {
        prepared = await computers.ask(machineId, {
          'action': 'prepareContribution',
          'tabId': tabId,
          'scope': 'swarm',
          'operationId': id,
          'installEngine': 'claude',
        });
        answered = true;
      } catch (_) {
        if (!answered && DateTime.now().isAfter(reachBy)) {
          throw SuperTabFailure(
            'UNREACHABLE',
            'Could not reach Harness on $machineName. Check it is online, then try again.',
          );
        }
      }
      if (_disposed) throw const SuperTabFailure('GONE', '');
      if (prepared != null) {
        if (prepared['state'] == 'ready' && prepared['scope'] == 'swarm') {
          _setupId = null;
          return prepared;
        }
        if (prepared['state'] != 'preparing') {
          _setupId = null;
          throw SuperTabFailure(
            prepared['error'] as String? ?? 'SETUP_FAILED',
            prepared['detail'] as String? ??
                'Update Harness on $machineName, then try again.',
          );
        }
      }
      if (DateTime.now().isAfter(deadline)) {
        throw SuperTabFailure(
          'SETUP_PENDING',
          'Setting up $machineName is still running. Try again to check it.',
        );
      }
      await Future<void>.delayed(pause);
    }
  }

  /// The server's refusals of a Buddy start that the next reading of Intern 3 answers: signed out, or none read yet.
  static const _readingPending = {'ENGINE_UNAVAILABLE', 'MACHINE_OFFLINE'};

  /// The person's one Buddy in the Swarm: one already running is kept; else it starts on Intern 3.
  Future<void> _buddy(SwarmReader reader, String engine) async {
    final running = swarmBuddy(reader, swarmBuddyKey);
    if (running != null && running.downSince == null) {
      keptBuddy = true;
      return;
    }
    await openSwarmBuddyChat(reader, swarmBuddyKey);
    // The server starts nothing on Intern 3 before a fresh reading of it says it may. Just signed in, its reading may still
    // say signed out for a pass (cli superTabs/machines.ts engineSignedIn), and just added, it has sent none to this Swarm
    // yet: its host finds a new Swarm on its next full read, up to a minute on. With Claude Code there and signed in already,
    // Start asked a second after the add (the Dell, 2026-11-06, MACHINE_OFFLINE "Wait for a fresh reading"). Asked again
    // meanwhile, never for ever.
    final deadline = DateTime.now().add(const Duration(minutes: 3));
    while (true) {
      try {
        await startSwarmBuddy(
          reader,
          projectId: swarmBuddyKey,
          machineId: machineId,
          engine: engine,
        );
        return;
      } on SuperTabFailure catch (failure) {
        if (!_readingPending.contains(failure.code) ||
            DateTime.now().isAfter(deadline)) {
          rethrow;
        }
      }
      if (_disposed) throw const SuperTabFailure('GONE', '');
      await Future<void>.delayed(const Duration(seconds: 3));
      await reader.refresh();
    }
  }

  Future<void> _command(
    SwarmReader reader,
    Map<String, dynamic> command,
  ) async {
    await reader.request(
      'POST',
      '/api/super-tabs/${Uri.encodeComponent(reader.tabId)}/commands',
      body: {'operationId': superTabOperationId(), 'command': command},
    );
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}
