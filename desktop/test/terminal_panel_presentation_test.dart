import 'dart:ui' show PointerDeviceKind;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/shared/theme/workspace_bar_style.dart';
import 'package:harness/terminal/terminal_session.dart';
import 'package:harness/terminal/terminal_font_store.dart';
import 'package:harness/widgets/terminal_panel.dart';
import 'package:harness/widgets/pane_header_actions.dart';
import 'package:harness/widgets/grid_model_picker.dart';
import 'package:xterm/xterm.dart';

import 'support/real_fonts.dart';
import 'swarm_screen_test.dart' show terminal;
import 'swarm_state_test.dart' show createApp;

void main() {
  setUpAll(loadRealFonts);
  testWidgets(
    'retained header uses current callbacks, names, projects and status',
    (tester) async {
      final app = createApp();
      final session = terminal('a0', []);
      final revision = ValueNotifier(0);
      final closed = <int>[];
      final deleted = <int>[];
      final zoomed = <int>[];
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
              onToggleZoom: () => zoomed.add(version),
              zoomed: version >= 2,
            ),
          ),
        ),
      );
      await tester.pump();
      revision.value = 1;
      await tester.pump();
      for (final label in ['Close Pane', 'Zoom Pane', 'Stop Harness']) {
        expect(find.byTooltip(label), findsNothing);
      }
      expect(closed, isEmpty);
      expect(deleted, isEmpty);
      expect(zoomed, isEmpty);
      expect(find.byTooltip('Pane actions'), findsNothing);
      expect(find.byTooltip('Restart Harness'), findsNothing);
      expect(find.byTooltip('Share harness'), findsNothing);
      session.agentName = 'Renamed terminal';
      app.machineStates['m']!.agents = [
        const Agent(
          id: 'a0',
          name: 'Renamed terminal',
          engine: 'codex',
          terminalAvailable: true,
          project: AgentProject(
            name: 'harness',
            cwd: '/work/worktrees/harness/codex-0922-1136/desktop',
            root: '/work/worktrees/harness/codex-0922-1136',
            branch: 'harness/codex-0922-1136',
          ),
        ),
      ];
      revision.value = 2;
      await tester.pump();
      expect(find.text('Renamed terminal'), findsOneWidget);
      expect(find.text('harness/codex-0922-1136'), findsNothing);
      expect(
        find.text('desktop'),
        findsNothing,
        reason: 'Project context belongs to the shared workspace status line.',
      );
      expect(find.text('codex-0922-1136'), findsNothing);
      app.machineStates['m']!.agents = [
        const Agent(
          id: 'a0',
          name: 'Renamed terminal',
          engine: 'codex',
          terminalAvailable: true,
          project: AgentProject(
            name: 'harness',
            cwd: '/work/worktrees/harness/codex-0922-1136',
            root: '/work/worktrees/harness/codex-0922-1136',
            branch: 'harness/codex-0922-1136',
            worktree: true,
          ),
        ),
      ];
      revision.value = 3;
      await tester.pump();
      expect(
        find.text('harness'),
        findsNothing,
        reason: 'Compact pane headers do not repeat project context.',
      );
      expect(
        find.text('codex-0922-1136'),
        findsNothing,
        reason: 'Its folder is named after the branch already shown.',
      );
      app.machineStates['m']!.agents = [
        const Agent(
          id: 'a0',
          name: 'Renamed terminal',
          engine: 'codex',
          terminalAvailable: true,
          project: AgentProject(
            name: 'harness',
            cwd: '/work/worktrees/harness/brave-otter',
            root: '/work/worktrees/harness/brave-otter',
            branch: 'tester/brave-otter',
            worktree: true,
            branchPending: true,
          ),
        ),
      ];
      revision.value = 4;
      await tester.pump();
      expect(find.text('harness'), findsNothing);
      expect(
        find.text('tester/brave-otter'),
        findsNothing,
        reason: 'A made-up branch waits for the session to name it.',
      );
      app.machineStates['m']!.agents = [
        const Agent(
          id: 'a0',
          name: 'Renamed terminal',
          engine: 'codex',
          terminalAvailable: true,
          project: AgentProject(
            name: 'harness',
            cwd: '/work/harness',
            root: '/work/harness',
            branch: '${kDetachedBranchPrefix}65281563',
          ),
        ),
      ];
      revision.value = 5;
      await tester.pump();
      expect(find.text('harness'), findsNothing);
      expect(
        find.textContaining('Detached'),
        findsNothing,
        reason: 'A commit an agent checked out is not a branch to show.',
      );
      expect(
        find.byWidgetPredicate(
          (widget) =>
              widget is Tooltip &&
              (widget.message ?? '').contains('No branch: on commit 65281563'),
        ),
        findsWidgets,
      );
      revision.value = 2;
      await tester.pump();
      expect(find.byTooltip('Restore Pane'), findsNothing);
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
        workspaceBarTextStyle().fontFamily,
      );
      await tester.pumpWidget(const SizedBox());
      revision.dispose();
      session.dispose();
      app.dispose();
    },
  );
  for (final local in [true, false]) {
    testWidgets(
      '${local ? 'local' : 'remote'} compact model selectors stay visible without moving the title or terminal',
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
              name: 'harness',
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
        final controls = find.byType(PaneHeaderActions);
        final terminalWidget = tester.widget<TerminalView>(
          find.byType(TerminalView),
        );
        final titleBounds = tester.getRect(title);
        expect(find.text('harness'), findsNothing);
        expect(find.text('main'), findsNothing);
        expect(find.text('Test host'), findsNothing);
        expect(
          find.descendant(of: controls, matching: find.byType(IconButton)),
          findsNothing,
        );
        expect(
          tester
              .widgetList<TextButton>(
                find.descendant(
                  of: controls,
                  matching: find.byType(TextButton),
                ),
              )
              .length,
          0,
        );
        expect(find.text('OpenAI').hitTestable(), findsOneWidget);
        for (final label in ['Close Pane', 'Zoom Pane', 'Stop Harness']) {
          expect(find.byTooltip(label).hitTestable(), findsNothing);
        }
        final controlsBounds = tester.getRect(controls);
        final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
        await mouse.addPointer(location: const Offset(1, 100));
        await mouse.moveTo(tester.getCenter(title));
        await tester.pump();
        for (final label in ['Close Pane', 'Zoom Pane', 'Stop Harness']) {
          expect(find.byTooltip(label), findsNothing);
        }
        expect(tester.getRect(title), titleBounds);
        expect(tester.getRect(controls), controlsBounds);
        await mouse.moveTo(tester.getCenter(find.byType(TerminalView)));
        await tester.pump();
        for (final label in ['Close Pane', 'Zoom Pane', 'Stop Harness']) {
          expect(find.byTooltip(label).hitTestable(), findsNothing);
        }
        expect(find.byTooltip('Share harness'), findsNothing);
        expect(find.text('main'), findsNothing);
        expect(tester.getRect(title), titleBounds);
        expect(
          tester.widget<TerminalView>(find.byType(TerminalView)),
          same(terminalWidget),
        );
        final titleStyle = tester.widget<Text>(title).style!;
        expect(titleStyle.fontFamily, workspaceBarTextStyle().fontFamily);
        expect(titleStyle.fontSize, 13);
        expect(titleStyle.fontWeight, FontWeight.normal);
        await mouse.removePointer();
        await tester.pumpWidget(const SizedBox());
        session.dispose();
        app.dispose();
      },
    );
  }
  testWidgets(
    'narrow headers preserve identity and model selection at large text',
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
        final picker = find.byType(GridModelPicker);
        expect(picker.hitTestable(), findsOneWidget);
        expect(find.byTooltip('Stop Harness'), findsNothing);
        expect(find.byTooltip('Zoom Pane'), findsNothing);
        expect(tester.getRect(title), titleBefore);
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
