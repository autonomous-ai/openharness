import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/pane_layout_store.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/state/swarm.dart';
import 'package:harness/state/terminal_pane.dart';
import 'package:harness/super_tabs/client.dart';
import 'package:harness/ws/ws_conn.dart';

import 'swarm_state_test.dart' show MemoryStore, createApp;
import 'swarm_screen_test.dart' show mount;
import 'support/open_harness.dart';
import 'support/super_tab_fixture.dart';

class _Catalog {
  final tabs = <Map<String, dynamic>>[
    {'id': '0123456789abcdef01234567', 'name': 'Pilot'},
  ];
  final paths = <String>[];
  final server = ConversationServer();
  String? fail;
  Completer<void>? hold;

  Future<Object?> request(
    String method,
    String path, {
    Map<String, dynamic>? body,
  }) async {
    if (Uri.parse(path).path != '/api/super-tabs') {
      return server.request(method, path, body: body);
    }
    expectSync(method, 'GET');
    paths.add(path);
    final after = Uri.parse(path).queryParameters['after'];
    final index = after == null
        ? 0
        : tabs.indexWhere((t) => t['id'] == after) + 1;
    final rows = index < tabs.length ? [Map.of(tabs[index])] : [];
    final next = index + 1 < tabs.length ? tabs[index]['id'] : null;
    if (hold case final waiting?) await waiting.future;
    if (fail == path) throw StateError('Connection lost');
    return {'tabs': rows, 'next': next};
  }
}

class _RestoringStore extends MemoryStore {
  final readingLayout = Completer<void>();
  final releaseLayout = Completer<void>();
  bool holdLayout = false;

  @override
  Future<String?> read(String key) async {
    final value = await super.read(key);
    if (holdLayout && key == 'swarm_layout_v1') {
      readingLayout.complete();
      await releaseLayout.future;
    }
    return value;
  }
}

class _Connection extends WsConn {
  _Connection(this.catalog)
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );
  final _Catalog catalog;
  final calls = <String>[];
  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    calls.add(type);
    if (type != 'super_tabs') return {};
    return {
      'value': await catalog.request(
        payload['method'] as String,
        payload['path'] as String,
        body: payload['body'] as Map<String, dynamic>?,
      ),
    };
  }
}

AppNotifier _computer(
  _Catalog catalog,
  MemoryStore store, {
  bool enteredSuperTabs = true,
}) {
  final connection = _Connection(catalog);
  final app = createApp(
    store: store,
    connected: true,
    connectionForTest: (_) => connection,
  );
  app.machineStates['m']!.localOnly = true;
  app.status = AppStatus.authenticated;
  app.currentUser = const CurrentUserProfile(
    id: 'owner',
    email: 'owner@example.invalid',
  );
  if (enteredSuperTabs) app.enterSuperTabs();
  addTearDown(app.dispose);
  return app;
}

