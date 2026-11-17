import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/devices/device_app.dart';
import 'package:harness/devices/device_app_offer.dart';

import '../support/device_app.dart';
import '../support/memory_key_value_store.dart';

/// A store whose reads wait for [gate], as a slow disk.
class _SlowStore extends MemoryKeyValueStore {
  final gate = Completer<void>();

  @override
  Future<String?> read(String key) async {
    await gate.future;
    return super.read(key);
  }
}

/// A store whose reads and writes throw, as a state file that cannot be opened.
class _BrokenStore extends MemoryKeyValueStore {
  @override
  Future<String?> read(String key) async => throw StateError('unreadable');

  @override
  Future<void> write(String key, String value) async =>
      throw StateError('unwritable');
}

DeviceAppFixture _fixture({bool supported = true, MemoryKeyValueStore? store}) {
  final fixture = DeviceAppFixture(supported: supported, store: store);
  addTearDown(fixture.offer.dispose);
  return fixture;
}

/// A dial attached, and the first answer and the stored one in.
Future<DeviceAppFixture> _attached({
  DeviceAppPresence presence = notInstalled,
  MemoryKeyValueStore? store,
}) async {
  final fixture = _fixture(store: store)..probe.presence = presence;
  fixture.offer.dialChanged(true);
  await pumpEventQueue();
  return fixture;
}

const _path = '/t/Harness Device.app';

