import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/command_bar.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/state/swarm_catalog.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/terminal/terminal_session.dart';
import 'package:harness/widgets/harness_command_bar.dart';
import 'package:harness/widgets/new_harness_form.dart';
import 'package:xterm/xterm.dart';

import 'support/real_fonts.dart';
import 'support/mixed_agents.dart';
import 'swarm_state_test.dart' show createApp, MemoryStore;
import 'swarm_screen_test.dart' show terminal;
import 'swarm_interactions_test.dart' show chord;
import 'terminal_find_test.dart' show output;

final input = find.byKey(const ValueKey('jev-command-input'));

Future<void> capture(
  WidgetTester tester,
  GlobalKey boundaryKey,
  String name,
) async {
  final output = Platform.environment['HARNESS_COMMAND_CAPTURE_DIR'];
  if (output == null) return;
  final boundary =
      boundaryKey.currentContext!.findRenderObject()! as RenderRepaintBoundary;
  await tester.runAsync(() async {
    final image = await boundary.toImage(pixelRatio: 2);
    final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
    await Directory(output).create(recursive: true);
    await File('$output/$name.png').writeAsBytes(bytes!.buffer.asUint8List());
    image.dispose();
  });
}

void main() {
  setUpAll(() async {
    await loadRealFonts();
    await (FontLoader(
      'MaterialIcons',
    )..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'))).load();
    for (final (family, asset) in [
      ('Lucide', 'lucide.ttf'),
      ('Lucide300', 'build_font/LucideVariable-w300.ttf'),
    ]) {
      await (FontLoader('packages/lucide_icons_flutter/$family')..addFont(
            rootBundle.load('packages/lucide_icons_flutter/assets/$asset'),
          ))
          .load();
    }
  });

  testWidgets(
    'Chrome-style entry routes the exact prompt only after selecting its recipient',
    (tester) async {
      tester.view.physicalSize = const Size(1280, 800);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      final focus = FocusNode();
      final boundary = GlobalKey();
      var calls = 0;
      String? sent;
      final recipient = CommandBarAction(
        id: 'send:auth',
        kind: CommandKind.send,
        title: 'Fixing the auth flow',
        detail: 'Send your prompt · Codex · openharness · MacBook Pro',
        perform: (prompt) async {
          sent = prompt;
          return null;
        },
      );
      final bar = CommandBarController(
        catalog: () => [recipient],
        resolve: (_, _) async {
          calls++;
          return {
            'selectedId': recipient.id,
            'autoExecute': false,
            'elapsedMs': 248,
          };
        },
      );
      addTearDown(() async {
        await tester.pumpWidget(const SizedBox());
        focus.dispose();
        bar.dispose();
      });
      await tester.pumpWidget(
        RepaintBoundary(
          key: boundary,
          child: MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: grid.buildAppTheme(brightness: Brightness.dark),
            home: Scaffold(
              backgroundColor: grid.AppPalette.swarmField,
              body: Center(
                child: SizedBox(
                  width: 760,
                  child: HarnessCommandBar(
                    controller: bar,
                    focusNode: focus,
                    onNew: () {},
                    onStore: () {},
                  ),
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(focus.hasFocus, isTrue);
      await capture(tester, boundary, 'start');
      await tester.enterText(
        input,
        'Fix the auth retry bug and add a regression test',
      );
      await tester.pump();
      expect(calls, 0);
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await tester.pumpAndSettle();
      expect(calls, 1);
      expect(sent, isNull);
      expect(find.text('Send prompt'), findsOneWidget);
      await capture(tester, boundary, 'route-preview');
      await tester.tap(find.byKey(const ValueKey('jev-action:send:auth')));
      await tester.pumpAndSettle();
      expect(sent, 'Fix the auth retry bug and add a regression test');
      expect(find.text('Sent to Fixing the auth flow'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'arrow keys reveal the selected action and Enter executes it once',
    (tester) async {
      final focus = FocusNode();
      var calls = 0;
      String? sent;
      final actions = List.generate(
        4,
        (i) => CommandBarAction(
          id: 'send:$i',
          kind: CommandKind.send,
          title: 'Agent $i',
          detail: 'Send the original task to this existing coding agent',
          perform: (_) async {
            sent = '$i';
            return null;
          },
        ),
      );
      final bar = CommandBarController(
        catalog: () => actions,
        resolve: (_, _) async {
          calls++;
          return {
            'selectedId': 'send:0',
            'suggestions': ['send:1', 'send:2', 'send:3'],
          };
        },
      );
      addTearDown(() async {
        await tester.pumpWidget(const SizedBox());
        focus.dispose();
        bar.dispose();
      });
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: Scaffold(
            body: Center(
              child: SizedBox(
                width: 600,
                child: HarnessCommandBar(
                  controller: bar,
                  focusNode: focus,
                  compact: true,
                  onNew: () {},
                  onStore: () {},
                ),
              ),
            ),
          ),
        ),
      );
      await tester.enterText(input, 'Fix the login test');
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await tester.pumpAndSettle();
      expect(focus.hasFocus, isTrue);
      for (var i = 0; i < 3; i++) {
        await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
        await tester.pumpAndSettle();
      }
      expect(bar.selected, 3);
      final button = tester.getRect(
        find.byKey(const ValueKey('jev-action:send:3')),
      );
      final panel = tester.getRect(find.byKey(const ValueKey('jev-results')));
      expect(button.bottom, lessThanOrEqualTo(panel.bottom));
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(sent, '3');
      expect(calls, 1);
      expect(tester.takeException(), isNull);
    },
  );

  for (final compact in [false, true]) {
    testWidgets(
      'results, watches and errors fit a narrow ${compact ? 'workspace' : 'start page'} at large text size',
      (tester) async {
        tester.view.physicalSize = const Size(420, 720);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.reset);
        final focus = FocusNode();
        final a = CommandBarAction(
          id: 'session',
          kind: CommandKind.open,
          title: 'Auth retry and session recovery',
          detail: 'Codex · openharness · MacBook Pro',
          context: 'Response: All 48 auth tests pass. Ready for review.',
          isSession: true,
        );
        final bar = CommandBarController(
          catalog: () => [a],
          resolve: (_, _) async => {
            'matches': [
              {'id': a.id},
            ],
          },
        );
        addTearDown(() async {
          await tester.pumpWidget(const SizedBox());
          focus.dispose();
          bar.dispose();
        });
        final boundary = GlobalKey();
        await tester.pumpWidget(
          RepaintBoundary(
            key: boundary,
            child: MaterialApp(
              theme: grid.buildAppTheme(brightness: Brightness.dark),
              builder: (_, child) => MediaQuery(
                data: const MediaQueryData(textScaler: TextScaler.linear(2)),
                child: child!,
              ),
              home: Scaffold(
                body: SingleChildScrollView(
                  padding: const EdgeInsets.all(20),
                  child: HarnessCommandBar(
                    controller: bar,
                    focusNode: focus,
                    compact: compact,
                    onNew: () {},
                    onStore: () {},
                  ),
                ),
              ),
            ),
          ),
        );
        bar.edit('Notify me when the tests pass');
        await bar.find();
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull);
        await capture(tester, boundary, compact ? 'compact-narrow' : 'narrow');
        await bar.startWatch();
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull);
        await tester.tap(find.byKey(const ValueKey('jev-watches')));
        await tester.pumpAndSettle();
        expect(find.byTooltip('Stop watch'), findsOneWidget);
        expect(tester.takeException(), isNull);
        await tester.tap(find.byTooltip('Stop watch'));
        await tester.pumpAndSettle();
        expect(bar.watches, isEmpty);
        await bar.submit('unsupported');
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull);
      },
    );
  }

  testWidgets(
    'the default build stays hidden until its shortcut and toggles closed',
    (tester) async {
      tester.view.physicalSize = const Size(1280, 800);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      final app = createApp();
      app.renameSwarm(app.activeSwarmId, 'Working tab');
      final boundary = GlobalKey();
      addTearDown(() async {
        await tester.pumpWidget(const SizedBox());
        app.dispose();
      });
      var calls = 0;
      await tester.pumpWidget(
        RepaintBoundary(
          key: boundary,
          child: MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: grid.buildAppTheme(brightness: Brightness.dark),
            home: SwarmScreen(
              notifier: app,
              nativeTabs: false,
              projectStore: SwarmProjectStore(),
              commandResolver: (_, _) async {
                calls++;
                return {'selectedId': null};
              },
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(input, findsNothing);
      expect(calls, 0);
      expect(
        find.byKey(const ValueKey('harness-start-search')),
        findsOneWidget,
      );
      await capture(tester, boundary, 'hidden-workspace');
      await chord(tester, LogicalKeyboardKey.keyJ, shift: true);
      await tester.pump();
      expect(tester.widget<TextField>(input).focusNode!.hasFocus, isTrue);
      await tester.enterText(input, 'Show me the layout options');
      await tester.pumpAndSettle();
      await capture(tester, boundary, 'hidden-palette');
      await tester.enterText(input, 'something unsupported');
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await tester.pumpAndSettle();
      expect(calls, 1);
      expect(find.textContaining('No clear match'), findsOneWidget);
      await chord(tester, LogicalKeyboardKey.keyJ, shift: true);
      await tester.pump();
      expect(input, findsNothing);
      await chord(tester, LogicalKeyboardKey.keyJ, shift: true);
      await tester.pump();
      expect(tester.widget<TextField>(input).focusNode!.hasFocus, isTrue);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
      expect(input, findsNothing);
      final previousTab = app.activeSwarmId;
      await chord(tester, LogicalKeyboardKey.keyJ, shift: true);
      await tester.pump();
      tester.testTextInput.enterText('Open a fresh tab');
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await tester.pumpAndSettle();
      expect(app.activeSwarmId, isNot(previousTab));
      expect(app.activeSwarm.isBlankNewTab, isTrue);
      final picker = find.byKey(const ValueKey('swarm-search-input'));
      expect(picker, findsNothing);
      expect(input, findsNothing);
      // The exact app command opens the tab even without a provider decision.
      expect(calls, 1);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'JEV hands a task to the new prompt on the chosen machine without a foreign folder',
    (tester) async {
      newHarnessOpensInBox = true;
      addTearDown(() => newHarnessOpensInBox = false);
      final app = createApp();
      seedMixedAgents(app);
      app.machineStates['m']!.localOnly = true;
      final session = TerminalSession(
        machineId: 'studio',
        agentId: 'focus',
        agentName: 'Remote task',
        engineId: 'opencode',
        send: (_, _) async => true,
        sendBinary: (_) async => true,
      )..status = TerminalSessionStatus.controlling;
      app.adoptSessionForTest(session);
      final projects = SwarmProjectStore(storage: MemoryStore());
      addTearDown(() async {
        await tester.pumpWidget(const SizedBox());
        app.dispose();
        projects.dispose();
      });
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: SwarmScreen(
            notifier: app,
            nativeTabs: false,
            projectStore: projects,
            commandResolver: (_, _) async => {
              'selectedId': 'create:m:studio/arm',
              'autoExecute': false,
            },
          ),
        ),
      );
      await tester.pumpAndSettle();
      await chord(tester, LogicalKeyboardKey.keyJ, shift: true);
      await tester.enterText(input, 'Plan the arm calibration');
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await tester.pumpAndSettle();
      expect(find.byType(NewHarnessForm), findsNothing);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(input, findsNothing);
      final prompt = tester
          .widget<NewHarnessForm>(find.byType(NewHarnessForm))
          .controller;
      expect(prompt.machineId, 'm');
      expect(prompt.harnessId, 'studio/arm');
      expect(prompt.engine, 'claude');
      expect(prompt.project.folder, isNull);
      expect(prompt.task, 'Plan the arm calibration');
      expect(prompt.field, NewHarnessField.harness);
      expect(
        find.byKey(const ValueKey('new-harness-field-project')),
        findsOneWidget,
      );
      expect(
        FocusManager.instance.primaryFocus?.debugLabel,
        'new-harness-form',
      );
      // Opening the experimental prompt saves this draft and removes its dock.
      await chord(tester, LogicalKeyboardKey.keyJ, shift: true);
      expect(find.byType(NewHarnessForm), findsNothing);
      expect(input, findsOneWidget);
      expect(tester.widget<TextField>(input).focusNode!.hasFocus, isTrue);
      expect(app.allPanes, hasLength(1));
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'disabling JEV leaves the normal start page and shortcut behavior intact',
    (tester) async {
      final app = createApp();
      final projects = SwarmProjectStore(storage: MemoryStore());
      var calls = 0;
      addTearDown(() async {
        await tester.pumpWidget(const SizedBox());
        app.dispose();
        projects.dispose();
      });
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: SwarmScreen(
            notifier: app,
            nativeTabs: false,
            projectStore: projects,
            commandBarEnabled: false,
            commandResolver: (_, _) async {
              calls++;
              return {'selectedId': null};
            },
          ),
        ),
      );
      await tester.pumpAndSettle();
      final previousTab = app.activeSwarmId;
      await chord(tester, LogicalKeyboardKey.keyJ, shift: true);
      await tester.pump();
      expect(input, findsNothing);
      expect(
        find.byKey(const ValueKey('harness-start-search')),
        findsOneWidget,
      );
      expect(app.activeSwarmId, previousTab);
      expect(calls, 0);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'direct navigation closes the palette and Go back returns to the original tab',
    (tester) async {
      tester.view.physicalSize = const Size(1280, 800);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      final app = createApp();
      app.renameSwarm(app.activeSwarmId, 'Research');
      final original = app.activeSwarmId;
      app.newSwarm(name: 'Prototype');
      final target = app.activeSwarmId;
      app.selectSwarm(original);
      final boundary = GlobalKey();
      addTearDown(() async {
        await tester.pumpWidget(const SizedBox());
        app.dispose();
      });
      await tester.pumpWidget(
        RepaintBoundary(
          key: boundary,
          child: MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: grid.buildAppTheme(brightness: Brightness.dark),
            home: SwarmScreen(
              notifier: app,
              nativeTabs: false,
              projectStore: SwarmProjectStore(),
              commandResolver: (_, _) async =>
                  throw Exception('exact navigation stays local'),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await chord(tester, LogicalKeyboardKey.keyJ, shift: true);
      await tester.pump();
      await tester.enterText(input, 'Open Prototype');
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await tester.pumpAndSettle();
      expect(input, findsNothing);
      expect(app.activeSwarmId, target);
      expect(find.text('Opened Prototype'), findsOneWidget);
      expect(find.text('Go back'), findsOneWidget);
      await capture(tester, boundary, 'direct-navigation');
      await tester.tap(find.text('Go back'));
      await tester.pumpAndSettle();
      expect(app.activeSwarmId, original);
      expect(app.swarms.any((s) => s.id == target), isTrue);
      expect(tester.takeException(), isNull);
    },
  );

  for (final withTerminalFind in [false, true]) {
    testWidgets(
      'hidden palette preserves pane geometry and input through refresh (Find open: $withTerminalFind)',
      (tester) async {
        tester.view.physicalSize = const Size(1280, 800);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.reset);
        final app = createApp();
        app.machineStates['m']!.nodeOnline = true;
        final sent = <TerminalBinaryFrame>[];
        final session = terminal('a0', sent);
        await output(session, 0, 'Authentication task\r\n', keyframe: true);
        app.adoptSessionForTest(session);
        final projects = SwarmProjectStore(storage: MemoryStore());
        var calls = 0;
        addTearDown(() async {
          await tester.pumpWidget(const SizedBox());
          app.dispose();
          projects.dispose();
        });
        await tester.pumpWidget(
          MaterialApp(
            theme: grid.buildAppTheme(brightness: Brightness.dark),
            home: SwarmScreen(
              notifier: app,
              nativeTabs: false,
              projectStore: projects,
              commandBarEnabled: true,
              commandResolver: (_, _) async {
                calls++;
                return {'selectedId': null};
              },
            ),
          ),
        );
        await tester.pumpAndSettle();
        expect(input, findsNothing);
        final terminalHeight = tester.getSize(find.byType(TerminalView)).height;
        if (withTerminalFind) {
          await chord(tester, LogicalKeyboardKey.keyF);
          await tester.pumpAndSettle();
        }
        await chord(tester, LogicalKeyboardKey.keyJ, shift: true);
        await tester.pump();
        final field = tester.widget<TextField>(input);
        expect(field.focusNode!.hasFocus, isTrue);
        tester.testTextInput.enterText('a');
        await tester.pump();
        expect(find.byKey(const ValueKey('jev-results')), findsOneWidget);
        expect(
          tester.getSize(find.byType(TerminalView)).height,
          terminalHeight,
        );

        // A daemon screen refresh must not reclaim the palette's input client.
        await output(
          session,
          1,
          'Authentication task refreshed\r\n',
          keyframe: true,
        );
        await tester.pump();
        await tester.pump();
        expect(field.focusNode!.hasFocus, isTrue);
        // Send through the currently attached input client; enterText(finder)
        // would re-focus the field and conceal the first-character regression.
        tester.testTextInput.enterText('auth task stays in the command bar');
        await tester.pump(const Duration(milliseconds: 20));
        expect(field.controller!.text, 'auth task stays in the command bar');
        expect(sent, isEmpty);
        expect(calls, 0);

        // Returning to the pane must still restore real terminal input.
        await tester.sendKeyEvent(LogicalKeyboardKey.escape);
        await tester.pump();
        expect(input, findsNothing);
        if (withTerminalFind) {
          await tester.sendKeyEvent(LogicalKeyboardKey.escape);
          await tester.pump();
        }
        await tester.tap(find.byType(TerminalView));
        await tester.pump();
        await output(session, 2, 'Another screen refresh\r\n', keyframe: true);
        await tester.pump();
        await tester.pump();
        tester.testTextInput.enterText('terminal draft');
        await tester.pump(const Duration(milliseconds: 20));
        expect(
          utf8.decode(sent.expand((frame) => frame.bytes).toList()),
          'terminal draft',
        );
        // Let the renderer's multi-click and resize timers finish before the
        // test binding checks that the disposed widget tree has no timers.
        await tester.pump(const Duration(milliseconds: 350));
        expect(tester.takeException(), isNull);
      },
    );
  }
}