/// Closes as a person does (the path behind x, Cmd+W and middle-click) and
/// lets the saved hidden set settle without calling the client directly.
Future<void> _close(AppNotifier app, Swarm tab) async {
  await app.requestCloseSwarm(tab.id);
  for (var i = 0; i < 20; i++) {
    await Future<void>.value();
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('account membership cannot reveal SuperTabs before deliberate entry', () async {
    final store = MemoryStore();
    final app = _computer(_Catalog(), store, enteredSuperTabs: false);
    app.newSwarm(name: 'Regular work');
    final regular = app.activeSwarm;
    await app.superTabs.refreshTabs();
    expect(app.swarms.where((s) => s.isSuperTab), isEmpty);
    expect(app.activeSwarm, same(regular));
    // The hidden shortcut marks a draft. It permits discovery without replacing
    // or navigating away from the existing regular work.
    app.newSwarm(newTabPage: true);
    app.markSuperTabDraft(app.activeSwarmId);
    final draft = app.activeSwarm;
    await app.superTabs.refreshTabs();
    expect(app.swarms, contains(regular));
    expect(app.activeSwarm, same(draft));
    expect(app.swarms.where((s) => s.superTabId != null).single.name, 'Pilot');
  });

  test(
    'restoring an already-open SuperTab keeps discovery available',
    () async {
      final store = MemoryStore();
      await PaneLayoutStore(storage: store).saveSwarms([
        Swarm(id: 'work', name: 'Regular work'),
        Swarm(id: 'pilot', name: 'Pilot', kind: 'superTab')
          ..superTabId = '0123456789abcdef01234567',
      ], 'work');
      final app = _computer(_Catalog(), store, enteredSuperTabs: false);
      app.currentUser = null;
      await app.restorePaneLayoutForTest();
      app.currentUser = const CurrentUserProfile(
        id: 'owner',
        email: 'owner@example.invalid',
      );
      await app.superTabs.refreshTabs();
      expect(app.swarms.map((s) => s.id), ['work', 'pilot']);
      expect(app.activeSwarmId, 'work');
    },
  );

  test(
    'entering SuperTabs for one account does not reveal them to another',
    () async {
      final app = _computer(_Catalog(), MemoryStore());
      app.currentUser = const CurrentUserProfile(
        id: 'other',
        email: 'other@example.invalid',
      );
      await app.superTabs.refreshTabs();
      expect(app.swarms.where((s) => s.isSuperTab), isEmpty);
      app.enterSuperTabs();
      await app.superTabs.refreshTabs();
      expect(app.swarms.where((s) => s.isSuperTab), hasLength(1));
    },
  );

  testWidgets(
    'another computer opens the discovered tab and its shared messages',
    (tester) async {
      final catalog = _Catalog();
      catalog.server.state['id'] = catalog.tabs.single['id'];
      catalog.server.append('Plan agreed on the first computer');
      final second = _computer(catalog, MemoryStore());
      final previous = second.activeSwarmId;
      await mount(tester, second);
      await second.superTabs.refreshTabs();
      await tester.pump();
      final shared = second.swarms.singleWhere((s) => s.isSuperTab);
      expect(find.byKey(ValueKey('tab-label:${shared.id}')), findsOneWidget);
      expect(second.activeSwarmId, previous);
      await tester.tap(find.byKey(ValueKey('tab-label:${shared.id}')));
      await tester.pumpAndSettle();
      expect(second.activeSwarm.superTabId, catalog.tabs.single['id']);
      expect(
        find.text('Plan agreed on the first computer', findRichText: true),
        findsOneWidget,
      );
      expect(second.allPanes, isEmpty);
      expect(catalog.server.posts, isEmpty);
      await tester.pumpWidget(const SizedBox.shrink());
      await second.superTabs.peek(shared.superTabId!)!.flush();
      second.superTabs.dispose();
      await tester.pump();
    },
  );

  test(
    'discovery waits for the saved workspace before adding shared tabs',
    () async {
      final store = MemoryStore();
      await PaneLayoutStore(storage: store)
          .saveSwarms([Swarm(id: 'saved', name: 'Existing work')], 'saved');
      final catalog = _Catalog();
      final app = _computer(catalog, store)..status = AppStatus.bootstrapping;
      await app.superTabs.refreshTabs();
      expect(app.swarms.where((s) => s.isSuperTab), isEmpty);
      await app.restorePaneLayoutForTest();
      expect(app.activeSwarm.name, 'Existing work');
      app.status = AppStatus.authenticated;
      await app.superTabs.refreshTabs();
      expect(app.activeSwarm.name, 'Existing work');
      expect(app.swarms.where((s) => s.isSuperTab), hasLength(1));
    },
  );

  test('discovery cannot replace regular tabs during an authenticated layout restore', () async {
    final store = _RestoringStore();
    final layout = PaneLayoutStore(storage: store);
    await layout.saveSwarms([
      Swarm(id: 'work', name: 'Existing work')
        ..panes.add(TerminalPane(id: 1, machineId: 'm', agentId: 'a0')),
      Swarm(id: 'notes', name: 'Notes')
        ..panes.add(TerminalPane(id: 2, machineId: 'm', agentId: 'a1')),
    ], 'notes');
    final saved = store.values['swarm_layout_v1'];
    final app = _computer(_Catalog(), store);
    store.holdLayout = true;
    final restoring = app.restorePaneLayoutForTest();
    await store.readingLayout.future;
    List<Swarm>? discoveredDuringRestore;
    String? savedDuringRestore;
    try {
      // Re-seating a signed-in machine restores through the same path while
      // the workspace is already authenticated. The boot status is no fence.
      await app.superTabs.refreshTabs();
      discoveredDuringRestore = app.swarms.where((s) => s.isSuperTab).toList();
      savedDuringRestore = store.values['swarm_layout_v1'];
    } finally {
      store.holdLayout = false;
      store.releaseLayout.complete();
      await restoring;
    }
    expect(app.swarms.map((s) => s.id), ['work', 'notes']);
    expect(app.activeSwarmId, 'notes');
    expect(app.allPanes.map((p) => p.agentId), ['a0', 'a1']);
    expect(discoveredDuringRestore, isEmpty);
    expect(savedDuringRestore, saved);
    await app.superTabs.refreshTabs();
    expect(app.swarms.map((s) => s.name), ['Existing work', 'Notes', 'Pilot']);
    expect(app.activeSwarmId, 'notes');
  });

  test(
    'two computers discover the same tab without navigation or a local copy',
    () async {
      final catalog = _Catalog();
      final first = _computer(catalog, MemoryStore());
      final second = _computer(catalog, MemoryStore());
      final firstFocus = first.activeSwarmId,
          secondFocus = second.activeSwarmId;
      await Future.wait([
        first.superTabs.refreshTabs(),
        second.superTabs.refreshTabs(),
      ]);
      for (final app in [first, second]) {
        expect(
          app.swarms.where((s) => s.isSuperTab).single.superTabId,
          catalog.tabs.single['id'],
        );
        expect(app.allPanes, isEmpty);
      }
      expect(first.activeSwarmId, firstFocus);
      expect(second.activeSwarmId, secondFocus);
      catalog.tabs.single['name'] = 'Research';
      catalog.tabs.add({'id': '1123456789abcdef01234567', 'name': 'Build'});
      await second.superTabs.refreshTabs();
      expect(second.swarms.where((s) => s.isSuperTab).map((s) => s.name), [
        'Research',
        'Build',
      ]);
      await second.superTabs.refreshTabs();
      expect(second.swarms.where((s) => s.isSuperTab), hasLength(2));
    },
  );

  test('closing hides only this computer and survives restart until explicitly opened', () async {
    final catalog = _Catalog();
    final store = MemoryStore();
    final first = _computer(catalog, store);
    final other = _computer(catalog, MemoryStore());
    await first.superTabs.refreshTabs();
    final tab = first.swarms.singleWhere((s) => s.isSuperTab);
    await _close(first, tab);
    expect(first.superTabs.hiddenIds, {tab.superTabId});
    await first.superTabs.refreshTabs();
    await other.superTabs.refreshTabs();
    expect(first.swarms.where((s) => s.isSuperTab), isEmpty);
    expect(other.swarms.where((s) => s.isSuperTab), hasLength(1));
    final restarted = _computer(catalog, store);
    await restarted.superTabs.refreshTabs();
    expect(restarted.swarms.where((s) => s.isSuperTab), isEmpty);
    restarted.openSuperTab(tab.superTabId!, 'Pilot');
    await restarted.superTabs.setTabVisible(tab.superTabId!, true);
    await restarted.superTabs.refreshTabs();
    expect(restarted.swarms.where((s) => s.isSuperTab), hasLength(1));
    expect(restarted.activeSwarm.superTabId, tab.superTabId);
  });

  test(
    'a hidden Swarm is listed after a restart and opening it shows it',
    () async {
      final catalog = _Catalog();
      final store = MemoryStore();
      final first = _computer(catalog, store);
      await first.superTabs.refreshTabs();
      expect(first.closedSuperTabs, isEmpty);
      final tab = first.swarms.singleWhere((s) => s.isSuperTab);
      await _close(first, tab);
      final restarted = _computer(catalog, store);
      // Before discovery the app cannot tell which hidden tabs are still ours.
      expect(restarted.closedSuperTabs, isEmpty);
      await restarted.superTabs.refreshTabs();
      expect(restarted.closedSuperTabs.map((t) => (t.id, t.name)), [
        (tab.superTabId, 'Pilot'),
      ]);
      restarted.openSuperTab(tab.superTabId!, 'Pilot');
      expect(restarted.closedSuperTabs, isEmpty);
      expect(restarted.activeSwarm.superTabId, tab.superTabId);
    },
  );

  test('a hidden Swarm the person left is not offered', () async {
    final catalog = _Catalog();
    final app = _computer(catalog, MemoryStore());
    await app.superTabs.setTabVisible('0123456789abcdef01234567', false);
    catalog.tabs.clear();
    await app.superTabs.refreshTabs();
    expect(app.closedSuperTabs, isEmpty);
  });

  testWidgets('closing a Swarm offers Reopen and Reopen shows it again', (
    tester,
  ) async {
    final catalog = _Catalog();
    final app = _computer(catalog, MemoryStore());
    await mount(tester, app);
    await app.superTabs.refreshTabs();
    await tester.pump();
    final tab = app.swarms.singleWhere((s) => s.isSuperTab);
    await app.requestCloseSwarm(tab.id);
    await tester.pump();
    expect(find.text('Swarm closed. Its agents keep running.'), findsOneWidget);
    expect(app.swarms.where((s) => s.isSuperTab), isEmpty);
    await tester.pump(const Duration(milliseconds: 400));
    await tester.tap(find.text('Reopen'));
    await tester.pump();
    expect(
      app.swarms.where((s) => s.superTabId == tab.superTabId),
      hasLength(1),
    );
    expect(app.closedSuperTabs, isEmpty);
    expect(app.superTabs.hiddenIds, isEmpty);
    await tester.pumpAndSettle();
    await tester.pumpWidget(const SizedBox.shrink());
    app.superTabs.dispose();
    await tester.pump();
  });

  testWidgets('the command palette brings a closed Swarm back by name', (
    tester,
  ) async {
    final catalog = _Catalog();
    final store = MemoryStore();
    final first = _computer(catalog, store);
    await first.superTabs.refreshTabs();
    final tab = first.swarms.singleWhere((s) => s.isSuperTab);
    await _close(first, tab);
    final app = _computer(catalog, store);
    await mount(tester, app);
    await app.superTabs.refreshTabs();
    await tester.pump();
    await openHarnessPicker(tester);
    await tester.enterText(
      find.byKey(const ValueKey('swarm-search-input')),
      '>Pilot',
    );
    await tester.pumpAndSettle();
    expect(find.text('Recent Swarms'), findsWidgets);
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    expect(app.activeSwarm.superTabId, tab.superTabId);
    expect(app.closedSuperTabs, isEmpty);
    await tester.pumpWidget(const SizedBox.shrink());
    app.superTabs.dispose();
    await tester.pump();
  });

  testWidgets('the New Tab page shows a closed Swarm after a restart', (
    tester,
  ) async {
    final catalog = _Catalog();
    final store = MemoryStore();
    final first = _computer(catalog, store);
    await first.superTabs.refreshTabs();
    final tab = first.swarms.singleWhere((s) => s.isSuperTab);
    await _close(first, tab);
    final app = _computer(catalog, store)..newSwarm(newTabPage: true);
    await mount(tester, app);
    expect(find.text('Recent Swarms'), findsNothing);
    await app.superTabs.refreshTabs();
    await tester.pump();
    expect(find.text('Recent Swarms'), findsOneWidget);
    await tester.tap(
      find.byKey(ValueKey('welcome-closed-super-tab-${tab.superTabId}')),
    );
    await tester.pumpAndSettle();
    expect(app.activeSwarm.superTabId, tab.superTabId);
    expect(app.closedSuperTabs, isEmpty);
    await tester.pumpWidget(const SizedBox.shrink());
    app.superTabs.dispose();
    await tester.pump();
  });

  testWidgets('the notice goes after about eight seconds', (tester) async {
    final app = _computer(_Catalog(), MemoryStore());
    await mount(tester, app);
    await app.superTabs.refreshTabs();
    await tester.pump();
    await app.closeSwarm(app.swarms.singleWhere((s) => s.isSuperTab).id);
    await tester.pump();
    // The countdown starts once the notice has slid in.
    await tester.pump(const Duration(milliseconds: 400));
    await tester.pump(const Duration(seconds: 7));
    expect(find.text('Reopen'), findsOneWidget);
    await tester.pump(const Duration(seconds: 2));
    await tester.pumpAndSettle();
    expect(find.text('Reopen'), findsNothing);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('closing an ordinary tab shows no Swarm notice', (tester) async {
    final app = _computer(_Catalog(), MemoryStore());
    await mount(tester, app);
    await app.superTabs.refreshTabs();
    app.newSwarm();
    app.newSwarm();
    final ordinary = app.swarms.where((s) => !s.isSuperTab).last;
    app.renameSwarm(ordinary.id, 'Scratch');
    final before = app.swarms.length;
    await app.requestCloseSwarm(ordinary.id);
    await tester.pump();
    expect(app.swarms.length, before - 1);
    expect(app.closedHistory, hasLength(1));
    expect(find.byType(SnackBar), findsNothing);
    await tester.pumpWidget(const SizedBox.shrink());
    app.superTabs.dispose();
    await tester.pump();
  });

  test(
    'opening a closed Swarm twice, from any entry, keeps one view',
    () async {
      final catalog = _Catalog();
      final app = _computer(catalog, MemoryStore());
      await app.superTabs.refreshTabs();
      final tab = app.swarms.singleWhere((s) => s.isSuperTab);
      final id = tab.superTabId!;
      await _close(app, tab);
      final historyId = app.closedHistory.single.historyId;
      // List first, then Reopen on the notice.
      expect(app.openClosedSuperTab(id), isTrue);
      app.reopenClosedSwarm(historyId: historyId);
      expect(app.swarms.where((s) => s.superTabId == id), hasLength(1));
      expect(app.closedHistory, isEmpty);
      // Reopen first, then the list or Settings.
      await _close(app, app.swarms.singleWhere((s) => s.superTabId == id));
      app.reopenClosedSwarm();
      app.openSuperTab(id, 'Pilot');
      expect(app.openClosedSuperTab(id), isFalse);
      expect(app.swarms.where((s) => s.superTabId == id), hasLength(1));
      expect(app.activeSwarm.superTabId, id);
    },
  );

  test(
    'a closed Swarm opens in the empty New Tab it was chosen from',
    () async {
      final catalog = _Catalog();
      final app = _computer(catalog, MemoryStore());
      await app.superTabs.refreshTabs();
      final tab = app.swarms.singleWhere((s) => s.isSuperTab);
      await _close(app, tab);
      app.newSwarm(newTabPage: true);
      final page = app.activeSwarm;
      final count = app.swarms.length;
      expect(
        app.openClosedSuperTab(tab.superTabId!, intoSwarmId: page.id),
        isTrue,
      );
      expect(app.swarms, hasLength(count));
      expect(page.superTabId, tab.superTabId);
      expect(page.isNewTabPage, isFalse);
      expect(app.activeSwarm, same(page));
    },
  );

  test(
    'a tab the person has left is not offered after an account switch',
    () async {
      final catalog = _Catalog();
      final store = MemoryStore();
      final app = _computer(catalog, store);
      await app.superTabs.refreshTabs();
      final tab = app.swarms.singleWhere((s) => s.isSuperTab);
      await _close(app, tab);
      expect(app.closedSuperTabs, hasLength(1));
      store.values['super_tab.hidden.other'] = '["${tab.superTabId}"]';
      catalog.fail = '/api/super-tabs';
      app.currentUser = const CurrentUserProfile(
        id: 'other',
        email: 'other@example.invalid',
      );
      await app.superTabs.refreshTabs();
      expect(app.superTabs.hiddenIds, {tab.superTabId});
      expect(app.closedSuperTabs, isEmpty);
    },
  );

  Future<(AppNotifier, List<Swarm>)> threeTabs(WidgetTester tester) async {
    final catalog = _Catalog()
      ..tabs.addAll([
        {'id': '1123456789abcdef01234567', 'name': 'Build'},
        {'id': '2123456789abcdef01234567', 'name': 'Ship'},
      ]);
    final app = _computer(catalog, MemoryStore());
    await mount(tester, app);
    await app.superTabs.refreshTabs();
    await tester.pump();
    return (app, app.swarms.where((s) => s.isSuperTab).toList());
  }

  Future<void> finishTest(WidgetTester tester, AppNotifier app) async {
    await tester.pumpAndSettle(const Duration(seconds: 10));
    await tester.pumpWidget(const SizedBox.shrink());
    app.superTabs.dispose();
    await tester.pump();
  }

  final closedNotice = find.text('Swarm closed. Its agents keep running.');

  testWidgets('two closes in the same frame leave one notice for the last', (
    tester,
  ) async {
    final (app, tabs) = await threeTabs(tester);
    await app.requestCloseSwarm(tabs[0].id);
    await app.requestCloseSwarm(tabs[1].id);
    for (var i = 0; i < 6; i++) {
      await tester.pump(const Duration(milliseconds: 300));
      expect(closedNotice.evaluate(), hasLength(lessThanOrEqualTo(1)));
    }
    expect(tester.takeException(), isNull);
    expect(closedNotice, findsOneWidget);
    await tester.tap(find.text('Reopen'));
    await tester.pump();
    expect(
      app.swarms.where((s) => s.isSuperTab).map((s) => s.name),
      contains(tabs[1].name),
    );
    expect(
      app.swarms.where((s) => s.isSuperTab).map((s) => s.name),
      isNot(contains(tabs[0].name)),
    );
    await finishTest(tester, app);
  });

  testWidgets(
    'closing three Swarms 20 ms apart leaves one notice for the last',
    (tester) async {
      final (app, tabs) = await threeTabs(tester);
      for (final tab in tabs) {
        await app.requestCloseSwarm(tab.id);
        await tester.pump(const Duration(milliseconds: 20));
      }
      for (var i = 0; i < 12; i++) {
        await tester.pump(const Duration(milliseconds: 300));
        expect(closedNotice.evaluate(), hasLength(lessThanOrEqualTo(1)));
      }
      expect(tester.takeException(), isNull);
      expect(find.text('Reopen'), findsOneWidget);
      await tester.tap(find.text('Reopen'));
      await tester.pump();
      expect(app.swarms.where((s) => s.isSuperTab).map((s) => s.name), [
        tabs.last.name,
      ]);
      await finishTest(tester, app);
    },
  );

  testWidgets(
    'a close behind an unrelated notice leaves it and then shows ours',
    (tester) async {
      final (app, tabs) = await threeTabs(tester);
      ScaffoldMessenger.of(tester.element(find.byType(SwarmScreen)))
          .showSnackBar(
            const SnackBar(content: Text('Something else'), persist: false),
          );
      await tester.pump(const Duration(milliseconds: 400));
      await app.requestCloseSwarm(tabs[0].id);
      await app.requestCloseSwarm(tabs[1].id);
      await tester.pump(const Duration(milliseconds: 400));
      expect(find.text('Something else'), findsOneWidget);
      expect(closedNotice, findsNothing);
      // The unrelated one runs its 4 s; ours follows, once.
      await tester.pump(const Duration(seconds: 4));
      await tester.pump(const Duration(seconds: 1));
      await tester.pump(const Duration(milliseconds: 400));
      expect(find.text('Something else'), findsNothing);
      expect(closedNotice, findsOneWidget);
      expect(tester.takeException(), isNull);
      await finishTest(tester, app);
    },
  );

  testWidgets('a close after the notice timed out shows a fresh one', (
    tester,
  ) async {
    final (app, tabs) = await threeTabs(tester);
    await app.requestCloseSwarm(tabs[0].id);
    await tester.pump();
    // The countdown starts once the notice has slid in.
    await tester.pump(const Duration(milliseconds: 400));
    await tester.pump(const Duration(seconds: 8));
    await tester.pump(const Duration(seconds: 1));
    await tester.pumpAndSettle();
    expect(closedNotice, findsNothing);
    await app.requestCloseSwarm(tabs[1].id);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(closedNotice, findsOneWidget);
    await tester.pump(const Duration(seconds: 7));
    expect(closedNotice, findsOneWidget);
    await finishTest(tester, app);
  });

  test('setting the same account again keeps the saved names', () async {
    final app = _computer(_Catalog(), MemoryStore());
    await app.superTabs.refreshTabs();
    await _close(app, app.swarms.singleWhere((s) => s.isSuperTab));
    expect(app.closedSuperTabs, hasLength(1));
    app.currentUser = const CurrentUserProfile(
      id: 'owner',
      email: 'owner@example.invalid',
    );
    expect(app.closedSuperTabs, hasLength(1));
  });

  test(
    'a discovery reply racing lead creation cannot duplicate the finished tab',
    () async {
      final catalog = _Catalog();
      final app = _computer(catalog, MemoryStore());
      final draft = app.activeSwarm;
      app.markSuperTabDraft(draft.id);
      await app.superTabs.refreshTabs();
      app.bindSuperTab(draft.id, catalog.tabs.single['id'] as String, 'Pilot');
      await app.superTabs.refreshTabs();
      expect(app.swarms.where((s) => s.isSuperTab), [draft]);
      expect(app.activeSwarm, same(draft));
    },
  );

  test(
    'a failed later page applies nothing and a retry discovers all pages',
    () async {
      final catalog = _Catalog()
        ..tabs.add({'id': '1123456789abcdef01234567', 'name': 'Build'})
        ..fail = '/api/super-tabs?after=0123456789abcdef01234567';
      final app = _computer(catalog, MemoryStore());
      await app.superTabs.refreshTabs();
      expect(app.swarms.where((s) => s.isSuperTab), isEmpty);
      expect(app.superTabs.discoveryError, isNotNull);
      catalog.fail = null;
      await app.superTabs.refreshTabs();
      expect(app.swarms.where((s) => s.isSuperTab), hasLength(2));
      expect(app.superTabs.discoveryError, isNull);
    },
  );

  test(
    'an old account response cannot add its tabs after switching accounts',
    () async {
      final hold = Completer<void>();
      final catalog = _Catalog()..hold = hold;
      final seen = <List<SuperTabListing>>[];
      final client = SuperTabClient(
        storage: MemoryStore(),
        transport: catalog.request,
        discoveryInterval: Duration.zero,
        onTabs: (rows, _) => seen.add(rows),
      );
      addTearDown(client.dispose);
      client.bind('first');
      final old = client.refreshTabs();
      await Future<void>.delayed(Duration.zero);
      expect(catalog.paths, hasLength(1));
      client.bind('second');
      catalog.hold = null;
      catalog.tabs[0] = {'id': 'second-tab', 'name': 'Second account'};
      await client.refreshTabs();
      hold.complete();
      await old;
      expect(seen, hasLength(1));
      expect(seen.single.single.id, 'second-tab');
    },
  );

  test(
    'hiding during a pending response wins and does not affect another account',
    () async {
      final catalog = _Catalog();
      final hiddenSnapshots = <Set<String>>[];
      final client = SuperTabClient(
        storage: MemoryStore(),
        transport: catalog.request,
        discoveryInterval: Duration.zero,
        onTabs: (_, hidden) => hiddenSnapshots.add(hidden),
      );
      addTearDown(client.dispose);
      client.bind('first');
      final hold = catalog.hold = Completer<void>();
      final reading = client.refreshTabs();
      await client.setTabVisible('0123456789abcdef01234567', false);
      hold.complete();
      await reading;
      expect(hiddenSnapshots.single, {'0123456789abcdef01234567'});
      client.bind('second');
      await client.refreshTabs();
      expect(hiddenSnapshots.last, isEmpty);
    },
  );

  testWidgets('sign-in discovers tabs and retries while the app stays open', (
    tester,
  ) async {
    final catalog = _Catalog()..fail = '/api/super-tabs';
    final seen = <List<SuperTabListing>>[];
    final client = SuperTabClient(
      storage: MemoryStore(),
      transport: catalog.request,
      discoveryInterval: const Duration(seconds: 15),
      onTabs: (rows, _) => seen.add(rows),
    );
    addTearDown(client.dispose);
    client.bind('owner');
    await tester.pump();
    expect(client.discoveryError, isA<StateError>());
    catalog.fail = null;
    await tester.pump(const Duration(seconds: 15));
    await tester.pump();
    expect(catalog.paths, hasLength(2));
    expect(client.discoveryError, isNull);
    expect(seen.single.single.name, 'Pilot');
    client.dispose();
    final count = catalog.paths.length;
    await tester.pump(const Duration(seconds: 30));
    expect(catalog.paths, hasLength(count));
  });

  test(
    'lead creation defers its own discovery until bound to the form tab',
    () async {
      final catalog = _Catalog();
      final app = _computer(catalog, MemoryStore());
      final id = catalog.tabs.single['id'] as String;
      app.superTabs.deferTabDiscovery(id);
      await app.superTabs.refreshTabs();
      expect(app.swarms.where((s) => s.isSuperTab), isEmpty);
      app.bindSuperTab(app.activeSwarmId, id, 'Pilot');
      await app.superTabs.refreshTabs();
      expect(app.swarms.where((s) => s.isSuperTab), hasLength(1));
    },
  );
}
