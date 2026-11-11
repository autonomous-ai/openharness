import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/agent_instructions.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/issue_panel.dart';
import 'package:harness/super_tabs/task_board.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/super_tab_fixture.dart';
import 'support/swarm_v4_channel.dart' show openSwarmV4;
import 'support/swarm_v4_data.dart';
import 'swarm_state_test.dart' show createApp;

/// The panes a person opens beside a v4 chat (anh Dee, 2026-11-09): an agent's Instructions, its Terminal, a project's Tasks and
/// the task opened from them, a task's thread. From a window 1080 wide a text pane sits beside the chat, half and half, and a
/// terminal from 1260 (it needs about 480); narrower, the pane takes the chat's place under the same bar and a Chat pill leads
/// back; a thread opens over the chat. The window is never under 880, and every pane opens at 880x560, 1024x700 and 1280x800.
void main() {
  Finder key(String k) => find.byKey(ValueKey(k));

  late SwarmV4Computer computer;
  late ConversationServer server;
  late SuperTabController controller;
  var terminalOpen = false;

  /// The window around the Swarm, to open a terminal as the workspace does from elsewhere.
  late StateSetter setHost;

  /// The Swarm of lampOS at [size], at [chat], with the terminal closed: the Terminal button opens a fixture, as the workspace does.
  /// Without [projects] it is a Swarm of agents alone, as a Personal Swarm starts.
  Future<void> show(
    WidgetTester tester,
    Size size, {
    String chat = 'agent-chat-second',
    bool projects = true,
    Brightness brightness = Brightness.light,
  }) async {
    computer = SwarmV4Computer(
      files: {'session-second/second': 'Answer in Vietnamese.\n'},
    );
    terminalOpen = false;
    await tester.binding.setSurfaceSize(size);
    addTearDown(() => tester.binding.setSurfaceSize(null));
    server = swarmV4Server();
    if (!projects) server.state['projects'] = <Object?>[];
    controller = server.controller(
      account: 'owner',
      initial: {'tabId': 'tab', 'accountId': 'owner', 'selectedId': chat},
    );
    addTearDown(controller.dispose);
    await tester.runAsync(controller.refresh);
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: brightness),
        home: Scaffold(
          body: StatefulBuilder(
            builder: (context, set) {
              setHost = set;
              return SuperTabView(
                controller: controller,
                onAddAgent: (_) {},
                onOpenTerminal: (_) {},
                machineName: (_) => 'Mac Studio',
                github: swarmV4GitHub(),
                instructions: computer.link,
                terminal: terminalOpen
                    ? const Center(child: Text('Terminal fixture'))
                    : null,
                onOpenGroupTerminals: () => set(() => terminalOpen = true),
                onCloseTerminal: () => set(() => terminalOpen = false),
              );
            },
          ),
        ),
      ),
    );
    await settle(tester);
  }

  /// The chat's composer, where it can be clicked: a page the stack hides is still in the tree, and not drawn.
  Finder composer() =>
      find.byKey(const ValueKey('super-message-composer')).hitTestable();

  Future<void> tap(WidgetTester tester, Finder what) async {
    await tester.tap(what);
    await settle(tester);
  }

  /// The pane [what] is drawn and can be clicked, in the window, and where the size says it is: beside the chat, in the right pane,
  /// or in its place, in the middle with the Chat pill over it and no right pane.
  void expectOpen(WidgetTester tester, Finder what, {required bool beside}) {
    expect(what, findsOneWidget);
    expect(what.hitTestable(), findsOneWidget);
    final window = tester.getRect(find.byType(MaterialApp));
    expect(window.contains(tester.getCenter(what)), isTrue);
    if (beside) {
      expect(
        find.descendant(of: key('super-right-pane'), matching: what),
        findsOneWidget,
      );
      expect(key('swarm-back-to-chat'), findsNothing);
    } else {
      expect(key('super-right-pane'), findsNothing);
      expect(
        find.descendant(of: key('super-center-pane'), matching: what),
        findsOneWidget,
      );
      expect(key('swarm-back-to-chat'), findsOneWidget);
    }
    expect(tester.takeException(), isNull);
  }

  final sizes = <(Size, bool, bool)>[
    // The window, and whether a text pane is beside the chat, and whether a terminal is.
    (const Size(880, 560), false, false),
    (const Size(1024, 700), false, false),
    (const Size(1079, 700), false, false),
    (const Size(1080, 700), true, false),
    (const Size(1259, 800), true, false),
    (const Size(1260, 800), true, true),
    (const Size(1280, 800), true, true),
    (const Size(1440, 900), true, true),
  ];

  for (final (size, text, terminal) in sizes) {
    final at = '${size.width.toInt()}x${size.height.toInt()}';
    final chat = composer();

    testWidgets('Instructions opens at $at', (tester) async {
      await show(tester, size);
      await tap(tester, key('swarm-instructions-button'));
      expectOpen(tester, find.byType(SwarmAgentInstructions), beside: text);
      // Beside, the chat stays; in its place, it goes and Chat brings it back, or the pane's own close does.
      expect(chat, text ? findsOneWidget : findsNothing);
      if (!text) {
        await tap(tester, key('swarm-back-to-chat-button'));
        expect(find.byType(SwarmAgentInstructions), findsNothing);
        expect(chat, findsOneWidget);
        await tap(tester, key('swarm-instructions-button'));
      }
      await tap(tester, key('swarm-instructions-close'));
      expect(find.byType(SwarmAgentInstructions), findsNothing);
      expect(chat, findsOneWidget);
      expect(key('swarm-back-to-chat'), findsNothing);
    });

    testWidgets('Terminal opens at $at', (tester) async {
      await show(tester, size);
      await tap(tester, key('swarm-terminal-button'));
      expectOpen(tester, find.text('Terminal fixture'), beside: terminal);
      expect(chat, terminal ? findsOneWidget : findsNothing);
      // Its button, or Chat in its place, closes it.
      if (!terminal) {
        await tap(tester, key('swarm-back-to-chat-button'));
      } else {
        await tap(tester, key('swarm-terminal-button'));
      }
      expect(find.text('Terminal fixture'), findsNothing);
      expect(chat, findsOneWidget);
    });

    testWidgets('Tasks opens at $at, and a task opens from it', (tester) async {
      await show(tester, size, chat: 'lead');
      await tap(tester, key('swarm-tasks-button'));
      expectOpen(tester, key('swarm-task-board'), beside: text);
      // The board scrolls sideways where its three columns do not fit: a person brings the card into view first.
      await tester.ensureVisible(key('swarm-task-5759'));
      await tap(tester, key('swarm-task-5759'));
      expectOpen(tester, key('swarm-issue-panel'), beside: text);
      // Its close leads back to the tasks, and Chat, in their place, to the channel.
      await tap(tester, key('swarm-issue-close'));
      expectOpen(tester, key('swarm-task-board'), beside: text);
      if (!text) {
        await tap(tester, key('swarm-back-to-chat-button'));
        expect(key('swarm-task-board'), findsNothing);
        expect(key('super-agents-only'), findsOneWidget);
      } else {
        await tap(tester, key('swarm-tasks-button'));
        expect(key('swarm-task-board'), findsNothing);
      }
    });

    testWidgets('a task\'s thread opens at $at', (tester) async {
      await show(tester, size, chat: 'lead');
      controller.openThread(
        server.messages.firstWhere(
              (m) => (m['text'] as String).startsWith('#2191'),
            )['id']
            as String,
      );
      await settle(tester);
      // Beside, in the right pane; narrower, a drawer over the chat, which stays under it.
      expect(key('super-thread-panel'), findsOneWidget);
      expect(key('super-thread-panel').hitTestable(), findsOneWidget);
      expect(
        find.descendant(
          of: key('super-right-pane'),
          matching: key('super-thread-panel'),
        ),
        text ? findsOneWidget : findsNothing,
      );
      expect(tester.takeException(), isNull);
      await tap(tester, key('super-thread-close'));
      expect(key('super-thread-panel'), findsNothing);
    });
  }

  testWidgets(
    'what is typed in the instructions stays typed while the window narrows and widens',
    (tester) async {
      await show(tester, const Size(1440, 900));
      await tap(tester, key('swarm-instructions-button'));
      await tap(tester, key('swarm-instructions-edit'));
      await tester.enterText(
        key('swarm-instructions-field'),
        'Never push to main.',
      );
      await tester.pump();
      String typed() => tester
          .widget<TextField>(key('swarm-instructions-field'))
          .controller!
          .text;
      for (final size in const [
        Size(1024, 700),
        Size(880, 560),
        Size(1440, 900),
      ]) {
        await tester.binding.setSurfaceSize(size);
        await settle(tester);
        expect(
          key('swarm-instructions-field'),
          findsOneWidget,
          reason: '$size',
        );
        expect(typed(), 'Never push to main.', reason: '$size');
      }
    },
  );

  testWidgets(
    'clicking the buttons as fast as a person can leaves one pane, and Chat leads back, at 1024x700',
    (tester) async {
      await show(tester, const Size(1024, 700));
      for (var i = 0; i < 7; i++) {
        await tester.tap(key('swarm-instructions-button'));
        await tester.pump();
      }
      await settle(tester);
      expect(find.byType(SwarmAgentInstructions), findsOneWidget);
      // Terminal takes Instructions' place, and Instructions Terminal's.
      await tap(tester, key('swarm-terminal-button'));
      expect(find.byType(SwarmAgentInstructions), findsNothing);
      expect(find.text('Terminal fixture'), findsOneWidget);
      await tap(tester, key('swarm-instructions-button'));
      expect(find.text('Terminal fixture'), findsNothing);
      expect(find.byType(SwarmAgentInstructions), findsOneWidget);
      await tap(tester, key('swarm-back-to-chat-button'));
      expect(find.byType(SwarmAgentInstructions), findsNothing);
      expect(composer(), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'a window under 720 opens a pane in the chat\'s place too, from an agent chosen in the list of conversations',
    (tester) async {
      await show(tester, const Size(700, 800), chat: 'lead');
      await tap(tester, find.byTooltip('Conversations'));
      await tap(tester, key('super-agent-second'));
      await tap(tester, key('swarm-instructions-button'));
      expectOpen(tester, find.byType(SwarmAgentInstructions), beside: false);
      await tap(tester, key('swarm-back-to-chat-button'));
      expect(composer(), findsOneWidget);
    },
  );
  testWidgets(
    'in a Swarm of agents alone, an agent\'s Instructions and Terminal open too',
    (tester) async {
      for (final (size, beside) in const [
        (Size(1024, 700), false),
        (Size(1440, 900), true),
      ]) {
        await show(tester, size, projects: false);
        await tap(tester, key('swarm-instructions-button'));
        expectOpen(tester, find.byType(SwarmAgentInstructions), beside: beside);
        await tap(tester, key('swarm-terminal-button'));
        expectOpen(tester, find.text('Terminal fixture'), beside: beside);
      }
    },
  );

  testWidgets(
    'Chat over a terminal in the chat\'s place closes the terminal and leaves the tasks beside',
    (tester) async {
      await show(tester, const Size(1200, 800), chat: 'lead');
      await tap(tester, key('swarm-tasks-button'));
      expectOpen(tester, key('swarm-task-board'), beside: true);
      // A terminal the workspace opens: 1200 is too narrow for it beside, so it takes the chat's place.
      setHost(() => terminalOpen = true);
      await settle(tester);
      expect(find.text('Terminal fixture').hitTestable(), findsOneWidget);
      await tap(tester, key('swarm-back-to-chat-button'));
      expect(find.text('Terminal fixture'), findsNothing);
      expectOpen(tester, key('swarm-task-board'), beside: true);
    },
  );

  testWidgets('Chat gives the composer its keys back', (tester) async {
    await show(tester, const Size(1024, 700));
    await tap(tester, composer());
    await tap(tester, key('swarm-instructions-button'));
    expect(composer(), findsNothing);
    await tap(tester, key('swarm-back-to-chat-button'));
    expect(FocusManager.instance.primaryFocus?.debugLabel, 'Swarm message');
  });

  testWidgets(
    'Tasks, and a task opened from them, keep what they read while the window narrows and widens',
    (tester) async {
      await show(tester, const Size(1440, 900), chat: 'lead');
      await tap(tester, key('swarm-tasks-button'));
      final board = tester.state(find.byType(SwarmTaskBoard));
      await tester.binding.setSurfaceSize(const Size(1024, 700));
      await settle(tester);
      expectOpen(tester, key('swarm-task-board'), beside: false);
      expect(tester.state(find.byType(SwarmTaskBoard)), same(board));
      await tester.ensureVisible(key('swarm-task-5759'));
      await tap(tester, key('swarm-task-5759'));
      final task = tester.state(find.byType(SwarmIssuePanel));
      await tester.binding.setSurfaceSize(const Size(1440, 900));
      await settle(tester);
      expectOpen(tester, key('swarm-issue-panel'), beside: true);
      expect(tester.state(find.byType(SwarmIssuePanel)), same(task));
    },
  );

  /// The colour painted nearest under [what]: the ground of the pane it is in.
  Color? ground(WidgetTester tester, Finder what) {
    for (final widget in tester.widgetList(
      find.ancestor(
        of: what,
        matching: find.byWidgetPredicate(
          (w) => w is ColoredBox || w is Material || w is DecoratedBox,
        ),
      ),
    )) {
      final color = switch (widget) {
        ColoredBox(:final color) => color,
        Material(:final color, :final type)
            when type != MaterialType.transparency =>
          color,
        DecoratedBox(:final BoxDecoration decoration) => decoration.color,
        _ => null,
      };
      if (color != null && color.a > 0) return color;
    }
    return null;
  }

  // Design system, Swarm elements, One surface: the left, middle and right panes share one ground, so a pane opened beside the
  // chat, or in its place, is not a white sheet on the Swarm's grey.
  for (final size in const [Size(880, 560), Size(1440, 900)]) {
    for (final brightness in Brightness.values) {
      final at = '${size.width.toInt()}x${size.height.toInt()}';
      testWidgets(
        'every pane stands on the Swarm\'s one ground, at $at, ${brightness.name}',
        (tester) async {
          final before = grid.AppTheme.brightness.value;
          grid.AppTheme.brightness.value = brightness;
          addTearDown(() => grid.AppTheme.brightness.value = before);
          void expectGround(String close) {
            final inView = find.descendant(
              of: find.byType(SuperTabView),
              matching: key(close),
            );
            expect(inView, findsOneWidget, reason: close);
            expect(
              ground(tester, inView),
              grid.AppPalette.swarmField,
              reason: close,
            );
          }

          await show(tester, size, brightness: brightness);
          await tap(tester, key('swarm-info-button'));
          expectGround('swarm-info-close');
          await tap(tester, key('swarm-instructions-button'));
          expectGround('swarm-instructions-close');
          await tap(tester, key('super-group-lead'));
          await tap(tester, key('swarm-tasks-button'));
          expectGround('swarm-tasks-close');
          await tester.ensureVisible(key('swarm-task-5759'));
          await tap(tester, key('swarm-task-5759'));
          expectGround('swarm-issue-close');
          await tap(tester, key('swarm-issue-close'));
          await tap(tester, key('swarm-tasks-close'));
          controller.openThread(
            server.messages.firstWhere(
                  (m) => (m['text'] as String).startsWith('#2191'),
                )['id']
                as String,
          );
          await settle(tester);
          expectGround('super-thread-close');
        },
      );

      testWidgets(
        'a browser agent\'s Browser stands on the Swarm\'s one ground, at $at, ${brightness.name}',
        (tester) async {
          final app = createApp(connected: true);
          app.machineStates['host'] =
              MachineState(
                  const Machine(
                    machineId: 'host',
                    authMode: MachineAuthMode.managed,
                    name: 'Mac Studio',
                    status: 'online',
                  ),
                )
                ..nodeOnline = true
                ..connectionStatus = ConnectionStatus.connected
                ..agentLoadStatus = AgentLoadStatus.loaded
                ..agents = [
                  Agent(
                    id: 'session-second',
                    name: 'second',
                    engine: 'claude',
                    browser: const AgentBrowser(state: 'starting'),
                  ),
                ];
          await openSwarmV4(
            tester,
            swarmV4Server(),
            saved: 'agent-chat-second',
            size: size,
            brightness: brightness,
            app: app,
          );
          await tester.tap(key('swarm-browser-button'));
          await tester.pump();
          expect(
            ground(tester, key('swarm-browser-close')),
            grid.AppPalette.swarmField,
          );
        },
      );
    }
  }
}

/// Settles, and lets the read mark a chat saves 200 ms after it is read go, so no timer outlives the test.
Future<void> settle(WidgetTester tester) async {
  await tester.pumpAndSettle();
  await tester.pump(const Duration(milliseconds: 300));
}
