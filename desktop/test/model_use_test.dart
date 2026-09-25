import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/models/model_search_catalog.dart';
import 'package:harness/state/swarm_search.dart';
import 'package:harness/usage/models_menu_controller.dart';

import 'support/model_manager.dart';

class _Subscriptions extends ModelsMenuController {
  @override
  List<Map<String, Object?>> get rows => const [];
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late ModelManagerTestApp app;
  late ModelSearchCatalog catalog;
  late _Subscriptions subscriptions;
  late SwarmSearchController search;
  const downloaded = {
    'id': 'weights.gguf',
    'name': 'Qwen',
    'state': 'downloaded',
    'canStart': true,
  };

  Future<void> prepare() async {
    app = ModelManagerTestApp(ModelManagerConnection());
    app.machineStates['m']!.nodeOnline = true;
    app.localInventory = {
      'models': [downloaded],
    };
    await app.modelManager.refresh();
    subscriptions = _Subscriptions();
    catalog = ModelSearchCatalog(
      app.modelManager,
      subscriptions,
      pollHosts: false,
    );
    search = SwarmSearchController(app, const [], models: catalog)
      ..setQuery(':Qwen')
      ..setModelSelection('codex', app.inventory, machineId: 'm');
  }

  void dispose({bool searchDisposed = false}) {
    if (!searchDisposed) search.dispose();
    catalog.dispose();
    subscriptions.dispose();
    app.dispose();
  }

  testWidgets('an unserved instance cannot be used until it can start again', (
    tester,
  ) async {
    await prepare();
    try {
      app.localInventory = {
        'models': [
          {...downloaded, 'canStart': false, 'canStop': true},
        ],
      };
      await app.modelManager.refresh();
      final row = search.selected!;
      expect(search.modelRowAction(row), isNull);
      expect(search.modelUseReason(row), 'Not serving');
      expect(search.submit(row), isNull);
      expect(app.actions, isEmpty);
      app.localInventory = {
        'models': [downloaded],
      };
      await app.modelManager.refresh();
      expect(search.selected!.id, row.id);
      expect(search.modelRowAction(search.selected!), 'Use');
      expect(search.canStartModelForUse(search.selected), isTrue);
    } finally {
      dispose();
    }
  });

  testWidgets(
    'Enter starts installed weights once and waits for serving readiness',
    (tester) async {
      await prepare();
      try {
        final row = search.selected!;
        expect(search.canSelectModel(row), isTrue);
        final selected = search.startModelForUse(row, stillCurrent: () => true);
        await tester.pump();
        expect(app.actions, [
          (machine: 'm', model: 'weights.gguf', start: true),
        ]);
        expect(search.usingModelId, row.modelId);
        expect(
          await search.startModelForUse(row, stillCurrent: () => true),
          isNull,
        );
        expect(app.actions, hasLength(1));
        app.localInventory = {
          'models': [
            {
              ...downloaded,
              'state': 'running',
              'canStart': false,
              'canStop': true,
            },
          ],
        };
        app.inventory = const GridModels(
          gridName: 'home',
          models: [GridModel(id: 'Qwen', node: 'This Mac')],
        );
        await tester.pump(const Duration(seconds: 2));
        expect((await selected)?.id, 'Qwen');
        expect(search.selected!.id, row.id);
        expect(search.usingModelId, isNull);
        expect(app.downloads, isEmpty);
      } finally {
        dispose();
      }
    },
  );

  testWidgets(
    'startup failure remains in the picker without selecting or retrying',
    (tester) async {
      await prepare();
      try {
        final row = search.selected!;
        final selected = search.startModelForUse(row, stillCurrent: () => true);
        await tester.pump();
        app.localInventory = {
          'models': [
            {
              ...downloaded,
              'operation': {
                'id': 'operation',
                'modelId': 'weights.gguf',
                'action': 'start',
                'stage': 'starting',
                'phase': 'failed',
                'error': 'Not enough memory.',
              },
            },
          ],
        };
        await tester.pump(const Duration(seconds: 2));
        expect(await selected, isNull);
        expect(search.modelUseError, 'Not enough memory.');
        expect(search.modelUseErrorId, row.modelId);
        expect(app.actions, hasLength(1));
        expect(search.usingModelId, isNull);
      } finally {
        dispose();
      }
    },
  );

  testWidgets(
    'closing the picker cancels the switch without stopping model startup',
    (tester) async {
      await prepare();
      final selected = search.startModelForUse(
        search.selected!,
        stillCurrent: () => true,
      );
      await tester.pump();
      search.dispose();
      await tester.pump();
      expect(await selected, isNull);
      expect(app.actions, [(machine: 'm', model: 'weights.gguf', start: true)]);
      dispose(searchDisposed: true);
    },
  );

  testWidgets('focus changes cancel the pending switch to the original pane', (
    tester,
  ) async {
    await prepare();
    try {
      var current = true;
      final selected = search.startModelForUse(
        search.selected!,
        stillCurrent: () => current,
      );
      await tester.pump();
      current = false;
      await tester.pump(const Duration(seconds: 2));
      expect(await selected, isNull);
      expect(search.usingModelId, isNull);
      expect(app.actions, hasLength(1));
    } finally {
      dispose();
    }
  });

  testWidgets('uninstalled and disconnected models never start on Enter', (
    tester,
  ) async {
    await prepare();
    try {
      app.localInventory = {
        'models': [
          {...downloaded, 'state': 'available'},
        ],
      };
      await app.modelManager.refresh();
      expect(search.canStartModelForUse(search.selected), isFalse);
      expect(
        await search.startModelForUse(
          search.selected!,
          stillCurrent: () => true,
        ),
        isNull,
      );
      app.localInventory = {
        'models': [downloaded],
      };
      await app.modelManager.refresh();
      app.machineStates['m']!.connectionStatus = ConnectionStatus.disconnected;
      expect(search.canStartModelForUse(search.selected), isFalse);
      expect(
        await search.startModelForUse(
          search.selected!,
          stillCurrent: () => true,
        ),
        isNull,
      );
      expect(app.actions, isEmpty);
      expect(app.downloads, isEmpty);
    } finally {
      dispose();
    }
  });
}
