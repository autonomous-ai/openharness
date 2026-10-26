// A harness the machine holds starts by itself: an agent it is installing, a
// model waking. Found on a fresh Ubuntu VM with desktop 1.2.65 and CLI 0.3.77
// (2026-10-12): the first workspace asked once while setup was still
// downloading the agents, was told "Installing OpenCode. The harness starts
// once it is installed.", and opened nothing, so three harnesses started with
// no pane anywhere. In the New Harness box the same line stayed after the
// harness had started, until Check status was pressed.
//
// A harness the machine is already starting needs no one either. The machine
// answers `pending` five seconds into a create, with nothing held, and a
// worktree from main took 13 s on the office Mac (2026-10-14): every such New
// Harness said "office is still starting your harness. Check again in a
// moment." in red, and opened nothing until Check status was pressed.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/widgets/new_harness_form.dart';
import 'package:harness/ws/ws_conn.dart';

import 'swarm_state_test.dart' show createApp;

const _installing = 'Installing Kilo. The harness starts once it is installed.';

/// A machine that holds a create while it installs the agent, then starts the
/// harness by itself: `pending` for [holds] answers, then made or refused.
class _Machine extends WsConn {
  _Machine()
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );

  int holds = 0;

  /// Answers `pending` with nothing held this many times: the machine has
  /// begun starting the harness (its worktree, its pane).
  int starts = 0;
  bool refuses = false;

  /// Keeps the next status answer back until it completes.
  Completer<void>? gate;
  final asked = <String>[];
  final cancels = <String>[];
  String? _engine;

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    switch (type) {
      case 'engines_probe':
        return {'engines': []};
      case 'git_project_info':
        return {'isGit': false};
      case 'fs_list_dir':
        return {'path': '/work', 'entries': []};
      case 'dsh_list':
        return {'dsh': []};
      case 'agent_create':
        asked.add(type);
        _engine = payload['engine'] as String?;
        return _answer(payload['creationId'] as String);
      case 'agent_create_status':
        asked.add(type);
        if (gate case final held?) {
          gate = null;
          await held.future;
        }
        return _answer(payload['creationId'] as String);
      case 'agent_create_cancel':
        cancels.add(payload['creationId'] as String);
        return {'creationId': payload['creationId'], 'state': 'cancelled'};
      default:
        return {};
    }
  }

  Map<String, dynamic> _answer(String creationId) {
    // Held first, then started: a request the machine has claimed is never
    // held again.
    if (holds > 0) {
      holds--;
      return {
        'creationId': creationId,
        'state': 'pending',
        'held': {'service': 'install', 'detail': _installing},
      };
    }
    if (starts > 0) {
      starts--;
      return {'creationId': creationId, 'state': 'pending'};
    }
    if (refuses) {
      return {
        'creationId': creationId,
        'state': 'failed',
        'failure': {
          'code': 'ENGINE_INSTALL_FAILED',
          'detail': 'Kilo could not be installed: npm ERR! network',
        },
      };
    }
    return {
      'creationId': creationId,
      'state': 'created',
      'agent': {'id': 'made', 'name': 'Made', 'engine': _engine},
    };
  }
}

AppNotifier _app(_Machine machine) {
  final app = createApp(connectionForTest: (_) => machine, connected: true)
    ..heldCreationInterval = const Duration(milliseconds: 1);
  addTearDown(app.dispose);
  return app;
}

Iterable<String?> _panesOf(AppNotifier app) =>
    app.allPanes.map((pane) => pane.agentId);

