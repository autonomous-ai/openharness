import 'package:harness/core/local_key_value_store.dart';
import 'package:harness/settings/experimental_features.dart';

String experimentFixtureKey(ExperimentalFeature feature) =>
    'experimental.${feature.id}';

/// An injected server fixture. The production store never reads these local keys.
class MemoryExperimentalTransport implements ExperimentalSettingsTransport {
  MemoryExperimentalTransport(this.storage, {this.accountId = 'u1'});
  final LocalKeyValueStore storage;
  final String accountId;
  int revision = 0;

  @override
  Future<Map<String, dynamic>> read() async => {
    'accountId': accountId,
    'revision': revision,
    'features': {
      for (final feature in ExperimentalFeature.values)
        feature.id: await storage.read(experimentFixtureKey(feature)) == 'on',
    },
  };

  @override
  Future<Map<String, dynamic>> write(
    String account,
    ExperimentalFeature feature,
    bool enabled,
  ) async {
    if (account != accountId) throw StateError('Account changed');
    await storage.write(experimentFixtureKey(feature), enabled ? 'on' : 'off');
    revision++;
    return read();
  }
}

/// ⚠️ Built in a `setUp`, `await refresh()` there too. The constructor starts the first read from
/// the real zone; a `testWidgets` body that awaits it (any [set] before it lands does) waits in the
/// fake-async zone, whose microtasks nothing flushes without a pump — the test hangs until the
/// binding's timeout instead of failing. Built inside the test body, everything stays in one zone.
class MemoryExperimentalFeaturesStore extends ExperimentalFeaturesStore {
  MemoryExperimentalFeaturesStore({required LocalKeyValueStore storage})
    : super(pollInterval: Duration.zero) {
    bind('u1', transport: MemoryExperimentalTransport(storage));
  }

  @override
  Future<void> set(ExperimentalFeature feature, bool on) async {
    if (!loaded) await refresh();
    await super.set(feature, on);
  }
}
