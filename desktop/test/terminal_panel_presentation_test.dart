import 'package:flutter/material.dart';
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
      // Every pane action is one ⋮ menu away.
      for (final label in [
        'Show message composer',
        'Zoom Pane',
        'Restart Harness',
        'Stop Harness',
        'Close Pane',
      ]) {
        await tester.tap(find.byTooltip('Pane actions'));
        await tester.pumpAndSettle();
        await tester.tap(find.text(label));
        await tester.pumpAndSettle();
      }
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
      expect(find.byTooltip('Pane actions'), findsOneWidget);
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
      await tester.pumpWidget(const SizedBox());
      revision.dispose();
      session.dispose();
      app.dispose();
    },
  );
  for (final local in [true, false]) {
    testWidgets(
      '${local ? 'local' : 'remote'} compact header keeps actions in the menu without repeating context or moving its title',
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
        // Context belongs to the main app bar; pane actions stay in one menu.
        expect(
          find.descendant(of: controls, matching: find.byType(IconButton)),
          findsOneWidget,
        );
        expect(find.byTooltip('Pane actions').hitTestable(), findsOneWidget);
        await tester.tap(find.byTooltip('Pane actions'));
        await tester.pumpAndSettle();
        expect(find.text('Stop Harness'), findsOneWidget);
        expect(find.text('Share harness'), findsOneWidget);
        // Neither the title nor the retained terminal moves when the menu opens.
        expect(find.text('main'), findsNothing);
        expect(tester.getRect(title), titleBounds);
        expect(
          tester.widget<TerminalView>(find.byType(TerminalView)),
          same(terminalWidget),
        );
        await tester.sendKeyEvent(LogicalKeyboardKey.escape);
        await tester.pumpAndSettle();
        expect(find.text('Stop Harness'), findsNothing);
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
        final menu = find.widgetWithIcon(IconButton, Icons.more_vert);
        await tester.tap(menu);
        await tester.pumpAndSettle();
        expect(find.text('Zoom Pane'), findsOneWidget);
        expect(find.text('Show viewer'), findsOneWidget);
        expect(find.text('Fork Harness'), findsOneWidget);
        expect(find.text('Stop Harness'), findsOneWidget);
        expect(tester.getRect(title), titleBefore);
        await tester.tap(find.text('Zoom Pane'));
        await tester.pumpAndSettle();
        expect(zooms, [240.0, 280.0, 420.0].indexOf(width) + 1);
        expect(find.text('Zoom Pane'), findsNothing);
        await tester.tap(menu);
        await tester.pumpAndSettle();
        await tester.tap(find.text('Fork Harness'));
        await tester.pumpAndSettle();
        expect(forks, zooms);
        // Escape and a click elsewhere both close it without choosing anything.
        await tester.tap(menu);
        await tester.pumpAndSettle();
        await tester.sendKeyEvent(LogicalKeyboardKey.escape);
        await tester.pumpAndSettle();
        expect(find.text('Zoom Pane'), findsNothing);
        await tester.tap(menu);
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
