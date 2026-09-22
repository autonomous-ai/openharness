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
}
