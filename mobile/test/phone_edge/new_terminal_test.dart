import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/core/permission_modes.dart';
import 'package:harness_mobile/core/project_folder.dart';
import 'package:harness_mobile/phone/agent_swipe.dart';
import 'package:harness_mobile/phone/new_agent_draft.dart';
import 'package:harness_mobile/phone/new_agent_page.dart';
import 'package:harness_mobile/phone/tty_controls.dart' show TtyFormRow;
import 'package:harness_mobile/state/app_state.dart';

import 'edge_fixture.dart';

/// New Harness's Terminal: a plain shell on the computer, the desktop's last row of the agent
/// list. It takes a folder or none (home), and none of an agent's choices — so the form asks for
/// none of them, and the request carries none of them.
void main() {
  // Both: a test that fails with the form up leaves its draft behind as the page is taken down.
  setUp(() => newAgentDraft = null);
  tearDown(() => newAgentDraft = null);

  Map<String, dynamic> created(Map<String, dynamic> payload) => {
    'creationId': payload['creationId'],
    'state': 'created',
    'agent': {
      'id': 'shell',
      'name': 'shell',
      'engine': 'terminal',
      'terminal': {'available': true},
    },
  };

  /// New on `m`, running [agents] (one in `/code/web` unless told), answering every create.
  Future<({AppNotifier app, EdgeConn conn})> openNew(
    WidgetTester tester, {
    List<Agent>? agents,
    void Function(AppNotifier app)? before,
  }) async {
    setPhone(tester, largePhone);
    final conn = EdgeConn(
      const {},
      (type, payload) => type == 'agent_create' ? created(payload) : null,
    );
    final app = edgeApp(conn: conn, agents: agents);
    before?.call(app);
    await tester.pumpWidget(
      phoneApp(
        Builder(
          builder: (context) => TextButton(
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute<void>(
                builder: (_) => NewAgentPage(notifier: app, machineId: 'm'),
              ),
            ),
            child: const Text('focus'),
          ),
        ),
      ),
    );
    await tester.tap(find.text('focus'));
    await frames(tester);
    return (app: app, conn: conn);
  }

  Future<void> close(WidgetTester tester, AppNotifier app) async {
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 3));
    app.dispose();
    await tester.pump(const Duration(seconds: 30));
  }

  /// Picks [label] in the agent chooser by searching for it: the list is longer than a screen.
  Future<void> chooseAgent(WidgetTester tester, String label) async {
    await tapInView(tester, find.text('agent'));
    await frames(tester);
    await tester.enterText(find.byType(TextField).last, label);
    await frames(tester);
    await tester.tap(find.text(label, findRichText: true).last);
    await frames(tester);
  }

  /// Runs the clock until the harness just made is open — see `new_check_status_test.dart`.
  Future<void> opened(WidgetTester tester) async {
    for (
      var i = 0;
      i < 120 && find.byType(AgentSwipeHost).evaluate().isEmpty;
      i++
    ) {
      await tester.pump(const Duration(milliseconds: 250));
    }
    await frames(tester, count: 8);
  }

  Finder formRow(String label) => find.byWidgetPredicate(
    (widget) => widget is TtyFormRow && widget.label == label,
  );

  String row(WidgetTester tester, String label) =>
      tester.widget<TtyFormRow>(formRow(label)).value;

  const note = 'A terminal opens straight on your shell; type there.';

  testWidgets('offered beside the agents, as the shell on that computer', (
    tester,
  ) async {
    final (:app, conn: _) = await openNew(tester);

    await tapInView(tester, find.text('agent'));
    await frames(tester);
    await tester.enterText(find.byType(TextField).last, 'Terminal');
    await frames(tester);

    // The desktop's line for it: every computer has a shell, so there is no install note to give.
    expect(find.text('Your shell on studio'), findsOneWidget);
    await close(tester, app);
  });

  testWidgets('listed first once it has been started here, as any agent is', (
    tester,
  ) async {
    final (:app, conn: _) = await openNew(tester);
    await app.agentPreference.select('terminal');

    await tapInView(tester, find.text('agent'));
    await frames(tester);

    final terminal = tester.getTopLeft(find.text('Terminal').last).dy;
    final amp = tester.getTopLeft(find.text('Amp').last).dy;
    expect(terminal, lessThan(amp), reason: 'recents come before the rest');
    await close(tester, app);
  });

  testWidgets('in a folder: the folder alone is sent, and the shell opens', (
    tester,
  ) async {
    final (:app, :conn) = await openNew(tester);
    expect(row(tester, 'project'), 'web');

    await chooseAgent(tester, 'Terminal');

    expect(row(tester, 'agent'), 'Terminal');
    expect(row(tester, 'project'), 'web');
    // None of an agent's choices: no Options, no first task — the desktop's line instead.
    expect(formRow('options'), findsNothing);
    expect(find.text('task (optional)'), findsNothing);
    expect(find.text(note), findsOneWidget);

    await tapInView(tester, find.text('Start'));
    await frames(tester, count: 20);
    await opened(tester);

    final asked = conn.payloads['agent_create']!.single;
    expect(asked['engine'], 'terminal');
    expect(asked['cwd'], '/code/web');
    expect(asked['bypassPermission'], isFalse);
    expect(asked['creationId'], isA<String>());
    for (final key in const [
      'prompt',
      'name',
      'permissionMode',
      'projectSource',
      'codexHome',
      'gridModel',
      'gridName',
    ]) {
      expect(asked.containsKey(key), isFalse, reason: '$key is an agent’s');
    }
    expect(find.byType(AgentSwipeHost), findsOneWidget);
    expect(app.agentPreference.value, 'terminal');
    await close(tester, app);
  });

  testWidgets('with no project: Start is ready, and the shell opens at home', (
    tester,
  ) async {
    final (:app, :conn) = await openNew(tester, agents: const []);
    expect(row(tester, 'project'), 'Choose a project');
    // A first harness offers first tasks to tap — an agent's, never a shell's.
    expect(find.text('Run the tests'), findsOneWidget);

    await chooseAgent(tester, 'Terminal');

    expect(row(tester, 'project'), '~');
    expect(find.text('Run the tests'), findsNothing);
    expect(find.text('Start'), findsOneWidget);
    expect(find.text('Choose a project'), findsNothing);

    await tapInView(tester, find.text('Start'));
    await frames(tester, count: 20);
    await opened(tester);

    final asked = conn.payloads['agent_create']!.single;
    expect(asked['engine'], 'terminal');
    expect(
      asked.containsKey('cwd'),
      isFalse,
      reason: 'the machine opens a terminal at home only when cwd is absent',
    );
    expect(find.byType(AgentSwipeHost), findsOneWidget);
    await close(tester, app);
  });

  testWidgets('a New Folder chosen for an agent is never sent with a shell, '
      'and the chooser offers no folder-making to one', (tester) async {
    newAgentDraft = const NewAgentDraft(
      machineId: 'm',
      engine: 'claude',
      permissionMode: kDefaultPermissionMode,
      project: ProjectFolderRequest.newProject(),
      projectLabel: 'New folder',
    );
    final (:app, :conn) = await openNew(
      tester,
      agents: const [],
      before: (app) => app.stateOf('m')!.projectFolderAvailable = true,
    );
    expect(row(tester, 'project'), 'New folder');

    await chooseAgent(tester, 'Terminal');
    // Where the shell will open, not the folder an agent would have made.
    expect(row(tester, 'project'), '~');

    await tapInView(tester, find.text('project'));
    await frames(tester);
    // The machine refuses to make a folder for a terminal, so neither door is offered to one.
    expect(find.text('+ Open Folder'), findsOneWidget);
    expect(find.text('+ Clone Repository'), findsNothing);
    expect(find.text('+ New Folder'), findsNothing);
    await tester.tapAt(const Offset(20, 20));
    await frames(tester);

    await tapInView(tester, find.text('Start'));
    await frames(tester, count: 20);
    await opened(tester);
    final asked = conn.payloads['agent_create']!.single;
    expect(asked['engine'], 'terminal');
    expect(asked.containsKey('projectSource'), isFalse);
    expect(asked.containsKey('cwd'), isFalse);
    await close(tester, app);
  });

  testWidgets('a task typed for an agent stays, unsent, until an agent is '
      'chosen again', (tester) async {
    final (:app, :conn) = await openNew(tester);
    await tester.enterText(find.byType(TextField), 'fix the build');
    await tester.pump();

    await chooseAgent(tester, 'Terminal');
    expect(find.text('fix the build'), findsNothing);
    expect(find.text(note), findsOneWidget);

    await chooseAgent(tester, 'Claude Code');
    expect(row(tester, 'agent'), 'Claude Code');
    expect(find.text(note), findsNothing);
    expect(find.text('fix the build'), findsOneWidget);
    expect(formRow('options'), findsOneWidget);

    await chooseAgent(tester, 'Terminal');
    await tapInView(tester, find.text('Start'));
    await frames(tester, count: 20);
    await opened(tester);
    final asked = conn.payloads['agent_create']!.single;
    expect(asked['engine'], 'terminal');
    expect(asked.containsKey('prompt'), isFalse);
    expect(asked.containsKey('name'), isFalse);
    await close(tester, app);
  });
}
