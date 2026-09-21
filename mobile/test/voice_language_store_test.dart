import 'dart:ui';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/phone/voice_language_store.dart';

import 'voice_fakes.dart';

void main() {
  late MemoryKeyValueStore storage;

  VoiceLanguageStore store({List<Locale> locales = const []}) =>
      VoiceLanguageStore(storage: storage, preferredLocales: locales);

  setUp(() => storage = MemoryKeyValueStore());

  test("the phone's language is the default, when the backend serves it", () {
    expect(store(locales: const [Locale('vi', 'VN')]).value, 'vi');
    expect(store(locales: const [Locale('de'), Locale('fr')]).value, 'fr');
    expect(store().value, 'en');
  });

  test('a chosen language is remembered and restored next time', () async {
    await store().select('vi');

    expect(storage.values['voice_input_language'], 'vi');

    final later = store();
    await later.load();
    expect(later.value, 'vi');
  });

  test('a language the backend does not serve is refused', () async {
    final languages = store();

    await languages.select('de');
    expect(languages.value, 'en');

    storage.values['voice_input_language'] = 'de';
    await languages.load();
    expect(languages.value, 'en');
  });
}
