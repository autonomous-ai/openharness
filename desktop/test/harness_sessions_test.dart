import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/harness_sessions.dart';
import 'package:harness/state/swarm_navigation.dart';
import 'package:harness/state/pending_question.dart';

import 'support/restart_connection.dart';
import 'swarm_state_test.dart' show createApp;

const _project = AgentProject(
  name: 'autonomous-harness',
  cwd: '/work/autonomous-harness',
  branch: 'fix/file-menu-order',
);
const _running = Agent(
  id: 'a0',
  name: 'Font styling review',
  engine: 'claude',
  sessionId: 'conversation',
  terminalAvailable: true,
  project: _project,
);
const _paused = Agent(
  id: 'saved',
  name: 'Landing page polish',
  engine: 'codex',
  sessionId: 'saved-conversation',
  status: 'stopped',
  project: AgentProject(
    name: 'website',
    cwd: '/work/website',
    branch: 'design/landing',
  ),
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late AppNotifier app;
  late RestartConnection connection;
  setUp(() {
    connection = RestartConnection();
    app = createApp(connectionForTest: (_) => connection);
    app.rememberOpenedHarness('m', 'a0');
    app.rememberOpenedHarness('m', 'saved');
    app.machineStates['m']!
      ..machine = const Machine(
        machineId: 'm',
        name: 'iMac — Office',
        authMode: MachineAuthMode.remote,
      )
      ..connectionStatus = ConnectionStatus.connected
      ..nodeOnline = true
      ..agents = [_running, _paused];
  });
  tearDown(() => app.dispose());

  PendingQuestion question(String id, {String request = 'question'}) =>
      PendingQuestion(
        machineId: 'm',
        agentId: id,
        requestId: request,
        answerKey: 'folder',
        prompt: 'Use the shared cache?',
        options: ['Yes', 'No'],
        multi: false,
        since: DateTime(2026, 9, 22),
      );

  test(
    'activity age is compact and safely handles old daemons and clock skew',
    () {
      final now = DateTime(2026, 9, 22, 12);
      expect(harnessActivityAge(null, now), '—');
      expect(
        harnessActivityAge(now.add(const Duration(minutes: 4)), now),
        '0m',
      );
      for (final sample in [
        (59, '0m'),
        (300, '5m'),
        (3599, '59m'),
        (3600, '1h'),
        (86400, '1d'),
        (172800, '2d'),
      ]) {
        expect(
          harnessActivityAge(now.subtract(Duration(seconds: sample.$1)), now),
          sample.$2,
        );
      }
      final parsed = Agent.fromJson({
        'id': 'fresh',
        'updatedAt': now.toIso8601String(),
      });
      expect(parsed.lastActivityAt, now);
      expect(parsed.copyWith(name: 'Renamed').lastActivityAt, now);
      expect(
        Agent.fromJson({'id': 'legacy', 'updatedAt': 'invalid'}).lastActivityAt,
        isNull,
      );
    },
  );

  test('recent follows real activity before navigation recency', () {
    for (final id in ['older', 'newer', 'unknown']) {
      app.rememberOpenedHarness('m', id);
    }
    app.machineStates['m']!.agents = [
      Agent.fromJson({'id': 'older', 'updatedAt': '2026-09-21T10:00:00Z'}),
      Agent.fromJson({'id': 'newer', 'updatedAt': '2026-09-22T10:00:00Z'}),
      const Agent(id: 'unknown', name: 'Unknown'),
    ];
    expect(
      visibleHarnessSessions(
        harnessSessions(app),
        recent: [agentDestinationId('m', 'older')],
      ).map((row) => row.agent.id),
      ['newer', 'older', 'unknown'],
    );
  });

  test(
    'recent sorts by last use: a harness opened anywhere outranks a busier one',
    () {
      app.machineStates['m']!.agents = [
        Agent.fromJson({'id': 'busy', 'updatedAt': '2026-09-26T11:00:00Z'}),
        // Quiet since nine, but somebody opened it at noon — in any client.
        Agent.fromJson({
          'id': 'opened',
          'updatedAt': '2026-09-26T09:00:00Z',
          'lastOpenedAt': '2026-09-26T12:00:00Z',
        }),
        // Opened long ago and busy since: the later of the two counts.
        Agent.fromJson({
          'id': 'worked',
          'updatedAt': '2026-09-26T10:00:00Z',
          'lastOpenedAt': '2026-09-26T08:00:00Z',
        }),
        const Agent(id: 'unknown', name: 'Unknown'),
      ];
      for (final id in ['busy', 'opened', 'worked', 'unknown']) {
        app.rememberOpenedHarness('m', id);
      }
      expect(SessionSort.recent.label, 'Recently used');
      expect(
        visibleHarnessSessions(harnessSessions(app)).map((row) => row.agent.id),
        ['opened', 'busy', 'worked', 'unknown'],
      );
      expect(
        harnessSessions(app)
            .singleWhere((row) => row.agent.id == 'opened')
            .lastUsedAt,
        DateTime.utc(2026, 9, 26, 12),
      );
    },
  );

  test('attention filters live questions, retains missing agents, excludes paused history', () {
    app.rememberOpenedHarness('m', 'missing');
    app.machineStates['m']!.blockedAgents.addAll({
      'a0': question('a0'),
      'saved': question('saved'),
      'missing': question('missing'),
    });
    final rows = visibleHarnessSessions(
      harnessSessions(app),
      filter: SessionFilter.needsInput,
    );
    expect(rows.map((row) => row.agent.id), containsAll(['a0', 'missing']));
    expect(rows, hasLength(2));
    expect(
      rows.singleWhere((row) => row.agent.id == 'missing').canControl,
      isFalse,
    );
    expect(
      rows.singleWhere((row) => row.agent.id == 'missing').canOpen,
      isFalse,
    );
    expect(
      visibleHarnessSessions(rows, query: 'office shared cache'),
      hasLength(2),
    );
  });

  test('inventory deduplicates views, searches context, and sorts deterministically', () async {
    await app.addAgentToSwarm('m', 'a0');
    app.newSwarm(name: 'Second view');
    await app.addAgentToSwarm('m', 'a0');
    final rows = harnessSessions(app);
    expect(rows, hasLength(2));
    expect(rows.first.open, isTrue);
    expect(
      visibleHarnessSessions(rows, query: 'office file-menu').single.agent.id,
      'a0',
    );
    expect(
      visibleHarnessSessions(
        rows,
        filter: SessionFilter.paused,
      ).single.agent.id,
      'saved',
    );
    expect(
      visibleHarnessSessions(
        rows,
        filter: SessionFilter.running,
      ).single.agent.id,
      'a0',
    );
    expect(
      visibleHarnessSessions(rows, recent: [rows.last.id]).first.agent.id,
      'saved',
    );
    expect(
      visibleHarnessSessions(rows, sort: SessionSort.project).first.agent.id,
      'a0',
    );
    app.machineStates['m']!.nodeOnline = false;
    expect(
      harnessSessions(app)
          .every((row) => !row.canControl && row.status == 'Offline'),
      isTrue,
    );
    expect(
      visibleHarnessSessions(
        harnessSessions(app),
        filter: SessionFilter.running,
      ),
      isEmpty,
    );
  });
}
