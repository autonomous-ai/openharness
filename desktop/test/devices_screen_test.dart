import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/devices/device_settings.dart';
import 'package:harness/devices/device_artwork.dart';
import 'package:harness/devices/device_hosts.dart';
import 'package:harness/devices/devices_controller.dart';
import 'package:harness/devices/devices_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/dial_status.dart';

import 'devices_controller_test.dart' show deviceStatus, report;
import 'support/real_fonts.dart';
import 'swarm_state_test.dart' show MemoryStore;

void main() {
  setUpAll(() async {
    await loadRealFonts();
    if (Platform.isMacOS) {
      final bytes = ByteData.sublistView(
        await File('/System/Library/Fonts/SFNS.ttf').readAsBytes(),
      );
      for (final family in ['.AppleSystemUIFont', 'SF Pro Text', 'Roboto']) {
        await (FontLoader(family)..addFont(Future.value(bytes))).load();
      }
    }
    final iconBytes = await rootBundle.load(
      'packages/lucide_icons_flutter/assets/lucide.ttf',
    );
    await (FontLoader(
      'packages/lucide_icons_flutter/Lucide400',
    )..addFont(Future.value(iconBytes))).load();
  });

  Future<void> pump(
    WidgetTester tester,
    DevicesController controller, {
    Brightness brightness = Brightness.light,
    Size size = const Size(1280, 940),
    double scale = 1,
    GlobalKey? capture,
    Future<bool> Function(Uri)? shop,
  }) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = size;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    grid.AppTheme.brightness.value = brightness;
    await tester.pumpWidget(
      RepaintBoundary(
        key: capture,
        child: MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: grid.buildAppTheme(brightness: brightness),
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context)
                .copyWith(textScaler: TextScaler.linear(scale)),
            child: grid.BrightnessScope(child: child!),
          ),
          home: Scaffold(
            body: DevicesScreen(controller: controller, openShop: shop),
          ),
        ),
      ),
    );
    await tester.runAsync(() async {
      final context = tester.element(find.byType(DevicesScreen));
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
    await tester.pumpAndSettle();
  }

  Future<void> capture(WidgetTester tester, GlobalKey key, String name) async {
    final output = Platform.environment['HARNESS_DEVICES_CAPTURE_DIR'];
    if (output == null) return;
    final render =
        key.currentContext!.findRenderObject()! as RenderRepaintBoundary;
    await tester.runAsync(() async {
      final image = await render.toImage(pixelRatio: 1);
      final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
      await Directory(output).create(recursive: true);
      await File('$output/$name.png').writeAsBytes(bytes!.buffer.asUint8List());
      image.dispose();
    });
  }

  Future<DevicesController> fleet(DialState dial) async {
    final controller = DevicesController(
      dial: dial,
      accountId: 'review',
      storage: MemoryStore(),
      sendSettings: (_, _) async => true,
    );
    await controller.load();
    report(dial, [
      for (var i = 0; i < 5; i++) deviceStatus('$i', attached: i != 4),
    ]);
    const names = [
      'Studio',
      'Home office',
      'Design desk',
      'Workshop',
      'Travel',
    ];
    for (var i = 0; i < 5; i++) {
      controller.rename(
        controller.devices[i].key,
        names[i],
        i < 2 ? HarnessDeviceModel.harness : HarnessDeviceModel.pro,
      );
    }
    return controller;
  }

  for (final brightness in Brightness.values) {
    testWidgets('${brightness.name} two round devices and one square device', (
      tester,
    ) async {
      final dial = DialState();
      final controller = DevicesController(
        dial: dial,
        accountId: 'mixed-hardware',
        sendSettings: (_, _) async => true,
      );
      await controller.load();
      final first = deviceStatus('round-one');
      final second = deviceStatus('round-two');
      // The connected square unit's older firmware sends its explicit hardware
      // identity without settings. It must still get the correct photograph.
      const square = DialStatus(
        attached: true,
        id: 'square',
        mac: '00:11:22:33:44:55',
        hw: 'harness-pro',
      );
      report(dial, [first, second, square]);
      // A user-selected retail label must not turn a reported round screen
      // into a square enclosure.
      controller.rename(
        controller.devices[1].key,
        'Round two',
        HarnessDeviceModel.pro,
      );
      final key = GlobalKey();
      await pump(tester, controller, brightness: brightness, capture: key);
      for (var i = 0; i < 3; i++) {
        final card = find.byKey(
          ValueKey('device-card-${controller.devices[i].key}'),
        );
        final artwork = tester.widget<DeviceArtwork>(
          find.descendant(of: card, matching: find.byType(DeviceArtwork)),
        );
        expect(artwork.square, i == 2);
      }
      await tester.tap(
        find.byKey(ValueKey('device-card-${controller.devices.last.key}')),
      );
      await tester.pumpAndSettle();
      expect(
        find.image(const AssetImage('assets/devices/harness-square.png')),
        findsNWidgets(2),
      );
      expect(tester.takeException(), isNull);
      controller.rename(
        controller.devices[1].key,
        'Round two',
        HarnessDeviceModel.harness,
      );
      controller.rename(
        controller.devices.last.key,
        'Square unit',
        HarnessDeviceModel.pro,
      );
      await tester.pumpAndSettle();
      await capture(tester, key, '${brightness.name}-mixed-hardware');

      // Shape also works without a retail SKU, using the same resolution as
      // the round units. Firmware's explicit shape is the authority.
      report(dial, [
        first,
        second,
        DialStatus.fromJson({
          'attached': true,
          'id': square.id,
          'mac': square.mac,
          'hw': 'unknown-board',
          'settings': {...first.settings!.toJson(), 'round': false},
        }),
      ]);
      await tester.pumpAndSettle();
      expect(
        find.image(const AssetImage('assets/devices/harness-square.png')),
        findsNWidgets(2),
      );
      await tester.pumpWidget(const SizedBox());
      controller.dispose();
      dial.dispose();
    });

    for (final empty in [false, true]) {
      testWidgets(
        '${brightness.name} ${empty ? 'empty' : 'five-device'} product view',
        (tester) async {
          final dial = DialState();
          final controller = empty
              ? DevicesController(
                  dial: dial,
                  accountId: 'review',
                  sendSettings: (_, _) async => true,
                )
              : await fleet(dial);
          final key = GlobalKey();
          await pump(tester, controller, brightness: brightness, capture: key);
          expect(tester.takeException(), isNull);
          expect(find.text('Shop'), findsOneWidget);
          if (!empty) {
            expect(find.text('Harness Pro'), findsNWidgets(3));
            expect(find.text('Faces'), findsOneWidget);
          }
          await capture(
            tester,
            key,
            '${brightness.name}-${empty ? 'empty' : 'devices'}',
          );
          await tester.pumpWidget(const SizedBox());
          controller.dispose();
          dial.dispose();
        },
      );
    }
  }

  testWidgets(
    'unreachable computers have no cards or errors and return with saved names',
    (tester) async {
      final hosts = DeviceHosts();
      const inventory = [
        DeviceHost(id: 'local', name: 'This Mac', online: true, local: true),
        DeviceHost(id: 'remote', name: 'Remote Mac', online: true),
      ];
      hosts.reconcile(inventory);
      final controller = DevicesController(
        hosts: hosts,
        accountId: 'review',
        sendHostSettings: (_, _, _) async => true,
      );
      await controller.load();
      hosts.receive('local', deviceStatus('local'));
      hosts.receive('remote', deviceStatus('remote'));
      final remote = controller.devices.firstWhere(
        (device) => device.machineId == 'remote',
      );
      controller.rename(remote.key, 'Studio dial', HarnessDeviceModel.pro);
      await pump(tester, controller);
      await tester.tap(find.byKey(ValueKey('device-card-${remote.key}')));
      await tester.pumpAndSettle();
      expect(find.text('2 devices'), findsOneWidget);

      for (final reason in [
        'Couldn’t reach Remote Mac.',
        'Link this computer in Machines.',
        'Update Harness on Remote Mac.',
      ]) {
        hosts.failed('remote', reason);
        await tester.pumpAndSettle();
        expect(find.byKey(ValueKey('device-card-${remote.key}')), findsNothing);
        expect(find.textContaining(reason), findsNothing);
        expect(find.text('1 device'), findsOneWidget);
        expect(find.text('Studio dial'), findsNothing);
        expect(find.text('Remote Mac'), findsNothing);
        hosts.receive('remote', deviceStatus('remote'));
        await tester.pumpAndSettle();
        expect(
          find.byKey(ValueKey('device-card-${remote.key}')),
          findsOneWidget,
        );
        expect(controller.device(remote.key)!.name, 'Studio dial');
      }

      hosts.reconcile([
        const DeviceHost(
          id: 'local',
          name: 'This Mac',
          online: false,
          local: true,
        ),
        const DeviceHost(id: 'remote', name: 'Remote Mac', online: false),
      ]);
      await tester.pumpAndSettle();
      expect(find.text('No devices connected'), findsOneWidget);
      expect(find.textContaining('Computer offline'), findsNothing);
      expect(find.byType(DeviceSettingsPanel), findsNothing);
      expect(
        controller.devices,
        hasLength(2),
        reason: 'Names are retained for reconnection',
      );
      await tester.pumpWidget(const SizedBox());
      controller.dispose();
      hosts.dispose();
    },
  );

  testWidgets('narrow layouts and 200 percent text remain scrollable', (
    tester,
  ) async {
    final dial = DialState();
    final controller = await fleet(dial);
    final key = GlobalKey();
    await pump(
      tester,
      controller,
      size: const Size(620, 800),
      scale: 2,
      capture: key,
    );
    expect(tester.takeException(), isNull);
    final settings = find.byType(DeviceSettingsPanel);
    await tester.ensureVisible(settings);
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    await capture(tester, key, 'narrow-enlarged');
    await tester.pumpWidget(const SizedBox());
    controller.dispose();
    dial.dispose();
  });

  testWidgets(
    'selected device owns changes through reorder and disconnect; Faces is a single choice',
    (tester) async {
      final dial = DialState();
      final sent = <(String, Map<String, Object?>)>[];
      final controller = DevicesController(
        dial: dial,
        accountId: 'a',
        sendSettings: (id, patch) async {
          sent.add((id, patch));
          return true;
        },
      );
      await controller.load();
      report(dial, [deviceStatus('a'), deviceStatus('b')]);
      await pump(tester, controller);
      final key = controller.devices.last.key;
      await tester.tap(find.byKey(ValueKey('device-card-$key')));
      await tester.pumpAndSettle();
      report(dial, [deviceStatus('b'), deviceStatus('a')]);
      await tester.pumpAndSettle();
      final sound = find.byKey(ValueKey('devices-sound-$key'));
      await tester.ensureVisible(sound);
      await tester.tap(sound);
      await tester.pump();
      expect(sent, hasLength(1));
      expect(sent.single.$1, 'b');
      expect(sent.single.$2, {'muted': false});
      expect(tester.widget<Switch>(sound).value, isFalse);
      expect(tester.widget<Switch>(sound).onChanged, isNull);
      report(dial, [deviceStatus('b', muted: false)]);
      await tester.pumpAndSettle();
      expect(tester.widget<Switch>(sound).value, isTrue);
      report(dial, []);
      await tester.pumpAndSettle();
      expect(tester.widget<Switch>(sound).onChanged, isNull);
      final faces = find.byKey(const Key('devices-faces'));
      await tester.ensureVisible(faces);
      await tester.tap(faces);
      await tester.pumpAndSettle();
      expect(deviceFaces, hasLength(1));
      expect(find.textContaining('New faces will appear'), findsOneWidget);
      await tester.tap(find.text('Done'));
      await tester.pumpAndSettle();
      expect(
        sent,
        hasLength(1),
        reason: 'Inspecting the current face never writes',
      );
      await tester.pumpWidget(const SizedBox());
      controller.dispose();
      dial.dispose();
    },
  );

  testWidgets(
    'USB setup adds the actual device, saves Pro model, and Shop opens the product page',
    (tester) async {
      final dial = DialState();
      final storage = MemoryStore();
      final opened = <Uri>[];
      final controller = DevicesController(
        dial: dial,
        accountId: 'a',
        storage: storage,
        sendSettings: (_, _) async => true,
      );
      await pump(
        tester,
        controller,
        shop: (url) async {
          opened.add(url);
          return true;
        },
      );
      await tester.tap(find.text('Shop'));
      await tester.pumpAndSettle();
      expect(opened, [harnessDeviceShopUrl]);
      await tester.tap(find.byKey(const Key('devices-add')));
      await tester.pumpAndSettle();
      expect(find.text('Waiting for a USB connection…'), findsOneWidget);
      expect(
        tester
            .widget<FilledButton>(
              find.widgetWithText(FilledButton, 'Finish setup'),
            )
            .onPressed,
        isNull,
      );
      report(dial, [deviceStatus('new')]);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Harness').last);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Harness Pro').last);
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField), 'Office Pro');
      await tester.ensureVisible(find.text('Finish setup'));
      await tester.tap(find.text('Finish setup'));
      await tester.pumpAndSettle();
      expect(controller.devices.single.name, 'Office Pro');
      expect(controller.devices.single.model, HarnessDeviceModel.pro);
      await controller.settled;
      expect(storage.values.values.single, contains('Office Pro'));
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      controller.dispose();
      dial.dispose();
    },
  );
}
