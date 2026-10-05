import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/dsh_catalog.dart';
import 'package:harness/core/models.dart';
import 'package:harness/daemons/zoo_controller.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/settings/experimental_features.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/state/swarm_search.dart';
import 'package:harness/state/swarm_catalog.dart';
import 'package:harness/store/experimental_harnesses.dart';
import 'package:harness/store/store_controller.dart';
import 'package:harness/store/store_discover.dart';
import 'package:harness/store/store_models.dart';
import 'package:harness/store/store_screen.dart';
import 'package:harness/widgets/open_harness_intent.dart';

import 'experimental_features_test.dart' show AccountSettings;
import 'daemons/zoo_test.dart' show FakeZooTransport;
import 'support/real_fonts.dart';

const _ordinary = DshEntry(
  id: 'autonomous/marp',
  name: 'Marp',
  engine: 'claude',
);
// Even a daemon that advertises the internal records cannot bypass the flags
// or turn a generated companion into a separately installable product.
const _advertised = [
  _ordinary,
  DshEntry(
    id: 'autonomous/devices',
    name: 'Devices',
    engine: 'codex',
    installed: true,
    updateAvailable: true,
  ),
  DshEntry(
    id: 'autonomous/pair',
    name: 'Tim',
    engine: 'codex',
    installed: true,
    updateAvailable: true,
  ),
];

class _App extends AppNotifier {
  _App()
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      );
  @override
  Future<void> probeDsh(String machineId, {bool force = false}) async {}
  @override
  Future<void> probeEngines(String machineId, {bool force = false}) async {}
  @override
  Future<String?> installDsh(
    String machineId,
    String id, {
    bool trustUnverified = false,
  }) async =>
      throw StateError('Bundled workspaces must not be installed from Store');
  @override
  Future<String?> updateDsh(
    String machineId,
    String id, {
    bool trustUnverified = false,
  }) async => throw StateError('Bundled workspaces update with Harness');
  @override
  Future<String?> removeDsh(String machineId, String id) async =>
      throw StateError('Bundled workspaces cannot be removed from Store');
}

class _Store implements StoreApi {
  @override
  Future<List<StoreRating>> ratings() async => [];
  @override
  Future<StoreReviews> reviews(String id) async =>
      StoreReviews(rating: StoreRating.none(id), reviews: const [], mine: null);
  @override
  Future<void> deleteReview(String id) async {}
  @override
  Future<StoreReview> putReview(
    String id, {
    required int rating,
    String? title,
    String? body,
  }) => throw UnimplementedError();
}

