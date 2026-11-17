import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/app_shell.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/auth/cli_login.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/devices/device_app.dart';
import 'package:harness/devices/device_app_offer.dart';
import 'package:harness/devices/device_hosts.dart';
import 'package:harness/devices/devices_controller.dart';
import 'package:harness/devices/devices_screen.dart';
import 'package:harness/devices/loose_sheet.dart' show petRows;
import 'package:harness/devices/pet_source.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/dial_status.dart';

import '../devices_controller_test.dart' show deviceStatus, report;
import '../pet_settings_test.dart' show sheetPreview;
import '../support/device_app.dart';
import '../support/memory_key_value_store.dart';

/// The menu-bar app's offer as a person meets it: the real shell with its band, over the real Devices screen with
/// its row, both drawn from the one offer the app owns.
const _band = Key('device-app-band');
const _bandInstall = Key('device-app-band-install');
const _bandDismiss = Key('device-app-band-dismiss');
const _row = Key('device-app-row');
const _rowAction = Key('device-app-row-action');
const _rowFailure = Key('device-app-row-failure');
const _sentence =
    'Your dial follows apps and terminal tabs with the Harness menu-bar app.';

final _mac = TargetPlatformVariant.only(TargetPlatform.macOS);

class _SignedOutCli extends CliLogin {
  @override
  Future<void> logout() async {}

  @override
  Future<CliAuthStatus> checkStatus() async => CliAuthStatus(loggedIn: false);
}

/// The Devices tab reads no machine in a test: this Mac's dial is the one host it hears from, plus [others].
class _QuietDevicesApp extends AppNotifier {
  _QuietDevicesApp({required super.deviceAppOffer})
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      );

  /// Other computers' hosts, each with its dial's status.
  final others = <DeviceHost, DialStatus>{};

  @override
  Future<void> refreshDevices() async {
    deviceHosts.reconcile([
      const DeviceHost(id: 'here', name: 'This Mac', local: true, online: true),
      ...others.keys,
    ]);
    deviceHosts.receive('here', dial.status, revision: 1);
    for (final MapEntry(key: host, value: status) in others.entries) {
      deviceHosts.receive(host.id, status, revision: 1);
    }
  }
}

/// The real Devices tab over [app], reading its machines every 10 seconds.
Future<void> _pumpTab(WidgetTester tester, AppNotifier app) async {
  tester.view.physicalSize = const Size(1280, 940);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: DevicesTab(
          notifier: app,
          refreshEvery: const Duration(seconds: 10),
        ),
      ),
    ),
  );
  await tester.pump();
  await tester.pump();
  addTearDown(() => tester.pumpWidget(const SizedBox()));
}

AppNotifier _app(
  DeviceAppFixture fixture, {
  AppStatus status = AppStatus.authenticated,
}) {
  final app = AppNotifier(
    config: AppConfig.dev,
    authSession: AuthSession(),
    configStore: null,
    cliLogin: _SignedOutCli(),
    deviceAppOffer: fixture.offer,
  );
  app.status = status;
  app.currentUser = const CurrentUserProfile(
    id: 'user-1',
    name: 'Sam',
    email: 'sam@example.com',
  );
  return app;
}

/// The Devices screen over this computer's dial, as the Devices tab builds it.
Future<DevicesController> _controller(AppNotifier app) async {
  final controller = DevicesController(
    dial: app.dial,
    accountId: 'a',
    storage: MemoryKeyValueStore(),
    sendSettings: (_, _) async => true,
  );
  await controller.load();
  return controller;
}

/// The window: the shell, its bands, and the Devices screen under them.
Future<void> _pump(
  WidgetTester tester,
  AppNotifier app,
  DevicesController controller,
) async {
  tester.view.physicalSize = const Size(1280, 940);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    ProviderScope(
      overrides: [appStateProvider.overrideWithValue(app)],
      child: HarnessApp(
        authenticatedScreen: (app) => Scaffold(
          body: DevicesScreen(
            controller: controller,
            deviceAppOffer: app.deviceAppOffer,
          ),
        ),
      ),
    ),
  );
  final screen = find.byType(DevicesScreen);
  if (screen.evaluate().isNotEmpty) {
    await tester.runAsync(() async {
      final context = tester.element(screen);
      await Future.wait([
        for (final image in ['front', 'side', 'desk'])
          precacheImage(
            AssetImage('assets/devices/harness-$image.webp'),
            context,
          ),
        precacheImage(
          const AssetImage('assets/devices/harness-square.png'),
          context,
        ),
      ]);
    });
  }
  await tester.pump();
  await tester.pump();
}

