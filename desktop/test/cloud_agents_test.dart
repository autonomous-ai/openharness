// Cloud agents on the desktop (docs/design/2026-10-11-cloud-agents.md): a cloud
// harness's frame, its chat pane with every pane's header, its question's
// choices answered as the dial answers one, the person's words sent to it, and
// the footer saying where it runs.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/state/workspace_status.dart';
import 'package:harness/widgets/cloud_chat_pane.dart';
import 'package:harness/widgets/engine_identity.dart';
import 'package:harness/widgets/new_harness_form.dart';
import 'package:harness/ws/ws_conn.dart';

import 'support/rename_connection.dart';
import 'swarm_screen_test.dart' show mount;
import 'swarm_state_test.dart' show createApp;

/// A connection that answers the cloud requests as the CLI's cloud service does.
class CloudConnection extends RenameConnection {
  final sent = <Map<String, dynamic>>[];
  final raw = <(String, Map<String, dynamic>)>[];
  Map<String, dynamic> sendReply = {'ok': true};
  int extraMessages = 0;

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    if (type == 'cloud_send') {
      sent.add(Map.of(payload));
      return sendReply;
    }
    if (type == 'cloud_transcript') {
      return {
        'messages': [
          {
            'id': 'p1',
            'from': 'person',
            'text': 'book a haircut saturday morning near me',
          },
          {
            'id': 'a1',
            'from': 'agent',
            'text': 'They have 9:30 or 11:00. Which one?',
          },
          for (var i = 0; i < extraMessages; i++)
            {'id': 'x$i', 'from': 'agent', 'text': 'Older line number $i'},
        ],
        'total': 2 + extraMessages,
      };
    }
    return super.request(type, payload: payload, timeout: timeout);
  }

  @override
  void sendRaw(String type, Map<String, dynamic> payload) =>
      raw.add((type, payload));
}

Map<String, dynamic> cloudFrame({
  String id = 'cloud_1',
  String engine = 'fo',
  String state = 'needs_input',
  String? activity,
  int messages = 2,
  List<Map<String, String>> links = const [],
  Map<String, dynamic>? project,
}) => {
  'id': id,
  'name': 'haircut Saturday',
  'engine': engine,
  'status': state == 'stopped' ? 'stopped' : 'active',
  'location': 'cloud',
  'terminal': {'available': false, 'primary': '', 'runtimes': []},
  'project': ?project,
  'cloud': {
    'place': cloudPlaceOf(engine),
    'state': state,
    'activity': activity,
    'links': links,
    'messages': messages,
  },
};

