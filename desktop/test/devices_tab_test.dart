import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/settings/experimental_features.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/state/pane_layout_store.dart';
import 'package:harness/state/swarm.dart';

import 'support/experimental_settings.dart';
import 'swarm_screen_test.dart' show mount;
import 'swarm_state_test.dart' show MemoryStore, createApp;

void main() {
  for (final composerInBox in [false, true]) {
    testWidgets(
      'Devices stays hidden until enabled and owns focus (composerInBox=$composerInBox)',
      (tester) async {
        newHarnessOpensInBox = composerInBox;
        addTearDown(() => newHarnessOpensInBox = false);
        final storage = MemoryStore();
        final app = createApp(store: storage);
        app.experimentalFeatures.bind(
          'u1',
          transport: MemoryExperimentalTransport(storage),
        );
        await app.experimentalFeatures.refresh();
        await mount(tester, app);
        final button = find.byKey(const ValueKey('swarm-devices-button'));
        expect(button, findsNothing);
        app.openDevices();
        expect(app.activeSwarm.isDevices, isFalse);
        await app.experimentalFeatures.set(
          ExperimentalFeature.devicesTab,
          true,
        );
        await tester.pumpAndSettle();
        expect(button, findsOneWidget);
        expect(
          tester.getCenter(button).dx,
          greaterThan(
            tester
                .getCenter(find.byKey(const ValueKey('swarm-search-button')))
                .dx,
          ),
        );
        expect(
          tester.getCenter(button).dx,
          lessThan(
            tester
                .getCenter(find.byKey(const ValueKey('swarm-store-button')))
                .dx,
          ),
        );
        await tester.tap(button);
        await tester.pumpAndSettle();
        expect(app.activeSwarm.isDevices, isTrue);
        app.openDevices();
        expect(app.swarms.where((s) => s.isDevices), hasLength(1));
        expect(find.text('Add your first device'), findsOneWidget);
        expect(
          tester
              .widget<Offstage>(find.byKey(const ValueKey('workspace-canvas')))
              .offstage,
          isFalse,
        );
        final canvasFocus = find
            .descendant(
              of: find.byKey(const ValueKey('workspace-canvas')),
              matching: find.byType(ExcludeFocus, skipOffstage: false),
              skipOffstage: false,
            )
            .first;
        expect(tester.widget<ExcludeFocus>(canvasFocus).excluding, isFalse);
        expect(app.activeSwarm.panes, hasLength(2));
        final viewer = app.activeSwarm.panes.first;
        final chat = app.activeSwarm.panes.last;
        expect(viewer.isDevices, isTrue);
        expect(chat.isViewer, isFalse);
        expect(find.text('Devices chat'), findsOneWidget);
        final left = tester.getRect(
          find.byKey(ValueKey('pane-frame:${viewer.id}')),
        );
        final right = tester.getRect(
          find.byKey(ValueKey('pane-frame:${chat.id}')),
        );
        expect(left.right, lessThan(right.left));
        expect(left.width / (left.width + right.width), closeTo(.7, .01));
        await app.experimentalFeatures.set(
          ExperimentalFeature.devicesTab,
          false,
        );
        await tester.pumpAndSettle();
        expect(button, findsNothing);
        expect(app.swarms.any((s) => s.isDevices), isFalse);
        expect(find.text('Add your first device'), findsNothing);
        await app.experimentalFeatures.set(
          ExperimentalFeature.devicesTab,
          true,
        );
        app.openDevices();
        await tester.pumpAndSettle();
        app.currentUser = const CurrentUserProfile(
          id: 'u2',
          email: 'u2@example.test',
        );
        await tester.pumpAndSettle();
        expect(button, findsNothing);
        expect(app.swarms.any((s) => s.isDevices), isFalse);
        expect(find.text('Add your first device'), findsNothing);
        await tester.pumpWidget(const SizedBox());
        app.dispose();
      },
    );
  }

  test(
    'a saved Devices tab cannot appear when the experiment is off',
    () async {
      final storage = MemoryStore();
      await PaneLayoutStore(storage: storage).saveSwarms([
        Swarm(id: 'devices', name: 'Devices', kind: 'devices'),
        Swarm(id: 'work', name: 'Work'),
      ], 'devices');
      final app = createApp(store: storage);
      await app.restorePaneLayoutForTest();
      expect(app.swarms.any((s) => s.isDevices), isFalse);
      app.dispose();
    },
  );

  test(
    'restoring a Devices tab reserves chat before its conversation loads',
    () async {
      final storage = MemoryStore();
      await PaneLayoutStore(storage: storage).saveSwarms([
        Swarm(id: 'devices', name: 'Devices', kind: 'devices'),
      ], 'devices');
      final app = createApp(store: storage);
      app.experimentalFeatures.bind(
        'u1',
        transport: MemoryExperimentalTransport(storage),
      );
      await app.experimentalFeatures.refresh();
      await app.experimentalFeatures.set(ExperimentalFeature.devicesTab, true);
      await app.restorePaneLayoutForTest();
      final tab = app.swarms.singleWhere((tab) => tab.isDevices);
      expect(tab.panes, hasLength(2));
      expect(tab.panes.first.isDevices, isTrue);
      expect(tab.panes.last.agentId, isNull);
      expect(tab.manualLayout!.tiles.first.width, .7);
      app.dispose();
    },
  );

  test(
    'older servers keep existing experiments working with Devices unavailable',
    () async {
      final store = ExperimentalFeaturesStore(pollInterval: Duration.zero);
      store.bind('u1', transport: _OldServer());
      await store.refresh();
      expect(store.loaded, isTrue);
      expect(store.enabled(ExperimentalFeature.shareButton), isTrue);
      expect(store.enabled(ExperimentalFeature.devicesTab), isFalse);
      expect(store.isAvailable(ExperimentalFeature.devicesTab), isFalse);
      store.dispose();
    },
  );
}

class _OldServer implements ExperimentalSettingsTransport {
  @override
  Future<Map<String, dynamic>> read() async => {
    'accountId': 'u1',
    'revision': 1,
    'features': {'focus_bar_creature': false, 'share_button': true},
  };
  @override
  Future<Map<String, dynamic>> write(
    String accountId,
    ExperimentalFeature feature,
    bool enabled,
  ) => read();
}
