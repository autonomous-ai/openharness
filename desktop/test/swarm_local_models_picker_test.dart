import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/models/model_search_catalog.dart';
import 'package:harness/models/swarm_models_target.dart';
import 'package:harness/state/swarm_navigation.dart';
import 'package:harness/state/swarm_search.dart';
import 'package:harness/usage/models_menu_controller.dart';
import 'package:harness/ws/ws_conn.dart';

import 'support/model_manager.dart';

const _grid = 'swarm-0123456789ab';

class _Subscriptions extends ModelsMenuController {
  @override
  List<Map<String, Object?>> get rows => const [
    {'engine': 'codex', 'title': 'OpenAI'},
  ];
}

/// The test app, answering the Swarm's API share requests as the CLI would.
class _SwarmApp extends ModelManagerTestApp {
  _SwarmApp() : super(ModelManagerConnection());
  final shareCalls = <({String connectionId, String model, bool start})>[];
  final shareGrids = <String>[];
  final shared = <({String connectionId, String model})>{};
  String? shareError;
  bool sharesFail = false;

  @override
  Future<Map<String, dynamic>> swarmApiShares(
    String machineId,
    String grid,
  ) async {
    if (sharesFail) throw StateError('offline');
    return {
      'shares': [
        for (final s in shared)
          {'grid': grid, 'connectionId': s.connectionId, 'model': s.model},
        {'grid': grid, 'model': 7},
      ],
    };
  }

  final offered = <({String sharedGrid, String model})>{};

  @override
  Future<Map<String, dynamic>> swarmOffers(
    String machineId,
    String grid,
  ) async => {
    'offers': [
      for (final o in offered)
        {'grid': grid, 'sharedGrid': o.sharedGrid, 'model': o.model},
    ],
  };

  @override
  Future<Map<String, dynamic>> swarmOffer(
    String machineId, {
    required String grid,
    required String sharedGrid,
    required String model,
    required bool start,
  }) async {
    final key = (sharedGrid: sharedGrid, model: model);
    start ? offered.add(key) : offered.remove(key);
    return {'offers': <Object>[]};
  }

