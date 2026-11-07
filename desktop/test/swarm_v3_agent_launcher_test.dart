import 'dart:async';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/join/agent_launcher.dart';

// The Buddy a person brings as they join starts through the Swarm on their own
// computer (buddy.create), whichever form chose its engine (task #4196).
void main() {
  test('a Buddy uses this computer and owner command without a login or Team setup', () async {
    final sent = <Map<String, dynamic>>[];
    final launcher = SwarmAgentLauncher(
      machineId: 'local',
      machineName: 'My computer',
      inSwarm: false,
      isCurrent: () => true,
      prepare: (operation) async => {
        'name': 'My computer',
        'cwd': '/work',
        'engines': ['codex', 'pi'],
      },
      command: (command, operation) async {
        sent.add(command);
        return {'startId': 'start', 'conversationId': 'chat'};
      },
    );
    final result = await launcher.create('codex', 'operation');
    expect(result['startId'], 'start');
    expect(sent, hasLength(1));
    expect(sent.single['type'], 'buddy.create');
    expect(sent.single['machineId'], 'local');
    expect(sent.single['setup'], containsPair('cwd', '/work'));
    expect((sent.single['setup'] as Map)['engines'], ['codex']);
    expect(sent.toString(), isNot(contains('teamSetup')));
  });

  test('a computer already in the Swarm sends no setup', () async {
    final sent = <Map<String, dynamic>>[];
    final launcher = SwarmAgentLauncher(
      machineId: 'local',
      machineName: 'Mac',
      inSwarm: true,
      isCurrent: () => true,
      prepare: (op) async => throw StateError('must not prepare'),
      command: (command, op) async {
        sent.add(command);
        return {'startId': 'one'};
      },
    );
    await launcher.create('claude', 'op');
    expect(sent.single.containsKey('setup'), isFalse);
  });

  test('a retry retains preparation and its operation', () async {
    var prepares = 0, starts = 0;
    final ops = <String>[];
    final launcher = SwarmAgentLauncher(
      machineId: 'local',
      machineName: 'Mac',
      inSwarm: false,
      isCurrent: () => true,
      prepare: (op) async {
        prepares++;
        return {
          'cwd': '/work',
          'engines': ['claude'],
        };
      },
      command: (cmd, op) async {
        ops.add(op);
        if (starts++ == 0) throw StateError('lost');
        return {'startId': 'one'};
      },
    );
    await expectLater(
      launcher.create('claude', 'op'),
      throwsA(isA<SwarmAgentLaunchFailure>()),
    );
    await launcher.create('claude', 'op');
    expect(prepares, 1);
    expect(ops.toSet(), {'op-start'});
  });

  test('account invalidation after prepare never sends a command', () async {
    var current = true;
    final launcher = SwarmAgentLauncher(
      machineId: 'local',
      machineName: 'Mac',
      inSwarm: false,
      isCurrent: () => current,
      prepare: (op) async {
        current = false;
        return {
          'cwd': '/work',
          'engines': ['claude'],
        };
      },
      command: (cmd, op) async => throw StateError('must not send'),
    );
    await expectLater(
      launcher.create('claude', 'op'),
      throwsA(isA<SwarmAgentLaunchFailure>()),
    );
  });

  // Audit finding 2 (#4442): a computer the Swarm doesn't list yet answers its
  // first ask "preparing"; the start waits for it, as Add computer does.
  test(
    'a computer still preparing is asked again until ready, and starts once',
    () {
      fakeAsync((async) {
        final asks = <String>[];
        final sent = <Map<String, dynamic>>[];
        final launcher = SwarmAgentLauncher(
          machineId: 'local',
          machineName: 'Mac',
          inSwarm: false,
          isCurrent: () => true,
          prepare: (op) async {
            asks.add(op);
            return asks.length < 3
                ? {'state': 'preparing'}
                : {
                    'cwd': '/work',
                    'engines': ['claude'],
                  };
          },
          command: (command, op) async {
            sent.add(command);
            return {'startId': 'one'};
          },
        );
        Map<String, dynamic>? result;
        Object? failure;
        launcher
            .create('claude', 'op')
            .then<void>(
              (r) {
                result = r;
              },
              onError: (Object e) {
                failure = e;
              },
            );
        async.elapse(const Duration(seconds: 5));
        expect(failure, isNull);
        expect(result?['startId'], 'one');
        expect(asks, ['op-prepare', 'op-prepare', 'op-prepare']);
        expect(sent.single['setup'], containsPair('cwd', '/work'));
        expect((sent.single['setup'] as Map).containsKey('state'), isFalse);
      });
    },
  );

  // Review of #4442: closing the form while the computer prepares stops the
  // wait; nothing is started, and once the start is sent it can't stop.
  test(
    'stop during the preparing wait sends no start; after it, stop refuses',
    () {
      fakeAsync((async) {
        var asks = 0;
        final sent = <Map<String, dynamic>>[];
        final launcher = SwarmAgentLauncher(
          machineId: 'local',
          machineName: 'Mac',
          inSwarm: false,
          isCurrent: () => true,
          prepare: (op) async {
            asks++;
            return {'state': 'preparing'};
          },
          command: (command, op) async {
            sent.add(command);
            return {'startId': 'one'};
          },
        );
        Object? failure;
        launcher.create('claude', 'op').catchError((Object e) {
          failure = e;
          return <String, dynamic>{};
        });
        async.elapse(const Duration(seconds: 3));
        expect(launcher.stop(), isTrue);
        final asked = asks;
        async.elapse(const Duration(seconds: 10));
        expect(failure, isA<SwarmAgentLaunchFailure>());
        expect(asks, asked);
        expect(sent, isEmpty);

        final listed = SwarmAgentLauncher(
          machineId: 'local',
          machineName: 'Mac',
          inSwarm: true,
          isCurrent: () => true,
          prepare: (op) async => throw StateError('must not prepare'),
          command: (command, op) => Completer<Map<String, dynamic>>().future,
        );
        listed.create('claude', 'op').ignore();
        async.flushMicrotasks();
        expect(listed.stop(), isFalse);
      });
    },
  );

  test('a computer that never finishes preparing gives up in plain words', () {
    fakeAsync((async) {
      final launcher = SwarmAgentLauncher(
        machineId: 'local',
        machineName: 'Mac',
        inSwarm: false,
        isCurrent: () => true,
        prepare: (op) async => {'state': 'preparing'},
        command: (command, op) async => throw StateError('must not send'),
      );
      Object? failure;
      launcher.create('claude', 'op').catchError((Object e) {
        failure = e;
        return <String, dynamic>{};
      });
      async.elapse(const Duration(minutes: 4));
      expect(failure, isNull);
      async.elapse(const Duration(minutes: 2));
      expect(
        failure,
        isA<SwarmAgentLaunchFailure>().having(
          (f) => f.message,
          'message',
          'Mac is still preparing your agent’s folder. Try again in a minute.',
        ),
      );
    });
  });

  // Audit finding 10 (#4442): never a raw TimeoutException or daemon error.
  test('a computer that doesn\'t answer times out in plain words', () {
    fakeAsync((async) {
      final launcher = SwarmAgentLauncher(
        machineId: 'local',
        machineName: 'Mac',
        inSwarm: false,
        isCurrent: () => true,
        prepare: (op) => Completer<Map<String, dynamic>>().future,
        command: (command, op) async => throw StateError('must not send'),
      );
      Object? failure;
      launcher.create('claude', 'op').catchError((Object e) {
        failure = e;
        return <String, dynamic>{};
      });
      async.elapse(const Duration(seconds: 30));
      expect(
        failure,
        isA<SwarmAgentLaunchFailure>().having(
          (f) => f.message,
          'message',
          'Mac didn’t answer in time. Check that Harness is running there, then try again.',
        ),
      );
    });
  });

  test('a raw failure becomes a sentence without its text', () async {
    final launcher = SwarmAgentLauncher(
      machineId: 'local',
      machineName: 'Mac',
      inSwarm: true,
      isCurrent: () => true,
      prepare: (op) async => throw StateError('unused'),
      command: (command, op) async =>
          throw StateError('/Users/someone/private path'),
    );
    await expectLater(
      launcher.create('claude', 'op'),
      throwsA(
        isA<SwarmAgentLaunchFailure>().having(
          (f) => f.message,
          'message',
          'Couldn’t reach Harness on Mac. Check that it’s running, then try again.',
        ),
      ),
    );
  });

  // Task #4541: Join's agent becomes a Member of the project picked.
  test('the pick goes with the start as its main project', () async {
    final sent = <Map<String, dynamic>>[];
    SwarmAgentLauncher launcher() => SwarmAgentLauncher(
      machineId: 'local',
      machineName: 'Mac',
      inSwarm: true,
      isCurrent: () => true,
      prepare: (op) async => throw StateError('must not prepare'),
      command: (command, op) async {
        sent.add(command);
        return {'startId': 'one'};
      },
    );
    await launcher().create('claude', 'a', mainProjectId: 'lamp');
    await launcher().create('claude', 'c');
    expect(sent[0], containsPair('mainProjectId', 'lamp'));
    expect(sent[1].containsKey('mainProjectId'), isFalse);
  });
}
