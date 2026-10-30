import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/models/local_model.dart';
import 'package:harness/models/model_search_catalog.dart';
import 'package:harness/models/api_connections_controller.dart';
import 'package:harness/state/swarm_navigation.dart';
import 'package:harness/state/swarm_search.dart';
import 'package:harness/usage/models_menu_controller.dart';
import 'package:harness/widgets/resting_model_words.dart';

import 'support/model_manager.dart';

class _NoSubscriptions extends ModelsMenuController {
  @override
  List<Map<String, Object?>> get rows => const [];
}

class _WithSubscriptions extends ModelsMenuController {
  @override
  List<Map<String, Object?>> get rows => const [
    {'engine': 'codex', 'title': 'OpenAI'},
  ];
}

class _MachineSubscriptions extends ModelsMenuController {
  bool signedOut = false;

  @override
  List<Map<String, Object?>> get rows => [
    {
      'engine': 'codex',
      'title': 'OpenAI',
      'account': 'same@example.com',
      'accountKey': 'local-account',
      'status': signedOut ? 'Not signed in' : '50% remaining',
    },
    {
      'engine': 'codex',
      'title': 'OpenAI',
      'account': 'same@example.com',
      'accountKey': 'remote-account',
      'status': '75% remaining',
    },
  ];

  @override
  Map<String, Object?>? subscriptionFor(
    String engine, {
    required bool local,
    required String machineName,
  }) => engine != 'codex'
      ? null
      : local
      ? rows.first
      : machineName == 'Other computer'
      ? rows.last
      : null;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late ModelManagerTestApp app;
  late ModelsMenuController subscriptions;
  late ModelSearchCatalog catalog;
  setUp(() {
    app = ModelManagerTestApp(ModelManagerConnection());
    subscriptions = _NoSubscriptions();
    catalog = ModelSearchCatalog(
      app.modelManager,
      subscriptions,
      pollHosts: false,
    );
  });
  tearDown(() {
    catalog.dispose();
    subscriptions.dispose();
    app.dispose();
  });

  test(
    'footer counts installed variants once across owned linked machines',
    () async {
      expect(catalog.installedCount, isNull);
      app.localInventory = {
        'models': [
          {
            'id': 'same-model',
            'name': 'Same model',
            'quant': 'Q4',
            'state': 'downloaded',
          },
          {'id': 'catalog-only', 'name': 'Download me'},
        ],
      };
      app.machineStates['other']!.connectionStatus = ConnectionStatus.connected;
      app.machineInventories['other'] = {
        'models': [
          {
            'id': 'same-model',
            'name': 'Same model',
            'quant': 'Q4',
            'state': 'running',
          },
          {
            'id': 'same-model',
            'name': 'Same model',
            'quant': 'Q8',
            'state': 'downloaded',
          },
        ],
      };
      catalog.watchInstalled();
      await catalog.refresh();
      expect(catalog.installedCount, 2);
      expect(catalog.installedDetail, contains('2 machines'));
      expect(app.gridSetups, isEmpty);
      expect(app.installs, 0);
      expect(app.connection.creations, isEmpty);

      // An offline host retains its last installed inventory; an unlinked host
      // leaves this account's scope altogether.
      app.machineStates['other']!.connectionStatus =
          ConnectionStatus.disconnected;
      app.notifyListeners();
      expect(catalog.installedCount, 2);
      expect(catalog.installedDetail, contains('Inventory unavailable'));
      app.machineStates['other']!.needsLink = true;
      app.notifyListeners();
      expect(catalog.installedCount, 1);
      app.localInventory = {'models': <Object>[]};
      await catalog.refresh();
      expect(catalog.installedCount, 0);
    },
  );

