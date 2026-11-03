import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/super_tabs/import_agent.dart';
import 'package:harness/ws/ws_conn.dart';

import 'support/super_tab_fixture.dart';
import 'swarm_state_test.dart' show createApp;

/// This Mac's daemon: answers `agent_handoff_prepare` with [handoff].
class _Daemon extends WsConn {
  _Daemon()
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );

  /// Every request, by type and payload.
  final calls = <(String, Map<String, dynamic>)>[];
  Map<String, dynamic> Function(Map<String, dynamic> payload) handoff = (_) => {
    'error': 'UNSUPPORTED',
  };

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    calls.add((type, Map.of(payload)));
    if (type == 'agent_handoff_prepare') return handoff(payload);
    return const {};
  }
}

/// An agent as this Mac's daemon lists it.
Agent _agent(
  String id, {
  String engine = 'claude',
  String status = 'active',
  String? sessionId = 'session',
  String? startedBy,
  String? parentAgentId,
  String cwd = '/work/api',
  String updatedAt = '2026-11-03T08:00:00.000Z',
}) => Agent.fromJson({
  'id': id,
  'name': 'fix-$id',
  'engine': engine,
  'status': status,
  'sessionId': ?sessionId,
  'startedBy': ?startedBy,
  'parentAgentId': ?parentAgentId,
  'project': {'name': 'api', 'cwd': cwd},
  'updatedAt': updatedAt,
  'terminal': {'available': true},
});

class ImportFixture {
  ImportFixture() {
    app = createApp(connected: true, connectionForTest: (_) => daemon);
    app.currentUser = const CurrentUserProfile(
      id: 'owner',
      email: 'owner@example.com',
    );
    app.machineStates['m']!.localOnly = true;
    for (final machine in const [
      // This Mac's Harness Team account, on the same account.
      Machine(
        machineId: 'team-m',
        authMode: MachineAuthMode.remote,
        name: 'Harness Team',
        sessionKind: 'team',
      ),
      // Another of the owner's computers.
      Machine(
        machineId: 'laptop',
        authMode: MachineAuthMode.remote,
        name: 'Laptop',
      ),
      // Someone else's computer, shared with the owner.
      Machine(
        machineId: 'shared',
        authMode: MachineAuthMode.remote,
        name: 'Mira',
        machineShare: MachineShare(
          ownerName: 'mira',
          ownerEmail: 'mira@example.com',
          via: 'person',
          added: true,
        ),
      ),
    ]) {
      app.machines = [...app.machines, machine];
      app.machineStates[machine.machineId] = MachineState(machine)
        ..agents = [_agent('${machine.machineId}-agent')];
    }
    server.state['projects'] = [projectFixture('lead', 'openharness', 'lead')];
    server.state['machines'] = <dynamic>[macPool, teamPool];
  }

  final daemon = _Daemon();
  late final AppNotifier app;
  final server = ConversationServer();
  late final c = server.controller();

  final macPool = <String, dynamic>{
    'machineId': 'm',
    'name': 'Studio',
    'contributorId': 'owner',
    'scope': 'swarm',
    'cwd': '/Users/owner/.harness/swarm/tab',
  };
  final teamPool = <String, dynamic>{
    'machineId': 'team-m',
    'name': 'Studio',
    'contributorId': 'owner',
    'hostMachineId': 'm',
    'scope': 'swarm',
    'cwd': '/Users/Shared/harness-team/swarm/tab',
    'observation': {'receivedAt': 1},
  };

  /// This Mac's agents, as its daemon lists them.
  set agents(List<Agent> agents) => app.machineStates['m']!.agents = agents;

  Future<void> start() => c.refresh();

