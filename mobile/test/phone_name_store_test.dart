import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/phone/phone_name_store.dart';

import 'voice_fakes.dart';

void main() {
  late MemoryKeyValueStore storage;
  setUp(() => storage = MemoryKeyValueStore());

  test('no override until the person types one', () {
    expect(PhoneNameStore(storage: storage).value, isNull);
  });

  test('a name is remembered and restored next time', () async {
    final store = PhoneNameStore(storage: storage);
    await store.rename('  Work phone ');
    expect(store.value, 'Work phone');
    expect(storage.values['phone_name'], 'Work phone');
    final next = PhoneNameStore(storage: storage);
    await next.load();
    expect(next.value, 'Work phone');
  });

  test('an empty name forgets the override', () async {
    final store = PhoneNameStore(storage: storage);
    await store.rename('Work phone');
    await store.rename('   ');
    expect(store.value, isNull);
    expect(storage.values.containsKey('phone_name'), isFalse);
  });
}
