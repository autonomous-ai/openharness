import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/pane_layout_store.dart';
import 'package:harness/state/swarm.dart';
import 'package:harness/super_tabs/client.dart';
import 'package:harness/ws/ws_conn.dart';

import 'swarm_state_test.dart' show MemoryStore, createApp;
import 'swarm_screen_test.dart' show mount;
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

AppNotifier _computer(_Catalog catalog, MemoryStore store) {
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
  addTearDown(app.dispose);
  return app;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

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
    await first.closeSwarm(tab.id);
    // Flush the same visibility intent before simulating a process restart.
    await first.superTabs.setTabVisible(tab.superTabId!, false);
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
