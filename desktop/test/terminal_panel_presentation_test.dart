import 'package:flutter/material.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/services.dart';
import 'package:harness/widgets/transient_menus.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/terminal/terminal_session.dart';
import 'package:harness/terminal/terminal_font_store.dart';
import 'package:harness/widgets/terminal_panel.dart';
import 'package:harness/widgets/pane_header_actions.dart';
import 'package:xterm/xterm.dart';

import 'swarm_screen_test.dart' show terminal;
import 'swarm_state_test.dart' show createApp;

void main() {
  testWidgets(
    'retained header uses current callbacks, names, projects and status',
    (tester) async {
      final app = createApp();
      final session = terminal('a0', []);
      final revision = ValueNotifier(0);
      final closed = <int>[];
      final deleted = <int>[];
      final restarted = <int>[];
      final zoomed = <int>[];
      final composed = <int>[];
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(1100, 700);
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        MaterialApp(
          home: ValueListenableBuilder<int>(
            valueListenable: revision,
            builder: (_, version, _) => TerminalPanel(
              notifier: app,
              session: session,
              focused: version.isEven,
              compactHeader: true,
              onClose: () => closed.add(version),
              onDelete: () => deleted.add(version),
              onRestart: () => restarted.add(version),
              onToggleZoom: () => zoomed.add(version),
              zoomed: version >= 2,
              onToggleComposer: () => composed.add(version),
            ),
          ),
        ),
      );
      await tester.pump();
      revision.value = 1;
      await tester.pump();
      final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
      await mouse.addPointer(
        location: tester.getCenter(find.text(session.agentName)),
      );
      await tester.pump(const Duration(milliseconds: 120));
      await tester.tap(find.byTooltip('Show message composer'));
      await tester.tap(find.byTooltip('Zoom Pane'));
      await tester.tap(find.byTooltip('Restart Agent'));
      await tester.tap(find.byTooltip('Stop Agent'));
      await tester.tap(find.byTooltip('Close Pane'));
      await tester.pump();
      expect(closed, [1]);
      expect(deleted, [1]);
      expect(restarted, [1]);
      expect(zoomed, [1]);
      expect(composed, [1]);
      session.agentName = 'Renamed terminal';
      app.machineStates['m']!.agents = [
        const Agent(
          id: 'a0',
          name: 'Renamed terminal',
          engine: 'codex',
          terminalAvailable: true,
          project: AgentProject(
            name: 'Terminal project',
            cwd: '/work/terminal',
            branch: 'fast-focus',
          ),
        ),
      ];
      revision.value = 2;
      await tester.pump();
      expect(find.text('Renamed terminal'), findsOneWidget);
      expect(find.text('fast-focus'), findsOneWidget);
      expect(find.text('terminal'), findsOneWidget);
      expect(find.byTooltip('Zoom Pane'), findsOneWidget);
      session.status = TerminalSessionStatus.takenOver;
      revision.value = 3;
      await tester.pump();
      expect(find.widgetWithText(TextButton, 'Take control'), findsOneWidget);
      expect(
        find.widgetWithText(FilledButton, 'Take control'),
        findsOneWidget,
        reason: 'the in-pane banner offers it too',
      );
      expect(
        find.byTooltip(
          'Read only: another app controls this terminal. Take control moves input ownership to this app.',
        ),
        findsOneWidget,
      );
      final previousFont = terminalFontStore.value;
      addTearDown(() => terminalFontStore.value = previousFont);
      terminalFontStore.value = const TerminalStyle(fontFamily: 'Monaco');
      await tester.pump();
      expect(
        tester.widget<Text>(find.text('Renamed terminal')).style!.fontFamily,
        'Monaco',
      );
      await mouse.removePointer();
      await tester.pumpWidget(const SizedBox());
      revision.dispose();
      session.dispose();
      app.dispose();
    },
  );
  for (final local in [true, false]) {
    testWidgets(
      '${local ? 'local' : 'remote'} header swaps details for actions without moving its title',
      (tester) async {
        final app = createApp();
        app.stateOf('m')!.localOnly = local;
        app.stateOf('m')!.agents = [
          const Agent(
            id: 'a0',
            name: 'Onboarding',
            engine: 'codex',
            terminalAvailable: true,
            project: AgentProject(
              name: 'Harness project',
              cwd: '/work/harness',
              branch: 'main',
            ),
          ),
        ];
        final session = terminal('a0', []);
        session.agentName = 'Onboarding';
        tester.view.devicePixelRatio = 1;
        tester.view.physicalSize = const Size(720, 300);
        addTearDown(tester.view.reset);
        await tester.pumpWidget(
          MaterialApp(
            home: TerminalPanel(
              notifier: app,
              session: session,
              focused: false,
              compactHeader: true,
              onClose: () {},
              onDelete: () {},
              onToggleZoom: () {},
              onToggleComposer: () {},
            ),
          ),
        );
        await tester.pump();
        final title = find.text('Onboarding');
        final details = find.byKey(const ValueKey('pane-header-details'));
        final controls = find.byType(PaneHeaderActions);
        final terminalWidget = tester.widget<TerminalView>(
          find.byType(TerminalView),
        );
        final titleBounds = tester.getRect(title);
        expect(tester.widget<AnimatedOpacity>(details).opacity, 1);
        expect(find.text('harness'), findsOneWidget);
        expect(find.text('main'), findsOneWidget);
        expect(
          tester.getRect(find.text('Test host')).left,
          greaterThan(titleBounds.right),
        );
        expect(
          tester.getRect(find.text('harness')).left,
          greaterThan(tester.getRect(find.text('Test host')).right),
        );
        expect(
          tester.getRect(find.text('main')).left,
          greaterThan(tester.getRect(find.text('harness')).right),
        );
        expect(find.byTooltip('Stop Agent').hitTestable(), findsNothing);
        expect(
          find.descendant(of: controls, matching: find.byType(IconButton)),
          findsNWidgets(local ? 5 : 6),
        );
        final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
        await mouse.addPointer(location: tester.getCenter(title));
        await tester.pump(const Duration(milliseconds: 120));
        expect(tester.widget<AnimatedOpacity>(details).opacity, 0);
        expect(find.byTooltip('Stop Agent').hitTestable(), findsOneWidget);
        expect(find.byTooltip('Share harness').hitTestable(), findsOneWidget);
        expect(tester.getRect(title), titleBounds);
        expect(
          tester.widget<TerminalView>(find.byType(TerminalView)),
          same(terminalWidget),
        );
        await mouse.moveTo(const Offset(300, 200));
        await tester.pump(const Duration(milliseconds: 120));
        expect(tester.widget<AnimatedOpacity>(details).opacity, 1);
        expect(find.byTooltip('Stop Agent').hitTestable(), findsNothing);
        // Keyboard users can reveal and reach the same actions without a mouse.
        Focus.of(tester.element(find.byTooltip('Stop Agent'))).nextFocus();
        await tester.pump(const Duration(milliseconds: 120));
        expect(find.byTooltip('Stop Agent').hitTestable(), findsOneWidget);
        await mouse.removePointer();
        await tester.pumpWidget(const SizedBox());
        session.dispose();
        app.dispose();
      },
    );
  }
  testWidgets(
    'narrow headers preserve identity and keyboard actions at large text',
    (tester) async {
      final app = createApp();
      final session = terminal('a0', []);
      session.agentName = 'Review the release notes';
      app.machineStates['m']!.agents = [
        const Agent(
          id: 'a0',
          name: 'Review the release notes',
          engine: 'codex',
          terminalAvailable: true,
          viewerUrl: 'http://fixture.invalid/viewer',
          project: AgentProject(
            name: 'release-notes',
            cwd: '/work/release-notes',
            branch: 'feature/very-long-branch',
          ),
        ),
      ];
      var zooms = 0;
      var forks = 0;
      final revision = ValueNotifier(0);
      tester.view.devicePixelRatio = 1;
      tester.platformDispatcher.textScaleFactorTestValue = 1.7;
      addTearDown(tester.view.reset);
      addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
      for (final width in [240.0, 280.0, 420.0]) {
        tester.view.physicalSize = Size(width, 600);
        await tester.pumpWidget(
          MaterialApp(
            home: ValueListenableBuilder<int>(
              valueListenable: revision,
              builder: (_, _, _) => TerminalPanel(
                notifier: app,
                session: session,
                focused: false,
                compactHeader: true,
                onToggleZoom: () => zooms++,
                onFork: () => forks++,
                onRestart: () {},
                onClose: () {},
                onDelete: () {},
                onToggleComposer: () {},
              ),
            ),
          ),
        );
        await tester.pump();
        final title = find.text(session.agentName);
        expect(tester.getSize(title).width, greaterThan(64));
        expect(tester.takeException(), isNull);
        final titleBefore = tester.getRect(title);
        final button = tester.widget<IconButton>(
          find.widgetWithIcon(IconButton, Icons.more_horiz),
        );
        button.focusNode!.requestFocus();
        await tester.pump(const Duration(milliseconds: 120));
        await tester.sendKeyEvent(LogicalKeyboardKey.enter);
        await tester.pumpAndSettle();
        expect(find.text('Zoom Pane'), findsOneWidget);
        expect(find.text('Show viewer'), findsOneWidget);
        expect(find.text('Fork Agent'), findsOneWidget);
        expect(find.text('Stop Agent'), findsOneWidget);
        expect(tester.getRect(title), titleBefore);
        await tester.sendKeyEvent(LogicalKeyboardKey.enter);
        await tester.pumpAndSettle();
        expect(zooms, [240.0, 280.0, 420.0].indexOf(width) + 1);
        expect(find.text('Zoom Pane'), findsNothing);
        await tester.sendKeyEvent(LogicalKeyboardKey.enter);
        await tester.pumpAndSettle();
        for (var i = 0; i < 5; i++) {
          await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
          await tester.pump();
        }
        await tester.sendKeyEvent(LogicalKeyboardKey.enter);
        await tester.pumpAndSettle();
        expect(forks, zooms);
        await tester.sendKeyEvent(LogicalKeyboardKey.enter);
        await tester.pumpAndSettle();
        await tester.sendKeyEvent(LogicalKeyboardKey.escape);
        await tester.pumpAndSettle();
        expect(find.text('Zoom Pane'), findsNothing);
        expect(button.focusNode!.hasFocus, isTrue);
        await tester.sendKeyEvent(LogicalKeyboardKey.enter);
        await tester.pumpAndSettle();
        dismissTransientMenus();
        await tester.pumpAndSettle();
        expect(find.text('Zoom Pane'), findsNothing);
        expect(tester.takeException(), isNull);
        for (final status in [
          TerminalSessionStatus.opening,
          TerminalSessionStatus.takenOver,
          TerminalSessionStatus.closed,
        ]) {
          session.status = status;
          revision.value++;
          await tester.pump();
          expect(tester.getSize(title).width, greaterThan(40));
          expect(tester.takeException(), isNull);
        }
        expect(find.byTooltip('Reconnect'), findsOneWidget);
        expect(
          tester
              .widget<IconButton>(
                find.widgetWithIcon(IconButton, Icons.refresh),
              )
              .onPressed,
          isNotNull,
        );
        session.status = TerminalSessionStatus.controlling;
      }
      await tester.pumpWidget(const SizedBox());
      revision.dispose();
      session.dispose();
      app.dispose();
    },
  );
}