Future<void> _tap(WidgetTester tester, Key key) async {
  await tester.ensureVisible(find.byKey(key));
  await tester.pump();
  await tester.tap(find.byKey(key));
  await tester.pump();
  await tester.pump();
}

/// The label of the button, or the text, under [key].
String _label(WidgetTester tester, Key key) => tester
    .widget<Text>(
      find.descendant(of: find.byKey(key), matching: find.byType(Text)).first,
    )
    .data!;

String _bandText(WidgetTester tester) =>
    tester.widget<Text>(find.byKey(_band)).data!;

void main() {
  testWidgets(
    'a dial and no menu-bar app: the band; Install installs, opens it, and the band goes',
    (tester) async {
      final fixture = DeviceAppFixture();
      final app = _app(fixture);
      addTearDown(app.dispose);
      final controller = await _controller(app);
      addTearDown(controller.dispose);
      report(app.dial, [deviceStatus('d1')]);
      await _pump(tester, app, controller);

      expect(_bandText(tester), _sentence);
      expect(_label(tester, _rowAction), 'Install');

      fixture.install.gate = Completer<void>();
      await _tap(tester, _bandInstall);
      expect(_label(tester, _bandInstall), 'Installing…');
      expect(_label(tester, _rowAction), 'Installing…');

      fixture.install.gate!.complete();
      await tester.pump();
      await tester.pump();
      expect(fixture.install.calls, 1);
      expect(find.byKey(_band), findsNothing);
      expect(find.byKey(_row), findsNothing);
    },
    variant: _mac,
  );

  testWidgets(
    'Not now hides the band, and it stays hidden after the window is built again',
    (tester) async {
      final fixture = DeviceAppFixture();
      final app = _app(fixture);
      addTearDown(app.dispose);
      final controller = await _controller(app);
      addTearDown(controller.dispose);
      report(app.dial, [deviceStatus('d1')]);
      await _pump(tester, app, controller);

      await _tap(tester, _bandDismiss);
      expect(find.byKey(_band), findsNothing);
      expect(_label(tester, _rowAction), 'Install');

      await tester.pumpWidget(const SizedBox());
      final again = DeviceAppFixture(store: fixture.store);
      final next = _app(again);
      addTearDown(next.dispose);
      final nextController = await _controller(next);
      addTearDown(nextController.dispose);
      report(next.dial, [deviceStatus('d1')]);
      await _pump(tester, next, nextController);

      expect(again.probe.lookups, greaterThan(0));
      expect(find.byKey(_band), findsNothing);
      expect(_label(tester, _rowAction), 'Install');
    },
    variant: _mac,
  );

  testWidgets('the Devices row: Install, then Open, then nothing', (
    tester,
  ) async {
    final fixture = DeviceAppFixture();
    final app = _app(fixture);
    addTearDown(app.dispose);
    final controller = await _controller(app);
    addTearDown(controller.dispose);
    report(app.dial, [deviceStatus('d1')]);
    await _pump(tester, app, controller);

    await _tap(tester, _rowAction);
    expect(fixture.install.calls, 1);
    expect(find.byKey(_row), findsNothing);

    fixture.probe.presence = installedNotRunning;
    await fixture.offer.refresh();
    await tester.pump();
    expect(_label(tester, _rowAction), 'Open');
    expect(find.byKey(_band), findsNothing);

    await _tap(tester, _rowAction);
    expect(fixture.open.paths, hasLength(1));

    fixture.probe.presence = installedRunning;
    await fixture.offer.refresh();
    await tester.pump();
    expect(find.byKey(_row), findsNothing);
    expect(find.byKey(_band), findsNothing);
  }, variant: _mac);

  testWidgets('a failed install shows its line and Retry on both', (
    tester,
  ) async {
    final fixture = DeviceAppFixture();
    final app = _app(fixture);
    addTearDown(app.dispose);
    final controller = await _controller(app);
    addTearDown(controller.dispose);
    report(app.dial, [deviceStatus('d1')]);
    await _pump(tester, app, controller);

    fixture.install.result = const DeviceAppInstallResult.failed(
      DeviceAppInstallStep.signature,
    );
    await _tap(tester, _bandInstall);
    expect(_bandText(tester), 'Couldn’t verify the download.');
    expect(_label(tester, _bandInstall), 'Retry');
    expect(
      tester.widget<Text>(find.byKey(_rowFailure)).data,
      'Couldn’t verify the download.',
    );
    expect(_label(tester, _rowAction), 'Retry');

    fixture.install.result = const DeviceAppInstallResult.done(
      '/t/Harness Device.app',
    );
    await _tap(tester, _rowAction);
    expect(fixture.install.calls, 2);
    expect(find.byKey(_band), findsNothing);
    expect(find.byKey(_row), findsNothing);
  }, variant: _mac);

  testWidgets('a dial on another computer: no row', (tester) async {
    final fixture = DeviceAppFixture();
    final app = _app(fixture);
    addTearDown(app.dispose);
    final hosts = DeviceHosts();
    addTearDown(hosts.dispose);
    hosts.reconcile([const DeviceHost(id: 'm', name: 'Mac', online: true)]);
    hosts.receive(
      'm',
      DialStatus(attached: true, devices: [deviceStatus('usb')]),
      revision: 1,
    );
    final controller = DevicesController(
      hosts: hosts,
      accountId: 'a',
      storage: MemoryKeyValueStore(),
      sendHostSettings: (_, _, _) async => true,
    );
    addTearDown(controller.dispose);
    await controller.load();
    expect(controller.devices.single.local, isFalse);
    fixture.offer.dialChanged(true);
    await _pump(tester, app, controller);

    expect(_bandText(tester), _sentence);
    expect(find.byKey(_row), findsNothing);
  }, variant: _mac);

  testWidgets('a Harness Pro alone: the same band and row', (tester) async {
    final fixture = DeviceAppFixture();
    final app = _app(fixture);
    addTearDown(app.dispose);
    final controller = await _controller(app);
    addTearDown(controller.dispose);
    final pro = DialStatus.fromJson({
      'id': 'pro',
      'mac': '00:11:22:33:pro',
      'attached': true,
      'fw': '0.1.14',
      'board': 'pro',
      'settings': {
        'brightness': 80,
        'character': 2,
        'face': 720,
        'round': false,
        'muted': true,
        'quiet': false,
        'straightTitle': true,
        'focusFace': false,
        'scrollReversed': false,
        'voiceLang': 'en',
      },
    });
    expect(pro.isPro, isTrue);
    report(app.dial, [pro]);
    await _pump(tester, app, controller);

    expect(_bandText(tester), _sentence);
    expect(
      find.descendant(
        of: find.byKey(_row),
        matching: find.text('Menu-bar app'),
      ),
      findsOneWidget,
    );
    expect(_label(tester, _rowAction), 'Install');

    await _tap(tester, _bandInstall);
    expect(fixture.install.calls, 1);
  }, variant: _mac);

  testWidgets(
    'the pet viewer stays level with the Pet section as the row goes',
    (tester) async {
      final fixture = DeviceAppFixture();
      addTearDown(fixture.offer.dispose);
      final dial = DialState();
      final controller = DevicesController(
        dial: dial,
        accountId: 'a',
        storage: MemoryKeyValueStore(),
        sendSettings: (_, _) async => true,
        petRequest: (_, type, _) async => type == 'pet_status'
            ? {
                'mapping': {'all': null, 'engines': <String, String>{}},
                'dial': {'supported': true, 'held': <String>[]},
              }
            : sheetPreview('boba', petRows),
      );
      addTearDown(controller.dispose);
      await controller.load();
      report(dial, [deviceStatus('d1')]);
      fixture.offer.dialChanged(true);
      await fixture.offer.refresh();
      tester.view.physicalSize = const Size(1280, 940);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      // No shell: only the offer rebuilds the screen as the row goes.
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: DevicesScreen(
              controller: controller,
              deviceAppOffer: fixture.offer,
              pickPetFile: () async => '/tmp/boba.png',
              resolvePetSource: (path) async =>
                  PetSource(pngPath: path, name: 'boba', cleanup: () async {}),
              loadPetSheet: (_) async => null,
            ),
          ),
        ),
      );
      await tester.pump();
      await tester.pump();
      addTearDown(() => tester.pumpWidget(const SizedBox()));

      fixture.install.gate = Completer<void>();
      await _tap(tester, _rowAction);
      expect(_label(tester, _rowAction), 'Installing…');
      await tester.ensureVisible(find.text('Choose file…'));
      await tester.pump();
      await tester.tap(find.text('Choose file…'));
      for (var i = 0; i < 4; i++) {
        await tester.pump();
      }
      final viewer = find.byKey(const ValueKey('devices-pet-viewer'));
      final panel = find.byKey(const ValueKey('pet-panel'));
      expect(
        tester.getRect(viewer).top,
        moreOrLessEquals(tester.getRect(panel).top, epsilon: .5),
      );

      fixture.install.gate!.complete();
      for (var i = 0; i < 4; i++) {
        await tester.pump();
      }
      expect(find.byKey(_row), findsNothing);
      expect(
        tester.getRect(viewer).top,
        moreOrLessEquals(tester.getRect(panel).top, epsilon: .5),
      );
    },
    variant: _mac,
  );

  testWidgets("the Devices tab shows the row, and its tick looks again", (
    tester,
  ) async {
    final fixture = DeviceAppFixture();
    final app = _QuietDevicesApp(deviceAppOffer: fixture.offer);
    addTearDown(app.dispose);
    report(app.dial, [deviceStatus('d1')]);
    await _pumpTab(tester, app);
    expect(_label(tester, _rowAction), 'Install');
    final before = fixture.probe.lookups;
    expect(before, greaterThan(0));

    await tester.pump(const Duration(seconds: 10));
    expect(fixture.probe.lookups, before + 1);

    // Hidden, the tab looks no more; seen again, it looks once.
    addTearDown(
      () => tester.binding.handleAppLifecycleStateChanged(
        AppLifecycleState.resumed,
      ),
    );
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    await tester.pump(const Duration(seconds: 30));
    expect(fixture.probe.lookups, before + 1);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pump();
    expect(fixture.probe.lookups, before + 2);
  }, variant: _mac);

  testWidgets(
    "the Devices tab: another computer's dial selected shows no row",
    (tester) async {
      final fixture = DeviceAppFixture();
      final app = _QuietDevicesApp(deviceAppOffer: fixture.offer);
      addTearDown(app.dispose);
      app.others[const DeviceHost(
        id: 'there',
        name: 'Other Mac',
        online: true,
      )] = DialStatus(
        attached: true,
        devices: [deviceStatus('d2')],
      );
      report(app.dial, [deviceStatus('d1')]);
      await _pumpTab(tester, app);
      expect(_label(tester, _rowAction), 'Install');

      await tester.tap(find.text('Other Mac'));
      await tester.pump();
      expect(find.byKey(_row), findsNothing);

      await tester.tap(find.text('This Mac'));
      await tester.pump();
      expect(_label(tester, _rowAction), 'Install');
    },
    variant: _mac,
  );

  testWidgets('before the workspace: no band', (tester) async {
    final fixture = DeviceAppFixture();
    final app = _app(fixture, status: AppStatus.unauthenticated);
    addTearDown(app.dispose);
    final controller = await _controller(app);
    addTearDown(controller.dispose);
    report(app.dial, [deviceStatus('d1')]);
    await fixture.offer.refresh();
    expect(fixture.offer.state, DeviceAppOfferState.offer);
    await _pump(tester, app, controller);

    expect(find.byKey(_band), findsNothing);
  });

  testWidgets('Linux shows nothing', (tester) async {
    final fixture = DeviceAppFixture(
      supported: deviceAppSupported(
        osVersion: 'Version 15.6 (Build 24G84)',
        viewer: false,
      ),
    );
    final app = _app(fixture);
    addTearDown(app.dispose);
    final controller = await _controller(app);
    addTearDown(controller.dispose);
    report(app.dial, [deviceStatus('d1')]);
    await _pump(tester, app, controller);

    expect(find.byKey(_band), findsNothing);
    expect(find.byKey(_row), findsNothing);
    expect(fixture.probe.lookups, 0);
  }, variant: TargetPlatformVariant.only(TargetPlatform.linux));
}