Future<AccountSettings> _bind(ExperimentalFeaturesStore features) async {
  final server = AccountSettings('account-a');
  features.bind('account-a', transport: server);
  await features.refresh();
  return server;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() async {
    await loadRealFonts();
    await (FontLoader('packages/lucide_icons_flutter/Lucide400')..addFont(
          rootBundle.load(
            'packages/lucide_icons_flutter/assets/build_font/LucideVariable-w400.ttf',
          ),
        ))
        .load();
  });

  test('each confirmed flag controls its own listing, including advertised records', () async {
    final features = ExperimentalFeaturesStore(pollInterval: Duration.zero);
    addTearDown(features.dispose);
    List<DshEntry> visible() =>
        storeVisibleHarnesses(_advertised, features).toList();
    expect(visible(), [_ordinary]);
    final server = await _bind(features);
    expect(visible(), [_ordinary]);
    for (final harness in ExperimentalStoreHarness.values) {
      final ack = Completer<Map<String, dynamic>>();
      server.writeOverride = () => ack.future;
      final saving = features.set(harness.feature, true);
      expect(visible(), [
        _ordinary,
      ], reason: 'Wait for account acknowledgement');
      server.features[harness.feature.id] = true;
      server.revision++;
      ack.complete(server.snapshot);
      await saving;
      expect(visible(), [_ordinary, harness.entry]);
      server.writeOverride = null;
      await features.set(harness.feature, false);
      expect(visible(), [_ordinary]);
    }
    for (final harness in ExperimentalStoreHarness.values) {
      await features.set(harness.feature, true);
    }
    expect(visible().map((entry) => entry.name), [
      'Marp',
      'Devices',
      'Companions',
    ]);
    await features.set(ExperimentalFeature.devicesTab, false);
    expect(visible().map((entry) => entry.name), ['Marp', 'Companions']);
    features.bind('account-b');
    expect(visible(), [
      _ordinary,
    ], reason: 'Never inherit another account’s flags');
  });

  test(
    'unavailable experiments and failed saves cannot reveal a listing',
    () async {
      final features = ExperimentalFeaturesStore(pollInterval: Duration.zero);
      addTearDown(features.dispose);
      final server = await _bind(features);
      server.writeOverride = () async => throw StateError('offline');
      await features.set(ExperimentalFeature.devicesTab, true);
      expect(storeVisibleHarnesses(_advertised, features), [_ordinary]);
      server.features[ExperimentalFeature.devicesTab.id] = true;
      server.revision++;
      server.readOverride = () async => {
        ...server.snapshot,
        'available': {ExperimentalFeature.devicesTab.id: false},
      };
      await features.refresh();
      expect(storeVisibleHarnesses(_advertised, features), [_ordinary]);
    },
  );

  test('an open Store search refreshes on flags and account changes', () async {
    final app = _App();
    addTearDown(app.dispose);
    app.machineStates['m'] = MachineState(
      const Machine(machineId: 'm', authMode: MachineAuthMode.remote),
    )..dsh.replace(_advertised);
    await _bind(app.experimentalFeatures);
    final search = SwarmSearchController(app, [])..setQuery('*');
    addTearDown(search.dispose);
    expect(search.isStoreMode, isTrue);
    expect(search.storeEntries.keys, [_ordinary.id]);
    for (final harness in ExperimentalStoreHarness.values) {
      await app.experimentalFeatures.set(harness.feature, true);
    }
    expect(
      search.storeEntries.keys,
      containsAll(['autonomous/devices', 'autonomous/pair']),
    );
    search.setQuery('* companions');
    expect(search.rows.single.storeId, 'autonomous/pair');
    await app.experimentalFeatures.set(
      ExperimentalFeature.focusBarCreature,
      false,
    );
    expect(
      search.rows.where((row) => row.storeId == 'autonomous/pair'),
      isEmpty,
    );
    expect(search.storeEntries, contains('autonomous/devices'));
    app.experimentalFeatures.bind(null);
    expect(search.storeEntries.keys, [_ordinary.id]);
  });

  Future<_App> mount(
    WidgetTester tester, {
    String? id,
    bool local = true,
    bool enabled = true,
    Size size = const Size(1200, 900),
    Brightness brightness = Brightness.dark,
    double scale = 1,
    GlobalKey? boundary,
  }) async {
    tester.view.physicalSize = size;
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final previousBrightness = grid.AppTheme.brightness.value;
    grid.AppTheme.brightness.value = brightness;
    addTearDown(() => grid.AppTheme.brightness.value = previousBrightness);
    final app = _App();
    addTearDown(app.dispose);
    if (local) {
      app.machineStates['m'] =
          MachineState(
              const Machine(
                machineId: 'm',
                name: 'This Mac',
                authMode: MachineAuthMode.remote,
              ),
            )
            ..localOnly = true
            ..dsh.replace(_advertised);
    }
    await _bind(app.experimentalFeatures);
    if (id != null && enabled) {
      await app.experimentalFeatures.set(
        ExperimentalStoreHarness.forId(id)!.feature,
        true,
      );
    }
    app.openStore();
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: brightness),
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context)
              .copyWith(textScaler: TextScaler.linear(scale)),
          child: grid.BrightnessScope(child: child!),
        ),
        home: Actions(
          actions: {
            OpenHarnessIntent: CallbackAction<OpenHarnessIntent>(
              onInvoke: (_) => throw StateError(
                'Use the existing app workspace, not generic creation',
              ),
            ),
          },
          child: RepaintBoundary(
            key: boundary,
            child: Scaffold(
              body: StoreTab(notifier: app, api: _Store(), initialHarness: id),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    return app;
  }

  testWidgets(
    'Store listings and an open product page follow live flag changes',
    (tester) async {
      final app = await mount(tester);
      List<String> ids() => tester
          .widget<StoreDiscover>(find.byType(StoreDiscover))
          .entries
          .map((entry) => entry.id)
          .toList();
      expect(ids(), isNot(contains('autonomous/devices')));
      expect(ids(), isNot(contains('autonomous/pair')));
      await app.experimentalFeatures.set(ExperimentalFeature.devicesTab, true);
      await tester.pumpAndSettle();
      expect(ids(), contains('autonomous/devices'));
      expect(ids(), isNot(contains('autonomous/pair')));
      // Open from Store discovery; its canonical product identity is stable.
      final card = find.byKey(const ValueKey('store-card:autonomous/devices'));
      await tester.ensureVisible(card);
      await tester.tap(card);
      await tester.pumpAndSettle();
      expect(find.text('Open'), findsOneWidget);
      final oldOpen = tester
          .widget<FilledButton>(
            find.byKey(const ValueKey('store-primary-action')),
          )
          .onPressed!;
      await app.experimentalFeatures.set(ExperimentalFeature.devicesTab, false);
      // An already captured callback must be harmless even before the next frame.
      oldOpen();
      expect(app.activeSwarm.isStore, isTrue);
      await tester.pumpAndSettle();
      expect(find.text('Open'), findsNothing);
      expect(ids(), isNot(contains('autonomous/devices')));
      await tester.pumpWidget(const SizedBox());
    },
  );

  for (final harness in ExperimentalStoreHarness.values) {
    testWidgets(
      'a disabled ${harness.entry.name} deep link cannot expose its page',
      (tester) async {
        final app = await mount(tester, id: harness.entry.id, enabled: false);
        expect(find.byType(StoreDiscover), findsOneWidget);
        expect(
          find.byKey(const ValueKey('store-primary-action')),
          findsNothing,
        );
        await openStoreAgent(
          tester.element(find.byType(StoreTab)),
          app,
          harness.entry.id,
          'm',
        );
        expect(app.activeSwarm.isStore, isTrue);
        expect(app.swarms, hasLength(1));
        await tester.pumpWidget(const SizedBox());
      },
    );
    for (final local in [false, true]) {
      testWidgets(
        '${harness.entry.name} opens and reuses its app workspace (local=$local)',
        (tester) async {
          final app = await mount(tester, id: harness.entry.id, local: local);
          expect(find.text('Open'), findsOneWidget);
          expect(find.text('Get'), findsNothing);
          expect(find.text('Update'), findsNothing);
          expect(find.text('Remove'), findsNothing);
          expect(find.textContaining('Included with Harness'), findsOneWidget);
          final storeTab = app.activeSwarm;
          await tester.tap(find.byKey(const ValueKey('store-primary-action')));
          await tester.pumpAndSettle();
          final workspace = app.activeSwarm;
          expect(
            harness == ExperimentalStoreHarness.devices
                ? workspace.isDevices
                : workspace.isCompanions,
            isTrue,
          );
          expect(workspace.panes, hasLength(2));
          expect(workspace.manualLayout!.tiles.first.width, .7);
          app.selectSwarm(storeTab.id);
          await tester.pumpAndSettle();
          await tester.tap(find.byKey(const ValueKey('store-primary-action')));
          expect(app.activeSwarm, same(workspace));
          expect(app.swarms, hasLength(2));
          expect(tester.takeException(), isNull);
          await tester.pumpWidget(const SizedBox());
        },
      );
    }
  }

  testWidgets(
    'Store opens Companions with both panes while its collection loads',
    (tester) async {
      tester.view.physicalSize = const Size(1280, 900);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      final app = _App()
        ..currentUser = const CurrentUserProfile(
          id: 'account-a',
          email: 'a@example.test',
        );
      final projects = SwarmProjectStore();
      final zoo = ZooController();
      final remote = FakeZooTransport()..gate = Completer<void>();
      addTearDown(app.dispose);
      addTearDown(projects.dispose);
      addTearDown(zoo.dispose);
      await _bind(app.experimentalFeatures);
      await app.experimentalFeatures.set(
        ExperimentalFeature.focusBarCreature,
        true,
      );
      app.openStore();
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: SwarmScreen(
            notifier: app,
            nativeTabs: false,
            projectStore: projects,
            zoo: zoo,
            zooTransport: remote,
            daemonClock: tester.binding.clock.now,
          ),
        ),
      );
      await tester.pump(const Duration(milliseconds: 100));
      await openStoreAgent(
        tester.element(find.byType(StoreTab)),
        app,
        'autonomous/pair',
        '',
      );
      final panes = app.panes.toList();
      expect(
        panes,
        hasLength(2),
        reason: 'Reserve chat before asynchronous collection setup',
      );
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.text('Opening your collection…'), findsOneWidget);
      final chat = find.byKey(const ValueKey('companion-conversation-setup'));
      expect(chat, findsOneWidget);
      final viewerRect = tester.getRect(
        find.byKey(ValueKey('pane-frame:${panes.first.id}')),
      );
      final chatRect = tester.getRect(
        find.byKey(ValueKey('pane-frame:${panes.last.id}')),
      );
      expect(viewerRect.right, lessThan(chatRect.left));
      expect(
        viewerRect.width / (viewerRect.width + chatRect.width),
        closeTo(.7, .01),
      );
      remote.gate!.complete();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));
      expect(zoo.loaded, isTrue);
      expect(app.panes, panes);
      expect(
        chat,
        findsOneWidget,
        reason: 'Unpaired companion retains its chat slot',
      );
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );

  for (final (label, size, brightness, scale) in [
    ('dark', const Size(1200, 900), Brightness.dark, 1.0),
    ('light-large-text', const Size(800, 760), Brightness.light, 2.0),
  ]) {
    for (final harness in ExperimentalStoreHarness.values) {
      testWidgets('${harness.entry.name} Store page renders at $label', (
        tester,
      ) async {
        final boundary = GlobalKey();
        await mount(
          tester,
          id: harness.entry.id,
          size: size,
          brightness: brightness,
          scale: scale,
          boundary: boundary,
        );
        final open = find.byKey(const ValueKey('store-primary-action'));
        await tester.ensureVisible(open);
        await tester.pumpAndSettle();
        expect(tester.widget<FilledButton>(open).onPressed, isNotNull);
        expect(tester.takeException(), isNull);
        final output =
            Platform.environment['HARNESS_STORE_EXPERIMENT_CAPTURE_DIR'];
        if (output != null) {
          await tester.runAsync(() async {
            final render =
                boundary.currentContext!.findRenderObject()!
                    as RenderRepaintBoundary;
            final image = await render.toImage(pixelRatio: 1);
            final data = await image.toByteData(format: ui.ImageByteFormat.png);
            await Directory(output).create(recursive: true);
            await File('$output/${harness.name}-$label.png')
                .writeAsBytes(data!.buffer.asUint8List());
            image.dispose();
          });
        }
        await tester.pumpWidget(const SizedBox());
      });
    }
  }
}
