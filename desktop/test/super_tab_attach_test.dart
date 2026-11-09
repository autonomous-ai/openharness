import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shortcuts/app_keymap.dart';
import 'package:harness/state/swarm_catalog.dart';
import 'package:harness/widgets/swarm_switcher.dart';

import 'keymap_host_test.dart' show MemoryKeymap;
import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;

/// Attach, beside + in Your Team (Swarm v4, anh Dee 2026-11-09: "this is like cmd p. while + is like cmd n"), clicked
/// through as a person does: ⌘P's picker of the agents running on their own computers, and the one chosen joins their
/// team with its own chat.
void main() {
  Finder key(String k) => find.byKey(ValueKey(k));

  Future<SuperTabLaunchFixture> open(WidgetTester tester) async {
    final f = SuperTabLaunchFixture();
    f.connection.journaled = false;
    f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
    f.app.machineStates['m']!.agents = [
      const Agent(
        id: 'docs-session',
        name: 'Docs bot',
        nameChosen: true,
        engine: 'claude',
        modelName: 'Opus 5.5',
        terminalAvailable: true,
      ),
      const Agent(
        id: 'shell',
        name: 'Plain shell',
        engine: 'terminal',
        terminalAvailable: true,
      ),
      const Agent(
        id: 'stopped',
        name: 'Stopped builder',
        engine: 'codex',
        status: 'stopped',
      ),
    ];
    final c = await f.app.superTabs.open(tabId);
    await c.refresh();
    final map = MemoryKeymap();
    addTearDown(map.dispose);
    final projects = SwarmProjectStore();
    addTearDown(projects.dispose);
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(1440, 900);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(
      MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        builder: (context, child) => KeymapProvider(keymap: map, child: child!),
        home: SwarmScreen(
          notifier: f.app,
          nativeTabs: false,
          projectStore: projects,
        ),
      ),
    );
    await tester.pumpAndSettle();
    return f;
  }

  testWidgets(
    'Attach opens the picker of the agents running here; the one chosen '
    'joins the team with its own chat, which opens',
    (tester) async {
      final f = await open(tester);
      await tester.tap(key('project-sidebar-agents-attach'));
      await tester.pumpAndSettle();
      expect(find.text('Attach agent'), findsOneWidget);
      expect(
        find.text('It joins your team with its own chat.'),
        findsOneWidget,
      );
      final search = tester
          .widget<SwarmSearchResults>(find.byType(SwarmSearchResults))
          .search;
      final docs = search.rows.singleWhere(
        (row) => row.agentId == 'docs-session',
      );
      expect(search.canSubmit(docs), isTrue);
      expect(search.actionLabel(docs), 'Attach');
      // A plain shell and a stopped session cannot join, and say why; Attach makes nothing new.
      expect(
        search.canSubmit(
          search.rows.singleWhere((row) => row.agentId == 'shell'),
        ),
        isFalse,
      );
      expect(
        search.canSubmit(
          search.rows.singleWhere((row) => row.agentId == 'stopped'),
        ),
        isFalse,
      );
      expect(search.rows.where((row) => row.isCreate), isEmpty);

      await tester.enterText(
        find.byKey(const ValueKey('swarm-search-input')),
        'Docs bot',
      );
      await tester.pumpAndSettle();
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();

      final commands = [
        for (final post in f.connection.server.posts) post['command'] as Map,
      ];
      expect(
        commands.singleWhere((c) => c['type'] == 'agent.new'),
        containsPair('name', 'Docs bot'),
      );
      final join = f.connection.joins.single['command'] as Map;
      expect(join, containsPair('harnessId', 'docs-session'));
      final chatId = join['conversationId'] as String;
      expect(f.app.superTabs.peek(tabId)!.selectedId, chatId);
      // The picker is gone.
      expect(find.text('Attach agent'), findsNothing);
      await tester.pumpWidget(const SizedBox());
      await f.app.superTabs.peek(tabId)!.flush();
      f.app.superTabs.dispose();
    },
  );
}