  test('an NVIDIA machine is told its VRAM, not its RAM', () async {
    final grouped = ModelSearchCatalog(
      app.modelManager,
      _WithSubscriptions(),
      pollHosts: false,
    );
    try {
      Map<String, Object?> answer({bool vram = true, bool total = true}) => {
        'memoryBytes': 64 * 1024 * 1024 * 1024,
        if (vram) ...{
          'fitMemory': 'vram',
          'fitBytes': 22 * 1024 * 1024 * 1024,
          if (total) 'gpuMemoryBytes': 24 * 1024 * 1024 * 1024,
        },
        'models': [
          {'id': 'catalog-A', 'name': 'AAA catalog'},
        ],
      };
      app.localInventory = answer(vram: false);
      await app.modelManager.refresh();
      expect(app.modelManager.fitsInVram, isFalse);
      expect(grouped.catalogHeading, 'Get for ${thisComputerName()} · 64 GB');
      app.localInventory = answer();
      await app.modelManager.refresh();
      expect(app.modelManager.fitsInVram, isTrue);
      expect(app.modelManager.fitBytes, 22 * 1024 * 1024 * 1024);
      expect(
        grouped.catalogHeading,
        'Get for ${thisComputerName()} · 24 GB VRAM',
      );
      app.localInventory = answer(total: false);
      await app.modelManager.refresh();
      expect(
        grouped.catalogHeading,
        'Get for ${thisComputerName()} · 22 GB VRAM for models',
      );
    } finally {
      grouped.dispose();
    }
  });

  test('sections separate your models from downloads, and fold the catalog past five', () async {
    final usage = _WithSubscriptions();
    final grouped = ModelSearchCatalog(
      app.modelManager,
      usage,
      pollHosts: false,
    );
    final search = SwarmSearchController(
      app,
      const [],
      models: grouped,
      offersCreate: true,
      adding: true,
    )..setQuery(':');
    try {
      app.localInventory = {
        'memoryBytes': 64 * 1024 * 1024 * 1024,
        'models': [
          for (final letter in ['A', 'B', 'C', 'D', 'E', 'F', 'G'])
            {'id': 'catalog-$letter', 'name': '${letter * 3} catalog'},
          {
            'id': 'installed',
            'name': 'ZZZ installed',
            'state': 'downloaded',
            'canStart': true,
          },
        ],
      };
      app.inventory = const GridModels(
        gridName: 'home',
        models: [],
        grids: [
          GridSection(
            name: 'Team',
            own: false,
            models: [GridModel(id: 'Shared Qwen', node: 'team.lan')],
          ),
        ],
      );
      app.modelManager.apis.connections = [
        const ApiConnection({'id': 'custom', 'name': 'Custom API'}),
      ];
      await app.modelManager.refresh();
      expect(search.rows.map((row) => row.title), [
        'OpenAI',
        'Custom API',
        '[ Add ]',
        'ZZZ installed',
        'AAA catalog',
        'BBB catalog',
        'CCC catalog',
        'DDD catalog',
        'EEE catalog',
        '[ More models (2) ]',
        'Shared Qwen · team.lan · Team',
      ]);
      expect(search.rows.map(search.modelSection), [
        ModelSearchSection.subscriptions,
        ModelSearchSection.apis,
        ModelSearchSection.apis,
        ModelSearchSection.local,
        for (var i = 0; i < 6; i++) ModelSearchSection.catalog,
        ModelSearchSection.shared,
      ]);
      // The downloads are headed with the machine they are for, and its memory.
      expect(grouped.catalogHeading, 'Get for ${thisComputerName()} · 64 GB');
      expect(
        search.modelSectionLabel(ModelSearchSection.catalog),
        grouped.catalogHeading,
      );
      expect(search.modelSectionLabel(ModelSearchSection.local), 'Your models');
      search.move(
        search.rows.indexWhere(search.isModelDownloadsRow) - search.cursor,
      );
      expect(search.actionLabel(search.selected), 'More models');
      expect(search.submit(), isNull);
      expect(search.modelDownloadsVisible, isTrue);
      expect(search.rows.map((row) => row.title), [
        'OpenAI',
        'Custom API',
        '[ Add ]',
        'ZZZ installed',
        for (final letter in ['A', 'B', 'C', 'D', 'E', 'F', 'G'])
          '${letter * 3} catalog',
        '[ Show fewer ]',
        'Shared Qwen · team.lan · Team',
      ]);
      expect(search.selected!.title, 'AAA catalog');
      expect(search.modelRowAction(search.selected!), isNull);
      search.move(
        search.rows.indexWhere(search.isModelDownloadsRow) - search.cursor,
      );
      expect(search.actionLabel(search.selected), 'Show fewer');
      search.submit();
      expect(search.modelDownloadsVisible, isFalse);
      // The top five stay listed with the rest folded away again.
      expect(search.rows.any((row) => row.title == 'EEE catalog'), isTrue);
      expect(search.rows.any((row) => row.title == 'FFF catalog'), isFalse);
      // A search reaches every catalog model, folded or not.
      search.setQuery(':local');
      expect(
        search.rows.where((row) => !row.isCreate).map((row) => row.title),
        [
          'ZZZ installed',
          for (final letter in ['A', 'B', 'C', 'D', 'E', 'F', 'G'])
            '${letter * 3} catalog',
        ],
      );
      expect(app.actions, isEmpty);
    } finally {
      search.dispose();
      grouped.dispose();
      usage.dispose();
    }
  });

