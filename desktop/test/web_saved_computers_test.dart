import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/local_key_value_store.dart';
import 'package:harness/core/models.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/web/onboarding/saved_computers.dart';
import 'package:harness/web/onboarding/web_first_machine.dart';
import 'package:harness/web/shell/web_workspace.dart';

import 'swarm_state_test.dart' show MemoryStore, createApp;

/// Storage a full or private-mode browser hands out: every call throws.
class _RefusingStore implements LocalKeyValueStore {
  @override
  Future<String?> read(String key) => Future.error(StateError('quota'));
  @override
  Future<void> write(String key, String value) =>
      Future.error(StateError('quota'));
  @override
  Future<void> delete(String key) => Future.error(StateError('quota'));
}

/// An account whose machine list has not answered yet, unless a test says so.
class _Account extends AppNotifier {
  _Account()
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      );

  bool loaded = false;

  @override
  bool get machineInventoryLoaded => loaded;

  void list(String id, String name) {
    final machine = Machine(
      machineId: id,
      name: name,
      authMode: MachineAuthMode.remote,
    );
    machines.add(machine);
    machineStates[id] = MachineState(machine)..nodeOnline = false;
  }

  void answer() {
    loaded = true;
    notifyListeners();
  }
}

const _ann = CurrentUserProfile(id: 'ann', email: 'ann@example.test');
const _bob = CurrentUserProfile(id: 'bob', email: 'bob@example.test');
const _macs = [
  SavedComputer(id: 'm1', name: 'Studio'),
  SavedComputer(id: 'm2', name: 'MacBookPro2021.local'),
];

