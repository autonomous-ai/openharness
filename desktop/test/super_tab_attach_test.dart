import 'dart:io';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shortcuts/app_keymap.dart';
import 'package:harness/state/swarm.dart';
import 'package:harness/state/swarm_catalog.dart';
import 'package:harness/state/terminal_pane.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/widgets/swarm_switcher.dart';

import 'keymap_host_test.dart' show MemoryKeymap;
import 'support/capture.dart';
import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;

/// Attach, beside + in Your Team (Swarm v4, anh Dee 2026-11-09: "this is like cmd p. while + is like cmd n"), clicked
/// through as a person does: ⌘P's picker of the agents running on their own computers, and the one chosen joins their
/// team with its own chat.
/// Set to a folder to write the pull request's pictures of Remove there.
final _shots = Platform.environment['REMOVE_AGENT_SHOTS'];

void main() {
  setUpAll(() => loadCaptureFonts(_shots));
  Finder key(String k) => find.byKey(ValueKey(k));
  final harness = RegExp('harness', caseSensitive: false);

  /// With [nothingRunning], no session runs on the person's computers.
  Future<SuperTabLaunchFixture> open(
    WidgetTester tester, {
    bool nothingRunning = false,
  }) async {
    final f = SuperTabLaunchFixture();
    f.connection.journaled = false;
    f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
    f.app.machineStates['m']!.agents = [
      Agent(
        id: 'docs-session',
        name: 'Docs bot',
        nameChosen: true,
        engine: 'claude',
        modelName: 'Opus 5.5',
        terminalAvailable: true,
        sessionId: 'docs-conversation',
        createdAt: DateTime.utc(2026, 11, 10, 8),
        closeSupported: true,
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
        sessionId: 'saved-builder',
      ),
    ];
    if (nothingRunning) f.app.machineStates['m']!.agents = const [];
    f.connection.native = {
      'id': 'stopped',
      'name': 'Stopped builder',
      'engine': 'codex',
      'sessionId': 'saved-builder',
      'status': 'stopped',
      'terminal': {'available': false},
    };
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
      // It finds agents: harness is not a word of the Swarm.
      expect(find.text('Search agents'), findsOneWidget);
      expect(find.textContaining(harness), findsNothing);
      final search = tester
          .widget<SwarmSearchResults>(find.byType(SwarmSearchResults))
          .search;
      final docs = search.rows.singleWhere(
        (row) => row.agentId == 'docs-session',
      );
      expect(search.canSubmit(docs), isTrue);
      expect(search.actionLabel(docs), 'Attach');
      // A plain shell cannot join, and says why; Attach makes nothing new.
      expect(
        search.canSubmit(
          search.rows.singleWhere((row) => row.agentId == 'shell'),
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

  // anh Dee 2026-11-10: "i should be able to attach stopped sessions too … resume + attach in one step".
  testWidgets('Attach speaks of agents when nothing matches, and an empty '
      'list says nothing', (tester) async {
    final f = await open(tester);
    await tester.tap(key('project-sidebar-agents-attach'));
    await tester.pumpAndSettle();
    await tester.enterText(key('swarm-search-input'), 'zzz');
    await tester.pumpAndSettle();
    expect(find.text('No matching agents'), findsOneWidget);
    expect(find.textContaining(harness), findsNothing);
    await tester.pumpWidget(const SizedBox());
    f.app.superTabs.dispose();
    // Nothing running on its person's computers: the list is empty, and says nothing.
    final none = await open(tester, nothingRunning: true);
    await tester.tap(key('project-sidebar-agents-attach'));
    await tester.pumpAndSettle();
    final results = find.byType(SwarmSearchResults);
    expect(tester.widget<SwarmSearchResults>(results).search.rows, isEmpty);
    expect(find.textContaining(harness), findsNothing);
    expect(
      find.descendant(of: results, matching: find.textContaining('yet')),
      findsNothing,
    );
    await tester.pumpWidget(const SizedBox());
    none.app.superTabs.dispose();
  });

  testWidgets('a stopped session resumes and joins in one step', (
    tester,
  ) async {
    final f = await open(tester);
    await tester.tap(key('project-sidebar-agents-attach'));
    await tester.pumpAndSettle();
    final search = tester
        .widget<SwarmSearchResults>(find.byType(SwarmSearchResults))
        .search;
    final stopped = search.rows.singleWhere((row) => row.agentId == 'stopped');
    expect(search.canSubmit(stopped), isTrue);
    expect(search.actionLabel(stopped), 'Attach');

    await tester.enterText(
      find.byKey(const ValueKey('swarm-search-input')),
      'Stopped builder',
    );
    await tester.pumpAndSettle();
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();

    final calls = f.connection.calls;
    expect(calls.where((c) => c.$1 == 'agent_resume'), hasLength(1));
    expect(calls.where((c) => c.$1 == 'agent_create'), isEmpty);
    final join = f.connection.joins.single['command'] as Map;
    expect(join, containsPair('harnessId', 'stopped'));
    expect(join, containsPair('name', 'Stopped builder'));
    expect(
      f.app.stateOf('m')!.agents.firstWhere((a) => a.id == 'stopped').isStopped,
      isFalse,
    );
    expect(f.app.superTabs.peek(tabId)!.selectedId, join['conversationId']);
    await tester.pumpWidget(const SizedBox());
    await f.app.superTabs.peek(tabId)!.flush();
    f.app.superTabs.dispose();
  });

  /// Attaches Docs bot through the picker, as a person does, and right-clicks Remove on its row: the agent it made.
  Future<SuperTabAgent> attachThenRemove(
    WidgetTester tester,
    SuperTabLaunchFixture f,
  ) async {
    await tester.tap(key('project-sidebar-agents-attach'));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byKey(const ValueKey('swarm-search-input')),
      'Docs bot',
    );
    await tester.pumpAndSettle();
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    final member = f.app.superTabs
        .peek(tabId)!
        .snapshot!
        .agents
        .singleWhere((a) => a.harnessId == 'docs-session');
    await tester.tap(
      key('super-agent-${member.id}'),
      buttons: kSecondaryButton,
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('Remove'));
    await tester.pumpAndSettle();
    return member;
  }

  List<Map> closes(SuperTabLaunchFixture f) => [
    for (final call in f.connection.calls)
      if (call.$1 == 'agent_close' && call.$2['mode'] != 'inspect') call.$2,
  ];

  List<Map> removals(SuperTabLaunchFixture f) => [
    for (final post in f.connection.server.posts)
      if ((post['command'] as Map)['type'] == 'agent.remove')
        post['command'] as Map,
  ];

  Future<void> done(WidgetTester tester, SuperTabLaunchFixture f) async {
    await tester.pumpWidget(const SizedBox());
    await f.app.superTabs.peek(tabId)!.flush();
    f.app.superTabs.dispose();
  }

  // anh Dee 2026-11-11: removing an agent from Your Team follows the rule closing a pane has.
  testWidgets('Remove, with Your Team its last place: an idle session stops '
      'quietly, then the Swarm lets go of it', (tester) async {
    final f = await open(tester);
    final member = await attachThenRemove(tester, f);
    expect(find.text('Remove Docs bot?'), findsOneWidget);
    expect(find.text('Its chat goes and its session stops.'), findsOneWidget);
    await tester.tap(key('remove-agent-confirm'));
    await tester.pumpAndSettle();
    // No question: it was idle.
    expect(key('session-close-now'), findsNothing);
    expect(closes(f), hasLength(1));
    expect(closes(f).single, containsPair('agentId', 'docs-session'));
    expect(closes(f).single, containsPair('mode', 'idle'));
    expect(removals(f).single, containsPair('agentId', member.id));
    expect(
      f.app
          .stateOf('m')!
          .agents
          .firstWhere((a) => a.id == 'docs-session')
          .isStopped,
      isTrue,
    );
    await done(tester, f);
  });

  testWidgets('Remove of a working session asks first, as closing its last '
      'view does: Cancel keeps it all, Stop stops it and removes it', (
    tester,
  ) async {
    final f = await open(tester);
    f.connection.closeActivity = 'working';
    final member = await attachThenRemove(tester, f);
    await captureWindow(tester, _shots, 'remove-agent');
    await tester.tap(key('remove-agent-confirm'));
    await tester.pumpAndSettle();
    await captureWindow(tester, _shots, 'remove-agent-working');
    expect(find.text('1 session is still working.'), findsOneWidget);
    // The review's own Cancel, over the Remove dialog.
    await tester.tap(find.text('Cancel').last);
    await tester.pumpAndSettle();
    expect(closes(f), isEmpty);
    expect(removals(f), isEmpty);
    expect(
      f.app.superTabs
          .peek(tabId)!
          .snapshot!
          .agents
          .any((a) => a.id == member.id),
      isTrue,
    );
    // Asked again, and this time Stop.
    await tester.tap(key('remove-agent-confirm'));
    await tester.pumpAndSettle();
    await tester.tap(key('session-close-now'));
    await tester.pumpAndSettle();
    expect(closes(f).single, containsPair('mode', 'now'));
    expect(removals(f).single, containsPair('agentId', member.id));
    expect(key('remove-agent-confirm'), findsNothing);
    await done(tester, f);
  });

  testWidgets('Remove of an agent its person still shows in a tab only takes '
      'it off the list: its session keeps running there', (tester) async {
    final f = await open(tester);
    f.app.swarms.add(
      Swarm(id: 'desk', name: 'Work')
        ..panes.add(
          TerminalPane(id: 77, machineId: 'm', agentId: 'docs-session'),
        ),
    );
    final member = await attachThenRemove(tester, f);
    expect(
      find.text('Its chat goes. It keeps running in your tab.'),
      findsOneWidget,
    );
    await tester.tap(key('remove-agent-confirm'));
    await tester.pumpAndSettle();
    expect(
      f.connection.calls.where((call) => call.$1 == 'agent_close'),
      isEmpty,
    );
    expect(removals(f).single, containsPair('agentId', member.id));
    expect(
      f.app
          .stateOf('m')!
          .agents
          .firstWhere((a) => a.id == 'docs-session')
          .isStopped,
      isFalse,
    );
    await done(tester, f);
  });

  testWidgets('a Stop its computer refuses keeps the agent, and says why', (
    tester,
  ) async {
    final f = await open(tester);
    f.connection.refuseClose = true;
    final member = await attachThenRemove(tester, f);
    await tester.tap(key('remove-agent-confirm'));
    await tester.pumpAndSettle();
    expect(find.text('This computer would not stop it.'), findsOneWidget);
    await tester.tap(find.text('Keep open'));
    await tester.pumpAndSettle();
    expect(key('remove-agent-confirm'), findsOneWidget);
    expect(removals(f), isEmpty);
    expect(
      f.app.superTabs
          .peek(tabId)!
          .snapshot!
          .agents
          .any((a) => a.id == member.id),
      isTrue,
    );
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    await done(tester, f);
  });
}