  test('the desktop list names its action rows for what they do, and keeps who shares a model on its line', () async {
    final usage = _WithSubscriptions();
    final grouped = ModelSearchCatalog(
      app.modelManager,
      usage,
      pollHosts: false,
    );
    final search = SwarmSearchController(
      app,
      const [],
      models: grouped,
      offersCreate: true,
      adding: true,
    )..setQuery(':');
    try {
      app.localInventory = {
        'models': [
          for (final letter in ['A', 'B', 'C', 'D', 'E', 'F', 'G'])
            {'id': 'catalog-$letter', 'name': '${letter * 3} catalog'},
        ],
      };
      app.inventory = const GridModels(
        gridName: 'home',
        models: [],
        grids: [
          GridSection(
            name: 'Team',
            own: false,
            models: [GridModel(id: 'Shared Qwen', node: 'team.lan')],
          ),
        ],
      );
      app.modelManager.apis.connections = [
        const ApiConnection({
          'id': 'custom',
          'name': 'Custom API',
          'baseUrl': 'https://relay.example.test/v1',
        }),
      ];
      await app.modelManager.refresh();
      SwarmDestination row(bool Function(SwarmDestination) test) =>
          search.rows.singleWhere(test);
      final subscription = row((r) => r.title == 'OpenAI');
      final api = row((r) => r.title == 'Custom API');
      final shared = row((r) => r.title == 'Shared Qwen · team.lan · Team');
      final more = row(search.isModelDownloadsRow);

      // One line a row: every other row keeps its own title, who shares a model included.
      expect(search.modelRowTitle(subscription), 'OpenAI');
      expect(search.modelRowTitle(api), 'Custom API');
      expect(search.modelRowTitle(shared), 'Shared Qwen · team.lan · Team');
      // The fold is named for what Enter does, with how many it holds.
      expect(search.modelRowTitle(more), 'More models (2)');
      search.move(search.rows.indexOf(more) - search.cursor);
      search.submit();
      expect(search.modelRowTitle(more), 'Show fewer');
    } finally {
      search.dispose();
      grouped.dispose();
      usage.dispose();
    }
  });

  test('a subscription the harness can use still shows how much of it is left, not Use', () async {
    final usage = _MachineSubscriptions();
    final grouped = ModelSearchCatalog(
      app.modelManager,
      usage,
      pollHosts: false,
    );
    final search = SwarmSearchController(
      app,
      const [],
      models: grouped,
      offersCreate: true,
      adding: true,
    )..setQuery(':');
    try {
      await app.modelManager.refresh();
      // A Codex harness on this computer: its own OpenAI account is one it can switch to.
      search.setModelSelection(
        'codex',
        const GridModels(gridName: 'home', models: []),
        machineId: 'm',
      );
      final own = search.rows.singleWhere(
        (row) => grouped.entries[row.modelId]?.subscription?['accountKey'] == 'local-account',
      );
      expect(search.canSelectModel(own), isTrue);
      expect(search.modelRowStatus(own), '50% remaining');
    } finally {
      search.dispose();
      grouped.dispose();
      usage.dispose();
    }
  });

