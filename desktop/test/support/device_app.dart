import 'dart:async';

import 'package:harness/devices/device_app.dart';
import 'package:harness/devices/device_app_offer.dart';

import 'memory_key_value_store.dart';

const notInstalled = DeviceAppPresence(installed: false, running: false);
const installedNotRunning = DeviceAppPresence(installed: true, running: false);
const installedRunning = DeviceAppPresence(installed: true, running: true);

class FakeDeviceAppProbe implements DeviceAppProbe {
  DeviceAppPresence presence = notInstalled;

  /// Thrown by [lookup] when set.
  Object? error;

  /// [lookup] waits for it when set.
  Completer<void>? gate;
  int lookups = 0;

  @override
  Future<DeviceAppPresence> lookup() async {
    lookups++;
    await gate?.future;
    final error = this.error;
    if (error != null) throw error;
    return presence;
  }
}

class FakeDeviceAppInstall {
  DeviceAppInstallResult result = const DeviceAppInstallResult.done(
    '/t/Harness Device.app',
  );

  /// Thrown by [call] when set.
  Object? error;

  /// [call] waits for it when set.
  Completer<void>? gate;
  int calls = 0;

  Future<DeviceAppInstallResult> call() async {
    calls++;
    await gate?.future;
    final error = this.error;
    if (error != null) throw error;
    return result;
  }
}

class FakeDeviceAppOpen {
  bool ok = true;

  /// Thrown by [call] when set: the real opener throws when `open` cannot start or runs out of time.
  Object? error;

  /// One per call; null is the bundle id form.
  final paths = <String?>[];

  Future<bool> call({String? path}) async {
    paths.add(path);
    final error = this.error;
    if (error != null) throw error;
    return ok;
  }
}

/// An offer over the three fakes and an in-memory store.
class DeviceAppFixture {
  DeviceAppFixture({bool supported = true, MemoryKeyValueStore? store}) {
    this.store = store ?? MemoryKeyValueStore();
    offer = DeviceAppOffer(
      supported: supported,
      probe: probe,
      install: install.call,
      open: open.call,
      store: this.store,
      log: lines.add,
    );
  }

  final probe = FakeDeviceAppProbe();
  final install = FakeDeviceAppInstall();
  final open = FakeDeviceAppOpen();

  /// Bundles the offer finds gone from disk; every other path is there.
  final gone = <String>{};
  final lines = <String>[];
  late final MemoryKeyValueStore store;
  late final DeviceAppOffer offer;

  /// The offer brought to [state] with a dial attached; `failed` at [step] (default download). Failed at `open`
  /// carries `installedAt: '/t/Harness Device.app'`. `installing` never ends: dispose the offer.
  static Future<DeviceAppFixture> inState(
    DeviceAppOfferState state, {
    DeviceAppInstallStep? step,
  }) async {
    final fixture = DeviceAppFixture();
    switch (state) {
      case DeviceAppOfferState.hidden:
        fixture.probe.presence = installedRunning;
      case DeviceAppOfferState.notRunning:
        fixture.probe.presence = installedNotRunning;
      case DeviceAppOfferState.offer:
        break;
      case DeviceAppOfferState.installing:
        fixture.install.gate = Completer<void>();
      case DeviceAppOfferState.failed:
        final failed = step ?? DeviceAppInstallStep.download;
        fixture.install.result = failed == DeviceAppInstallStep.open
            ? const DeviceAppInstallResult.failed(
                DeviceAppInstallStep.open,
                installedAt: '/t/Harness Device.app',
              )
            : DeviceAppInstallResult.failed(failed);
    }
    final offer = fixture.offer;
    await offer.restored;
    offer.dialChanged(true);
    // Joins the lookup the dial started, so its answer is in before the install.
    await offer.refresh();
    if (state == DeviceAppOfferState.installing) unawaited(offer.install());
    if (state == DeviceAppOfferState.failed) await offer.install();
    return fixture;
  }
}