void main() {
  test(
    'a cloud harness\'s frame reads as one, and a terminal agent\'s never does',
    () {
      final agent = Agent.fromJson(
        cloudFrame(
          engine: 'devin-cloud',
          state: 'working',
          activity: 'Reading code',
          links: [
            {'label': 'Session', 'url': 'https://app.devin.ai/sessions/1'},
            {
              'label': 'Pull request #42',
              'url': 'https://github.com/acme/api/pull/42',
            },
            {'label': 'Bad', 'url': 'http://not-https'},
          ],
        ),
      );
      expect(agent.isCloud, isTrue);
      expect(agent.terminalAvailable, isFalse);
      expect(agent.cloud!.place, "Devin's cloud");
      expect(agent.cloud!.working, isTrue);
      expect(agent.cloud!.activity, 'Reading code');
      expect(agent.cloud!.links.map((link) => link.label), [
        'Session',
        'Pull request #42',
      ]);
      expect(
        agent.cloud!.pullRequest?.url,
        'https://github.com/acme/api/pull/42',
      );
      expect(agent.copyWith(name: 'renamed').cloud, same(agent.cloud));
      expect(
        Agent.fromJson({
          'id': 'a1',
          'name': 'x',
          'engine': 'claude',
          'cloud': {'place': 'x'},
        }).isCloud,
        isFalse,
      );
      final odd = AgentCloud.fromJson({
        'state': 'dancing',
        'messages': -3,
        'links': 'x',
      });
      expect(
        [odd.place, odd.state, odd.messages, odd.links],
        ['The cloud', 'idle', 0, isEmpty],
      );
      expect(AgentCloud.fromJson(null).pullRequest, isNull);
    },
  );

  test('cloud agents are named by the Naming System\'s rule and never probed as engines', () {
    expect(cloudAgents.map((agent) => agent.label), [
      'Fo',
      'Devin Cloud',
      'Cursor Cloud',
    ]);
    expect(engineIdentity('devin-cloud').label, 'Devin Cloud');
    expect(engineIdentity('devin').label, 'Devin');
    expect(
      allEngines.map((engine) => engine.id),
      isNot(contains('devin-cloud')),
    );
    expect(isCloudAgentId('fo'), isTrue);
    expect(isCloudAgentId('claude'), isFalse);
    expect(cloudAgentTakesRepository('fo'), isFalse);
    expect(cloudAgentTakesRepository('cursor-cloud'), isTrue);
    expect(cloudPlaceOf('cursor-cloud'), "Cursor's cloud");
    expect(cloudPlaceOf('other'), 'The cloud');
  });

  Future<(AppNotifier, CloudConnection)> setUp(
    WidgetTester tester,
    Map<String, dynamic> frame,
  ) async {
    final connection = CloudConnection();
    final app = createApp(
      connectionForTest: (_) => connection,
      connected: true,
    );
    addTearDown(app.dispose);
    await app.handleEventForTest('m', {
      'type': 'agent_synced',
      'payload': {'agent': frame},
    });
    return (app, connection);
  }

  Agent agentOf(AppNotifier app, [String id = 'cloud_1']) =>
      app.stateOf('m')!.agents.firstWhere((agent) => agent.id == id);

  Future<void> mountPane(
    WidgetTester tester,
    AppNotifier app, {
    VoidCallback? onClose,
  }) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ListenableBuilder(
            listenable: app,
            builder: (context, _) => CloudChatPane(
              notifier: app,
              machineId: 'm',
              agent: agentOf(app),
              onClose: onClose,
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  testWidgets(
    'the chat pane: every pane\'s header, the conversation, and its question\'s choices answered as the dial does',
    (tester) async {
      final (app, connection) = await setUp(tester, cloudFrame());
      await app.handleEventForTest('m', {
        'type': 'commander_question',
        'agentId': 'cloud_1',
        'payload': {
          'requestId': 'cloud_q_1',
          'questions': [
            {
              'key': 'answer',
              'q': 'Which one?',
              'options': ['9:30', '11:00'],
              'multi': false,
              'canText': true,
            },
          ],
        },
      });
      var closed = 0;
      await mountPane(tester, app, onClose: () => closed++);
      expect(find.byKey(const ValueKey('cloud-pane-title')), findsOneWidget);
      expect(find.text('haircut Saturday'), findsOneWidget);
      // The agent on the right, plainly: no picker to move a cloud harness elsewhere.
      expect(find.byKey(const ValueKey('pane-agent-control')), findsOneWidget);
      expect(find.text('Fo'), findsWidgets);
      expect(
        find.text("Fo's cloud"),
        findsNothing,
        reason: 'the place is said in the footer, never in the header',
      );
      expect(
        find.text('book a haircut saturday morning near me'),
        findsOneWidget,
      );
      expect(find.text('They have 9:30 or 11:00. Which one?'), findsOneWidget);
      expect(find.text('1) 9:30'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('cloud-choice-0')));
      await tester.pumpAndSettle();
      // Answered as words for it, so a refusal can be said: the service takes them as the answer.
      expect(connection.sent, [
        {'agentId': 'cloud_1', 'text': '9:30'},
      ]);
      expect(connection.raw, isEmpty);
      await tester.tap(find.byTooltip('Close Pane'));
      expect(closed, 1);
    },
  );

  testWidgets('its title is renamed as a terminal pane\'s is: a double click', (
    tester,
  ) async {
    final (app, connection) = await setUp(tester, cloudFrame());
    await mountPane(tester, app);
    final title = find.byKey(const ValueKey('cloud-pane-title'));
    await tester.tap(title);
    await tester.pump(const Duration(milliseconds: 50));
    await tester.tap(title);
    await tester.pumpAndSettle();
    final field = find.byKey(const Key('agent-rename-input'));
    expect(field, findsOneWidget);
    tester.testTextInput.enterText('Trip planning');
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.pump();
    expect(connection.renames.single, {
      'agentId': 'cloud_1',
      'name': 'Trip planning',
    });
    connection.replies.single.complete({
      'agent': {'id': 'cloud_1', 'name': 'Trip planning'},
    });
    await tester.pumpAndSettle();
    expect(find.text('Trip planning'), findsOneWidget);
  });

  testWidgets('words for it are sent, and a refusal is said in the pane', (
    tester,
  ) async {
    final (app, connection) = await setUp(
      tester,
      cloudFrame(state: 'working', activity: 'Calling Hair Lab'),
    );
    await mountPane(tester, app);
    expect(find.text('Calling Hair Lab…'), findsOneWidget);
    await tester.enterText(
      find.byKey(const ValueKey('cloud-prompt')),
      'make it 10',
    );
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    expect(connection.sent, [
      {'agentId': 'cloud_1', 'text': 'make it 10'},
    ]);
    expect(
      find.text('make it 10'),
      findsNothing,
      reason: 'the prompt empties once its maker has the words',
    );
    connection.sendReply = {
      'error': 'BUSY',
      'detail': 'Fo is still working. Send it again once it stops.',
    };
    await tester.enterText(find.byKey(const ValueKey('cloud-prompt')), 'again');
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    expect(
      find.text('Fo is still working. Send it again once it stops.'),
      findsOneWidget,
    );
    expect(
      find.text('again'),
      findsOneWidget,
      reason: 'refused words stay in the prompt',
    );
  });

  testWidgets('the conversation is read again when its frame says it moved', (
    tester,
  ) async {
    final (app, _) = await setUp(tester, cloudFrame(messages: 2));
    var reads = 0;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ListenableBuilder(
            listenable: app,
            builder: (context, _) => CloudChatPane(
              notifier: app,
              machineId: 'm',
              agent: agentOf(app),
              read: (machineId, agentId) async {
                reads++;
                return {
                  'messages': [
                    {'id': 'x', 'from': 'agent', 'text': 'read $reads'},
                  ],
                  'total': 1,
                };
              },
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('read 1'), findsOneWidget);
    await app.handleEventForTest('m', {
      'type': 'agent_synced',
      'payload': {
        'agent': cloudFrame(
          messages: 3,
          state: 'stopped',
          activity: 'Fo keeps working on its own.',
        ),
      },
    });
    await tester.pumpAndSettle();
    expect(find.text('read 2'), findsOneWidget);
    expect(find.text('Fo keeps working on its own.'), findsOneWidget);
  });

  test('New Harness offers the cloud agents, asks a coding one for a GitHub repository, and makes one with its task', () async {
    final connection = CreateConnection();
    final app = createApp(
      connectionForTest: (_) => connection,
      connected: true,
    );
    addTearDown(app.dispose);
    final devin = NewHarnessController(
      app,
      machineId: 'm',
      engine: 'devin-cloud',
      folder: '/work/no-remote',
    );
    addTearDown(devin.dispose);
    expect(devin.isCloud, isTrue);
    expect(devin.takesTask, isTrue);
    expect(devin.hasModes, isFalse);
    expect(devin.isGitProject, isFalse);
    expect(devin.cloudRepository, isNull);
    expect(
      devin.requiredChoice?.message,
      'Choose a GitHub repository for Devin Cloud.',
    );
    expect(devin.acuLimit, 5);
    devin.setAcuLimit(10);
    expect(devin.acuLimit, 10);

    final fo = NewHarnessController(app, machineId: 'm', engine: 'fo');
    addTearDown(fo.dispose);
    expect(fo.requiredChoice?.message, 'Tell Fo what to do.');
    fo.setTask('book a haircut saturday morning near me');
    expect(fo.requiredChoice, isNull);
    expect(await fo.create(), NewHarnessOutcome.created);
    expect(connection.creates.single, containsPair('engine', 'fo'));
    expect(
      connection.creates.single,
      containsPair('prompt', 'book a haircut saturday morning near me'),
    );
    expect(connection.creates.single.containsKey('repositoryUrl'), isFalse);
    expect(connection.creates.single.containsKey('cwd'), isFalse);

    // Refused by the cloud service: its own words, never "not confirmed".
    connection.refuse = {
      'error': 'NOT_CONNECTED',
      'detail':
          'Connect Fo in Connections (Add custom, https://mcp.api.wajo.ai/fo).',
    };
    final again = NewHarnessController(app, machineId: 'm', engine: 'fo');
    addTearDown(again.dispose);
    again.setTask('book a haircut');
    expect(await again.create(), NewHarnessOutcome.failed);
    expect(
      again.error,
      'Connect Fo in Connections (Add custom, https://mcp.api.wajo.ai/fo).',
    );
  });

  test('New Harness sends a coding cloud agent its repository, and a box closed mid-create says nothing', () async {
    final connection = CreateConnection();
    final app = createApp(
      connectionForTest: (_) => connection,
      connected: true,
    );
    addTearDown(app.dispose);
    final devin = NewHarnessController(
      app,
      machineId: 'm',
      engine: 'devin-cloud',
    );
    addTearDown(devin.dispose);
    devin.focusField(NewHarnessField.projectRepository);
    devin.setQuery('acme/api');
    devin.accept();
    expect(devin.cloudRepository, 'https://github.com/acme/api.git');
    devin.setTask('fix the flaky login test');
    expect(devin.requiredChoice, isNull);
    expect(await devin.create(), NewHarnessOutcome.created);
    expect(
      connection.creates.single,
      containsPair('repositoryUrl', 'https://github.com/acme/api.git'),
    );
    expect(connection.creates.single, containsPair('acuLimit', 5));

    // Closed while the cloud service makes it: nothing is said to a box
    // that is gone.
    final fo = NewHarnessController(app, machineId: 'm', engine: 'fo');
    fo.setTask('book a haircut');
    final made = fo.create();
    fo.dispose();
    expect(await made, NewHarnessOutcome.failed);
    expect(connection.creates, hasLength(2));
  });

  testWidgets(
    'each press of Devin Cloud\'s limit steps to the next, round to the first',
    (tester) async {
      final connection = CreateConnection();
      final app = createApp(
        connectionForTest: (_) => connection,
        connected: true,
      );
      addTearDown(app.dispose);
      final devin = NewHarnessController(
        app,
        machineId: 'm',
        engine: 'devin-cloud',
      );
      addTearDown(devin.dispose);
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SizedBox(
              width: 1000,
              height: 600,
              child: NewHarnessForm(
                controller: devin,
                onClose: () {},
                onCreated: () {},
                desktop: true,
                embedded: true,
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      final limit = find.byKey(const ValueKey('new-harness-field-acu'));
      expect(devin.acuLimit, 5);
      for (final next in [10, 20, 2, 5]) {
        await tester.tap(limit);
        await tester.pumpAndSettle();
        expect(devin.acuLimit, next);
      }
      expect(find.text('Up to 5 ACUs'), findsOneWidget);
    },
  );

  testWidgets('the dial scrolls a focused cloud conversation', (tester) async {
    final (app, connection) = await setUp(tester, cloudFrame());
    connection.extraMessages = 60;
    await app.addAgentToSwarm('m', 'cloud_1');
    await mount(tester, app);
    await tester.pump(const Duration(milliseconds: 50));
    await tester.pumpAndSettle();
    final list = find.byKey(const ValueKey('cloud-conversation'));
    ScrollPosition position() =>
        tester.widget<ListView>(list).controller!.position;
    expect(app.focusedPane?.agentId, 'cloud_1');
    expect(position().pixels, 0);
    expect(position().maxScrollExtent, greaterThan(100));

    Future<void> dial(Map<String, dynamic> p) =>
        app.handleEventForTest('m', {'type': 'dial_scroll', 'payload': p});
    await dial({'phase': 'down', 'dy': 0});
    // Terminal convention: a positive dy shows earlier lines, here older messages.
    await dial({'phase': 'move', 'dy': 20});
    expect(position().pixels, 50);
    await dial({'phase': 'move', 'dy': -8});
    expect(position().pixels, 30);
    await dial({'phase': 'move', 'dy': -100});
    expect(position().pixels, 0, reason: 'clamped at the newest message');
    await dial({'phase': 'move', 'dy': 20});
    await dial({'phase': 'up', 'dy': 0, 'velocity': 400});
    final released = position().pixels;
    // Inertia reads the wall clock; pumping advances only the fake timers.
    // Wait for one real clock tick, including hosts with coarser clock precision.
    await tester.runAsync(() async {
      final before = DateTime.now();
      do {
        await Future<void>.delayed(const Duration(milliseconds: 1));
      } while (!DateTime.now().isAfter(before));
    });
    await tester.pump(const Duration(milliseconds: 200));
    expect(position().pixels, greaterThan(released), reason: 'the fling');
    await dial({'phase': 'down', 'dy': 0});
    final stopped = position().pixels;
    await tester.pump(const Duration(milliseconds: 200));
    expect(position().pixels, stopped, reason: 'a touch stops the fling');

    // Gone from the screen, the pane no longer takes the dial.
    await tester.pumpWidget(const SizedBox());
    await dial({'phase': 'move', 'dy': 20});
  });

  testWidgets(
    'in the workspace, a cloud harness\'s pane is its conversation, not a terminal waiting for one',
    (tester) async {
      final (app, _) = await setUp(
        tester,
        cloudFrame(state: 'working', activity: 'Calling Hair Lab'),
      );
      await app.addAgentToSwarm('m', 'cloud_1');
      await mount(tester, app);
      await tester.pump(const Duration(milliseconds: 50));
      expect(find.byType(CloudChatPane), findsOneWidget);
      expect(
        find.text('This harness has no available terminal.'),
        findsNothing,
      );
      expect(
        find.text('book a haircut saturday morning near me'),
        findsOneWidget,
      );
    },
  );

  test(
    'the footer says where a cloud harness runs, where a computer\'s name goes',
    () async {
      final app = createApp();
      addTearDown(app.dispose);
      await app.handleEventForTest('m', {
        'type': 'agent_synced',
        'payload': {
          'agent': cloudFrame(
            engine: 'devin-cloud',
            project: {
              'kind': 'git',
              'name': 'api',
              'cwd': '',
              'root': null,
              'remote': 'https://github.com/acme/api',
              'branch': 'devin/fix',
            },
          ),
        },
      });
      await app.addAgentToSwarm('m', 'cloud_1');
      app.focusPane(app.panes.single.id);
      final context = WorkspacePaneContext.focused(app)!;
      expect(context.machineName, "Devin's cloud");
      expect(context.agent!.isCloud, isTrue);
    },
  );
}

/// A connection that makes the cloud harness New Harness asks for.
class CreateConnection extends CloudConnection {
  final creates = <Map<String, dynamic>>[];
  Map<String, dynamic>? refuse;

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    if (type == 'agent_create') {
      creates.add(Map.of(payload));
      // As the real connection does: an error reply is thrown, not returned.
      if (refuse case final refusal?) {
        throw WsRequestFailure(
          responseType: 'agent_create_result',
          code: refusal['error'] as String,
          detail: refusal['detail'] as String?,
          payload: refusal,
        );
      }
      return {
        'agent': cloudFrame(
          id: 'cloud_9',
          engine: payload['engine'] as String,
          state: 'working',
          messages: 1,
        ),
      };
    }
    if (type == 'engines_probe') return {'engines': []};
    if (type == 'dsh_list') return {'dsh': []};
    return super.request(type, payload: payload, timeout: timeout);
  }
}
