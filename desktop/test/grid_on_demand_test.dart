// Grid is an add-on: the app never sets it up by starting, by opening a picker or by reading a list.
// It is set up the first time a person asks for a grid feature — the models picker's Set up row, or
// opening the Model Manager — through the daemon, with this Harness account's token (no second
// browser). Until then the picker offers that one row in place of local and shared models.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/local_key_value_store.dart';
import 'package:harness/core/models.dart';
import 'package:harness/models/model_manager_controller.dart';
import 'package:harness/models/model_search_catalog.dart';
import 'package:harness/state/swarm_search.dart';
import 'package:harness/widgets/swarm_resource_preview.dart';
import 'package:harness/widgets/swarm_switcher.dart';

import 'keymap_host_test.dart' show MemoryKeymap, key;
import 'keymap_runtime_test.dart' as configured;
import 'resource_picker_test.dart' show fixture;
import 'support/model_manager.dart';
import 'support/real_fonts.dart';

class _MemoryStore implements LocalKeyValueStore {
  final values = <String, String>{};
  @override
  Future<String?> read(String key) async => values[key];
  @override
  Future<void> write(String key, String value) async => values[key] = value;
  @override
  Future<void> delete(String key) async => values.remove(key);
}

/// What the daemon lists on a machine whose Grid is not set up: nothing, and that it is needed.
Map<String, dynamic> _notSetUp() => {
  'models': <Object>[],
  'supportsDownload': true,
  'busy': false,
  'gridSetupNeeded': true,
  // What the daemon notes beside the list with no grid sign-in; the Set up row already says it.
  'notice': 'Sign in to find models for this computer.',
};

SwarmSearchController search(WidgetTester tester) =>
    tester.widget<SwarmSearchResults>(find.byType(SwarmSearchResults)).search;

Finder _inPreview(String text) => find.descendant(
  of: find.byType(SwarmResourcePreview),
  matching: find.textContaining(text),
);