  // The owner, 2026-10-18: a model another machine serves — on your own grid too — is shared with
  // you, named with that machine and its grid; Your models are this computer's.
  test('a model another machine serves on your own grid is shared, under its machine and grid', () async {
    app.localReadFails = true;
    app.inventory = const GridModels(
      gridName: 'home',
      models: [],
      grids: [
        GridSection(
          name: 'Team',
          own: false,
          models: [GridModel(id: 'Shared model', node: 'team.lan')],
        ),
        GridSection(
          name: 'home',
          own: true,
          models: [GridModel(id: 'qwen3.8-27b', node: 'mac.lan')],
        ),
      ],
    );
    await app.modelManager.refresh();
    // Your own grid's first, then other teams'.
    expect(catalog.rows.map((row) => row.title), [
      'qwen3.8-27b · mac.lan · home',
      'Shared model · team.lan · Team',
    ]);
    final other = catalog.entries[catalog.rows.first.modelId]!;
    expect(other.section, ModelSearchSection.shared);
    expect(other.source, 'Shared · home');
    expect(other.node, 'mac.lan');
    expect(other.local, isNull);
    final search = SwarmSearchController(app, const [], models: catalog)
      ..setQuery(':local');
    addTearDown(search.dispose);
    expect(search.rows.map((row) => row.title), isEmpty);
    search.setQuery(':mac.lan');
    expect(search.rows.map((row) => row.title), [
      'qwen3.8-27b · mac.lan · home',
    ]);
    expect(app.actions, isEmpty);
    expect(app.downloads, isEmpty);
  });

  test('a catalog model running here is one row, matched to the name grid serves it under', () async {
    Map<String, Object?> running() => {
      'models': [
        {
          'id': 'unsloth/Qwen3.8-27B-GGUF',
          'name': 'Qwen3.8-27B',
          'state': 'running',
          'canStop': true,
          'app': 'Grid',
          'servedAs': ['Qwen3.8-27B-UD-Q4_K_M'],
        },
      ],
    };
    app.localInventory = running();
    app.inventory = const GridModels(
      gridName: 'home',
      models: [],
      grids: [
        GridSection(
          name: 'home',
          own: true,
          models: [GridModel(id: 'Qwen3.8-27B-UD-Q4_K_M', node: 'This Mac')],
        ),
      ],
    );
    await app.modelManager.refresh();
    final served = catalog.entries.values.where(
      (entry) => entry.local?.id == 'unsloth/Qwen3.8-27B-GGUF',
    );
    expect(catalog.entries, hasLength(1));
    expect(served.single.gridModel?.id, 'Qwen3.8-27B-UD-Q4_K_M');
  });

  test(
    'a name is shown without the quant its file ends in, as hn shows it',
    () {
      const cases = {
        'Qwen3.8-27B-UD-Q4_K_M': 'Qwen3.8-27B',
        'Qwen3-4B-Instruct-2507-Q4_K_M': 'Qwen3-4B-Instruct-2507',
        'qwen3:4b-instruct-2507-q4_k_m': 'qwen3:4b-instruct-2507',
        'Kev-0.8B-Q8_0': 'Kev-0.8B',
        'gpt-oss-20b-MXFP4': 'gpt-oss-20b',
        'Mistral-7B-v0.1.IQ4_XS': 'Mistral-7B-v0.1',
        'gemma-4-E4B-it-BF16': 'gemma-4-E4B-it',
        'Qwen3.6-35B-A3B-UD_Q5_K_XL': 'Qwen3.6-35B-A3B',
        'Qwen3.6-35B-A3B': 'Qwen3.6-35B-A3B',
        'llama3.2:3b': 'llama3.2:3b',
        'Qwen-Q3-Coder': 'Qwen-Q3-Coder',
        'Q4_K_M': 'Q4_K_M',
        '-Q4': '-Q4',
        'Qwen/Qwen3.8-27B': 'Qwen/Qwen3.8-27B',
      };
      for (final MapEntry(:key, :value) in cases.entries) {
        expect(withoutQuant(key), value, reason: key);
      }
    },
  );