void main() {
  group('kept computers', () {
    late MemoryStore storage;
    late SavedComputers saved;
    setUp(() {
      storage = MemoryStore();
      saved = SavedComputers(storage);
    });

    test('an account reads back the computers it kept', () async {
      await saved.claim('ann');
      await saved.write('ann', _macs);

      expect(await saved.read('ann'), _macs);
    });

    test('another account on this browser forgets them first', () async {
      await saved.claim('ann');
      await saved.write('ann', _macs);

      await saved.claim('bob');

      expect(await saved.read('ann'), isNull);
      expect(storage.values.keys.where((k) => k.contains('ann')), isEmpty);
    });

    test('signing out forgets them', () async {
      await saved.claim('ann');
      await saved.write('ann', _macs);

      await saved.claim(null);

      expect(storage.values, isEmpty);
    });

    test('a late write for an account that left keeps nothing', () async {
      await saved.claim('ann');
      await saved.claim('bob');

      await saved.write('ann', _macs);

      expect(await saved.read('ann'), isNull);
    });

    test(
      'anything unreadable is no list, and a refusing storage never throws',
      () async {
        await saved.claim('ann');
        storage.values['web.computers.ann'] = '{not json';
        expect(await saved.read('ann'), isNull);

        final refusing = SavedComputers(_RefusingStore());
        await refusing.claim('ann');
        await refusing.write('ann', _macs);
        expect(await refusing.read('ann'), isNull);
      },
    );
  });

  group('the watch', () {
    late _Account app;
    late MemoryStore storage;
    setUp(() {
      app = _Account();
      storage = MemoryStore();
    });
    tearDown(() => app.dispose());

    test(
      'keeps the computers the answered list shows, for its account',
      () async {
        final watch = SavedComputersWatch(app, SavedComputers(storage));
        addTearDown(watch.dispose);
        app.currentUser = _ann;
        app.list('m1', 'Studio');
        app.answer();
        await pumpEventQueue();

        expect(await SavedComputers(storage).read('ann'), [
          const SavedComputer(id: 'm1', name: 'Studio'),
        ]);
      },
    );

    test(
      'offers them while the list is read, and not once it answers',
      () async {
        final store = SavedComputers(storage);
        await store.claim('ann');
        await store.write('ann', _macs);
        final watch = SavedComputersWatch(app, store);
        addTearDown(watch.dispose);

        // The app says so once it knows who signed in (status, then notify).
        app
          ..currentUser = _ann
          ..notifyListeners();
        await pumpEventQueue();
        expect(watch.shown, _macs);

        app.answer();
        expect(watch.shown, isNull);
      },
    );

    test('never offers one account\'s computers to another', () async {
      final store = SavedComputers(storage);
      await store.claim('ann');
      await store.write('ann', _macs);
      final watch = SavedComputersWatch(app, store);
      addTearDown(watch.dispose);

      app
        ..currentUser = _bob
        ..notifyListeners();
      await pumpEventQueue();

      expect(watch.shown, isNull);
      expect(await store.read('ann'), isNull);
    });
  });

  testWidgets(
    'the web workspace keeps the list from its first frame, connect page or not',
    (tester) async {
      final storage = MemoryStore();
      final app = createApp(store: storage, connected: true)
        ..currentUser = _ann;
      addTearDown(app.dispose);
      tester.view.physicalSize = const Size(1280, 800);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);

      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: WebWorkspace(app: app),
        ),
      );
      await tester.runAsync(pumpEventQueue);

      expect(savedComputersOf(app), same(savedComputersOf(app)));
      expect(storage.values['web.computers.saved_by'], 'ann');
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );

  test('Clear now takes the kept computers, and an unchanged list is not kept again', () async {
    final storage = MemoryStore();
    final app = _Account()..currentUser = _ann;
    addTearDown(app.dispose);
    final store = SavedComputers(storage);
    final own = SavedComputersWatch(app, store);
    addTearDown(own.dispose);
    app
      ..list('m1', 'Studio')
      ..answer();
    await pumpEventQueue();
    expect(await store.read('ann'), isNotNull);

    await own.clear();
    app.notifyListeners();
    await pumpEventQueue();
    expect(await store.read('ann'), isNull);
    expect(storage.values['web.computers.saved_by'], 'ann');

    app
      ..list('m2', 'Build server')
      ..notifyListeners();
    await pumpEventQueue();
    expect((await store.read('ann'))?.map((c) => c.name), [
      'Studio',
      'Build server',
    ]);
  });

  test('the browser\'s Clear now reaches the kept computers', () async {
    final storage = MemoryStore();
    final app = createApp(store: storage)..currentUser = _ann;
    addTearDown(app.dispose);
    savedComputersOf(app);
    await pumpEventQueue();
    await SavedComputers(storage).write('ann', _macs);
    expect(storage.values['web.computers.ann'], isNotNull);

    await app.browserCopies.clear();

    expect(storage.values['web.computers.ann'], isNull);
  });

  test('a session that expires forgets the kept computers, as it does the Super Tab views', () async {
    final storage = MemoryStore();
    final app = createApp(store: storage)
      ..status = AppStatus.authenticated
      ..currentUser = _ann;
    addTearDown(app.dispose);
    savedComputersOf(app);
    app.notifyListeners();
    await pumpEventQueue();
    await SavedComputers(storage).write('ann', _macs);
    expect(storage.values['web.computers.ann'], isNotNull);

    app.expireSessionForTest('Your sign-in expired. Sign in again.');
    await pumpEventQueue();

    expect(storage.values['web.computers.ann'], isNull);
    expect(storage.values['web.computers.saved_by'], isNull);
  });

  test('a browser that boots into an expired session forgets the last account\'s computers', () async {
    final storage = MemoryStore();
    await SavedComputers(storage).claim('ann');
    await SavedComputers(storage).write('ann', _macs);
    final app = createApp(store: storage);
    addTearDown(app.dispose);
    savedComputersOf(app);
    await pumpEventQueue();
    // Booting: who signed in is not known yet, so nothing is forgotten.
    expect(storage.values['web.computers.ann'], isNotNull);

    app
      ..status = AppStatus.unauthenticated
      ..notifyListeners();
    await pumpEventQueue();

    expect(storage.values['web.computers.ann'], isNull);
    expect(storage.values['web.computers.saved_by'], isNull);
  });

  testWidgets('the web frame keeps the computers from the app\'s start, before any workspace', (
    tester,
  ) async {
    final storage = MemoryStore();
    final app = createApp(store: storage)..status = AppStatus.unauthenticated;
    addTearDown(app.dispose);
    await tester.runAsync(() async {
      await SavedComputers(storage).claim('ann');
      await SavedComputers(storage).write('ann', _macs);
    });

    await tester.pumpWidget(
      ProviderScope(
        overrides: [appStateProvider.overrideWithValue(app)],
        child: const KeptComputers(child: SizedBox.shrink()),
      ),
    );
    await tester.runAsync(pumpEventQueue);

    expect(storage.values['web.computers.ann'], isNull);
  });

  group('the connect page', () {
    late _Account app;
    setUp(() => app = _Account()..currentUser = _ann);
    tearDown(() => app.dispose());

    Future<void> mount(WidgetTester tester, SavedComputersWatch saved) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: Scaffold(
            body: SingleChildScrollView(
              child: WebFirstMachine(app: app, saved: saved),
            ),
          ),
        ),
      );
    }

    testWidgets('draws the kept computers at once while the list is read', (
      tester,
    ) async {
      final store = SavedComputers(MemoryStore());
      await tester.runAsync(() async {
        await store.claim('ann');
        await store.write('ann', _macs);
      });
      final watch = SavedComputersWatch(app, store);
      addTearDown(watch.dispose);
      await tester.runAsync(pumpEventQueue);
      await mount(tester, watch);

      expect(find.text('Finding your computers…'), findsNothing);
      expect(find.text('Connect your computer'), findsOneWidget);
      expect(find.text('Studio'), findsOneWidget);
      expect(find.text('MacBookPro2021.local'), findsOneWidget);
      expect(find.text('Checking…'), findsNWidgets(2));
      expect(find.widgetWithText(FilledButton, 'Connect'), findsNothing);

      app
        ..list('m1', 'Studio')
        ..answer();
      await tester.pump();
      expect(find.text('Checking…'), findsNothing);
      expect(
        find.text('Offline. Open Harness on it, or run harness start there.'),
        findsOneWidget,
      );
      expect(find.text('MacBookPro2021.local'), findsNothing);
    });

    testWidgets('with nothing kept, it says it is looking', (tester) async {
      final watch = SavedComputersWatch(app, SavedComputers(MemoryStore()));
      addTearDown(watch.dispose);
      await tester.runAsync(pumpEventQueue);
      await mount(tester, watch);

      expect(find.text('Finding your computers…'), findsOneWidget);
    });
  });
}