  @override
  Future<Map<String, dynamic>> swarmApiShare(
    String machineId, {
    required String grid,
    required String connectionId,
    required String model,
    required bool start,
  }) async {
    shareCalls.add((connectionId: connectionId, model: model, start: start));
    shareGrids.add(grid);
    if (shareError != null) return {'error': shareError};
    final key = (connectionId: connectionId, model: model);
    start ? shared.add(key) : shared.remove(key);
    return {'ok': true};
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late _SwarmApp app;
  late ModelsMenuController subscriptions;
  late ModelSearchCatalog catalog;
  late SwarmModelsTarget target;
  late SwarmSearchController search;

  setUp(() async {
    app = _SwarmApp();
    app.localInventory = {
      'supportsDownload': true,
      'models': [
        {
          'id': 'downloaded',
          'name': 'Downloaded model',
          'state': 'downloaded',
          'canStart': true,
        },
        {
          'id': 'served',
          'name': 'Served model',
          'state': 'downloaded',
          'canStart': false,
          'canStop': false,
          'servedOn': [
            {
              'grid': _grid,
              'servedAs': ['served'],
            },
          ],
        },
        {
          'id': 'catalog',
          'name': 'Catalog model',
          'state': 'available',
          'canStart': true,
        },
        {
          'id': 'tiny',
          'name': 'llama3.2:3b',
          'state': 'downloaded',
          'canStart': true,
        },
        {
          'id': 'tiny-get',
          'name': 'qwen3:4b',
          'state': 'available',
          'canStart': true,
        },
      ],
    };
    subscriptions = _Subscriptions();
    catalog = ModelSearchCatalog(
      app.modelManager,
      subscriptions,
      pollHosts: false,
    );
    target = SwarmModelsTarget(app: app, grid: _grid, machineId: 'm');
    search = SwarmSearchController(
      app,
      const [],
      models: catalog,
      swarmModels: target,
    )..setQuery(':');
    await catalog.refresh();
  });
  tearDown(() {
    search.dispose();
    target.dispose();
    catalog.dispose();
    subscriptions.dispose();
    app.dispose();
  });

  SwarmDestination row(String modelId) =>
      search.rows.firstWhere((r) => r.modelId == 'model:local:$modelId');

  test('hides models shared with you for now, keeping their offer and what the Swarm\'s own grid serves apart', () async {
    app.inventory = const GridModels(
      gridName: 'home',
      models: [],
      grids: [
        GridSection(
          name: 'Team',
          own: false,
          models: [GridModel(id: 'Shared Qwen', node: 'team.lan')],
        ),
        GridSection(
          name: _grid,
          own: false,
          models: [GridModel(id: 'deepseek/v4', node: 'This Mac')],
        ),
      ],
    );
    await app.modelManager.refresh(force: true);
    // Hidden for now (swarmSharedWithYouShown): no Shared with you in the Swarm's window.
    expect(swarmSharedWithYouShown, isFalse);
    expect(
      search.rows.where(
        (r) => search.modelSection(r) == ModelSearchSection.shared,
      ),
      isEmpty,
    );
    // Its actions stay, for when it is shown again: not offered until the person offers it, then stopped the same way.
    SwarmDestination qwen() =>
        catalog.rows.firstWhere((r) => r.title.startsWith('Shared Qwen'));
    expect(search.modelRowStatus(qwen()), isNull);
    final offer = search.swarmModelAction(qwen())!;
    expect(offer.label, 'Offer to Swarm');
    expect(await offer.run!(), isNull);
    expect(app.offered, {(sharedGrid: 'Team', model: 'Shared Qwen')});
    expect(search.modelRowStatus(qwen()), 'Offered');
    final stop = search.swarmModelAction(qwen())!;
    expect(stop.label, 'Stop offering');
    await stop.run!();
    expect(app.offered, isEmpty);
  });

  test('lists no subscriptions: nothing in one can be given to a Swarm', () {
    expect(
      search.rows.where(
        (r) =>
            catalog.entries[r.modelId]?.section ==
            ModelSearchSection.subscriptions,
      ),
      isEmpty,
    );
    // The same catalog outside a Swarm lists them.
    final plain = SwarmSearchController(app, const [], models: catalog)
      ..setQuery(':');
    addTearDown(plain.dispose);
    expect(
      plain.rows.where(
        (r) =>
            catalog.entries[r.modelId]?.section ==
            ModelSearchSection.subscriptions,
      ),
      isNotEmpty,
    );
  });

  test('ends its APIs in Add API connection, as \u2318I does, with no Swarm action of its own', () {
    final adding = SwarmSearchController(
      app,
      const [],
      models: catalog,
      swarmModels: target,
      adding: true,
      offersCreate: true,
    )..setQuery(':');
    addTearDown(adding.dispose);
    final create = adding.rows.singleWhere((r) => r.isCreate);
    expect(adding.modelSection(create), ModelSearchSection.apis);
    expect(adding.swarmModelAction(create), isNull);
    // Choosing it is the window's to answer (it opens the add form), never a harness start.
    expect(adding.submit(create)?.destination.isCreate, isTrue);
  });

  test('offers Run for Swarm, Stop for Swarm and Get by what the model is to the Swarm', () async {
    expect(search.modelRowStatus(row('served')), 'In Swarm');
    expect(search.swarmModelAction(row('served'))!.label, 'Stop for Swarm');
    expect(search.swarmModelAction(row('catalog'))!.label, 'Get');
    // A start the CLI refuses says why, in its words, though the list read after it clears the manager's error
    // (2026-10-26: a Run for Swarm refused at the plan's network limit said nothing).
    final refusal = Completer<Map<String, dynamic>>();
    app.actionReply = refusal;
    final refused = search.swarmModelAction(row('downloaded'))!.run!();
    refusal.completeError(
      const WsRequestFailure(
        responseType: 'grid_fleet_model_start_result',
        code: 'Free plan allows 5 networks; upgrade to create more',
      ),
    );
    expect(
      await refused,
      'Free plan allows 5 networks; upgrade to create more',
    );
    app.actionReply = null;
    final run = search.swarmModelAction(row('downloaded'))!;
    expect(run.label, 'Run for Swarm');
    expect(await run.run!(), isNull);
    expect(app.actions.last, (machine: 'm', model: 'downloaded', start: true));
    expect(app.grids.last, _grid);
    // Outside a Swarm there is no Swarm action.
    final plain = SwarmSearchController(app, const [], models: catalog)
      ..setQuery(':');
    addTearDown(plain.dispose);
    expect(plain.swarmModelAction(row('downloaded')), isNull);
  });

  test('a scope shows one section, and All every one again', () {
    final sections = search.rows.map(search.modelSection).toSet();
    expect(sections, contains(ModelSearchSection.catalog));
    expect(sections, contains(ModelSearchSection.local));
    search.setModelScope(ModelSearchSection.catalog);
    expect(search.rows, isNotEmpty);
    expect(search.rows.map(search.modelSection).toSet(), {
      ModelSearchSection.catalog,
    });
    search.setModelScope(null);
    expect(search.rows.map(search.modelSection).toSet(), sections);
  });

  test(
    'offers neither Run nor Get for a model too small to drive a coding agent',
    () {
      final run = search.swarmModelAction(row('tiny'))!;
      expect(run.label, 'Run for Swarm');
      expect(run.run, isNull);
      final get = search.swarmModelAction(row('tiny-get'))!;
      expect(get.label, 'Get');
      expect(get.run, isNull);
      expect(search.swarmModelAction(row('downloaded'))!.run, isNotNull);
    },
  );

  test('stops a model running for the Swarm on the Swarm\'s grid', () async {
    await search.swarmModelAction(row('served'))!.run!();
    expect(app.actions.last, (machine: 'm', model: 'served', start: false));
    expect(app.grids.last, _grid);
  });

  test('shares an API model with the Swarm and stops, and keeps what it knew when the read fails', () async {
    expect(target.shared('c1', 'deepseek'), isFalse);
    expect(await target.share('c1', 'deepseek', start: true), isNull);
    expect(app.shareCalls.single, (
      connectionId: 'c1',
      model: 'deepseek',
      start: true,
    ));
    expect(target.shared('c1', 'deepseek'), isTrue);
    app.sharesFail = true;
    await target.refresh();
    expect(target.shared('c1', 'deepseek'), isTrue);
    app.sharesFail = false;
    app.shareError = 'not a member';
    expect(await target.share('c1', 'deepseek', start: false), 'not a member');
    expect(target.error, 'not a member');
    app.shareError = null;
    expect(await target.share('c1', 'deepseek', start: false), isNull);
    expect(target.shared('c1', 'deepseek'), isFalse);
  });

  // 2026-10-24: a list of actions that could not be taken until a separate Set up read as broken. The owner's first
  // share or run sets the Swarm's models up, then does it; anyone else waits for the owner.
  test('before set up, the owner\'s first share sets the Swarm\'s models up, then shares on its grid', () async {
    var setUps = 0;
    final fresh = SwarmModelsTarget(
      app: app,
      grid: '',
      machineId: 'm',
      ready: false,
      canSetUp: true,
      onSetUp: () async {
        setUps++;
        return (
          grid: setUps == 1 ? null : _grid,
          error: setUps == 1 ? 'offline' : null,
        );
      },
    );
    addTearDown(fresh.dispose);
    Future<String?> share() => fresh.share('c1', 'deepseek', start: true);
    // A failed set up shares nothing and says why.
    expect(await fresh.whenSetUp(share), 'offline');
    expect(fresh.setupError, 'offline');
    expect(app.shareCalls, isEmpty);
    expect(await fresh.whenSetUp(share), isNull);
    expect(fresh.ready, isTrue);
    expect(app.shareGrids, [_grid]);
    // Set up now: the action runs as it is.
    expect(await fresh.whenSetUp(() async => 'ran'), 'ran');
    expect(setUps, 2);
    // Someone who may not set it up is told who does.
    final member = SwarmModelsTarget(
      app: app,
      grid: '',
      machineId: 'm',
      ready: false,
      setupNote: 'The owner sets it up.',
    );
    addTearDown(member.dispose);
    expect(await member.whenSetUp(() async => 'ran'), 'The owner sets it up.');
    member.markReady(_grid);
    expect(member.grid, _grid);
  });
}
