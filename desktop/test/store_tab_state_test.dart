// The store's side of the app model: the Harness Store is one tab — it takes
// over an empty New Tab, is selected rather than duplicated, has no tab limit,
// and survives a restart as the store (layouts from before the kind was saved
// included). And the two requests its buttons send a machine, `dsh_install`
// and `dsh_remove`, with every way a machine can say no turned into a sentence.
// Last, the Store page uses the local daemon only, even with older and
// relayed machines connected beside it.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/pane_layout_store.dart';
import 'package:harness/state/swarm.dart';
import 'package:harness/state/terminal_pane.dart';
import 'package:harness/store/store_controller.dart';
import 'package:harness/store/store_models.dart';
import 'package:harness/store/store_screen.dart';
import 'package:harness/ws/ws_conn.dart';

import 'swarm_state_test.dart' show MemoryStore, createApp;

/// One machine's daemon, answering by request type.
class _Daemon extends WsConn {
  _Daemon(String machineId)
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: machineId,
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );

  final requests = <(String, Map<String, dynamic>)>[];
  Future<Map<String, dynamic>> Function(
    String type,
    Map<String, dynamic> payload,
  )
  answer = (_, _) async => {};

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) {
    requests.add((type, Map.of(payload)));
    return answer(type, payload);
  }
}

Future<Map<String, dynamic>> _refuse(String code, [String? detail]) =>
    Future.error(
      WsRequestFailure(responseType: 'x', code: code, detail: detail),
    );

const _typst = {
  'id': 'autonomous/typst',
  'name': 'Typst',
  'engine': 'claude',
  'category': 'Documents',
};

