import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/join/agent_launcher.dart';

// The Buddy a person brings as they join starts through the Swarm on their own
// computer (buddy.create), whichever form chose its engine (task #4196).
void main() {
  test(
    'a Buddy uses this computer and owner command without a login or Team setup',
    () async {
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
    },
  );

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
    await expectLater(launcher.create('claude', 'op'), throwsStateError);
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
}
