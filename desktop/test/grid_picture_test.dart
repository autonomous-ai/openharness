// The app-level picture of what the account's grids serve, and the surfaces that refresh it (the Model
// Manager, the pane picker) keeping quiet while the app is in the background. (The macOS Models menu
// this also covered was removed on main in #303 — Models opens from the View menu now.)
// grid-reads-without-waking issue 02, desktop half.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/models/model_manager_controller.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/widgets/grid_model_picker.dart';
import 'package:harness/ws/ws_conn.dart';

import 'support/model_manager.dart';
import 'swarm_state_test.dart' show MemoryStore, createApp;

/// A daemon that answers `grid_models_list` from [reply] and counts every time it is asked.
class _Daemon extends WsConn {
  _Daemon(this.reply)
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );

  Map<String, dynamic> reply;
  int asked = 0;

  /// When set, the next `grid_models_list` waits on it — so a test can land a push while a read is
  /// still out.
  Completer<void>? hold;

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    if (type != 'grid_models_list') return {};
    asked++;
    final held = hold;
    if (held != null) {
      hold = null;
      final answer = reply;
      await held.future;
      return answer;
    }
    return reply;
  }
}

Map<String, dynamic> _reply({
  String state = 'awake',
  String node = 'macbook',
  List<String> ids = const ['Qwen3.5-4B'],
  bool withNewFields = true,
}) => {
  'gridName': 'home',
  'models': [
    for (final id in ids) {'id': id, 'node': node},
  ],
  'grids': [
    {
      'name': 'home',
      'type': 'permissioned-public',
      'own': true,
      'models': [
        for (final id in ids) {'id': id, 'node': node},
      ],
      if (withNewFields) ...{
        'state': state,
        'seenAt': '2026-09-24T08:00:00.000Z',
        'lastKnownAge': 42,
      },
    },
  ],
  'supportsModelLaunch': true,
};

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('GridModels.fromReply', () {
    test('reads the three optional fields a newer daemon adds', () {
      final answer = GridModels.fromReply(_reply(state: 'asleep'));
      final section = answer.sections.single;
      expect(section.state, GridSectionState.asleep);
      expect(section.seenAt, DateTime.utc(2026, 9, 24, 8));
      expect(section.lastKnownAge, 42);
      // The sleeping section keeps its last known models — never blanked.
      expect(section.models.single.id, 'Qwen3.5-4B');
    });

    test('an older daemon that sends none of them reads exactly as before', () {
      final answer = GridModels.fromReply(_reply(withNewFields: false));
      final section = answer.sections.single;
      expect(section.state, isNull);
      expect(section.seenAt, isNull);
      expect(section.lastKnownAge, isNull);
      expect(section.name, 'home');
      expect(section.own, isTrue);
      expect(section.models.single.node, 'macbook');
      expect(section.models.single.grid, 'home');
      expect(answer.models.single.id, 'Qwen3.5-4B');
      expect(answer.reachable, isTrue);
      expect(answer.supportsModelLaunch, isTrue);
    });

    test('a state it does not know, a negative age and a bad time are no claim at all', () {
      final raw = _reply();
      final grid = (raw['grids'] as List).single as Map<String, dynamic>;
      grid['state'] = 'hibernating';
      grid['lastKnownAge'] = -5;
      grid['seenAt'] = 'yesterday';
      final section = GridModels.fromReply(raw).sections.single;
      expect(section.state, isNull);
      expect(section.lastKnownAge, isNull);
      expect(section.seenAt, isNull);
    });
  });

  group('the app-level picture', () {
    late _Daemon daemon;
    late AppNotifier app;
    setUp(() {
      daemon = _Daemon(_reply());
      app = createApp(connectionForTest: (_) => daemon);
    });
    tearDown(() => app.dispose());

    test('a grid_models_changed push replaces it with no request', () async {
      expect(app.gridPictures['m'], isNull);
      await app.handleEventForTest('m', {
        'type': 'grid_models_changed',
        'payload': _reply(state: 'asleep', node: 'studio'),
      });
      final picture = app.gridPictures['m']!;
      expect(picture.sections.single.state, GridSectionState.asleep);
      expect(picture.sections.single.models.single.node, 'studio');
      expect(daemon.asked, 0);
    });

    test(
      'every read feeds it, and reads that overlap are one request',
      () async {
        final first = app.refreshGridModels('m');
        final second = app.refreshGridModels('m');
        expect(identical(await first, await second), isTrue);
        expect(daemon.asked, 1);
        expect(
          app.gridPictures['m']!.sections.single.state,
          GridSectionState.awake,
        );
      },
    );

    test(
      'a read that was out when a push landed does not overwrite the push',
      () async {
        final hold = daemon.hold = Completer<void>();
        final read = app.refreshGridModels('m');
        await app.handleEventForTest('m', {
          'type': 'grid_models_changed',
          'payload': _reply(state: 'asleep'),
        });
        hold.complete();
        await read;
        expect(
          app.gridPictures['m']!.sections.single.state,
          GridSectionState.asleep,
        );
      },
    );

    test(
      'a read that could not reach the machine keeps the last good picture for every surface',
      () async {
        await app.refreshGridModels('m');
        daemon.reply = {'error': 'GRID_MODELS_FAILED'};

        // The caller that must know (the creation check) still hears that the machine did not answer…
        expect((await app.refreshGridModels('m')).reachable, isFalse);
        // …while the picture every other surface shows stays the last list it had.
        final picture = await app.readGridPicture('m');
        expect(picture.reachable, isTrue);
        expect(picture.sections.single.models.single.id, 'Qwen3.5-4B');
        expect(app.gridPictures['m']!.reachable, isTrue);
      },
    );

    test('the foreground flag follows the lifecycle, unknown counting as foreground', () {
      expect(app.inForeground, isTrue);
      app.appLifecycleChanged(AppLifecycleState.inactive);
      expect(app.inForeground, isFalse);
      app.appLifecycleChanged(AppLifecycleState.hidden);
      expect(app.inForeground, isFalse);
      app.appLifecycleChanged(AppLifecycleState.resumed);
      expect(app.inForeground, isTrue);
      app.appLifecycleChanged(null);
      expect(app.inForeground, isTrue);
    });
  });

  group('the Model Manager timer', () {
    late ModelManagerTestApp app;
    setUp(() => app = ModelManagerTestApp(ModelManagerConnection()));
    tearDown(() => app.dispose());

    // Each test owns its controller and disposes it before the test ends: its 4 s timer is a fake
    // timer inside `testWidgets`, and one left running fails the test.
    ModelManagerController manager() =>
        ModelManagerController(app, storage: MemoryStore())
          // The visible panel is the tick that reads every 4 s whatever the clock says — the idle
          // 60 s read compares `DateTime.now()`, which fake time does not move.
          ..setPanelVisible(true);

    testWidgets(
      'a background app runs none of it, and one refresh runs on return',
      (tester) async {
        final controller = manager();
        app.appLifecycleChanged(AppLifecycleState.hidden);
        controller.start();
        await tester.pump();
        for (var i = 0; i < 30; i++) {
          await tester.pump(const Duration(seconds: 4));
        }
        expect(app.localReads, 0);
        expect(app.gridReads, 0);

        app.appLifecycleChanged(AppLifecycleState.resumed);
        await tester.pump();
        expect(app.localReads, 1);
        expect(app.gridReads, 1);
        controller.dispose();
        await tester.pump(const Duration(seconds: 10));
      },
    );

    testWidgets('in the foreground it reads as it always did', (tester) async {
      final controller = manager();
      controller.start();
      await tester.pump();
      final first = app.localReads;
      expect(first, 1);
      await tester.pump(const Duration(seconds: 4));
      expect(app.localReads, 2);
      controller.dispose();
      await tester.pump(const Duration(seconds: 10));
    });

    testWidgets('a push reaches the manager with no read of its own', (
      tester,
    ) async {
      final controller = manager();
      controller.start();
      await tester.pump();
      final reads = app.gridReads;
      await app.handleEventForTest('m', {
        'type': 'grid_models_changed',
        'payload': _reply(ids: ['Pushed-Model']),
      });
      expect(controller.sections.single.models.single.id, 'Pushed-Model');
      expect(app.gridReads, reads);
      controller.dispose();
      await tester.pump(const Duration(seconds: 10));
    });
  });

  group('the pane picker prefetch', () {
    late _Daemon daemon;
    late AppNotifier app;
    setUp(() {
      daemon = _Daemon(_reply());
      app = createApp(connectionForTest: (_) => daemon);
    });
    tearDown(() => app.dispose());

    Future<void> mount(WidgetTester tester) => tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Center(
            child: GridModelPicker(
              notifier: app,
              machineId: 'm',
              engineLabel: 'claude',
            ),
          ),
        ),
      ),
    );

    testWidgets('does not run in the background, and runs once on return', (
      tester,
    ) async {
      app.appLifecycleChanged(AppLifecycleState.inactive);
      await mount(tester);
      await tester.pump();
      expect(daemon.asked, 0);
      app.appLifecycleChanged(AppLifecycleState.resumed);
      await tester.pump();
      expect(daemon.asked, 1);
      app.appLifecycleChanged(AppLifecycleState.inactive);
      app.appLifecycleChanged(AppLifecycleState.resumed);
      await tester.pump();
      // A picker that is already warm owes nothing on a second return.
      expect(daemon.asked, 1);
    });

    testWidgets('in the foreground it warms as it always did', (tester) async {
      await mount(tester);
      await tester.pump();
      expect(daemon.asked, 1);
    });

    testWidgets('a push lands in the open menu with no request', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(1200, 900);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await mount(tester);
      await tester.tap(find.byType(GridModelPicker));
      await tester.pumpAndSettle();
      expect(find.text('Qwen3.5-4B'), findsOneWidget);
      final asked = daemon.asked;
      await app.handleEventForTest('m', {
        'type': 'grid_models_changed',
        'payload': _reply(ids: ['Pushed-Model']),
      });
      await tester.pumpAndSettle();
      expect(find.text('Pushed-Model'), findsOneWidget);
      expect(daemon.asked, asked);
    });
  });
}