  test('a model shared from another machine reads as it does there, without its quant', () async {
    app.localInventory = {'models': <Object>[]};
    app.inventory = const GridModels(
      gridName: 'home',
      models: [],
      grids: [
        GridSection(
          name: 'scholes-f8d388e6',
          own: false,
          models: [GridModel(id: 'Qwen3.8-27B-UD-Q4_K_M', node: 'harness')],
        ),
      ],
    );
    await app.modelManager.refresh();
    expect(
      catalog.rows.single.title,
      'Qwen3.8-27B · harness · scholes-f8d388e6',
    );
    final entry = catalog.entries.values.single;
    expect(entry.gridModel?.id, 'Qwen3.8-27B-UD-Q4_K_M');
    final search = SwarmSearchController(app, const [], models: catalog)
      ..setQuery(':Q4_K_M');
    addTearDown(search.dispose);
    expect(search.rows.map((row) => row.title), [
      'Qwen3.8-27B · harness · scholes-f8d388e6',
    ]);
  });

  test('legacy own-grid replies remain visible in models', () async {
    app.localInventory = {'models': <Object>[]};
    app.inventory = const GridModels(
      gridName: 'home',
      models: [GridModel(id: 'Qwen', node: 'mac.lan')],
    );
    await app.modelManager.refresh();
    expect(catalog.rows.single.title, 'Qwen · mac.lan · home');
    expect(catalog.entries.values.single.source, 'Shared · home');
  });

  test('Use keeps accounts with the same email scoped to the pane host', () {
    final usage = _MachineSubscriptions();
    final accounts = ModelSearchCatalog(
      app.modelManager,
      usage,
      pollHosts: false,
    );
    final search = SwarmSearchController(app, const [], models: accounts)
      ..setQuery(':OpenAI')
      ..setModelSelection('codex', app.inventory, machineId: 'm');
    try {
      final local = search.rows.firstWhere(
        (row) =>
            accounts.entries[row.modelId]?.subscription?['accountKey'] ==
            'local-account',
      );
      final remote = search.rows.firstWhere(
        (row) =>
            accounts.entries[row.modelId]?.subscription?['accountKey'] ==
            'remote-account',
      );
      expect(search.modelRowAction(local), 'Use');
      expect(search.modelRowAction(remote), isNull);
      search.setModelSelection('codex', app.inventory, machineId: 'other');
      expect(search.modelRowAction(local), isNull);
      expect(search.modelRowAction(remote), 'Use');
      search.setModelSelection('claude', app.inventory, machineId: 'm');
      expect(search.rows.any(search.canSelectModel), isFalse);
      search.setModelSelection('codex', app.inventory, machineId: 'm');
      usage.signedOut = true;
      expect(search.canSelectModel(local), isFalse);
      expect(app.actions, isEmpty);
    } finally {
      search.dispose();
      accounts.dispose();
      usage.dispose();
    }
  });

  test(
    'matching model names never hide hosts or grant local controls',
    () async {
      app.localInventory = {
        'models': [
          {'id': 'qwen', 'name': 'Qwen'},
        ],
      };
      app.inventory = const GridModels(
        gridName: 'home',
        models: [
          GridModel(id: 'qwen', node: 'This Mac'),
          GridModel(id: 'qwen', node: 'mac.lan'),
        ],
      );
      await app.modelManager.refresh();
      expect(catalog.rows, hasLength(3));
      expect(catalog.entries, hasLength(3));
      expect(
        catalog.entries.values.where((entry) => entry.local != null),
        hasLength(1),
      );
      // This computer's is yours; mac.lan's is shared with you.
      expect(
        catalog.entries.values.where(
          (entry) => entry.source == 'On this computer',
        ),
        hasLength(1),
      );
      expect(
        catalog.entries.values.where(
          (entry) => entry.source == 'Shared · home',
        ),
        hasLength(1),
      );
    },
  );