void main() {
  test('a dial and no app: the offer', () async {
    final fixture = _fixture();
    final seen = <DeviceAppOfferState>[];
    fixture.offer.addListener(() => seen.add(fixture.offer.state));
    fixture.offer.dialChanged(true);
    await fixture.offer.restored;
    await pumpEventQueue();
    expect(fixture.offer.state, DeviceAppOfferState.offer);
    expect(fixture.offer.bandVisible, isTrue);
    expect(fixture.probe.lookups, 1);
    expect(seen.last, DeviceAppOfferState.offer);
  });

  test('each missing condition hides it', () async {
    final unsupported = _fixture(supported: false);
    unsupported.offer
      ..dialChanged(true)
      ..windowFronted();
    await unsupported.offer.refresh();
    await pumpEventQueue();
    expect(unsupported.offer.state, DeviceAppOfferState.hidden);
    expect(unsupported.offer.bandVisible, isFalse);
    expect(unsupported.probe.lookups, 0);

    final noDial = _fixture();
    noDial.offer.windowFronted();
    await noDial.offer.refresh();
    await pumpEventQueue();
    expect(noDial.offer.state, DeviceAppOfferState.hidden);
    expect(noDial.probe.lookups, 0);

    final noAnswerYet = _fixture()..probe.gate = Completer<void>();
    noAnswerYet.offer.dialChanged(true);
    await pumpEventQueue();
    expect(noAnswerYet.offer.state, DeviceAppOfferState.hidden);
    expect(noAnswerYet.offer.bandVisible, isFalse);

    final running = await _attached(presence: installedRunning);
    expect(running.offer.state, DeviceAppOfferState.hidden);
    expect(running.offer.bandVisible, isFalse);

    final notRunning = await _attached(presence: installedNotRunning);
    expect(notRunning.offer.state, DeviceAppOfferState.notRunning);
    expect(notRunning.offer.bandVisible, isFalse);
  });

  // An AppNotifier built in a test without its own offer gets the real one, unsupported under test: a press must
  // not reach the real installer or `open`.
  test('unsupported: Install and Open do nothing', () async {
    final fixture = _fixture(supported: false);
    fixture.offer.dialChanged(true);
    await fixture.offer.install();
    await fixture.offer.open();
    expect(fixture.install.calls, 0);
    expect(fixture.open.paths, isEmpty);
    expect(fixture.offer.state, DeviceAppOfferState.hidden);
  });

  test('the dial coming looks once; later status frames do not', () async {
    final fixture = await _attached();
    fixture.offer
      ..dialChanged(true)
      ..dialChanged(true);
    await pumpEventQueue();
    expect(fixture.probe.lookups, 1);

    // Unplugged and plugged in again is a dial coming.
    fixture.offer
      ..dialChanged(false)
      ..dialChanged(true);
    await pumpEventQueue();
    expect(fixture.probe.lookups, 2);
  });

  test('the window coming back and the Devices tick look again', () async {
    final fixture = await _attached();
    expect(fixture.probe.lookups, 1);
    fixture.offer.windowFronted();
    await pumpEventQueue();
    expect(fixture.probe.lookups, 2);
    await fixture.offer.refresh();
    expect(fixture.probe.lookups, 3);

    fixture.offer
      ..dialChanged(false)
      ..windowFronted();
    await fixture.offer.refresh();
    await pumpEventQueue();
    expect(fixture.probe.lookups, 3);
    expect(fixture.offer.state, DeviceAppOfferState.hidden);
  });

  test('two lookups asked at once are one', () async {
    final fixture = _fixture()..probe.gate = Completer<void>();
    fixture.offer.dialChanged(true);
    final first = fixture.offer.refresh();
    final second = fixture.offer.refresh();
    fixture.offer.windowFronted();
    expect(fixture.probe.lookups, 1);
    fixture.probe.gate!.complete();
    await Future.wait([first, second]);
    expect(fixture.probe.lookups, 1);
    expect(fixture.offer.state, DeviceAppOfferState.offer);
  });

  test('a lookup that fails keeps the last answer and says so', () async {
    final fixture = await _attached(presence: installedNotRunning);
    fixture.probe.error = StateError('LaunchServices');
    await fixture.offer.refresh();
    expect(fixture.offer.state, DeviceAppOfferState.notRunning);
    expect(fixture.lines, contains('device app: lookup failed'));

    // With no answer before it, nothing shows.
    final first = _fixture()..probe.error = StateError('LaunchServices');
    first.offer.dialChanged(true);
    await pumpEventQueue();
    expect(first.offer.state, DeviceAppOfferState.hidden);
    expect(first.lines, ['device app: lookup failed']);
  });

  test('Install runs it, says so, and trusts its result at once', () async {
    final fixture = await _attached();
    final seen = <DeviceAppOfferState>[];
    fixture.offer.addListener(() => seen.add(fixture.offer.state));
    fixture.install.gate = Completer<void>();
    final run = fixture.offer.install();
    expect(fixture.offer.state, DeviceAppOfferState.installing);
    expect(fixture.offer.bandVisible, isTrue);
    fixture.install.gate!.complete();
    await run;
    expect(fixture.offer.state, DeviceAppOfferState.hidden);
    expect(seen, [DeviceAppOfferState.installing, DeviceAppOfferState.hidden]);
    expect(fixture.lines, [
      'device app: install started',
      'device app: install done',
    ]);
    // It looks once after the install; LaunchServices registers a fresh bundle late, so its "not installed" is
    // not believed yet.
    await pumpEventQueue();
    expect(fixture.probe.lookups, 2);
    expect(fixture.offer.state, DeviceAppOfferState.hidden);

    await fixture.offer.refresh();
    expect(fixture.offer.state, DeviceAppOfferState.hidden);
    fixture.probe.presence = installedNotRunning;
    await fixture.offer.refresh();
    expect(fixture.offer.state, DeviceAppOfferState.notRunning);
    // Once it said installed, "not installed" is believed again.
    fixture.probe.presence = notInstalled;
    await fixture.offer.refresh();
    expect(fixture.offer.state, DeviceAppOfferState.offer);
  });

  test('an answer asked before an install ended is not believed', () async {
    final fixture = await _attached();
    fixture.install.gate = Completer<void>();
    final run = fixture.offer.install();
    fixture.probe.gate = Completer<void>();
    final asked = fixture.offer.refresh();
    fixture.install.gate!.complete();
    await run;
    // What the lookup saw before the app had opened.
    fixture.probe.presence = installedNotRunning;
    fixture.probe.gate!.complete();
    await asked;
    expect(fixture.offer.state, DeviceAppOfferState.hidden);

    await fixture.offer.refresh();
    expect(fixture.offer.state, DeviceAppOfferState.notRunning);
  });

  test('an answer asked before an Open ended is not believed', () async {
    final fixture = await _attached(presence: installedNotRunning);
    fixture.probe.gate = Completer<void>();
    final asked = fixture.offer.refresh();
    await fixture.offer.open();
    expect(fixture.offer.state, DeviceAppOfferState.hidden);
    // What the lookup saw before the app had opened.
    fixture.probe.gate!.complete();
    await asked;
    expect(fixture.offer.state, DeviceAppOfferState.hidden);
  });

  test('a second press joins the running install', () async {
    final fixture = await _attached();
    fixture.install.gate = Completer<void>();
    final first = fixture.offer.install();
    final second = fixture.offer.install();
    expect(fixture.install.calls, 1);
    fixture.install.gate!.complete();
    await Future.wait([first, second]);
    expect(fixture.install.calls, 1);
    expect(
      fixture.lines.where((line) => line == 'device app: install started'),
      hasLength(1),
    );
  });

  test(
    'a failure names its step and keeps Retry until the app is there',
    () async {
      final fixture = await _attached();
      fixture.install.result = const DeviceAppInstallResult.failed(
        DeviceAppInstallStep.checksum,
      );
      await fixture.offer.install();
      expect(fixture.offer.state, DeviceAppOfferState.failed);
      expect(fixture.offer.failedStep, DeviceAppInstallStep.checksum);
      expect(fixture.offer.bandVisible, isTrue);
      expect(fixture.lines.last, 'device app: install failed checksum');

      await fixture.offer.refresh();
      expect(fixture.offer.state, DeviceAppOfferState.failed);
      expect(fixture.offer.failedStep, DeviceAppInstallStep.checksum);

      await fixture.offer.install();
      expect(fixture.install.calls, 2);

      fixture.probe.presence = installedRunning;
      await fixture.offer.refresh();
      expect(fixture.offer.state, DeviceAppOfferState.hidden);
      expect(fixture.offer.failedStep, isNull);
    },
  );

  test('installed but not opened: Retry only opens it', () async {
    final fixture = await _attached();
    fixture.install.result = const DeviceAppInstallResult.failed(
      DeviceAppInstallStep.open,
      installedAt: _path,
    );
    await fixture.offer.install();
    expect(fixture.offer.state, DeviceAppOfferState.failed);
    expect(fixture.offer.failedStep, DeviceAppInstallStep.open);
    expect(fixture.offer.bandVisible, isTrue);
    expect(fixture.lines.last, 'device app: install failed open');

    // LaunchServices has not registered it yet: still Retry to open, never to download again.
    await fixture.offer.refresh();
    expect(fixture.offer.failedStep, DeviceAppInstallStep.open);

    await fixture.offer.open();
    expect(fixture.open.paths, [_path]);
    expect(fixture.install.calls, 1);
    expect(fixture.offer.state, DeviceAppOfferState.hidden);
  });

  test(
    'Open from the row goes by bundle id; a refusal shows the line',
    () async {
      final fixture = await _attached(presence: installedNotRunning);
      fixture.open.ok = false;
      await fixture.offer.open();
      expect(fixture.open.paths, [null]);
      expect(fixture.offer.state, DeviceAppOfferState.failed);
      expect(fixture.offer.failedStep, DeviceAppInstallStep.open);
      expect(fixture.lines.last, 'device app: open failed');

      fixture.open.ok = true;
      await fixture.offer.open();
      expect(fixture.open.paths, [null, null]);
      expect(fixture.offer.state, DeviceAppOfferState.hidden);
      expect(fixture.offer.failedStep, isNull);
    },
  );

  test('a refused Open from the row stays off the band', () async {
    final fixture = await _attached(presence: installedNotRunning);
    fixture.open.ok = false;
    await fixture.offer.open();
    expect(fixture.offer.state, DeviceAppOfferState.failed);
    expect(fixture.offer.failedStep, DeviceAppInstallStep.open);
    expect(fixture.offer.bandVisible, isFalse);

    await fixture.offer.open();
    expect(fixture.offer.bandVisible, isFalse);
  });

  test('an install whose open fails keeps the band through Retry', () async {
    final fixture = await _attached();
    fixture.install.result = const DeviceAppInstallResult.failed(
      DeviceAppInstallStep.open,
      installedAt: _path,
    );
    await fixture.offer.install();
    expect(fixture.offer.bandVisible, isTrue);

    fixture.open.ok = false;
    await fixture.offer.open();
    expect(fixture.offer.failedStep, DeviceAppInstallStep.open);
    expect(fixture.offer.bandVisible, isTrue);
  });

  test('an opener that throws is a refusal', () async {
    final fixture = await _attached(presence: installedNotRunning);
    fixture.open.error = StateError('open timed out');
    await fixture.offer.open();
    expect(fixture.offer.state, DeviceAppOfferState.failed);
    expect(fixture.offer.failedStep, DeviceAppInstallStep.open);
    expect(fixture.lines.last, 'device app: open failed');
  });

  test('the dial leaving during an install', () async {
    final fixture = await _attached();
    fixture.install.gate = Completer<void>();
    final run = fixture.offer.install();
    fixture.offer.dialChanged(false);
    expect(fixture.offer.state, DeviceAppOfferState.hidden);
    expect(fixture.offer.bandVisible, isFalse);
    fixture.install.gate!.complete();
    await run;
    await pumpEventQueue();
    expect(fixture.offer.state, DeviceAppOfferState.hidden);
    expect(fixture.lines.last, 'device app: install done');
    // No dial, no lookup after it.
    expect(fixture.probe.lookups, 1);
  });

  test('an install that throws is a failed install step', () async {
    final fixture = await _attached();
    fixture.install.error = StateError('disk full');
    await fixture.offer.install();
    expect(fixture.offer.state, DeviceAppOfferState.failed);
    expect(fixture.offer.failedStep, DeviceAppInstallStep.install);
    expect(fixture.lines.last, 'device app: install failed install');
  });

  test('an installer that throws before its future is a failed install step', () async {
    final probe = FakeDeviceAppProbe();
    final offer = DeviceAppOffer(
      supported: true,
      probe: probe,
      install: () => throw StateError('disk full'),
      open: FakeDeviceAppOpen().call,
    );
    addTearDown(offer.dispose);
    offer.dialChanged(true);
    await pumpEventQueue();
    await offer.install();
    expect(offer.state, DeviceAppOfferState.failed);
    expect(offer.failedStep, DeviceAppInstallStep.install);
  });

  test('Not now hides the band for good and keeps the row', () async {
    final store = MemoryKeyValueStore();
    final fixture = await _attached(store: store);
    final dismissed = fixture.offer.dismiss();
    expect(fixture.offer.bandVisible, isFalse);
    await dismissed;
    expect(fixture.offer.state, DeviceAppOfferState.offer);
    expect(store.values['device_app.offer_dismissed'], 'true');

    final again = _fixture(store: store);
    again.offer.dialChanged(true);
    await again.offer.restored;
    await pumpEventQueue();
    expect(again.offer.state, DeviceAppOfferState.offer);
    expect(again.offer.bandVisible, isFalse);
  });

  test('the band waits for the stored answer', () async {
    final store = _SlowStore();
    final fixture = _fixture(store: store);
    var notified = 0;
    fixture.offer.addListener(() => notified++);
    fixture.offer.dialChanged(true);
    await pumpEventQueue();
    expect(fixture.offer.state, DeviceAppOfferState.offer);
    expect(fixture.offer.bandVisible, isFalse);

    final before = notified;
    store.gate.complete();
    await fixture.offer.restored;
    expect(fixture.offer.bandVisible, isTrue);
    expect(notified, greaterThan(before));
  });

  test('a store that cannot be read or written is a first run', () async {
    final fixture = _fixture(store: _BrokenStore());
    await fixture.offer.restored;
    fixture.offer.dialChanged(true);
    await pumpEventQueue();
    expect(fixture.offer.bandVisible, isTrue);

    await fixture.offer.dismiss();
    expect(fixture.offer.bandVisible, isFalse);
    expect(fixture.offer.state, DeviceAppOfferState.offer);
  });

  test('the lines carry only step names', () async {
    final lines = <String>[];
    for (final step in DeviceAppInstallStep.values) {
      final fixture = await _attached();
      fixture.install.result = step == DeviceAppInstallStep.open
          ? const DeviceAppInstallResult.failed(
              DeviceAppInstallStep.open,
              installedAt: _path,
            )
          : DeviceAppInstallResult.failed(step);
      await fixture.offer.install();
      lines.addAll(fixture.lines);
    }
    final done = await _attached();
    await done.offer.install();
    lines.addAll(done.lines);

    // Errors that carry a path must not reach a line.
    final lookup = await _attached();
    lookup.probe.error = StateError(_path);
    await lookup.offer.refresh();
    lines.addAll(lookup.lines);
    final open = await _attached(presence: installedNotRunning);
    open.open.error = StateError(_path);
    await open.offer.open();
    lines.addAll(open.lines);

    expect(
      lines,
      everyElement(
        matches(
          RegExp(
            r'^device app: (install started|install done|install failed '
            r'(manifest|download|checksum|unpack|signature|install|open)'
            r'|lookup failed|open failed)$',
          ),
        ),
      ),
    );
    // Every kind of line was made: started, done, seven failures, lookup and open.
    expect(lines.toSet(), hasLength(11));
  });

  test('after dispose nothing notifies', () async {
    final store = _SlowStore();
    final fixture = DeviceAppFixture(store: store);
    fixture.offer.dialChanged(true);
    await pumpEventQueue();
    fixture.install.gate = Completer<void>();
    final run = fixture.offer.install();
    fixture.probe.gate = Completer<void>();
    final lookup = fixture.offer.refresh();

    fixture.offer.dispose();
    store.gate.complete();
    fixture.install.gate!.complete();
    fixture.probe.gate!.complete();
    // A notification after dispose throws, and would fail these.
    await Future.wait([run, lookup, fixture.offer.restored]);
    await pumpEventQueue();
    // No lookup after the install either.
    expect(fixture.probe.lookups, 2);
  });
}
