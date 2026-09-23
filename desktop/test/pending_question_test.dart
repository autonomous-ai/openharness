// The window learning that an agent is blocked. Everything here is the
// bookkeeping around two frames — `commander_question` and its close — which is
// what decides whether a row can lie: a question that outlives its dialog, a
// wait clock that resets itself, a stale close wiping a live question.
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/core/local_key_value_store.dart';
import 'package:harness/notify/agent_alerts.dart';
import 'package:harness/notify/alert_sounds.dart';
import 'package:harness/state/pending_question.dart';

/// A key/value store that lives in memory. Tests must never touch the real one.
class _Memory implements LocalKeyValueStore {
  final values = <String, String?>{};

  @override
  Future<String?> read(String key) async => values[key];

  @override
  Future<void> write(String key, String value) async => values[key] = value;

  @override
  Future<void> delete(String key) async => values.remove(key);
}

const _machine = Machine(
  machineId: 'm1',
  authMode: MachineAuthMode.remote,
  name: 'MacBook-Pro.local',
);

AppNotifier notifierWithMachine() {
  final notifier = AppNotifier(
    config: AppConfig.dev,
    authSession: AuthSession(),
    configStore: null,
  );
  notifier.machineStates[_machine.machineId] = MachineState(_machine);
  return notifier;
}

Map<String, dynamic> asked({
  String agentId = 'a1',
  String requestId = 'q_1',
  String prompt = 'Which colour theme do you want?',
  List<String> options = const ['Blue', 'Red'],
  bool multi = false,
}) => {
  'type': 'commander_question',
  'agentId': agentId,
  'dbSessionId': 's1',
  'payload': {
    'requestId': requestId,
    'questions': [
      {'key': prompt, 'q': prompt, 'options': options, 'multi': multi},
    ],
  },
};

Map<String, dynamic> closed({
  String agentId = 'a1',
  String requestId = 'q_1',
}) => {
  'type': 'commander_question_close',
  'agentId': agentId,
  'dbSessionId': 's1',
  'payload': {'requestId': requestId},
};