void main() {
  group('a create told to wait out a hold', () {
    test('asks after the same request until the harness is made, and opens its pane', () async {
      final machine = _Machine()..holds = 3;
      final app = _app(machine);
      final attempt = AgentCreationAttempt(
        holdWait: const Duration(minutes: 1),
      );
      final error = await app.createAgent(
        'm',
        engine: 'kilo',
        folder: '/work',
        attempt: attempt,
      );
      expect(error, isNull);
      // One create, then what became of it: never a second harness.
      expect(machine.asked, [
        'agent_create',
        'agent_create_status',
        'agent_create_status',
        'agent_create_status',
      ]);
      expect(attempt.agentId, 'made');
      expect(attempt.awaitingConfirmation, isFalse);
      expect(_panesOf(app).where((id) => id == 'made'), hasLength(1));
    });

    test('answers at once, as before, when it is not held', () async {
      final machine = _Machine();
      final app = _app(machine);
      final error = await app.createAgent(
        'm',
        engine: 'kilo',
        folder: '/work',
        attempt: AgentCreationAttempt(holdWait: const Duration(minutes: 1)),
      );
      expect(error, isNull);
      expect(machine.asked, ['agent_create']);
    });

    test('ends on a refusal, with the machine\'s reason', () async {
      final machine = _Machine()
        ..holds = 1
        ..refuses = true;
      final app = _app(machine);
      final attempt = AgentCreationAttempt(
        holdWait: const Duration(minutes: 1),
      );
      final error = await app.createAgent(
        'm',
        engine: 'kilo',
        folder: '/work',
        attempt: attempt,
      );
      expect(error, isNotNull);
      expect(machine.asked, ['agent_create', 'agent_create_status']);
      expect(attempt.awaitingConfirmation, isFalse);
      expect(_panesOf(app), isNot(contains('made')));
    });

    test('gives the hold\'s own words when the wait has passed, the request still saved', () async {
      final machine = _Machine()..holds = 1 << 20;
      final app = _app(machine);
      final attempt = AgentCreationAttempt(
        holdWait: const Duration(milliseconds: 40),
      );
      final error = await app.createAgent(
        'm',
        engine: 'kilo',
        folder: '/work',
        attempt: attempt,
      );
      expect(error, _installing);
      expect(attempt.canCancelPending, isTrue);
      expect(machine.asked.where((type) => type == 'agent_create'), [
        'agent_create',
      ]);
      expect(machine.asked.length, greaterThan(1));
    });
  });

  group('a harness the machine is already starting', () {
    test(
      'is asked after by any create until it is made, and its pane opens',
      () async {
        final machine = _Machine()..starts = 3;
        final app = _app(machine);
        final attempt = AgentCreationAttempt();
        final error = await app.createAgent(
          'm',
          engine: 'claude',
          folder: '/work',
          attempt: attempt,
        );
        expect(error, isNull);
        expect(machine.asked, [
          'agent_create',
          'agent_create_status',
          'agent_create_status',
          'agent_create_status',
        ]);
        expect(attempt.awaitingConfirmation, isFalse);
        expect(_panesOf(app).where((id) => id == 'made'), hasLength(1));
      },
    );

    test('ends on a refusal that came while it started', () async {
      final machine = _Machine()
        ..starts = 1
        ..refuses = true;
      final app = _app(machine);
      final attempt = AgentCreationAttempt();
      final error = await app.createAgent(
        'm',
        engine: 'claude',
        folder: '/work',
        attempt: attempt,
      );
      expect(error, contains('Kilo could not be installed'));
      expect(machine.asked, ['agent_create', 'agent_create_status']);
      expect(attempt.awaitingConfirmation, isFalse);
    });

    test('has its own wait after a hold before it, as a new computer\'s first harness does', () async {
      final machine = _Machine()
        ..holds = 1
        ..starts = 2;
      final app = _app(machine)
        ..startingCreationWait = const Duration(milliseconds: 200);
      // The install outlasts the start's whole wait.
      final gate = machine.gate = Completer<void>();
      unawaited(
        Future<void>.delayed(const Duration(milliseconds: 400), gate.complete),
      );
      final attempt = AgentCreationAttempt(
        holdWait: const Duration(minutes: 1),
      );
      final error = await app.createAgent(
        'm',
        engine: 'kilo',
        folder: '/work',
        attempt: attempt,
      );
      expect(error, isNull);
      expect(machine.asked, [
        'agent_create',
        'agent_create_status',
        'agent_create_status',
        'agent_create_status',
      ]);
    });

    test('a later call that never reaches the machine answers at once, not after a start\'s wait', () async {
      final machine = _Machine()..starts = 1 << 20;
      final app = _app(machine)
        ..startingCreationWait = const Duration(milliseconds: 40);
      final attempt = AgentCreationAttempt();
      await app.createAgent(
        'm',
        engine: 'claude',
        folder: '/work',
        attempt: attempt,
      );
      app.startingCreationWait = const Duration(minutes: 1);
      final asked = machine.asked.length;
      final watch = Stopwatch()..start();
      // Other choices for the same request: refused before the machine is asked.
      final error = await app.createAgent(
        'm',
        engine: 'codex',
        folder: '/work',
        attempt: attempt,
      );
      expect(error, 'Check the original request before changing its choices.');
      expect(watch.elapsed, lessThan(const Duration(seconds: 5)));
      expect(machine.asked, hasLength(asked));
    });

    test('says it is still starting once the wait has passed, Check status still offered', () async {
      final machine = _Machine()..starts = 1 << 20;
      final app = _app(machine)
        ..startingCreationWait = const Duration(milliseconds: 40);
      final attempt = AgentCreationAttempt();
      final error = await app.createAgent(
        'm',
        engine: 'claude',
        folder: '/work',
        attempt: attempt,
      );
      expect(error, contains('still starting your harness'));
      expect(attempt.awaitingConfirmation, isTrue);
      expect(attempt.canCancelPending, isFalse);
      expect(machine.asked.where((type) => type == 'agent_create'), [
        'agent_create',
      ]);
      expect(machine.asked.length, greaterThan(1));
    });
  });

  test(
    'a create not told to wait answers a hold at once with what it waits for',
    () async {
      final machine = _Machine()..holds = 3;
      final app = _app(machine);
      final attempt = AgentCreationAttempt();
      final error = await app.createAgent(
        'm',
        engine: 'kilo',
        folder: '/work',
        attempt: attempt,
      );
      expect(error, _installing);
      expect(machine.asked, ['agent_create']);
      expect(attempt.canCancelPending, isTrue);
    },
  );

  group('the New Harness box', () {
    NewHarnessController boxOn(AppNotifier app) {
      final box = NewHarnessController(
        app,
        machineId: 'm',
        engine: 'claude',
        folder: '/work',
      );
      addTearDown(box.dispose);
      return box;
    }

    test('asks after a held request by itself, changing nothing on screen until the harness has started', () async {
      final machine = _Machine()..holds = 2;
      final app = _app(machine);
      final box = boxOn(app);
      expect(await box.create(), NewHarnessOutcome.failed);
      expect(box.error, _installing);
      expect(box.canCancelPending, isTrue);

      // Still held: the line and the buttons stay exactly as they were.
      final seen = <(String?, String?)>[];
      void record() => seen.add((box.status, box.error));
      box.addListener(record);
      final still = box.followHeld();
      expect((box.status, box.error), (null, _installing));
      expect(await still, NewHarnessOutcome.failed);
      expect(seen, [(null, _installing)]);
      expect(box.canCancelPending, isTrue);
      box.removeListener(record);

      // Started: the same outcome a press of Check status would have had.
      expect(await box.followHeld(), NewHarnessOutcome.created);
      expect(box.checking, isFalse);
      expect(box.busy, isFalse);
      expect(machine.asked, [
        'agent_create',
        'agent_create_status',
        'agent_create_status',
      ]);
      expect(_panesOf(app).where((id) => id == 'made'), hasLength(1));
    });

    test('starts a harness the machine takes a while over without ever saying it is still starting', () async {
      final machine = _Machine()..starts = 2;
      final app = _app(machine);
      final box = boxOn(app);
      final errors = <String?>[];
      void record() => errors.add(box.error);
      box.addListener(record);
      expect(await box.create(), NewHarnessOutcome.created);
      box.removeListener(record);
      expect(errors.whereType<String>(), isEmpty);
      expect(box.checking, isFalse);
      expect(box.busy, isFalse);
      expect(machine.asked, [
        'agent_create',
        'agent_create_status',
        'agent_create_status',
      ]);
      expect(_panesOf(app).where((id) => id == 'made'), hasLength(1));
    });

    test('has nothing to ask after when no request is held', () async {
      final machine = _Machine();
      final app = _app(machine);
      final box = boxOn(app);
      expect(await box.followHeld(), NewHarnessOutcome.failed);
      expect(machine.asked, isEmpty);
    });

    test('says a refusal that came while it waited', () async {
      final machine = _Machine()
        ..holds = 1
        ..refuses = true;
      final app = _app(machine);
      final box = boxOn(app);
      await box.create();
      expect(await box.followHeld(), NewHarnessOutcome.failed);
      expect(box.error, isNot(_installing));
      expect(box.checking, isFalse);
      expect(box.canCancelPending, isFalse);
    });

    test('still cancels when Cancel is pressed during such a check', () async {
      final machine = _Machine()..holds = 10;
      final app = _app(machine);
      final box = boxOn(app);
      await box.create();
      final gate = machine.gate = Completer<void>();
      final check = box.followHeld();
      final cancel = box.cancelPending();
      // The same check is joined, not doubled.
      expect(box.followHeld(), completion(NewHarnessOutcome.failed));
      gate.complete();
      expect(await check, NewHarnessOutcome.failed);
      await cancel;
      expect(machine.cancels, hasLength(1));
      expect(box.status, 'Creation cancelled.');
      expect(box.canCancelPending, isFalse);
    });

    for (final (engine, hint) in [
      ('claude', 'What would you like to work on?'),
      ('terminal', 'Open a terminal in this repo'),
      // Takes no first message, and is not a terminal: the box said one would open.
      ('kilo', 'Type to Kilo once it opens'),
    ]) {
      testWidgets('says what $engine does with the task line', (tester) async {
        final app = _app(_Machine());
        final box = NewHarnessController(
          app,
          machineId: 'm',
          engine: engine,
          folder: '/work',
        );
        addTearDown(box.dispose);
        await tester.pumpWidget(
          MaterialApp(
            theme: ThemeData.dark(),
            home: Scaffold(
              body: Center(
                child: SizedBox(
                  width: 1000,
                  height: 600,
                  child: NewHarnessForm(
                    controller: box,
                    onClose: () {},
                    onCreated: () {},
                    desktop: true,
                    embedded: true,
                  ),
                ),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        final field = tester.widget<TextField>(
          find.byKey(const ValueKey('new-harness-task')),
        );
        expect(field.decoration?.hintText, hint);
      });
    }

    for (final starting in [false, true]) {
      testWidgets(
        'the form follows ${starting ? 'startup after its wait expires' : 'a held request'} with no press',
        (tester) async {
          final previous = NewHarnessFormState.heldFollowInterval;
          NewHarnessFormState.heldFollowInterval = const Duration(seconds: 3);
          addTearDown(() => NewHarnessFormState.heldFollowInterval = previous);
          final machine = _Machine();
          if (starting) {
            machine.starts = 3;
          } else {
            machine.holds = 3;
          }
          final app = _app(machine)..startingCreationWait = Duration.zero;
          final box = boxOn(app);
          var created = 0;
          await tester.pumpWidget(
            MaterialApp(
              theme: ThemeData.dark(),
              home: Scaffold(
                body: Center(
                  child: SizedBox(
                    width: 820,
                    height: 450,
                    child: NewHarnessForm(
                      controller: box,
                      onClose: () {},
                      onCreated: () => created++,
                    ),
                  ),
                ),
              ),
            ),
          );
          await tester.pumpAndSettle();
          // Not through runAsync: a timer made there is a real one, which no pump moves.
          final first = box.create();
          await tester.pump();
          expect(await first, NewHarnessOutcome.failed);
          await tester.pump();
          final waiting = box.error!;
          expect(
            waiting,
            starting ? contains('still starting your harness') : _installing,
          );
          expect(box.canCancelPending, !starting);
          expect(find.text(waiting), findsOneWidget);
          expect(created, 0);

          // Twice still pending, then started: only status checks, never another create.
          await tester.pump(const Duration(seconds: 3));
          await tester.pump();
          expect(machine.asked, hasLength(2));
          expect(created, 0);
          expect(find.text(waiting), findsOneWidget);
          await tester.pump(const Duration(seconds: 3));
          await tester.pump();
          expect(created, 0);
          await tester.pump(const Duration(seconds: 3));
          await tester.pump();
          expect(created, 1);
          expect(machine.asked, [
            'agent_create',
            'agent_create_status',
            'agent_create_status',
            'agent_create_status',
          ]);

          // Nothing more is asked once it is made.
          await tester.pump(const Duration(seconds: 10));
          expect(machine.asked, hasLength(4));
        },
      );
    }
  });
}