  test(
    'each linked host exposes its own inventory without a served Grid row',
    () async {
      const model = {
        'id': 'weights.gguf',
        'name': 'Qwen',
        'state': 'downloaded',
        'canStart': true,
      };
      app.localInventory = {
        'models': [model],
        'supportsDownload': true,
      };
      app.machineStates['other']!
        ..connectionStatus = ConnectionStatus.connected
        ..nodeOnline = true;
      app.machineInventories['other'] = {
        'models': [model],
      };
      catalog.setVisible(true);
      await catalog.refresh();
      expect(
        catalog.entries.values.where((entry) => entry.local != null),
        hasLength(2),
      );
      final remote = catalog.entries.values.singleWhere(
        (entry) => entry.controller?.targetMachineId == 'other',
      );
      expect(remote.gridModel, isNull);
      expect(remote.controller!.supportsDownload, isFalse);
      await remote.controller!.control(remote.local!, 'start');
      expect(app.actions, [
        (machine: 'other', model: 'weights.gguf', start: true),
      ]);
      expect(app.localInventory['models'], [model]);
      expect(app.connection.creations, isEmpty);
    },
  );

  test(
    'unlinked and offline hosts are not queried or given controls',
    () async {
      final remote = app.machineStates['other']!
        ..connectionStatus = ConnectionStatus.connected
        ..nodeOnline = true
        ..needsLink = true;
      catalog.setVisible(true);
      await catalog.refresh();
      expect(app.inventoryReads, isNot(contains('other')));
      remote
        ..needsLink = false
        ..nodeOnline = false;
      app.notifyListeners();
      await catalog.refresh();
      expect(app.inventoryReads, isNot(contains('other')));
      expect(app.actions, isEmpty);
      expect(app.connection.creations, isEmpty);
    },
  );

  test(
    'selection follows the target pane machine model capabilities',
    () async {
      app.localInventory = {'models': <Object>[]};
      app.inventory = const GridModels(
        gridName: 'home',
        models: [GridModel(id: 'Qwen', node: 'mac.lan')],
      );
      await app.modelManager.refresh();
      final search = SwarmSearchController(app, const [], models: catalog)
        ..setQuery(':Qwen')
        ..setModelSelection(
          'codex',
          const GridModels.unreachable(),
          machineId: 'other',
        );
      addTearDown(search.dispose);
      expect(search.canSelectModel(search.selected), isFalse);
      // A live picture from the pane's host updates availability without reopening.
      app.gridPictures.adopt('other', app.inventory);
      expect(search.canSelectModel(search.selected), isTrue);
      expect(search.actionLabel(search.selected), 'Use');
      app.gridPictures.adopt(
        'other',
        const GridModels(
          gridName: 'home',
          models: [GridModel(id: 'Qwen', node: 'mac.lan')],
          localModelEngines: {'claude'},
        ),
      );
      expect(search.canSelectModel(search.selected), isFalse);
      expect(search.actionLabel(search.selected), 'Unavailable');
      expect(app.actions, isEmpty);
    },
  );

  test(
    'own model states use the existing offline and resting wording',
    () async {
      app.localInventory = {'models': <Object>[]};
      app.inventory = const GridModels(
        gridName: 'home',
        models: [],
        grids: [
          GridSection(
            name: 'home',
            own: true,
            state: GridSectionState.asleep,
            lastKnownAge: 120,
            models: [
              GridModel(id: 'Resting', node: 'mac.lan'),
              GridModel(
                id: 'Offline',
                node: 'rig.lan',
                unavailable: GridModelUnavailable(machine: 'Rig'),
              ),
            ],
          ),
        ],
      );
      await app.modelManager.refresh();
      final rows = catalog.entries.values.toList();
      expect(rows[0].status, restingSubtitle(120));
      expect(rows[1].status, offlineRowSentence('Rig'));
      final search = SwarmSearchController(app, const [], models: catalog)
        ..setQuery(':')
        ..setModelSelection('codex', app.inventory, machineId: 'm');
      try {
        final resting = search.rows.firstWhere(
          (row) => row.title == 'Resting · mac.lan · home',
        );
        final offline = search.rows.firstWhere(
          (row) => row.title == 'Offline · rig.lan · home',
        );
        expect(search.modelRowAction(resting), 'Use');
        expect(search.modelRowAction(offline), isNull);
        expect(search.canSelectModel(offline), isFalse);
      } finally {
        search.dispose();
      }
    },
  );
}