void main() {
  group('openStore', () {
    test('from a tab with work, the store gets a tab of its own, then is selected rather than repeated', () async {
      final storage = MemoryStore();
      final app = createApp(store: storage);
      addTearDown(app.dispose);
      await app.addAgentToSwarm('m', 'a0');
      final work = app.activeSwarm;
      app.openStore();
      final store = app.activeSwarm;
      expect(store, isNot(same(work)));
      expect(store.isStore, isTrue);
      expect(store.name, Swarm.storeName);
      expect(app.swarms, [work, store]);

      app.selectSwarm(work.id);
      app.openStore();
      expect(app.activeSwarm, same(store));
      expect(app.swarms, hasLength(2));

      await app.flushPaneLayout();
      final saved = await PaneLayoutStore(storage: storage).loadSwarms();
      final rows = (saved!['swarms'] as List).cast<Map>();
      expect(rows.map((row) => row['kind']), [null, 'store']);
    });

    test(
      'a draft New Tab the store takes over is kept when you leave it',
      () async {
        final app = createApp();
        addTearDown(app.dispose);
        await app.addAgentToSwarm('m', 'a0');
        final work = app.activeSwarm;
        app.newSwarm(draft: true);
        final draft = app.activeSwarm;
        expect(app.isDraftSwarm(draft.id), isTrue);
        app.openStore();
        expect(app.activeSwarm, same(draft));
        expect(draft.isStore, isTrue);
        expect(app.isDraftSwarm(draft.id), isFalse);
        app.selectSwarm(work.id);
        expect(
          app.swarms,
          contains(draft),
          reason: 'the store is not an abandoned draft',
        );
      },
    );

    test(
      'there is no tab limit, and a new store tab never reuses an id',
      () async {
        final app = createApp();
        addTearDown(app.dispose);
        await app.addAgentToSwarm('m', 'a0');
        for (var i = 0; i < 40; i++) {
          app.newSwarm(name: 'Project $i');
        }
        // A tab that arrived holding the next id in line.
        final next = int.parse(app.activeSwarmId.split('-').last) + 1;
        app.swarms.add(Swarm(id: 'swarm-$next', name: 'Arrived'));
        app.openStore();
        expect(app.swarms, hasLength(43));
        expect(app.activeSwarm.isStore, isTrue);
        expect(app.activeSwarmId, 'swarm-${next + 1}');
        expect(app.swarms.map((swarm) => swarm.id).toSet(), hasLength(43));
      },
    );
  });

  group('restoring the store tab', () {
    Future<AppNotifier> restore(List<Swarm> saved, String activeId) async {
      final storage = MemoryStore();
      await PaneLayoutStore(storage: storage).saveSwarms(saved, activeId);
      final app = createApp(store: storage);
      addTearDown(app.dispose);
      await app.restorePaneLayoutForTest();
      return app;
    }

    test('one store tab comes back, by kind or by an older layout\'s empty store name', () async {
      final app = await restore([
        Swarm(id: 'store', name: Swarm.storeName, kind: 'store'),
        Swarm(id: 'work', name: 'Work')
          ..panes.add(TerminalPane(id: 1, machineId: 'm', agentId: 'a0')),
        // An older build's second store tab, saved before the kind was.
        Swarm(id: 'legacy', name: Swarm.storeName),
        // A tab someone named after the store, with work in it, is theirs.
        Swarm(id: 'named', name: Swarm.storeName)
          ..panes.add(TerminalPane(id: 2, machineId: 'm', agentId: 'a1')),
      ], 'work');
      expect(app.swarms.map((swarm) => swarm.id), ['store', 'work', 'named']);
      expect(app.swarms.map((swarm) => swarm.isStore), [true, false, false]);
      expect(app.activeSwarmId, 'work');
    });

    test('a layout saved before the kind was written restores its store as the store', () async {
      final app = await restore([
        Swarm(id: 'work', name: 'Work')
          ..panes.add(TerminalPane(id: 1, machineId: 'm', agentId: 'a0')),
        Swarm(id: 'legacy', name: Swarm.storeName),
      ], 'legacy');
      expect(app.activeSwarm.id, 'legacy');
      expect(app.activeSwarm.isStore, isTrue);
      app.openStore();
      expect(
        app.swarms,
        hasLength(2),
        reason: 'the restored store is the store',
      );
    });
  });

  group('removeDsh', () {
    Future<(AppNotifier, _Daemon)> machine() async {
      final daemon = _Daemon('m');
      final app = createApp(connectionForTest: (_) => daemon);
      addTearDown(app.dispose);
      return (app, daemon);
    }

    test('a removal asks the machine, then asks its catalog again', () async {
      final (app, daemon) = await machine();
      daemon.answer = (type, _) async => switch (type) {
        'dsh_remove' => {'ok': true},
        _ => {
          'dsh': [_typst],
        },
      };
      expect(await app.removeDsh('m', 'autonomous/typst'), isNull);
      expect(daemon.requests.map((r) => r.$1), ['dsh_remove', 'dsh_list']);
      expect(daemon.requests.first.$2, {'id': 'autonomous/typst'});
      expect(app.stateOf('m')!.dsh['autonomous/typst'], isNotNull);
      expect(
        await app.removeDsh('nowhere', 'autonomous/typst'),
        'Machine not found',
      );
    });

    test(
      'every refusal is a sentence naming the machine, and nothing is re-asked',
      () async {
        final (app, daemon) = await machine();
        Future<String?> answered(
          Future<Map<String, dynamic>> Function() answer,
        ) {
          daemon.requests.clear();
          daemon.answer = (_, _) => answer();
          return app.removeDsh('m', 'autonomous/typst');
        }

        expect(
          await answered(
            () async => {'ok': false, 'detail': 'An agent is using it'},
          ),
          'An agent is using it',
        );
        expect(
          await answered(() async => {'ok': false, 'detail': ''}),
          'Remove failed on Test host',
        );
        expect(await answered(() async => {}), 'Remove failed on Test host');
        for (final code in ['UNSUPPORTED', 'UNSUPPORTED_ON_REMOTE']) {
          expect(
            await answered(() => _refuse(code)),
            'Update the harness CLI on Test host to remove harnesses',
            reason: code,
          );
        }
        expect(
          await answered(() => _refuse('DSH_BUSY', 'Close its agents first')),
          'Close its agents first',
        );
        expect(
          await answered(() => _refuse('DSH_BUSY', '')),
          'Remove failed on Test host (DSH_BUSY)',
        );
        expect(
          await answered(
            () => Future.error(const WsRequestTimeout('dsh_remove')),
          ),
          'Test host did not answer. Try again.',
        );
        expect(
          await answered(() => Future.error(StateError('socket closed'))),
          'Remove failed on Test host',
        );
        expect(daemon.requests.map((r) => r.$1), ['dsh_remove']);
      },
    );
  });

  group('installDsh', () {
    test(
      'every refusal fails the run with a sentence, and a retry is its own run',
      () async {
        final daemon = _Daemon('m');
        final app = createApp(connectionForTest: (_) => daemon);
        addTearDown(app.dispose);
        final catalog = app.stateOf('m')!.dsh;
        Future<String?> answered(
          Future<Map<String, dynamic>> Function() answer,
        ) {
          daemon.answer = (_, _) => answer();
          return app.installDsh('m', 'autonomous/typst');
        }

        final pending = Completer<Map<String, dynamic>>();
        final first = answered(() => pending.future);
        final run = catalog.runs['autonomous/typst']!;
        expect(run.inProgress, isTrue);
        pending.complete({'ok': false, 'detail': 'kicad-cli not found'});
        expect(await first, 'kicad-cli not found');
        expect(run.failed, isTrue);
        expect(run.detail, 'kicad-cli not found');

        expect(
          await answered(() async => {'ok': false}),
          'Install failed on Test host',
        );
        expect(
          identical(catalog.runs['autonomous/typst'], run),
          isFalse,
          reason: 'Try again starts a new run with its own clock',
        );
        expect(
          await answered(() => _refuse('UNSUPPORTED_ON_REMOTE')),
          'Update the harness CLI on Test host to install harnesses',
        );
        expect(
          await answered(() => _refuse('DOCTOR_FAILED', 'miss typst-cli')),
          'miss typst-cli',
        );
        expect(
          await answered(() => _refuse('DOCTOR_FAILED')),
          'Install failed on Test host (DOCTOR_FAILED)',
        );
        expect(
          await answered(
            () => Future.error(const WsRequestTimeout('dsh_install')),
          ),
          'Test host is still installing. Try again in a few minutes.',
        );
        expect(
          await answered(() => Future.error(StateError('socket closed'))),
          'Install failed on Test host',
        );
        expect(catalog.installs['autonomous/typst']!.failed, isTrue);
        expect(
          await app.installDsh('nowhere', 'autonomous/typst'),
          'Machine not found',
        );
        expect(daemon.requests.map((r) => r.$1).toSet(), {'dsh_install'});
      },
    );
  });

  testWidgets('Store Get, New Harness and Remove use the local daemon', (
    tester,
  ) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(1280, 1600);
    addTearDown(tester.view.reset);

    final installed = <String>{};
    final local = _Daemon('local')
      ..answer = (type, payload) async => switch (type) {
        'engines_probe' => {'engines': <Object>[]},
        'dsh_install' => (() {
          installed.add(payload['id'] as String);
          return {'ok': true};
        })(),
        'dsh_remove' => {'ok': installed.remove(payload['id'])},
        _ => {
          'dsh': [
            {..._typst, 'installed': installed.contains(_typst['id'])},
          ],
        },
      };
    final older = _Daemon('older')..answer = (_, _) => _refuse('UNSUPPORTED');
    final relay = _Daemon('relay')
      ..answer = (type, _) => switch (type) {
        'dsh_install' => _refuse('UNSUPPORTED_ON_REMOTE'),
        'engines_probe' => Future.value({'engines': <Object>[]}),
        _ => Future.value({
          'dsh': [_typst],
        }),
      };
    final daemons = {'local': local, 'older': older, 'relay': relay};
    final app = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
      connectionForTest: (id) => daemons[id]!,
    );
    addTearDown(app.dispose);
    for (final (id, name) in [
      ('local', 'studio-mac'),
      ('older', 'old-box'),
      ('relay', 'relay-box'),
    ]) {
      final machine = Machine(
        machineId: id,
        authMode: MachineAuthMode.remote,
        name: name,
      );
      app.machineStates[id] = MachineState(machine)
        ..localOnly = id == 'local'
        ..nodeOnline = true;
    }
    app.openStore();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: StoreTab(
            notifier: app,
            api: _NoRatings(),
            initialHarness: 'autonomous/typst',
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    Finder row(String id) => find.byKey(ValueKey('store-machine:$id'));
    Finder says(String id, String text) =>
        find.descendant(of: row(id), matching: find.text(text));

    expect(says('local', 'Not installed'), findsOneWidget);
    expect(row('older'), findsNothing);
    expect(row('relay'), findsNothing);
    expect(older.requests, isEmpty);
    expect(relay.requests, isEmpty);

    await tester.tap(find.byKey(const ValueKey('store-primary-action')));
    await tester.pumpAndSettle();
    expect(installed, {'autonomous/typst'});
    expect(says('local', 'Installed'), findsOneWidget);
    expect(
      find.descendant(
        of: find.byKey(const ValueKey('store-primary-action')),
        matching: find.text('New Harness'),
      ),
      findsOneWidget,
    );

    await tester.tap(find.byKey(const ValueKey('store-remove:local')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('store-confirm')));
    await tester.pumpAndSettle();
    expect(installed, isEmpty);
    expect(says('local', 'Not installed'), findsOneWidget);
    expect(local.requests.map((r) => r.$1).where((t) => t != 'engines_probe'), [
      'dsh_list',
      'dsh_install',
      'dsh_list',
      'dsh_remove',
      'dsh_list',
    ]);

    expect(older.requests, isEmpty);
    expect(relay.requests, isEmpty);
    expect(tester.takeException(), isNull);
  });
}

class _NoRatings implements StoreApi {
  @override
  Future<List<StoreRating>> ratings() async => const [];
  @override
  Future<StoreReviews> reviews(String harnessId) async => StoreReviews(
    rating: StoreRating.none(harnessId),
    reviews: const [],
    mine: null,
  );
  @override
  Future<StoreReview> putReview(
    String harnessId, {
    required int rating,
    String? title,
    String? body,
  }) => throw UnimplementedError();
  @override
  Future<void> deleteReview(String harnessId) async {}
}
