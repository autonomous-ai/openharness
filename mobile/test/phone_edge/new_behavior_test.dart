import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/phone/agent_swipe.dart';
import 'package:harness_mobile/phone/new_agent_draft.dart';
import 'package:harness_mobile/phone/new_agent_page.dart';
import 'package:harness_mobile/phone/find_row.dart';
import 'package:harness_mobile/phone/tty_controls.dart'
    show TtyFieldMic, TtyFormRow;
import 'package:harness_mobile/state/app_state.dart';

import 'edge_fixture.dart';

/// New as somebody fills it in: every chooser, every option, the draft kept on the way out, a
/// double tap on Start, and a machine that goes away mid-form.
void main() {
  tearDown(() => newAgentDraft = null);

  /// A second machine, and what each answers about its engines, profiles and repositories.
  const answers = {
    'engines_probe': {
      'engines': [
        {'engine': 'claude', 'installed': true, 'signedIn': true},
        {
          'engine': 'codex',
          'installed': true,
          'signedIn': true,
          'supportsCodexHome': true,
        },
        {'engine': 'opencode', 'installed': false, 'installable': false},
      ],
    },
    'grid_models_list': {
      'supportsModelLaunch': true,
      'localModelEngines': ['claude', 'codex', 'opencode'],
      'grids': [
        {
          'name': 'own',
          'own': true,
          'models': [
            {'id': 'qwen-coder', 'node': 'studio'},
          ],
        },
        {
          'name': 'team-grid',
          'own': false,
          'models': [
            {'id': 'shared-coder', 'node': 'server'},
          ],
        },
      ],
    },
    'codex_profiles_list': {
      'profiles': [
        {'path': '/home/ada/.codex-work', 'label': 'work'},
        {'path': '/home/ada/.codex-home', 'label': 'home'},
      ],
    },
    'git_project_info': {
      'isGit': true,
      'branch': 'main',
      'root': '/code/web',
      'defaultRef': 'refs/heads/main',
      'branches': [
        {'ref': 'refs/heads/main', 'name': 'main'},
        {'ref': 'refs/heads/fix/login', 'name': 'fix/login'},
        {
          'ref': 'refs/remotes/origin/main',
          'name': 'origin/main',
          'remote': true,
        },
      ],
    },
  };

  Future<({AppNotifier app, EdgeConn conn})> openNew(
    WidgetTester tester, {
    bool twoMachines = false,
    bool awayComputer = false,
    bool makesProjects = true,
    String? folder,
    List<Agent>? agents,
    Map<String, Map<String, dynamic>> overrides = const {},
    String? remembered,
  }) async {
    setPhone(tester, largePhone);
    final conn = EdgeConn({...answers, ...overrides}, startsAgents);
    if (!makesProjects) {
      conn.capabilities = {...conn.capabilities, 'features': {}};
    }
    final app = edgeApp(conn: conn, agents: agents ?? [edgeAgent('a')]);
    // The folder this phone last started in on `m`: the project row's default, ahead of the
    // latest harness's folder.
    if (remembered != null) await app.projectHistory.select('m', remembered);
    app.stateOf('m')!
      ..projectFolderAvailable = makesProjects
      ..terminalCapabilityLoaded = true;
    if (twoMachines) {
      const other = Machine(
        machineId: 'mini',
        authMode: MachineAuthMode.remote,
        name: 'mini',
      );
      app.machines = [...app.machines, other];
      app.machineStates['mini'] = MachineState(other)
        ..nodeOnline = true
        ..connectionStatus = ConnectionStatus.connected
        ..agentLoadStatus = AgentLoadStatus.loaded
        ..agents = [edgeAgent('x', project: 'api')];
    }
    if (awayComputer) {
      // Harness is not running there: listed, but no harness can start on it.
      const away = Machine(
        machineId: 'box',
        authMode: MachineAuthMode.remote,
        name: 'box',
      );
      app.machines = [...app.machines, away];
      app.machineStates['box'] = MachineState(away)..nodeOnline = false;
    }
    await tester.pumpWidget(
      phoneApp(
        Builder(
          builder: (context) => TextButton(
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute<void>(
                builder: (_) => NewAgentPage(
                  notifier: app,
                  machineId: 'm',
                  folder: folder,
                  voice: edgeVoice().voice,
                ),
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

  Future<void> choose(WidgetTester tester, String row, String item) async {
    await tapInView(tester, find.text(row));
    await frames(tester);
    await tapInView(tester, find.text(item, findRichText: true).last);
    await frames(tester);
  }

  testWidgets('a double tap on Start starts one harness, not two', (
    tester,
  ) async {
    final (:app, :conn) = await openNew(tester);
    // The harness's page comes once its terminal is asked for, which waits for the socket.
    conn.handshaken = true;
    final start = tester.getCenter(find.text('Start'));
    await tester.tapAt(start);
    await tester.pump(const Duration(milliseconds: 40));
    await tester.tapAt(start);
    await tester.pump(const Duration(milliseconds: 40));
    await tester.tapAt(start);
    await frames(tester, count: 20);
    expect(conn.payloads['agent_create'], hasLength(1));
    expect(find.byType(AgentSwipeHost), findsOneWidget);
    await close(tester, app);
  });

  testWidgets(
    'a suggestion fills the task; a long one counts toward its limit',
    (tester) async {
      // Nothing running: the first-task chips are a first harness's alone.
      final (:app, :conn) = await openNew(tester, agents: []);
      await tester.tap(find.text('Run the tests'));
      await tester.pump();
      expect(find.text('Run the tests'), findsOneWidget);
      expect(find.text('Explain this project to me'), findsNothing);

      await tester.enterText(find.byType(TextField), 'x' * 1900);
      await tester.pump();
      expect(find.textContaining('1900/'), findsOneWidget);
      // Starting with a long task is the next test's; with no harness yet there is no project
      // chosen for this one to start in.
      expect(conn.payloads['agent_create'], isNull);
      await close(tester, app);
    },
  );

  testWidgets('the agent chooser: Codex, its profiles and its approvals', (
    tester,
  ) async {
    final (:app, :conn) = await openNew(tester);
    await choose(tester, 'agent', 'Codex');
    expect(find.text('Codex', findRichText: true), findsWidgets);

    expect(find.text('profile'), findsNothing);
    expect(find.text('approvals'), findsNothing);
    expect(find.text('branch'), findsNothing);
    await tapInView(tester, find.text('options'));
    await frames(tester);
    await choose(tester, 'profile', 'work');
    await tapInView(tester, find.text('approvals'));
    await frames(tester);
    final modes = find.byType(ListView).last;
    expect(modes, findsOneWidget);
    await tester.tapAt(tester.getCenter(find.byType(ModalBarrier).last));
    await frames(tester);

    // Collapsing Options hides the rows without discarding the chosen profile.
    await tapInView(tester, find.text('options'));
    await frames(tester);
    expect(find.text('profile'), findsNothing);

    await tapInView(tester, find.text('Start'));
    await frames(tester, count: 20);
    final created = conn.payloads['agent_create']!.single;
    expect(created['engine'], 'codex');
    expect(created['codexHome'], '/home/ada/.codex-work');
    await close(tester, app);
  });

  testWidgets('an engine the machine cannot install is offered, and says so', (
    tester,
  ) async {
    final (:app, conn: _) = await openNew(tester);
    await tapInView(tester, find.text('agent'));
    await frames(tester);
    expect(find.text('more'), findsNothing);
    await tester.scrollUntilVisible(
      find.text('not installed'),
      200,
      scrollable: find.byType(Scrollable).last,
    );
    expect(find.text('not installed'), findsWidgets);
    await close(tester, app);
  });

  TtyFormRow formRow(WidgetTester tester, String label) =>
      tester.widget<TtyFormRow>(
        find.byWidgetPredicate(
          (widget) => widget is TtyFormRow && widget.label == label,
        ),
      );

  /// The machine's harness, working in another folder than `/code/web` (the folder these tests
  /// remember): Start may switch `/code/web`'s branch with Worktree off.
  final elsewhere = [edgeAgent('a', project: 'api')];

  for (final worktree in [false, true]) {
    testWidgets(
      'branch and worktree are independent; create with worktree $worktree',
      (tester) async {
        // Worktree off moves the folder to fix/login, so nothing may be working in it — a harness
        // there is refused (`new_branch_guard_test.dart`). Worktree on leaves the folder alone.
        final (:app, :conn) = await openNew(
          tester,
          remembered: worktree ? null : '/code/web',
          agents: worktree ? null : elsewhere,
        );
        expect(find.text('branch'), findsNothing);
        expect(find.text('worktree'), findsNothing);
        await tapInView(tester, find.text('options'));
        await frames(tester);
        expect(formRow(tester, 'branch').value, 'main');
        expect(formRow(tester, 'worktree').value, '[x]');

        await choose(tester, 'branch', 'fix/login');
        expect(formRow(tester, 'branch').value, 'fix/login');
        expect(formRow(tester, 'worktree').value, '[x]');
        await tapInView(tester, find.text('worktree'));
        await frames(tester);
        expect(formRow(tester, 'worktree').value, '[ ]');
        expect(formRow(tester, 'branch').value, 'fix/login');
        if (worktree) {
          await tapInView(tester, find.text('worktree'));
          await frames(tester);
        }
        // Collapsing Options must keep both choices.
        await tapInView(tester, find.text('options'));
        await frames(tester);
        await tapInView(tester, find.text('Start'));
        await frames(tester, count: 20);
        final payload = conn.payloads['agent_create']!.single;
        expect(payload['projectSource'], worktree ? 'worktree' : 'branch');
        expect(payload['gitSource'], '/code/web');
        expect(payload['branchRef'], 'refs/heads/fix/login');
        expect(payload.containsKey('cwd'), isFalse);
        expect(payload.containsKey('gridModel'), isFalse);
        await close(tester, app);
      },
    );
  }

  testWidgets('a new branch name works with Worktree off', (tester) async {
    // The folder moves to the new branch, so nothing may be working in it.
    final (:app, :conn) = await openNew(
      tester,
      remembered: '/code/web',
      agents: elsewhere,
    );
    await tapInView(tester, find.text('options'));
    await frames(tester);
    await tapInView(tester, find.text('worktree'));
    await frames(tester);
    await choose(tester, 'branch', 'New branch…');
    await tester.enterText(find.byType(TextField).last, 'fix the login');
    await tester.pump();
    expect(find.text('Git will call it fix-the-login'), findsOneWidget);
    await tester.tap(find.text('Use'));
    await frames(tester);
    expect(formRow(tester, 'branch').value, 'fix-the-login');
    expect(formRow(tester, 'worktree').value, '[ ]');
    await tapInView(tester, find.text('Start'));
    await frames(tester, count: 20);
    final payload = conn.payloads['agent_create']!.single;
    expect(payload['projectSource'], 'branch');
    expect(payload['gitSource'], '/code/web');
    expect(payload['branchName'], 'fix-the-login');
    await close(tester, app);
  });

  for (final (model, grid) in [
    ('qwen-coder', 'own'),
    ('shared-coder', 'team-grid'),
  ]) {
    testWidgets(
      'starts directly on $model from $grid without a Codex profile',
      (tester) async {
        final (:app, :conn) = await openNew(tester);
        await choose(tester, 'agent', 'Codex');
        await tapInView(tester, find.text('options'));
        await frames(tester);
        await choose(tester, 'profile', 'work');
        await tapInView(tester, find.text('model'));
        await frames(tester);
        expect(find.text('Subscription'), findsOneWidget);
        expect(find.text('On your machines'), findsOneWidget);
        expect(find.text('Shared · team-grid'), findsOneWidget);
        expect(tester.testTextInput.isVisible, isTrue);
        tester.testTextInput.updateEditingValue(TextEditingValue(text: model));
        await frames(tester);
        await tapInView(tester, find.text(model, findRichText: true).last);
        await frames(tester);
        expect(formRow(tester, 'model').value, model);
        expect(find.text('profile'), findsNothing);
        await tapInView(tester, find.text('Start'));
        await frames(tester, count: 20);
        final payload = conn.payloads['agent_create']!.single;
        expect(payload['gridModel'], model);
        expect(payload['gridName'], grid);
        expect(payload.containsKey('codexHome'), isFalse);
        expect(conn.payloads['agent_retarget'], isNull);
        await close(tester, app);
      },
    );
  }

  testWidgets(
    'model, branch and Worktree survive Cancel; subscription restores profile',
    (tester) async {
      // Worktree off moves the folder to fix/login, so nothing may be working in it.
      final (:app, :conn) = await openNew(
        tester,
        remembered: '/code/web',
        agents: elsewhere,
      );
      await choose(tester, 'agent', 'Codex');
      await tapInView(tester, find.text('options'));
      await frames(tester);
      await choose(tester, 'profile', 'work');
      await choose(tester, 'model', 'qwen-coder');
      await choose(tester, 'branch', 'fix/login');
      await tapInView(tester, find.text('worktree'));
      await frames(tester);
      await tester.binding.handlePopRoute();
      await frames(tester, count: 6);
      expect(newAgentDraft?.model?.id, 'qwen-coder');
      expect(newAgentDraft?.branchRef, 'refs/heads/fix/login');
      expect(newAgentDraft?.worktree, isFalse);
      await tester.tap(find.text('focus'));
      await frames(tester);
      await tapInView(tester, find.text('options'));
      await frames(tester);
      expect(formRow(tester, 'model').value, 'qwen-coder');
      expect(formRow(tester, 'branch').value, 'fix/login');
      expect(formRow(tester, 'worktree').value, '[ ]');
      await choose(tester, 'model', 'OpenAI');
      expect(formRow(tester, 'profile').value, 'work');
      await tapInView(tester, find.text('Start'));
      await frames(tester, count: 20);
      final payload = conn.payloads['agent_create']!.single;
      expect(payload['codexHome'], '/home/ada/.codex-work');
      expect(payload.containsKey('gridModel'), isFalse);
      expect(payload['projectSource'], 'branch');
      expect(payload['gitSource'], '/code/web');
      await close(tester, app);
    },
  );

  testWidgets('changing computers drops the old computer model selection', (
    tester,
  ) async {
    final (:app, :conn) = await openNew(tester, twoMachines: true);
    await tapInView(tester, find.text('options'));
    await frames(tester);
    await choose(tester, 'model', 'qwen-coder');
    await choose(tester, 'project', 'api');
    expect(formRow(tester, 'model').value, 'Anthropic');
    await tapInView(tester, find.text('Start'));
    await frames(tester, count: 20);
    expect(
      conn.payloads['agent_create']!.single.containsKey('gridModel'),
      isFalse,
    );
    await close(tester, app);
  });

  testWidgets(
    'an older CLI keeps subscription creation and explains missing models',
    (tester) async {
      final (:app, :conn) = await openNew(
        tester,
        overrides: {'grid_models_list': {}},
      );
      await tapInView(tester, find.text('options'));
      await frames(tester);
      await tapInView(tester, find.text('model'));
      await frames(tester);
      expect(find.textContaining('Update Harness CLI'), findsOneWidget);
      expect(find.text('qwen-coder', findRichText: true), findsNothing);
      await tapInView(tester, find.text('Anthropic', findRichText: true).last);
      await frames(tester);
      await tapInView(tester, find.text('Start'));
      await frames(tester, count: 20);
      expect(
        conn.payloads['agent_create']!.single.containsKey('gridModel'),
        isFalse,
      );
      await close(tester, app);
    },
  );

  testWidgets('the project: a folder on another computer moves the harness '
      'there', (tester) async {
    final (:app, :conn) = await openNew(tester, twoMachines: true);
    await choose(tester, 'project', 'api');
    expect(formRow(tester, 'computer').value, 'mini');
    expect(formRow(tester, 'project').value, 'api');
    await tapInView(tester, find.text('Start'));
    await frames(tester, count: 20);
    await close(tester, app);
  });

  // Desktop's order (new_harness.dart `_agentOptions`): the selected agent, then the most recently
  // used, then the rest as the catalog lists them.
  testWidgets('agents are offered selected first, then most recently used', (
    tester,
  ) async {
    final (:app, conn: _) = await openNew(tester);
    await app.agentPreference.select('claude');
    await app.agentPreference.select('opencode');
    await app.agentPreference.select('codex');
    await tapInView(tester, find.text('agent'));
    await frames(tester);
    final titles = tester
        .widgetList<FindRow>(find.byType(FindRow))
        .map((row) => row.title)
        .toList();
    expect(titles.take(3), ['Claude Code', 'Codex', 'OpenCode']);
    expect(find.text('more'), findsNothing);
    await close(tester, app);
  });

  testWidgets('the project picker is ready to type without tapping its field', (
    tester,
  ) async {
    final (:app, conn: _) = await openNew(tester, twoMachines: true);
    await tapInView(tester, find.text('project'));
    await frames(tester);
    expect(tester.testTextInput.isVisible, isTrue);
    tester.testTextInput.updateEditingValue(
      const TextEditingValue(text: 'api'),
    );
    await frames(tester);
    expect(
      find.descendant(
        of: find.byType(FindRow),
        matching: find.text('api', findRichText: true),
      ),
      findsOneWidget,
    );
    // The chooser's rows only: the project row behind the sheet still names `web`.
    expect(
      find.descendant(
        of: find.byType(FindRow),
        matching: find.text('web', findRichText: true),
      ),
      findsNothing,
    );
    await close(tester, app);
  });

  testWidgets('the project: a new folder, and a repository by URL', (
    tester,
  ) async {
    final (:app, :conn) = await openNew(tester);
    await choose(tester, 'project', '+ New Folder');
    expect(formRow(tester, 'project').value, 'New folder');

    await choose(tester, 'project', '+ Clone Repository');
    await tester.enterText(find.byType(TextField).last, 'not a repository');
    await tester.tap(find.text('Select'));
    await tester.pump();
    expect(find.text('That is not a GitHub repository.'), findsOneWidget);
    await tester.enterText(
      find.byType(TextField).last,
      'https://github.com/ada/engine',
    );
    await tester.tap(find.text('Select'));
    await frames(tester);
    expect(formRow(tester, 'project').value, 'engine');

    await tapInView(tester, find.text('Start'));
    await frames(tester, count: 20);
    expect(conn.payloads['agent_create'], hasLength(1));
    await close(tester, app);
  });

  testWidgets('a computer too old to make a project is not offered it', (
    tester,
  ) async {
    final (:app, conn: _) = await openNew(tester, makesProjects: false);
    await tapInView(tester, find.text('project'));
    await frames(tester);
    // Left out rather than drawn dead (see `new_agent_chooser.dart`).
    expect(find.text('+ Open Folder', findRichText: true), findsOneWidget);
    expect(find.text('+ Clone Repository', findRichText: true), findsNothing);
    expect(find.text('+ New Folder', findRichText: true), findsNothing);
    await close(tester, app);
  });

  testWidgets('no project yet: Start asks for one first', (tester) async {
    final (:app, :conn) = await openNew(tester, agents: []);
    expect(find.text('Choose a project', findRichText: true), findsWidgets);
    await tapInView(
      tester,
      find.text('Choose a project', findRichText: true).last,
    );
    await frames(tester);
    expect(find.text('+ Open Folder', findRichText: true), findsOneWidget);
    expect(conn.payloads['agent_create'], isNull);
    await close(tester, app);
  });

  testWidgets('the form is kept on the way out, and back on the way in', (
    tester,
  ) async {
    final (:app, conn: _) = await openNew(tester);
    await tester.enterText(find.byType(TextField), 'write the release notes');
    await tester.binding.handlePopRoute();
    await frames(tester, count: 6);
    expect(newAgentDraft?.task, 'write the release notes');

    await tester.tap(find.text('focus'));
    await frames(tester);
    expect(find.text('write the release notes'), findsOneWidget);

    // Nothing typed and nothing chosen is not a draft.
    await tester.enterText(find.byType(TextField), '');
    await tester.binding.handlePopRoute();
    await frames(tester, count: 6);
    await close(tester, app);
  });

  testWidgets('its computer goes offline mid-form: the form stays, and says so '
      'on Start', (tester) async {
    final (:app, conn: _) = await openNew(tester);
    await app.handleMachineEventForTest('m', {
      'type': 'node_status',
      'payload': {'online': false},
    });
    await frames(tester);
    expect(find.byType(NewAgentPage), findsOneWidget);
    await tapInView(tester, find.text('Start'));
    await frames(tester, count: 20);
    expect(tester.takeException(), isNull);
    await close(tester, app);
  });

  testWidgets('said into the task: added to what was typed', (tester) async {
    setPhone(tester, largePhone);
    final app = edgeApp();
    final voice = edgeVoice();
    voice.stt.replies.add(' then deploy it ');
    await tester.pumpWidget(
      phoneApp(NewAgentPage(notifier: app, machineId: 'm', voice: voice.voice)),
    );
    await frames(tester);
    await tester.enterText(find.byType(TextField), 'fix the tests');
    await tester.tap(find.byType(TtyFieldMic));
    await frames(tester);
    await tester.tap(find.byType(TtyFieldMic));
    await frames(tester);
    expect(find.text('fix the tests then deploy it'), findsOneWidget);
    await close(tester, app);
  });

  testWidgets('Open Folder: the computer\'s folders, and back out', (
    tester,
  ) async {
    final (:app, conn: _) = await openNew(tester);
    await choose(tester, 'project', '+ Open Folder');
    expect(find.text('Cancel'), findsWidgets);
    await tester.tap(find.text('Cancel').last);
    await frames(tester);
    expect(formRow(tester, 'project').value, 'web');
    await close(tester, app);
  });

  testWidgets('a draft with no agent chosen: Start asks for one', (
    tester,
  ) async {
    newAgentDraft = const NewAgentDraft(
      machineId: 'm',
      engine: null,
      permissionMode: 'auto',
      folder: '/code/web/',
      task: 'pick up where I left off',
    );
    final (:app, :conn) = await openNew(tester);
    expect(find.text('Choose an agent', findRichText: true), findsWidgets);
    await tapInView(tester, find.text('Choose an agent').last);
    await frames(tester);
    expect(find.text('Agent'), findsOneWidget);
    expect(conn.payloads['agent_create'], isNull);
    await close(tester, app);
  });

  testWidgets('a repository the computer could not read says so', (
    tester,
  ) async {
    setPhone(tester, largePhone);
    final app = edgeApp(
      conn: EdgeConn(const {
        'git_project_info': {'error': 'E2EE_REQUIRED'},
      }),
    );
    await tester.pumpWidget(
      phoneApp(NewAgentPage(notifier: app, machineId: 'm')),
    );
    await frames(tester);
    await tapInView(tester, find.text('options'));
    await frames(tester);
    expect(
      find.text('No answer from the computer', findRichText: true),
      findsOneWidget,
    );
    await close(tester, app);
  });

  testWidgets('the task\'s mic, with the page\'s own voice when none is given', (
    tester,
  ) async {
    // The microphone plugin's channel: permission refused, so nothing records.
    const record = MethodChannel('com.llfbandit.record/messages');
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(record, (call) async {
          if (call.method == 'hasPermission') return false;
          return null;
        });
    addTearDown(
      () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(record, null),
    );
    setPhone(tester, largePhone);
    final app = edgeApp();
    await tester.pumpWidget(
      phoneApp(NewAgentPage(notifier: app, machineId: 'm')),
    );
    await frames(tester);
    await tester.tap(find.byType(TtyFieldMic));
    await frames(tester);
    expect(tester.takeException(), isNull);
    await close(tester, app);
  });

  for (final pickDefault in [false, true]) {
    testWidgets('the Profile sheet put away keeps the profile'
        '${pickDefault ? '; Default clears it' : ''}', (tester) async {
      final (:app, :conn) = await openNew(tester);
      await choose(tester, 'agent', 'Codex');
      await tapInView(tester, find.text('options'));
      await frames(tester);
      await choose(tester, 'profile', 'work');
      expect(formRow(tester, 'profile').value, 'work');

      // A tap above the sheet: nothing was picked, so nothing changes. It once came back as
      // Default, whose value is no profile.
      await tapInView(tester, find.text('profile'));
      await frames(tester);
      expect(find.text('Profile'), findsOneWidget);
      await tester.tapAt(tester.getCenter(find.byType(ModalBarrier).last));
      await frames(tester);
      expect(find.text('Profile'), findsNothing);
      expect(formRow(tester, 'profile').value, 'work');

      if (pickDefault) {
        await choose(tester, 'profile', 'Default');
        expect(formRow(tester, 'profile').value, 'Default');
      }
      await tapInView(tester, find.text('Start'));
      await frames(tester, count: 20);
      final created = conn.payloads['agent_create']!.single;
      expect(created['engine'], 'codex');
      if (pickDefault) {
        expect(created.containsKey('codexHome'), isFalse);
      } else {
        expect(created['codexHome'], '/home/ada/.codex-work');
      }
      await close(tester, app);
    });
  }

  group('the first task', () {
    /// The task as the field holds it.
    String task(WidgetTester tester) =>
        tester.widget<TextField>(find.byType(TextField)).controller!.text;

    /// Picks [engine] in the agent chooser by searching for it: the list is longer than a screen.
    Future<void> chooseAgent(WidgetTester tester, String engine) async {
      await tapInView(tester, find.text('agent'));
      await frames(tester);
      await tester.enterText(find.byType(TextField).last, engine);
      await frames(tester);
      await tester.tap(find.text(engine, findRichText: true).last);
      await frames(tester);
    }

    testWidgets('Hermes starts on its first task', (tester) async {
      final (:app, :conn) = await openNew(tester);
      await chooseAgent(tester, 'Hermes');
      expect(formRow(tester, 'agent').value, 'Hermes');
      await tester.enterText(
        find.byType(TextField),
        'summarise the open issues',
      );
      await tapInView(tester, find.text('Start'));
      await frames(tester, count: 20);
      final created = conn.payloads['agent_create']!.single;
      expect(created['engine'], 'hermes');
      expect(created['prompt'], 'summarise the open issues');
      await close(tester, app);
    });

    testWidgets('typed or pasted past the limit: kept whole; Start says so and '
        'sends nothing, and starts once it fits', (tester) async {
      final (:app, :conn) = await openNew(tester);
      await tester.enterText(find.byType(TextField), 'x' * 2001);
      await tester.pump();
      expect(task(tester), hasLength(2001));
      expect(find.text('2001/2000'), findsOneWidget);

      await tapInView(tester, find.text('Start'));
      await frames(tester, count: 20);
      expect(conn.payloads['agent_create'], isNull);
      expect(find.byType(NewAgentPage), findsOneWidget);
      expect(
        find.text('✗ A first message can be 2000 characters; this is 2001.'),
        findsOneWidget,
      );
      expect(task(tester), hasLength(2001));

      // The line follows the words: still over, it says how far; once they fit, it goes.
      await tester.enterText(find.byType(TextField), 'x' * 2005);
      await tester.pump();
      expect(
        find.text('✗ A first message can be 2000 characters; this is 2005.'),
        findsOneWidget,
      );
      // The space around a task is not counted, as the machine does not count it.
      await tester.enterText(find.byType(TextField), ' ${'x' * 2000}\n');
      await tester.pump();
      expect(find.textContaining('A first message can be'), findsNothing);

      await tapInView(tester, find.text('Start'));
      await frames(tester, count: 20);
      expect(conn.payloads['agent_create']!.single['prompt'], 'x' * 2000);
      await close(tester, app);
    });

    testWidgets('said past the limit: kept whole; Start says so and sends '
        'nothing', (tester) async {
      setPhone(tester, largePhone);
      final conn = EdgeConn(answers, startsAgents);
      final app = edgeApp(conn: conn);
      final voice = edgeVoice();
      voice.stt.replies.add('y' * 20);
      await tester.pumpWidget(
        phoneApp(
          NewAgentPage(notifier: app, machineId: 'm', voice: voice.voice),
        ),
      );
      await frames(tester);
      await tester.enterText(find.byType(TextField), 'x' * 1990);
      await tester.tap(find.byType(TtyFieldMic));
      await frames(tester);
      await tester.tap(find.byType(TtyFieldMic));
      await frames(tester);
      expect(task(tester), '${'x' * 1990} ${'y' * 20}');

      await tapInView(tester, find.text('Start'));
      await frames(tester, count: 20);
      expect(conn.payloads['agent_create'], isNull);
      expect(
        find.text('✗ A first message can be 2000 characters; this is 2011.'),
        findsOneWidget,
      );
      expect(task(tester), hasLength(2011));
      await close(tester, app);
    });

    testWidgets('a task in a folder that exists names the harness after it', (
      tester,
    ) async {
      final (:app, :conn) = await openNew(tester);
      expect(formRow(tester, 'project').value, 'web');
      await tester.enterText(
        find.byType(TextField),
        'Fix the login redirect loop on Safari\nand say what changed',
      );
      await tapInView(tester, find.text('Start'));
      await frames(tester, count: 20);
      final created = conn.payloads['agent_create']!.single;
      expect(
        created['prompt'],
        'Fix the login redirect loop on Safari\nand say what changed',
      );
      expect(created['name'], 'Fix the login redirect loop on');
      // The folder is the one chosen: only a New folder is named by the task.
      expect(created['gitSource'], '/code/web');
      expect(created.containsKey('projectName'), isFalse);
      await close(tester, app);
    });

    testWidgets('no task: no name and no task sent', (tester) async {
      final (:app, :conn) = await openNew(tester);
      await tester.enterText(find.byType(TextField), '  \n ');
      await tapInView(tester, find.text('Start'));
      await frames(tester, count: 20);
      final created = conn.payloads['agent_create']!.single;
      expect(created.containsKey('prompt'), isFalse);
      expect(created.containsKey('name'), isFalse);
      await close(tester, app);
    });

    testWidgets('a New folder is named after its task, and the harness too', (
      tester,
    ) async {
      final (:app, :conn) = await openNew(tester);
      await choose(tester, 'project', '+ New Folder');
      await tester.enterText(
        find.byType(TextField),
        'Robot nói chuyện với Gemini',
      );
      await tapInView(tester, find.text('Start'));
      await frames(tester, count: 20);
      final created = conn.payloads['agent_create']!.single;
      expect(created['projectSource'], 'new');
      expect(created['projectName'], 'robot-noi-chuyen-voi-gemini');
      expect(created['name'], 'Robot nói chuyện với Gemini');
      expect(created['prompt'], 'Robot nói chuyện với Gemini');
      await close(tester, app);
    });
  });

  group('the computer row', () {
    testWidgets('a row of its own, between agent and project; the project row '
        'names only the project', (tester) async {
      final (:app, conn: _) = await openNew(tester);
      expect(formRow(tester, 'computer').value, 'studio');
      expect(formRow(tester, 'computer').detail, isNull);
      expect(formRow(tester, 'project').value, 'web');
      double top(String label) => tester.getTopLeft(find.text(label)).dy;
      expect(top('agent'), lessThan(top('computer')));
      expect(top('computer'), lessThan(top('project')));

      // Typing folds the rows into one line, which still says where: `computer:project`.
      await tester.enterText(find.byType(TextField), 'fix the login test');
      raiseKeyboard(tester);
      await frames(tester);
      expect(find.text('computer'), findsNothing);
      expect(formRow(tester, 'harness').value, startsWith('studio:web · '));
      lowerKeyboard(tester);
      await frames(tester);
      await close(tester, app);
    });

    testWidgets('its computer goes offline: the row says so, and stops saying '
        'so when it is back', (tester) async {
      final (:app, conn: _) = await openNew(tester);
      await app.handleMachineEventForTest('m', {
        'type': 'node_status',
        'payload': {'online': false},
      });
      await frames(tester);
      expect(formRow(tester, 'computer').value, 'studio');
      expect(formRow(tester, 'computer').detail, 'Offline');

      await app.handleMachineEventForTest('m', {
        'type': 'node_status',
        'payload': {'online': true},
      });
      await frames(tester);
      expect(formRow(tester, 'computer').detail, isNull);
      await close(tester, app);
    });

    testWidgets('the chooser lists every computer; one that cannot take a '
        'harness is greyed, with why', (tester) async {
      final (:app, conn: _) = await openNew(
        tester,
        twoMachines: true,
        awayComputer: true,
      );
      await tapInView(tester, find.text('computer'));
      await frames(tester);
      expect(find.text('Computer'), findsOneWidget);
      expect(find.text('studio', findRichText: true), findsWidgets);
      expect(find.text('mini', findRichText: true), findsOneWidget);
      expect(find.text('box', findRichText: true), findsOneWidget);
      expect(find.text('Offline', findRichText: true), findsOneWidget);

      // A tap on the away one does nothing: the sheet stays, the form stays where it was.
      await tester.tap(find.text('box', findRichText: true));
      await frames(tester);
      expect(find.text('Computer'), findsOneWidget);
      await tester.tapAt(tester.getCenter(find.byType(ModalBarrier).last));
      await frames(tester);
      expect(formRow(tester, 'computer').value, 'studio');
      expect(formRow(tester, 'project').value, 'web');
      await close(tester, app);
    });

    testWidgets('another computer: the harness moves there, with that '
        'computer\'s own project', (tester) async {
      final (:app, conn: _) = await openNew(tester, twoMachines: true);
      await choose(tester, 'computer', 'mini');
      expect(formRow(tester, 'computer').value, 'mini');
      expect(formRow(tester, 'project').value, 'api');

      // What Start would send, read off the draft the form leaves on the way out.
      await tester.binding.handlePopRoute();
      await frames(tester, count: 6);
      expect(newAgentDraft?.machineId, 'mini');
      expect(newAgentDraft?.folder, '/code/api');
      expect(newAgentDraft?.project, isNull);
      await close(tester, app);
    });

    testWidgets('back on a computer: what was chosen there comes back, however '
        'the form left it', (tester) async {
      final (:app, conn: _) = await openNew(tester, twoMachines: true);
      // Not the computer's default, so coming back to it cannot be mistaken for the default.
      await choose(tester, 'project', '+ New Folder');
      expect(formRow(tester, 'project').value, 'New folder');

      // Left by the computer row.
      await choose(tester, 'computer', 'mini');
      expect(formRow(tester, 'project').value, 'api');
      await choose(tester, 'computer', 'studio');
      expect(formRow(tester, 'computer').value, 'studio');
      expect(formRow(tester, 'project').value, 'New folder');

      // Left by a folder on the other computer in Project.
      await choose(tester, 'project', 'api');
      expect(formRow(tester, 'computer').value, 'mini');
      await choose(tester, 'computer', 'studio');
      expect(formRow(tester, 'project').value, 'New folder');

      await tester.binding.handlePopRoute();
      await frames(tester, count: 6);
      expect(newAgentDraft?.machineId, 'm');
      expect(newAgentDraft?.folder, isNull);
      expect(newAgentDraft?.project, isNotNull);
      await close(tester, app);
    });

    testWidgets('opened for a folder: that folder stays on its own computer', (
      tester,
    ) async {
      final (:app, conn: _) = await openNew(
        tester,
        twoMachines: true,
        folder: '/code/site',
      );
      expect(formRow(tester, 'project').value, 'site');
      await choose(tester, 'computer', 'mini');
      expect(formRow(tester, 'project').value, 'api');
      await choose(tester, 'computer', 'studio');
      expect(formRow(tester, 'project').value, 'site');
      await close(tester, app);
    });

    testWidgets('a computer that drops off while the chooser is up is not '
        'moved to', (tester) async {
      final (:app, conn: _) = await openNew(tester, twoMachines: true);
      await tapInView(tester, find.text('computer'));
      await frames(tester);
      // The sheet was drawn while mini was answering; it goes away under it.
      app.stateOf('mini')!.nodeOnline = false;
      await tester.tap(find.text('mini', findRichText: true).last);
      await frames(tester);
      expect(formRow(tester, 'computer').value, 'studio');
      expect(formRow(tester, 'project').value, 'web');
      expect(
        find.text('✗ That computer is no longer available.'),
        findsOneWidget,
      );
      await close(tester, app);
    });
  });
}