void main() {
  // The alert group installs a mock method-call handler, which needs the binding up.
  TestWidgetsFlutterBinding.ensureInitialized();

  group('shaping', () {
    test('reads the prompt, its options and its answer key', () {
      final question = PendingQuestion.fromPayload(
        machineId: 'm1',
        agentId: 'a1',
        payload: asked()['payload'] as Map<String, dynamic>,
        now: DateTime(2026),
      )!;
      expect(question.prompt, 'Which colour theme do you want?');
      expect(question.options, ['Blue', 'Red']);
      // The daemon keys the answer by the question's own text for a
      // pane-derived dialog; kept so a client that answers has the key.
      expect(question.answerKey, 'Which colour theme do you want?');
    });

    test('refuses a payload with nothing to draw', () {
      for (final payload in <Map<String, dynamic>>[
        {'questions': <dynamic>[]},
        {'requestId': 'q', 'questions': <dynamic>[]},
        {
          'requestId': 'q',
          'questions': [
            {'q': '   ', 'options': []},
          ],
        },
      ]) {
        expect(
          PendingQuestion.fromPayload(
            machineId: 'm1',
            agentId: 'a1',
            payload: payload,
            now: DateTime(2026),
          ),
          isNull,
        );
      }
    });
  });

  group('the window following a dialog', () {
    test(
      'a question makes its agent blocked, and the close clears it',
      () async {
        final n = notifierWithMachine();
        await n.handleMachineEventForTest('m1', asked());
        expect(n.questionFor('m1', 'a1')!.agentId, 'a1');
        expect(n.questionFor('m1', 'a1')!.prompt, contains('colour theme'));

        await n.handleMachineEventForTest('m1', closed());
        expect(n.questionFor('m1', 'a1'), isNull);
      },
    );

    test('a re-announce of the same question keeps the original clock', () async {
      // The daemon re-announces an open question on reconnect and on attaching
      // to a turn that was already mid-dialog. If that reset the clock, an
      // agent blocked for ten minutes would read as new after every hiccup.
      final n = notifierWithMachine();
      await n.handleMachineEventForTest('m1', asked());
      final first = n.questionFor('m1', 'a1')!.since;
      await Future<void>.delayed(const Duration(milliseconds: 5));
      await n.handleMachineEventForTest('m1', asked());
      expect(n.questionFor('m1', 'a1')!.since, first);
    });

    test(
      'the next page of a dialog replaces it, and starts its own clock',
      () async {
        final n = notifierWithMachine();
        await n.handleMachineEventForTest('m1', asked());
        final first = n.questionFor('m1', 'a1')!.since;
        await Future<void>.delayed(const Duration(milliseconds: 5));
        await n.handleMachineEventForTest(
          'm1',
          asked(
            requestId: 'q_2',
            prompt: 'Which font?',
            options: ['Mono', 'Sans'],
          ),
        );
        final now = n.questionFor('m1', 'a1')!;
        expect(now.prompt, 'Which font?');
        expect(now.since.isAfter(first), isTrue);
      },
    );

    test('a close for a question that already moved on is ignored', () async {
      // Ordering on the wire is not guaranteed, and the close for page one can
      // arrive after page two is already up. Wiping the live one would leave an
      // agent blocked with nothing anywhere saying so.
      final n = notifierWithMachine();
      await n.handleMachineEventForTest('m1', asked());
      await n.handleMachineEventForTest(
        'm1',
        asked(requestId: 'q_2', prompt: 'Which font?'),
      );
      await n.handleMachineEventForTest('m1', closed(requestId: 'q_1'));
      expect(n.questionFor('m1', 'a1')!.prompt, 'Which font?');
    });

    test('the turn ending clears it even with no close frame', () async {
      // A question cannot outlive its own turn — the daemon's watcher is torn
      // down at turn_ended and says the same thing from its end. This side does
      // not depend on that frame surviving the trip.
      final n = notifierWithMachine();
      await n.handleMachineEventForTest('m1', asked());
      await n.handleMachineEventForTest('m1', {
        'type': 'turn_ended',
        'agentId': 'a1',
        'payload': <String, dynamic>{},
      });
      expect(n.questionFor('m1', 'a1'), isNull);
    });

    test('deleting the agent takes its question with it', () async {
      final n = notifierWithMachine();
      await n.handleMachineEventForTest('m1', asked());
      await n.handleMachineEventForTest('m1', {
        'type': 'agent_deleted',
        'agentId': 'a1',
        'payload': <String, dynamic>{},
      });
      expect(n.questionFor('m1', 'a1'), isNull);
    });
  });

  // ── the sound the window makes ────────────────────────────────────────────────────────────────
  //
  // Two moments are worth interrupting someone over: an agent finished, and an agent stopped to
  // ask. Everything else in this file is about what the window DRAWS; this is about what it plays.

  group('alert sounds', () {
    late List<String> played;
    const channel = MethodChannel('harness/swarm_tabs');

    setUp(() {
      played = [];
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, (call) async {
            if (call.method == 'playAlert') {
              played.add((call.arguments as Map)['sound'] as String);
            }
            return null;
          });
    });

    tearDown(() {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, null);
    });

    /// A clock the test drives, so the rate limiter cannot be mistaken for the thing under test.
    /// Feeding repeats "instantly" made the re-announcement test pass with the guard REMOVED —
    /// the gap was swallowing them, not the guard.
    late DateTime clock;

    /// Never the default storage. `AlertSoundStore()` with no argument writes to the real
    /// preferences file on this machine, and the "switch off" test below turned the feature off
    /// for the developer running it — a test that silently changes the app you are building.
    AlertSoundStore store({bool on = true}) {
      final made = AlertSoundStore(storage: _Memory());
      // Switched ON explicitly: silence is the default now, so a wiring test that forgot this
      // would pass by making no sound for the wrong reason.
      if (on) made.value = true;
      return made;
    }

    AppNotifier wired() {
      clock = DateTime(2026, 9, 23, 12);
      final notifier = AppNotifier(
        config: AppConfig.dev,
        authSession: AuthSession(),
        alerts: AlertSounds(
          store: store(),
          channel: channel,
          now: () => clock,
        ),
        // Injected, and switched on. Left to the default this would read the app's own global
        // store — the real file-backed one — so the banner assertions would pass or fail on a
        // preference belonging to whoever ran the suite, and silently stop testing anything the
        // day that default flipped. Which it has.
        agentAlerts: AgentAlerts(
          store: ScreenAlertStore(storage: _Memory())..value = true,
        ),
      );
      notifier.machines = [_machine];
      notifier.machineStates['m1'] = MachineState(_machine);
      return notifier;
    }

    test('an agent that stops to ask is heard', () async {
      final app = wired();
      addTearDown(app.dispose);
      await app.handleMachineEventForTest('m1', asked());
      await Future<void>.delayed(Duration.zero);
      expect(played, [AlertKind.needsYou.sound]);
    });

    test('the daemon re-announcing the SAME question is not heard again', () async {
      // Every reconnect re-sends every open question, and attaching to a turn that is already
      // mid-dialog does too. A window that beeped at those would sound an alarm whenever the
      // network hiccuped — for a question the person has been looking at for ten minutes.
      final app = wired();
      addTearDown(app.dispose);
      await app.handleMachineEventForTest('m1', asked());
      // Well past the rate limiter, so silence here is the guard's doing and nothing else.
      clock = clock.add(const Duration(minutes: 5));
      await app.handleMachineEventForTest('m1', asked());
      clock = clock.add(const Duration(minutes: 5));
      await app.handleMachineEventForTest('m1', asked());
      await Future<void>.delayed(Duration.zero);
      expect(played, [AlertKind.needsYou.sound]);
    });

    test('a DIFFERENT question from the same agent is heard', () async {
      final app = wired();
      addTearDown(app.dispose);
      await app.handleMachineEventForTest('m1', asked(requestId: 'q_1'));
      clock = clock.add(const Duration(minutes: 5));
      await app.handleMachineEventForTest(
        'm1',
        asked(requestId: 'q_2', prompt: 'Overwrite the file?'),
      );
      await Future<void>.delayed(Duration.zero);
      // Two questions, two answers owed, and far enough apart that the gap is not the reason.
      expect(played, [AlertKind.needsYou.sound, AlertKind.needsYou.sound]);
    });

    test('a finished turn is heard, with its own sound', () async {
      final app = wired();
      addTearDown(app.dispose);
      await app.handleMachineEventForTest('m1', {
        'type': 'turn_ended',
        'agentId': 'a1',
        'payload': {'agentId': 'a1'},
      });
      await Future<void>.delayed(Duration.zero);
      expect(played, [AlertKind.done.sound]);
    });

    test('a finished turn also raises a banner, named after the agent', () async {
      final app = wired();
      addTearDown(app.dispose);
      app.machineStates['m1']!.agents = [
        const Agent(id: 'a1', name: 'Respond to greeting', engine: 'codex'),
      ];
      await app.handleMachineEventForTest('m1', {
        'type': 'turn_ended',
        'agentId': 'a1',
        'payload': {'agentId': 'a1'},
      });
      final raised = app.agentAlerts.alerts;
      expect(raised, hasLength(1));
      // The agent's own NAME. A banner naming a uuid tells nobody which pane to look at.
      expect(raised.single.title, 'Respond to greeting');
      expect(raised.single.kind, AlertKind.done);
      expect(raised.single.agentId, 'a1');
    });

    test('a question raises a banner too, and a re-announced one does not', () async {
      final app = wired();
      addTearDown(app.dispose);
      await app.handleMachineEventForTest('m1', asked());
      clock = clock.add(const Duration(minutes: 5));
      await app.handleMachineEventForTest('m1', asked());
      expect(app.agentAlerts.alerts, hasLength(1));
      expect(app.agentAlerts.alerts.single.kind, AlertKind.needsYou);
    });

    test('both moments mark the harness unread, whatever the switches say', () async {
      // The mark is not an interruption — it sits still until somebody goes looking — so it is
      // deliberately outside the banner and sound switches. Somebody who turned the noisy halves
      // off still wants the window to say which agent moved while they were away.
      final app = AppNotifier(
        config: AppConfig.dev,
        authSession: AuthSession(),
        alerts: AlertSounds(store: store(on: false), channel: channel),
        agentAlerts: AgentAlerts(
          store: ScreenAlertStore(storage: _Memory()),
        ),
      );
      addTearDown(app.dispose);
      app.machines = [_machine];
      app.machineStates['m1'] = MachineState(_machine);

      await app.handleMachineEventForTest('m1', {
        'type': 'turn_ended',
        'agentId': 'a1',
        'payload': {'agentId': 'a1'},
      });
      expect(app.agentUnread.kindFor('m1', 'a1'), AlertKind.done);
      expect(app.agentAlerts.alerts, isEmpty, reason: 'banners were off');

      await app.handleMachineEventForTest('m1', asked());
      expect(app.agentUnread.kindFor('m1', 'a1'), AlertKind.needsYou);

      // And going to it is what makes it read.
      app.markAgentSeen('m1', 'a1');
      expect(app.agentUnread.count, 0);
    });

    test('a deleted harness stops being counted', () async {
      final app = wired();
      addTearDown(app.dispose);
      await app.handleMachineEventForTest('m1', asked());
      expect(app.agentUnread.count, 1);
      await app.handleMachineEventForTest('m1', {
        'type': 'agent_deleted',
        'payload': {'agentId': 'a1'},
      });
      expect(app.agentUnread.count, 0);
    });

    test('nothing is heard while the switch is off', () async {
      final off = store(on: false);
      final app = AppNotifier(
        config: AppConfig.dev,
        authSession: AuthSession(),
        alerts: AlertSounds(store: off, channel: channel),
      );
      addTearDown(app.dispose);
      app.machines = [_machine];
      app.machineStates['m1'] = MachineState(_machine);
      await app.handleMachineEventForTest('m1', asked());
      await app.handleMachineEventForTest('m1', {
        'type': 'turn_ended',
        'agentId': 'a1',
        'payload': {'agentId': 'a1'},
      });
      await Future<void>.delayed(Duration.zero);
      expect(played, isEmpty);
    });
  });
}