  void dispose() {
    c.dispose();
    app.dispose();
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  Future<ImportFixture> fixture() async {
    final f = ImportFixture();
    addTearDown(f.dispose);
    await f.start();
    return f;
  }

  group('which agents can be imported', () {
    test('only this Mac\'s own Claude Code and Codex agents, running or '
        'resumable, that no Swarm lists and the Swarm did not start', () async {
      final f = await fixture();
      f.agents = [
        _agent('claude', updatedAt: '2026-11-03T08:00:00.000Z'),
        _agent('codex', engine: 'codex', updatedAt: '2026-11-03T09:00:00.000Z'),
        _agent('opencode', engine: 'opencode'),
        _agent('terminal', engine: 'terminal'),
        // Listed by this Swarm: a teammate's agent and a Buddy.
        _agent('listed'),
        _agent('buddy'),
        // Started by the Swarm: an agent started it, from no harness here.
        _agent('swarm-started', startedBy: 'agent'),
        // Started by one of this Mac's own harnesses: the person's.
        _agent('child', startedBy: 'agent', parentAgentId: 'claude'),
        _agent('paused', status: 'stopped'),
        _agent('gone', status: 'stopped', sessionId: null),
      ];
      (f.server.state['agents'] as List).addAll([
        {
          'id': 'agent-listed',
          'projectId': 'lead',
          'name': 'Engineer',
          'machineId': 'm',
          'harnessId': 'listed',
          'contributorId': 'owner',
          'configuration': {'engine': 'claude'},
        },
        {
          'id': 'agent-buddy',
          'projectId': 'lead',
          'name': 'Buddy',
          'buddyOf': {'personId': 'owner', 'generation': 'fixture'},
          'machineId': 'm',
          'harnessId': 'buddy',
          'contributorId': 'owner',
          'configuration': {'engine': 'claude'},
        },
      ]);
      await f.c.refresh();

      final offered = importableAgents(f.app, f.c);
      // Newest first, all on this Mac.
      expect(
        [for (final a in offered) a.agent.id],
        ['codex', 'claude', 'child', 'paused'],
      );
      expect(offered.map((a) => a.machineId).toSet(), {'m'});
    });

    test('never an agent of the Team account, another computer or another '
        'person', () async {
      final f = await fixture();
      f.agents = [];
      expect(importableAgents(f.app, f.c), isEmpty);
    });

    test('nothing when this computer is not running Harness', () async {
      final f = await fixture();
      f.agents = [_agent('claude')];
      f.app.machineStates['m']!.localOnly = false;
      expect(importableAgents(f.app, f.c), isEmpty);
      expect(importUnavailable(f.app, f.c), isNotNull);
    });
  });

  group('where the new agent runs', () {
    test('this Mac\'s Team account in the Swarm: import is offered', () async {
      final f = await fixture();
      expect(importUnavailable(f.app, f.c), isNull);
    });

    test('no Team account for this Mac in the Swarm says how to set one up, '
        'and starts nowhere else', () async {
      final f = await fixture();
      f.server.state['machines'] = <dynamic>[f.macPool];
      await f.c.refresh();
      expect(importUnavailable(f.app, f.c), kImportNeedsTeamAccount);
      // A Team account of another Mac is not this Mac's.
      f.server.state['machines'] = <dynamic>[
        f.macPool,
        {...f.teamPool, 'hostMachineId': 'laptop'},
      ];
      await f.c.refresh();
      expect(importUnavailable(f.app, f.c), kImportNeedsTeamAccount);
    });

    test('a Team account that takes no work says why', () async {
      final f = await fixture();
      f.teamPool['teamWork'] = {
        'allowed': false,
        'code': 'PRIVACY_CHECK_FAILED',
        'reason': 'Its Team account failed the privacy check.',
      };
      await f.c.refresh();
      expect(
        importUnavailable(f.app, f.c),
        'Its Team account failed the privacy check.',
      );
    });

    test('this Mac not in the Swarm says to add it', () async {
      final f = await fixture();
      f.server.state['machines'] = <dynamic>[];
      await f.c.refresh();
      expect(importUnavailable(f.app, f.c), kImportNeedsThisMac);
    });
  });
}
