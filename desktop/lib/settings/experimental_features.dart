import 'dart:async';

import 'package:flutter/foundation.dart';

import '../api/api_client.dart';
import '../core/viewer_mode.dart';

enum ExperimentalFeature {
  focusBarCreature(
    'focus_bar_creature',
    'Focus-bar creature',
    'Start with an egg in the focus bar and find Companions in Harness Store. Your collection and progress are saved to your account.',
  ),
  shareButton(
    'share_button',
    'Share button',
    'Show Share in the top-right corner of the workspace.',
  );

  const ExperimentalFeature(this.id, this.label, this.description);
  final String id, label, description;
  bool get available => switch (this) {
    focusBarCreature => !kIsWeb && !kViewerMode,
    shareButton => true,
  };
}

abstract interface class ExperimentalSettingsTransport {
  Future<Map<String, dynamic>> read();
  Future<Map<String, dynamic>> write(
    String accountId,
    ExperimentalFeature feature,
    bool enabled,
  );
}

class ApiExperimentalSettingsTransport
    implements ExperimentalSettingsTransport {
  ApiExperimentalSettingsTransport(this.api);
  final ApiClient api;
  @override
  Future<Map<String, dynamic>> read() => api.experimentalSettings();
  @override
  Future<Map<String, dynamic>> write(
    String accountId,
    ExperimentalFeature feature,
    bool enabled,
  ) => api.setExperimentalSetting(accountId, feature.id, enabled);
}

/// Account opt-ins. No installation-wide cache can enable another account's experiments.
/// Changes are displayed only after acknowledgement; reads never write or migrate local choices.
class ExperimentalFeaturesStore extends ChangeNotifier {
  ExperimentalFeaturesStore({this.pollInterval = const Duration(seconds: 30)});
  final Duration pollInterval;
  final _choices = <ExperimentalFeature, bool>{};
  final _available = <ExperimentalFeature, bool>{};
  ExperimentalSettingsTransport? _transport;
  String? accountId;
  int _generation = 0, _epoch = 0, _revision = -1;
  bool loaded = false, saving = false, _disposed = false;
  String? error;
  ExperimentalFeature? savingFeature, errorFeature;
  Future<void>? _reading;
  Timer? _poll;

  bool enabled(ExperimentalFeature feature) => choice(feature) == true;
  bool? choice(ExperimentalFeature feature) =>
      loaded ? _choices[feature] : null;
  bool isAvailable(ExperimentalFeature feature) => _available[feature] != false;
  bool get signedIn => accountId != null;

  void bind(String? account, {ExperimentalSettingsTransport? transport}) {
    if (_disposed || (accountId == account && _transport == transport)) return;
    ++_generation;
    ++_epoch;
    accountId = account;
    _transport = transport;
    loaded = saving = false;
    savingFeature = errorFeature = null;
    error = null;
    _revision = -1;
    _choices.clear();
    _available.clear();
    _reading = null;
    _poll?.cancel();
    _poll = null;
    _notify();
    if (account != null && transport != null) {
      unawaited(refresh());
      if (pollInterval > Duration.zero) {
        _poll = Timer.periodic(pollInterval, (_) => unawaited(refresh()));
      }
    }
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  bool _current(int generation) => !_disposed && generation == _generation;

  Future<void> refresh() {
    if (_disposed || accountId == null || _transport == null || saving) {
      return Future.value();
    }
    final pending = _reading;
    if (pending != null) return pending;
    late final Future<void> reading;
    reading = _read(_generation, _epoch).whenComplete(() {
      if (identical(_reading, reading)) _reading = null;
    });
    return _reading = reading;
  }

  Future<void> _read(int generation, int epoch) async {
    try {
      final result = await _transport!.read();
      if (!_current(generation) || epoch != _epoch) return;
      _apply(result);
      error = null;
      errorFeature = null;
    } catch (_) {
      if (!_current(generation) || epoch != _epoch) return;
      error = 'Couldn’t read your account settings. Refresh to try again.';
    }
    _notify();
  }

  void _apply(Map<String, dynamic> result) {
    final revision = result['revision'];
    final features = result['features'];
    final available = result['available'];
    if (result['accountId'] != accountId ||
        revision is! int ||
        revision < 0 ||
        features is! Map ||
        ExperimentalFeature.values.any(
          (feature) => features[feature.id] is! bool,
        )) {
      throw const FormatException('Invalid account settings');
    }
    if (revision < _revision) return;
    _revision = revision;
    for (final feature in ExperimentalFeature.values) {
      // Older servers do not know this experiment. Keep their existing
      // settings usable, and leave the new feature off and unavailable.
      _choices[feature] = features[feature.id] == true;
      _available[feature] =
          features.containsKey(feature.id) &&
          (available is! Map || available[feature.id] != false);
    }
    loaded = true;
  }

  Future<void> set(ExperimentalFeature feature, bool on) async {
    if (_disposed ||
        !loaded ||
        saving ||
        accountId == null ||
        _transport == null) {
      return;
    }
    final generation = _generation;
    ++_epoch;
    saving = true;
    savingFeature = feature;
    error = null;
    errorFeature = null;
    _notify();
    try {
      final result = await _transport!.write(accountId!, feature, on);
      if (!_current(generation)) return;
      _apply(result);
    } catch (_) {
      if (!_current(generation)) return;
      error =
          'Couldn’t confirm the change. Refresh to check your saved setting.';
      errorFeature = feature;
    } finally {
      if (_current(generation)) {
        saving = false;
        savingFeature = null;
        _notify();
      }
    }
  }

  @override
  void dispose() {
    _disposed = true;
    _poll?.cancel();
    super.dispose();
  }
}
