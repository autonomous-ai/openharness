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
  ),

  /// What agents may do with Harness: the account's, on every computer it signs in to, each off
  /// until turned on. They were each computer's Settings ▸ Agents until the owner made them
  /// experiments of the account (2026-10-12). Each computer's daemon keeps a copy for its launches
  /// (cli/src/lib/agentSettings.ts) and `harness settings` turns them from a terminal.
  agentsStartAgents(
    'agents_start_agents',
    'Agents can start other agents',
    'Turn on to let Claude Code and Codex start, wait for and close harnesses of their own; their '
        'instructions say how. Off, each agent works alone.',
  ),
  agentPullRequestLine(
    'agent_pull_request_line',
    'Mark pull requests from agent-started harnesses',
    'Turn on to have a harness another agent started add one line to the pull requests it opens: '
        '🤝 Started by another agent in Harness.',
  ),

  /// Agent Messages (docs/design/2026-10-10-agent-messages.md). It replaced each tab's own switch,
  /// a 💬 beside its × that was easy to hit by mistake and turned the tab off, failing a message
  /// that was waiting (owner, 2026-10-12).
  agentMessages(
    'agent_messages',
    'Agents in the same tab can message each other',
    'Turn on to let Claude Code and Codex in one tab send each other messages with harness send. Invite people to a tab and their harnesses join it from their own computers.',
  ),

  /// Stored inverted (ruling T4): every account experiment is "off unless true", and the summary is
  /// shared unless the person hides it. The switch shows it as "share", checked when this is off.
  agentMessagesHideSummary(
    'agent_messages_hide_summary',
    'Share a one-line summary of what your harnesses are doing with people in your shared tabs',
    'One line of at most 120 characters, for the harnesses listed in a shared tab.',
  ),

  /// `harness tell` (cli/src/messages/tell.ts): one way, from the starter, apart
  /// from Agent Messages, which give a started harness no exception (owner, 2026-10-11).
  agentsTellAgents(
    'agents_tell_agents',
    'Agents can give more work to harnesses they started',
    'Turn on to let an agent send a harness it started its next task with harness tell, in the same conversation, on any of your machines.',
  );

  const ExperimentalFeature(this.id, this.label, this.description);
  final String id, label, description;

  /// Super Tab owns coordination. Keep the old wire values readable for existing
  /// clients and sessions, without asking people to assemble the feature here.
  bool get visibleInSettings => this == focusBarCreature || this == shareButton;

  /// The switch shows the opposite of the stored value.
  bool get inverted => this == agentMessagesHideSummary;
  bool get available => switch (this) {
    focusBarCreature => !kIsWeb && !kViewerMode,
    shareButton ||
    agentsStartAgents ||
    agentPullRequestLine ||
    agentMessages ||
    agentMessagesHideSummary ||
    agentsTellAgents => true,
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
    Map<String, dynamic>? result;
    try {
      result = await _transport!.read();
    } catch (_) {}
    if (!_current(generation) || epoch != _epoch) return;
    final before = _shown();
    try {
      if (result == null) throw const FormatException('Unreadable');
      _apply(result);
      error = null;
      errorFeature = null;
    } catch (_) {
      error = 'Couldn’t read your account settings. Refresh to try again.';
    }
    // The fallback poll reads every 30 s and almost always finds nothing new.
    // Every pane header, the workspace screen (a setState and a native menu
    // sync) and search listen here, so notifying on each read rebuilt them
    // twice a minute for every account, on the UI thread whose long frames
    // production samples (Oct 17: 6.7% of Linux samples over 250 ms, macOS
    // 0.25%). Only a read that changes what is shown notifies.
    if (!listEquals(before, _shown())) _notify();
  }

  /// Everything a listener can read after a read: a newer revision that
  /// changes no choice changes nothing on screen.
  List<Object?> _shown() => [
    loaded,
    error,
    errorFeature,
    for (final feature in ExperimentalFeature.values) ...[
      _choices[feature],
      _available[feature],
    ],
  ];

  void _apply(Map<String, dynamic> result) {
    final revision = result['revision'];
    final features = result['features'];
    final available = result['available'];
    if (result['accountId'] != accountId ||
        revision is! int ||
        revision < 0 ||
        features is! Map ||
        // An experiment a server does not name is one it predates (below), not a bad answer:
        // the agents' three reached the app before every backend had them.
        ExperimentalFeature.values.any(
          (feature) =>
              features.containsKey(feature.id) && features[feature.id] is! bool,
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

/// One experiment's [ExperimentalFeaturesStore.choice] as a listenable: null
/// until the account's settings are read. It notifies whenever the store does
/// — when any experiment, its availability, a save or an error changes — so a
/// listener compares with the value it last saw.
class ExperimentChoice implements ValueListenable<bool?> {
  const ExperimentChoice(this.store, this.feature);

  final ExperimentalFeaturesStore store;
  final ExperimentalFeature feature;

  @override
  bool? get value => store.choice(feature);

  @override
  void addListener(VoidCallback listener) => store.addListener(listener);

  @override
  void removeListener(VoidCallback listener) => store.removeListener(listener);
}
