import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/terminal/terminal_session.dart';

import 'support/restart_connection.dart';
import 'swarm_state_test.dart' show createApp;

/// ⌘B's send (docs/design/2026-10-09-auto-router.md): the task goes into the session's own pane once it
/// takes input, and a stopped session is resumed first, as ⌘P opens one.
class _Pane extends TerminalSession {
  _Pane(String agentId)
    : super(
        machineId: 'm',
        agentId: agentId,
        agentName: agentId,
        engineId: 'claude',
        send: (_, _) async => true,
        sendBinary: (_) async => true,
      ) {
    status = TerminalSessionStatus.controlling;
    streamId = 's-$agentId';
  }

  final typed = <String>[];

  @override
  bool get acceptsInput => true;

  @override
  Future<bool> sendComposerText(String text, {String? tabId}) async {
    typed.add(text);
    return true;
  }
}

const _saved = Agent(
  id: 'saved',
  name: 'Lamp v1',
  engine: 'claude',
  sessionId: 'lamp-conversation',
  status: 'stopped',
  project: AgentProject(name: 'lamp', cwd: '/work/lamp'),
);

/// Claude Code: a pane that takes input is ready (Codex's would also wait for its own prompt).
const _live = Agent(
  id: 'live',
  name: 'Lamp v2',
  engine: 'claude',
  terminalAvailable: true,
);

/// The machine's receipt for a resume of [_saved] into [sessionId].
Map<String, dynamic> _resumed(String sessionId) {
  final receipt = restartReceipt(
    connection.requests.single['creationId'] as String,
    agentId: 'saved',
    name: 'Lamp v1',
    sessionId: sessionId,
  );
  return {
    ...receipt,
    'agent': {...receipt['agent'] as Map<String, dynamic>, 'engine': 'claude'},
  };
}

late RestartConnection connection;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late AppNotifier app;
  setUp(() {
    connection = RestartConnection();
    app = createApp(connectionForTest: (_) => connection, connected: true);
    app.machineStates['m']!.agents.addAll([_saved, _live]);
  });
  tearDown(() => app.dispose());

  bool hasPane(String agentId) =>
      app.allPanes.any((pane) => pane.agentId == agentId);

  test(
    'a live session\'s pane is handed the task once it takes input',
    () async {
      final pane = _Pane('live');
      app.adoptSessionForTest(pane);
      expect(await app.sendTaskToSession('m', 'live', 'and the chart'), isNull);
      expect(pane.typed, ['and the chart']);
      expect(connection.types, isEmpty);
    },
  );

  test('a stopped session is resumed before its pane comes forward, then given the task', () async {
    final sending = app.sendTaskToSession(
      'm',
      'saved',
      'pick the lamp work back up',
    );
    await Future<void>.delayed(Duration.zero);
    expect(connection.types, ['agent_resume']);
    expect(connection.requests.single['agentId'], 'saved');
    // Nothing is opened for it until its own conversation is back.
    expect(hasPane('saved'), isFalse);
    connection.restartReplies.single.complete(_resumed('lamp-conversation'));
    await Future<void>.delayed(Duration.zero);
    expect(hasPane('saved'), isTrue);
    // Its terminal arrives and takes input: the task is typed there.
    final pane = _Pane('saved');
    app.allPanes.firstWhere((p) => p.agentId == 'saved').session = pane;
    app.notifyListeners();
    expect(await sending, isNull);
    expect(pane.typed, ['pick the lamp work back up']);
  });

  test('a session that resumes into another conversation is not sent to, and leaves no pane', () async {
    final sending = app.sendTaskToSession(
      'm',
      'saved',
      'pick the lamp work back up',
    );
    await Future<void>.delayed(Duration.zero);
    connection.restartReplies.single.complete(
      restartReceipt(
        connection.requests.single['creationId'] as String,
        agentId: 'saved',
        sessionId: 'some-other-conversation',
      ),
    );
    expect(await sending, isNotNull);
    expect(hasPane('saved'), isFalse);
  });

  test('Esc while it resumes sends nothing and opens nothing', () async {
    var wanted = true;
    final sending = app.sendTaskToSession(
      'm',
      'saved',
      'pick the lamp work back up',
      stillWanted: () => wanted,
    );
    await Future<void>.delayed(Duration.zero);
    wanted = false;
    connection.restartReplies.single.complete(_resumed('lamp-conversation'));
    expect(await sending, 'Nothing was sent.');
    expect(hasPane('saved'), isFalse);
  });
}