void main() {
  group('the Model Manager controller', () {
    late ModelManagerConnection connection;
    late ModelManagerTestApp app;
    late ModelManagerController controller;
    setUp(() {
      connection = ModelManagerConnection();
      app = ModelManagerTestApp(connection)..installed = false;
      controller = ModelManagerController(
        app,
        storage: _MemoryStore(),
        poll: false,
      );
    });
    tearDown(() {
      controller.dispose();
      app.dispose();
    });

    test('the app starting prepares nothing: no Grid harness installed, no Model Manager made', () async {
      controller.start();
      await controller.refresh();
      await pumpEventQueue();
      expect(app.installs, 0);
      expect(connection.creations, isEmpty);
      expect(app.gridSetups, isEmpty);
    });

    test('a list read says Grid is not set up, and sets nothing up', () async {
      app.localInventory = _notSetUp();
      controller.start();
      await controller.refresh();
      await controller.refresh(force: true);
      expect(controller.gridSetupNeeded, isTrue);
      expect(app.gridSetups, isEmpty);
      // The daemon's note about it is not an error: the Set up row is the whole of the message.
      expect(controller.error, isNull);
    });

    test(
      'Set up sets Grid up once, and the list then reads it set up',
      () async {
        app.localInventory = _notSetUp();
        controller.start();
        await controller.refresh();
        expect(await controller.setUpGrid(), isTrue);
        expect(app.gridSetups, ['m']);
        expect(controller.gridSetupNeeded, isFalse);
        expect(controller.settingUpGrid, isFalse);
        expect(controller.gridSetupError, isNull);
      },
    );

    test('a set-up refused keeps the Set up offered, and says why', () async {
      app
        ..localInventory = _notSetUp()
        ..gridSetupFailure = 'grid is too old for --harness';
      controller.start();
      await controller.refresh();
      expect(await controller.setUpGrid(), isFalse);
      expect(controller.gridSetupNeeded, isTrue);
      expect(controller.gridSetupError, 'grid is too old for --harness');
      // A plain read afterwards does not carry the last attempt's words forward.
      await controller.refresh(force: true);
      expect(controller.gridSetupError, isNull);
    });

    test('opening the Model Manager sets Grid up first', () async {
      app.localInventory = _notSetUp();
      controller.start();
      await controller.refresh();
      await controller.open();
      expect(app.gridSetups, ['m']);
      expect(app.installs, 1);
      expect(connection.creations, hasLength(1));
    });

    test('signed out of Harness, Set up signs in first, then sets Grid up by itself', () async {
      app
        ..localInventory = _notSetUp()
        ..signedIn = false;
      controller.start();
      await controller.refresh();
      // One press: it opens the Harness sign-in rather than failing with "Not signed in".
      expect(await controller.setUpGrid(), isFalse);
      expect(app.logins, 1);
      // The sign-in landed and this machine is connected: the set-up it was for runs, unasked.
      await pumpEventQueue();
      expect(app.gridSetups, ['m']);
      expect(controller.gridSetupNeeded, isFalse);
      expect(controller.gridSetupError, isNull);
    });

    test('a sign-in cancelled leaves nothing waiting to set Grid up behind a later one', () async {
      app
        ..localInventory = _notSetUp()
        ..signedIn = false
        ..loginLands = false;
      controller.start();
      await controller.refresh();
      await controller.setUpGrid();
      await pumpEventQueue();
      expect(app.logins, 1);
      expect(app.gridSetups, isEmpty);
      // Signing in some other way later does not set Grid up on its own.
      app
        ..signedIn = true
        ..notifyListeners();
      await pumpEventQueue();
      expect(app.gridSetups, isEmpty);
    });

    test(
      'a Model Manager whose Grid could not be set up is not made',
      () async {
        app
          ..localInventory = _notSetUp()
          ..gridSetupFailure = 'no grid on this computer';
        controller.start();
        await controller.refresh();
        await controller.open();
        expect(controller.error, 'no grid on this computer');
        expect(app.installs, 0);
        expect(connection.creations, isEmpty);
      },
    );
  });

  group('the models picker', () {
    setUpAll(loadRealFonts);

    Future<ModelManagerTestApp> notSetUp() async {
      final app = await fixture();
      app.localInventory = _notSetUp();
      await app.modelManager.refresh(force: true);
      return app;
    }

    testWidgets(
      'offers one Set up row for local and shared models, and sets Grid up only on Enter',
      (tester) async {
        final app = await notSetUp();
        final map = MemoryKeymap();
        try {
          await configured.mount(tester, app, map);
          await key(tester, LogicalKeyboardKey.keyI, cmd: true);
          await tester.pumpAndSettle();
          final picker = search(tester);
          final setup = picker.rows.singleWhere(picker.isGridSetupRow);
          expect(setup.title, '[ Set up local & shared models ]');
          expect(picker.modelSection(setup), ModelSearchSection.local);
          // It stands for what is shared with you too; there is nothing to download yet.
          expect(
            find.byKey(const ValueKey('model-section:Shared with you')),
            findsNothing,
          );
          expect(
            find.byKey(const ValueKey('model-section:Get models')),
            findsNothing,
          );
          // Opening the picker, and reading it, set nothing up.
          expect(app.gridSetups, isEmpty);
          // And no row's preview repeats "sign in" in yellow: the Set up row says it once.
          expect(
            find.byKey(const ValueKey('local-model-inventory-notice')),
            findsNothing,
          );
          expect(find.textContaining('Sign in to find models'), findsNothing);

          picker.move(picker.rows.indexOf(setup) - picker.cursor);
          await tester.pump();
          expect(_inPreview('Local & shared models'), findsOneWidget);
          expect(
            _inPreview("You won't be asked to sign in again."),
            findsOneWidget,
          );
          expect(picker.actionLabel(setup), 'Set up');

          await key(tester, LogicalKeyboardKey.enter);
          await tester.pumpAndSettle();
          expect(app.gridSetups, ['m']);
          expect(picker.rows.where(picker.isGridSetupRow), isEmpty);
          expect(
            find.byKey(const ValueKey('model-section:Shared with you')),
            findsOneWidget,
          );
        } finally {
          await tester.pumpWidget(const SizedBox());
          app.dispose();
          map.dispose();
        }
      },
    );

    testWidgets('a set-up refused stays offered, with why in the preview', (
      tester,
    ) async {
      final app = await notSetUp();
      app.gridSetupFailure = 'grid is too old for --harness';
      final map = MemoryKeymap();
      try {
        await configured.mount(tester, app, map);
        await key(tester, LogicalKeyboardKey.keyI, cmd: true);
        await tester.pumpAndSettle();
        final picker = search(tester);
        picker.move(
          picker.rows.indexWhere(picker.isGridSetupRow) - picker.cursor,
        );
        await tester.pump();
        await key(tester, LogicalKeyboardKey.enter);
        await tester.pumpAndSettle();
        expect(app.gridSetups, ['m']);
        expect(picker.rows.where(picker.isGridSetupRow), hasLength(1));
        expect(
          _inPreview('Could not set up: grid is too old for --harness'),
          findsOneWidget,
        );
      } finally {
        await tester.pumpWidget(const SizedBox());
        app.dispose();
        map.dispose();
      }
    });

    testWidgets(
      'signed out, the row signs in and says so — no dead end at "Not signed in"',
      (tester) async {
        final app = await notSetUp();
        app.signedIn = false;
        // The workspace starts the Model Manager's watch outside tests; the sign-in's follow-up
        // set-up rides on it.
        app.modelManager.start();
        final map = MemoryKeymap();
        try {
          await configured.mount(tester, app, map);
          await key(tester, LogicalKeyboardKey.keyI, cmd: true);
          await tester.pumpAndSettle();
          final picker = search(tester);
          final setup = picker.rows.singleWhere(picker.isGridSetupRow);
          picker.move(picker.rows.indexOf(setup) - picker.cursor);
          await tester.pump();
          expect(picker.actionLabel(setup), 'Sign in');
          // Why a sign-in: the models belong to the Harness account this computer is not using.
          expect(
            _inPreview(
              'belong to your Harness account, so you need to sign in',
            ),
            findsOneWidget,
          );
          expect(_inPreview('Sign in opens in your browser.'), findsOneWidget);
          await key(tester, LogicalKeyboardKey.enter);
          await tester.pumpAndSettle();
          expect(app.logins, 1);
          expect(app.gridSetups, ['m']);
          expect(find.textContaining('Not signed in'), findsNothing);
        } finally {
          await tester.pumpWidget(const SizedBox());
          app.dispose();
          map.dispose();
        }
      },
    );

    testWidgets(
      'while Set up is offered, nothing it stands for is listed beside it',
      (tester) async {
        final app = await fixture();
        // A downloaded file on disk, and models shared on a grid this Mac read before: neither can be
        // used until Grid is set up, so neither is listed next to the row that sets it up.
        app
          ..localInventory = {
            ..._notSetUp(),
            'models': [
              {
                'id': 'local:Qwen3.6-35B-A3B-UD-Q5_K_XL.gguf',
                'name': 'Qwen3.6-35B-A3B',
                'state': 'downloaded',
                'sizeBytes': 27159116064,
                'canStart': true,
              },
            ],
          }
          ..inventory = const GridModels(
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
        await app.modelManager.refresh(force: true);
        final map = MemoryKeymap();
        try {
          await configured.mount(tester, app, map);
          await key(tester, LogicalKeyboardKey.keyI, cmd: true);
          await tester.pumpAndSettle();
          final picker = search(tester);
          final sections = picker.rows.map(picker.modelSection).toSet();
          expect(
            picker.rows
                .where(
                  (row) => picker.modelSection(row) == ModelSearchSection.local,
                )
                .map((row) => row.id),
            [SwarmSearchController.gridSetupRowId],
          );
          expect(sections, isNot(contains(ModelSearchSection.shared)));
          expect(sections, isNot(contains(ModelSearchSection.catalog)));
          expect(find.text('Qwen3.6-35B-A3B'), findsNothing);
          expect(find.textContaining('Shared Qwen'), findsNothing);
        } finally {
          await tester.pumpWidget(const SizedBox());
          app.dispose();
          map.dispose();
        }
      },
    );

    testWidgets(
      'an open picker notices Grid set up some other way, and drops the Set up row',
      (tester) async {
        final app = await notSetUp();
        // The workspace starts the Model Manager's watch outside tests.
        app.modelManager.start();
        final map = MemoryKeymap();
        try {
          await configured.mount(tester, app, map);
          await key(tester, LogicalKeyboardKey.keyI, cmd: true);
          await tester.pumpAndSettle();
          final picker = search(tester);
          expect(picker.rows.where(picker.isGridSetupRow), hasLength(1));
          // Set up elsewhere — a terminal's `harness grid login` — while the picker stays open.
          app.localInventory = {..._notSetUp()}
            ..remove('gridSetupNeeded')
            ..remove('notice');
          await tester.pump(const Duration(seconds: 5));
          await tester.pumpAndSettle();
          expect(picker.rows.where(picker.isGridSetupRow), isEmpty);
          expect(app.gridSetups, isEmpty);
        } finally {
          await tester.pumpWidget(const SizedBox());
          app.dispose();
          map.dispose();
        }
      },
    );

    testWidgets('a set-up Grid is not offered again', (tester) async {
      final app = await fixture();
      final map = MemoryKeymap();
      try {
        await configured.mount(tester, app, map);
        await key(tester, LogicalKeyboardKey.keyI, cmd: true);
        await tester.pumpAndSettle();
        final picker = search(tester);
        expect(picker.gridSetupOffered, isFalse);
        expect(picker.rows.where(picker.isGridSetupRow), isEmpty);
      } finally {
        await tester.pumpWidget(const SizedBox());
        app.dispose();
        map.dispose();
      }
    });
  });
}
