import 'dart:convert';

import 'package:flutter/foundation.dart';

import 'package:harness_mobile/core/harness_file_store.dart';
import 'package:harness_mobile/core/local_key_value_store.dart';

/// A feature this phone tries before everybody gets it: Settings ▸ Experimental, the desktop's
/// section of the same name (`desktop/lib/settings/experimental_features.dart`). Every one is off
/// until turned on.
///
/// ⚠️ **This phone's choice, not the account's.** The desktop's experiments are columns the backend
/// keeps for the account (`backend/src/lib/experimentalSettings.ts`), so one more of those is a
/// migration and a backend release. These exist to try a feature on one phone while it is being
/// built (owner, 2026-10-26), so they live in this phone's state file.
enum PhoneExperiment {
  /// Swarm on the phone, while its screens are built. Its ways in, the Swarm mark on Home's title
  /// (`swarm/swarm_mark.dart`) and the Swarm command in Find (`phone/phone_search_actions.dart`),
  /// are offered only while this is on.
  swarm(
    'swarm',
    'Swarm',
    'Open your Swarms from Home or Find. Still taking shape.',
  );

  const PhoneExperiment(this.id, this.label, this.description);

  /// Stable across releases: it is what the state file remembers.
  final String id;
  final String label, description;
}

/// Which [PhoneExperiment]s are on, remembered across launches. Loaded by `loadPersistedSettings()`
/// before the first frame, so a way in that is on never appears a frame late.
class ExperimentalFeaturesStore extends ValueNotifier<Set<PhoneExperiment>> {
  ExperimentalFeaturesStore({LocalKeyValueStore? storage})
    : _storage = storage ?? HarnessFileStore.shared,
      super(const {});

  static const _key = 'experimental_features';

  final LocalKeyValueStore _storage;

  /// Ids this build does not know, kept so a write does not drop an experiment a newer build of
  /// the app turned on (a TestFlight build, then the store's older one).
  Set<String> _unknown = const {};

  bool isOn(PhoneExperiment experiment) => value.contains(experiment);

  Future<void> load() async {
    try {
      final saved = await _storage.read(_key);
      if (saved == null) return;
      final decoded = jsonDecode(saved);
      if (decoded is! List) return;
      final ids = decoded.whereType<String>().toSet();
      final known = {
        for (final experiment in PhoneExperiment.values) experiment.id,
      };
      _unknown = ids.difference(known);
      value = {
        for (final experiment in PhoneExperiment.values)
          if (ids.contains(experiment.id)) experiment,
      };
    } on Exception {
      // Everything stays off; only the memory is missing.
    }
  }

  Future<void> set(PhoneExperiment experiment, bool on) async {
    if (isOn(experiment) == on) return;
    value = on
        ? {...value, experiment}
        : {...value.where((other) => other != experiment)};
    final ids = [..._unknown, for (final other in value) other.id]..sort();
    try {
      await _storage.write(_key, jsonEncode(ids));
    } on Exception {
      // Kept in memory for this run.
    }
  }
}

final experimentalFeaturesStore = ExperimentalFeaturesStore();
