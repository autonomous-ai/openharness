// What the app remembers about the dial, and how it reads the dial's status frame.
import 'package:flutter_test/flutter_test.dart';

import 'package:harness/core/local_key_value_store.dart';
import 'package:harness/state/dial_status.dart';

class _MemoryStore implements LocalKeyValueStore {
  final values = <String, String>{};
  @override
  Future<String?> read(String key) async => values[key];
  @override
  Future<void> write(String key, String value) async => values[key] = value;
  @override
  Future<void> delete(String key) async => values.remove(key);
}

void main() {
  test(
    '"seen" is remembered across launches, and only ever set by a real dial',
    () async {
      final store = _MemoryStore();
      final state = DialState(store);
      await state.restore();
      expect(state.seen, isFalse);

      state.apply(DialStatus.none);
      expect(store.values, isEmpty, reason: 'nothing seen yet');

      state.apply(const DialStatus(attached: true));
      await Future<void>.delayed(Duration.zero);
      expect(store.values['dial_seen'], '1');

      final later = DialState(store);
      await later.restore();
      expect(later.seen, isTrue);
    },
  );

  test('the frame is read with is, never as', () {
    expect(
      DialStatus.fromJson({'attached': true, 'fw': '0.0.58'}).fw,
      '0.0.58',
    );
    final junk = DialStatus.fromJson({
      'attached': 'yes',
      'fw': 7,
      'updating': '',
    });
    expect(junk.attached, isFalse);
    expect(junk.fw, isNull);
    expect(junk.updating, isNull);
  });

  test('a device reports its settings, its identity, and the rest of the desk', () {
    final status = DialStatus.fromJson(const {
      'attached': true,
      'id': 'AA:01',
      'mac': 'aa:bb:cc',
      'fw': '0.0.90',
      'settings': {
        'brightness': 60, 'character': 1, 'face': 466, 'muted': true, 'rim': false, 'quiet': true,
        'straightTitle': false, 'focusFace': false, 'scrollReversed': true,
        'round': true, 'voiceLang': 'vi',
      },
      'devices': [
        {'attached': true, 'id': 'AA:01'},
        {'attached': false, 'id': 'BB:02', 'mac': 'dd:ee'},
      ],
    });
    expect(status.id, 'AA:01');
    expect(status.mac, 'aa:bb:cc');
    expect(status.settings?.brightness, 60);
    expect(status.settings?.character, 1);
    expect(status.settings?.voiceLang, 'vi');
    expect(status.settings?.round, isTrue);
    expect(status.devices.map((d) => d.id), ['AA:01', 'BB:02']);
    expect(status.devices.last.attached, isFalse);
  });

  test('half a settings object is refused whole', () {
    // A default here is a value this window invented, and the pane would then offer a setting the
    // device does not have — which is the failure the read-back answer exists to prevent.
    expect(DeviceSettings.fromJson(const {'brightness': 50}), isNull);
    expect(DeviceSettings.fromJson(const {
      'brightness': 50, 'character': 0, 'face': 466, 'muted': false, 'rim': true, 'quiet': false,
      'straightTitle': false, 'focusFace': false, 'scrollReversed': false,
      'voiceLang': 'en',   // no `round`
    }), isNull);
    expect(DeviceSettings.fromJson(null), isNull);
    expect(DeviceSettings.fromJson('not an object'), isNull);
  });

  test('a device unplugged but lately seen stays on the desk', () {
    // The pane shows its rows read-only rather than dropping the robot while a cable is out.
    final state = DialState();
    expect(state.devices, isEmpty);
    state.apply(DialStatus.fromJson(const {
      'attached': false,
      'mac': 'aa:bb',
      'settings': {
        'brightness': 10, 'character': 0, 'face': 466, 'muted': false, 'rim': true, 'quiet': false,
        'straightTitle': false, 'focusFace': false, 'scrollReversed': false,
        'round': true, 'voiceLang': 'en',
      },
    }));
    expect(state.devices, hasLength(1));
    expect(state.devices.single.settings?.face, 466);
    state.apply(DialStatus.none);
    expect(state.devices, isEmpty);
  });
}
