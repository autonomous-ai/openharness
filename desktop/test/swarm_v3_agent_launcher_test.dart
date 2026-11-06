import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/join/agent_launcher.dart';

void main() {
  for (final kind in ['buddy', 'regular', 'pm']) {
    test(
      '$kind uses this computer and owner command without a login or Team setup',
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
            return command['type'] == 'machine.contribute'
                ? {}
                : {'startId': 'start', 'conversationId': 'chat'};
          },
        );
        final result = await launcher.create(
          'codex',
          kind,
          kind == 'pm' ? 'Compiler' : null,
          'operation',
        );
        expect(result['startId'], 'start');
        final start = sent.last;
        expect(start['machineId'], 'local');
        if (kind == 'buddy') {
          expect(sent, hasLength(1));
          expect(start['type'], 'buddy.create');
          expect(start['setup'], containsPair('cwd', '/work'));
          expect((start['setup'] as Map)['engines'], ['codex']);
        } else {
          expect(sent.first['type'], 'machine.contribute');
          expect(sent.first['teamAccountOnly'], isTrue);
          expect(sent.first.containsKey('ifMissing'), isFalse);
          expect(start['type'], 'agent.new');
          expect(start['kind'], kind);
          if (kind == 'pm') expect(start.containsKey('name'), isFalse);
          expect(start['projectName'], kind == 'pm' ? 'Compiler' : null);
        }
        expect(sent.toString(), isNot(contains('teamSetup')));
      },
    );
  }
  for (final kind in ['regular', 'pm']) {
    test(
      'a non-owner collaborator can create $kind without sharing their login',
      () async {
        final calls = <Map<String, dynamic>>[];
        final launcher = SwarmAgentLauncher(
          machineId: 'collaborator-computer',
          machineName: 'This computer',
          inSwarm: false,
          isCurrent: () => true,
          prepare: (_) async => {
            'cwd': '/work',
            'engines': ['claude'],
          },
          command: (command, operation) async {
            // This transport represents a collaborator, not the org owner. The
            // backend reserves automatic ifMissing admission for the owner.
            if (command['type'] == 'machine.contribute' &&
                command['ifMissing'] == true) {
              throw const SwarmAgentLaunchFailure(
                'Only the org owner adds a machine automatically.',
              );
            }
            calls.add(command);
            return command['type'] == 'machine.contribute'
                ? <String, dynamic>{}
                : {'startId': 'started', 'conversationId': 'own-chat'};
          },
        );
        final result = await launcher.create(
          'claude',
          kind,
          kind == 'pm' ? 'Compiler' : null,
          'collaborator-operation',
        );
        expect(result['startId'], 'started');
        expect(calls, hasLength(2));
        expect(calls.first['teamAccountOnly'], isTrue);
        expect(calls.first.containsKey('ownAccountWork'), isFalse);
        expect(calls.last['type'], 'agent.new');
      },
    );
  }
  test('a retry retains preparation and each command operation', () async {
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
        if (cmd['type'] == 'agent.new' && starts++ == 0)
          throw StateError('lost');
        return {'startId': 'one'};
      },
    );
    await expectLater(
      launcher.create('claude', 'regular', null, 'op'),
      throwsStateError,
    );
    await launcher.create('claude', 'regular', null, 'op');
    expect(prepares, 1);
    expect(ops.where((op) => op.endsWith('-start')).toSet(), hasLength(1));
    expect(ops.where((op) => op.endsWith('-machine')), hasLength(1));
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
      launcher.create('claude', 'buddy', null, 'op'),
      throwsA(isA<SwarmAgentLaunchFailure>()),
    );
  });
}
