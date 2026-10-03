import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/devices/devices_controller.dart';
import 'package:harness/state/dial_status.dart';

import 'swarm_state_test.dart' show MemoryStore;

DialStatus deviceStatus(
  String id, {
  String? mac,
  bool attached = true,
  int brightness = 80,
  bool muted = true,
  String? updating,
}) => DialStatus.fromJson({
  'id': id,
  'mac': mac ?? '00:11:22:33:$id',
  'attached': attached,
  'fw': '0.0.101',
  'updating': updating,
  'settings': {
    'brightness': brightness,
    'character': 2,
    'face': 466,
    'round': true,
    'muted': muted,
    'quiet': false,
    'straightTitle': true,
    'focusFace': false,
    'scrollReversed': false,
    'voiceLang': 'en',
  },
});

void report(DialState dial, List<DialStatus> devices) => dial.apply(
  DialStatus(attached: devices.any((d) => d.attached), devices: devices),
);

void main() {
  test(
    'reusing a USB port for a different MAC keeps two distinct devices',
    () async {
      final dial = DialState();
      final controller = DevicesController(
        dial: dial,
        accountId: 'a',
        sendSettings: (_, _) async => true,
      );
      await controller.load();
      report(dial, [deviceStatus('port', mac: 'aa:aa')]);
      final first = controller.devices.single.key;
      controller.rename(first, 'Studio', HarnessDeviceModel.pro);
      report(dial, [deviceStatus('port', mac: 'bb:bb')]);
      expect(controller.devices, hasLength(2));
      expect(controller.device(first)!.status.attached, isFalse);
      expect(controller.devices.last.name, isNot('Studio'));
      controller.dispose();
      dial.dispose();
    },
  );

  test('a failed library read cannot overwrite saved devices; retry merges new arrivals', () async {
    final storage = _ReadFailureStore();
    final dial = DialState();
    final first = DevicesController(
      dial: dial,
      accountId: 'a',
      storage: storage,
      sendSettings: (_, _) async => true,
    );
    await first.load();
    report(dial, [deviceStatus('old')]);
    first.rename(
      first.devices.single.key,
      'Saved device',
      HarnessDeviceModel.pro,
    );
    await first.settled;
    first.dispose();
    final saved = storage.values.values.single;
    storage.fail = true;
    report(dial, [deviceStatus('new')]);
    final next = DevicesController(
      dial: dial,
      accountId: 'a',
      storage: storage,
      sendSettings: (_, _) async => true,
    );
    await next.load();
    await next.settled;
    expect(next.error, isNotNull);
    expect(storage.values.values.single, saved);
    storage.fail = false;
    await next.retrySave();
    await next.settled;
    expect(next.devices, hasLength(2));
    expect(next.devices.any((d) => d.name == 'Saved device'), isTrue);
    expect(next.error, isNull);
    next.dispose();
    dial.dispose();
  });

  test('five devices retain individual names, models and readings across reconnect and restart', () async {
    final storage = MemoryStore();
    final dial = DialState();
    final sent = <String>[];
    final controller = DevicesController(
      dial: dial,
      accountId: 'a',
      storage: storage,
      sendSettings: (id, patch) async {
        sent.add(id);
        return true;
      },
    );
    await controller.load();
    report(dial, [for (var i = 0; i < 5; i++) deviceStatus('$i')]);
    for (var i = 0; i < 5; i++) {
      controller.rename(
        controller.devices[i].key,
        'Desk $i',
        i < 2 ? HarnessDeviceModel.harness : HarnessDeviceModel.pro,
      );
    }
    expect(
      controller.devices.where((d) => d.model == HarnessDeviceModel.pro),
      hasLength(3),
    );
    final key = controller.devices.last.key;
    // Same hardware moved to a different USB port keeps its saved identity.
    report(dial, [
      deviceStatus('new-port', mac: '00:11:22:33:4', brightness: 35),
    ]);
    expect(controller.devices, hasLength(5));
    expect(controller.device(key)!.name, 'Desk 4');
    expect(controller.device(key)!.status.id, 'new-port');
    expect(controller.devices.where((d) => d.status.attached), hasLength(1));
    await controller.settled;
    controller.dispose();
    dial.apply(DialStatus.none);
    final restored = DevicesController(
      dial: dial,
      accountId: 'a',
      storage: storage,
      sendSettings: (_, _) async => true,
    );
    await restored.load();
    expect(restored.devices, hasLength(5));
    expect(restored.devices.every((d) => !d.canEdit), isTrue);
    expect(restored.device(key)!.status.settings!.brightness, 35);
    expect(
      sent,
      isEmpty,
      reason: 'Discovery and restoration never apply settings',
    );
    final other = DevicesController(
      dial: dial,
      accountId: 'b',
      storage: storage,
      sendSettings: (_, _) async => true,
    );
    await other.load();
    expect(other.devices, isEmpty);
    restored.dispose();
    other.dispose();
    dial.dispose();
  });

  test('patches address one device and values change only when that device acknowledges', () async {
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
    final key = controller.devices.last.key;
    await controller.update(key, {'muted': false});
    expect(sent, hasLength(1));
    expect(sent.single.$1, 'b');
    expect(sent.single.$2, {'muted': false});
    expect(controller.saving(key), isTrue);
    expect(controller.device(key)!.status.settings!.muted, isTrue);
    report(dial, [deviceStatus('a', muted: false), deviceStatus('b')]);
    expect(
      controller.saving(key),
      isTrue,
      reason: 'Another device cannot acknowledge this write',
    );
    report(dial, [deviceStatus('b', muted: false), deviceStatus('a')]);
    expect(controller.saving(key), isFalse);
    expect(controller.device(key)!.status.settings!.muted, isFalse);
    report(dial, [deviceStatus('b', attached: false), deviceStatus('a')]);
    await controller.update(key, {'brightness': 15});
    expect(sent, hasLength(1));
    report(dial, [deviceStatus('b', updating: '0.0.102')]);
    await controller.update(key, {'brightness': 15});
    expect(sent, hasLength(1));
    controller.dispose();
    dial.dispose();
  });

  testWidgets(
    'unconfirmed and disconnected writes recover without optimistic settings',
    (tester) async {
      final dial = DialState();
      final controller = DevicesController(
        dial: dial,
        accountId: 'a',
        confirmationTimeout: const Duration(seconds: 2),
        sendSettings: (_, _) async => true,
      );
      await controller.load();
      report(dial, [deviceStatus('a')]);
      final key = controller.devices.single.key;
      await controller.update(key, {'brightness': 15});
      await tester.pump(const Duration(seconds: 2));
      expect(controller.deviceError(key), contains('wasn’t confirmed'));
      expect(controller.device(key)!.status.settings!.brightness, 80);
      await controller.update(key, {'brightness': 25});
      expect(controller.deviceError(key), isNull);
      dial.disconnect();
      expect(controller.deviceError(key), contains('disconnected'));
      expect(controller.saving(key), isFalse);
      controller.dispose();
      dial.dispose();
    },
  );

  test('a late transport failure cannot cancel a newer write', () async {
    final dial = DialState();
    final first = Completer<bool>();
    var calls = 0;
    final controller = DevicesController(
      dial: dial,
      accountId: 'a',
      sendSettings: (_, _) => ++calls == 1 ? first.future : Future.value(true),
    );
    await controller.load();
    report(dial, [deviceStatus('a')]);
    final key = controller.devices.single.key;
    final old = controller.update(key, {'brightness': 20});
    report(dial, [deviceStatus('a', brightness: 20)]);
    await controller.update(key, {'brightness': 40});
    first.complete(false);
    await old;
    expect(controller.saving(key), isTrue);
    expect(controller.deviceError(key), isNull);
    controller.dispose();
    dial.dispose();
  });
}

class _ReadFailureStore extends MemoryStore {
  bool fail = false;
  @override
  Future<String?> read(String key) async {
    if (fail) throw StateError('Read unavailable');
    return super.read(key);
  }
}
