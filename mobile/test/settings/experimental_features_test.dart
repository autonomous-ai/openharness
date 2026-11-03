import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/snapshot_store.dart';
import 'package:harness_mobile/core/startup.dart';
import 'package:harness_mobile/phone/phone_name_store.dart';
import 'package:harness_mobile/phone/voice_language_store.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/appearance_prefs_store.dart';
import 'package:harness_mobile/stats/harness_stats.dart';
import 'package:harness_mobile/terminal/terminal_font_store.dart';
import 'package:harness_mobile/terminal/terminal_theme_store.dart';

import '../voice_fakes.dart';

/// Counts writes, so a test can say a choice that changed nothing wrote nothing.
class _CountingStore extends MemoryKeyValueStore {
  int writes = 0;

  @override
  Future<void> write(String key, String value) {
    writes++;
    return super.write(key, value);
  }
}

void main() {
  late _CountingStore storage;
  setUp(() => storage = _CountingStore());

  test('every experiment is off until turned on', () async {
    final store = ExperimentalFeaturesStore(storage: storage);
    await store.load();
    expect(store.value, isEmpty);
    expect(store.isOn(PhoneExperiment.swarm), isFalse);
  });

  test('turned on, it is remembered and restored next time', () async {
    final store = ExperimentalFeaturesStore(storage: storage);
    await store.set(PhoneExperiment.swarm, true);
    expect(store.isOn(PhoneExperiment.swarm), isTrue);
    expect(storage.values['experimental_features'], '["swarm"]');

    final next = ExperimentalFeaturesStore(storage: storage);
    await next.load();
    expect(next.isOn(PhoneExperiment.swarm), isTrue);
  });

  test('turned off again, the next launch has it off', () async {
    final store = ExperimentalFeaturesStore(storage: storage);
    await store.set(PhoneExperiment.swarm, true);
    await store.set(PhoneExperiment.swarm, false);
    expect(store.isOn(PhoneExperiment.swarm), isFalse);

    final next = ExperimentalFeaturesStore(storage: storage);
    await next.load();
    expect(next.isOn(PhoneExperiment.swarm), isFalse);
  });

  test(
    'a switch to where it already is writes nothing and tells nobody',
    () async {
      final store = ExperimentalFeaturesStore(storage: storage);
      var told = 0;
      store.addListener(() => told++);
      await store.set(PhoneExperiment.swarm, false);
      expect(storage.writes, 0);
      expect(told, 0);

      await store.set(PhoneExperiment.swarm, true);
      await store.set(PhoneExperiment.swarm, true);
      expect(storage.writes, 1);
      expect(told, 1);
    },
  );

  test(
    'an experiment a newer build turned on survives this build\'s write',
    () async {
      storage.values['experimental_features'] = '["later_feature","swarm"]';
      final store = ExperimentalFeaturesStore(storage: storage);
      await store.load();
      expect(store.value, {PhoneExperiment.swarm});

      await store.set(PhoneExperiment.swarm, false);
      expect(storage.values['experimental_features'], '["later_feature"]');
    },
  );

  for (final (what, saved) in const [
    ('not JSON', 'swarm'),
    ('not a list', '{"swarm":true}'),
    ('a list of other things', '[1,true,null]'),
  ]) {
    test('a saved value that is $what leaves everything off', () async {
      storage.values['experimental_features'] = saved;
      final store = ExperimentalFeaturesStore(storage: storage);
      await store.load();
      expect(store.value, isEmpty);
    });
  }

  test('a storage that fails keeps the choice for this run', () async {
    final store = ExperimentalFeaturesStore(storage: _FailingStore());
    await store.load();
    expect(store.value, isEmpty);
    await store.set(PhoneExperiment.swarm, true);
    expect(store.isOn(PhoneExperiment.swarm), isTrue);
  });

  test('the app loads it before the first frame', () async {
    storage.values['experimental_features'] = '["swarm"]';
    final experiments = ExperimentalFeaturesStore(storage: storage);
    final prefs = MemoryKeyValueStore();
    await loadPersistedSettings(
      terminalFont: TerminalFontStore(storage: prefs),
      terminalTheme: TerminalThemeStore(storage: prefs),
      appearance: AppearancePrefsStore(storage: prefs),
      stats: HarnessStats(store: MemorySnapshotStore()),
      voiceLanguage: VoiceLanguageStore(
        storage: prefs,
        preferredLocales: const [Locale('en', 'US')],
      ),
      phoneName: PhoneNameStore(storage: prefs),
      experiments: experiments,
    );
    expect(experiments.isOn(PhoneExperiment.swarm), isTrue);
  });
}

class _FailingStore extends MemoryKeyValueStore {
  @override
  Future<String?> read(String key) async => throw Exception('disk');

  @override
  Future<void> write(String key, String value) async => throw Exception('disk');
}
