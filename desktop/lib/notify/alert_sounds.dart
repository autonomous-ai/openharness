library;

import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import '../core/harness_file_store.dart';
import '../core/local_key_value_store.dart';

/// What an alert is FOR. The two moments worth interrupting someone over.
enum AlertKind {
  /// An agent finished its turn. The work you were waiting on is on screen.
  done('Glass'),

  /// An agent stopped and is waiting on a person — a question, a permission.
  /// Nothing moves until somebody answers, which is why it is the more
  /// insistent of the two sounds.
  needsYou('Submarine');

  const AlertKind(this.sound);

  /// A macOS system alert sound, played by name. Using the ones every Mac
  /// already has means no audio asset ships with the app, nothing has to be
  /// decoded, and the sounds sit at the volume the person set for alerts.
  final String sound;
}

/// Whether this computer plays a sound when an agent finishes or gets stuck.
///
/// OFF by default. An app that makes a noise nobody asked for is a bad guest,
/// and a swarm is many agents: the first thing a new user would hear is a
/// sound they did not choose, from a window they may not be looking at. It is
/// one switch away in Settings ▸ Notifications for anybody who wants it.
class AlertSoundStore extends ValueNotifier<bool> {
  AlertSoundStore({LocalKeyValueStore? storage})
    : _storage = storage ?? HarnessFileStore.shared,
      super(false);

  static const _key = 'app_alert_sounds';

  final LocalKeyValueStore _storage;
  Future<void>? _save;

  /// Read the saved choice. Tolerant: a missing or hand-edited value lands on
  /// the default rather than throwing, the same rule the appearance store
  /// follows. Only the exact string `on` switches it on, so a truncated file
  /// cannot start making noises nobody asked for.
  Future<void> load() async {
    try {
      value = (await _storage.read(_key)) == 'on';
    } catch (_) {
      value = false;
    }
  }

  /// Apply now, persist in order — rapid flips coalesce so an older write
  /// cannot replace the final choice.
  Future<void> set(bool on) {
    if (value == on) return _save ?? Future.value();
    value = on;
    final pending = (_save ?? Future.value()).then(
      (_) => _storage.write(_key, on ? 'on' : 'off'),
    );
    _save = pending;
    return pending;
  }
}

/// The one store the app reads, loaded at start-up beside the other preferences.
final alertSoundStore = AlertSoundStore();

/// Plays the alerts.
///
/// Separate from the store so the thing that DECIDES whether to make a noise
/// and the thing that makes it can be tested apart — and so a test can hear
/// what would have played without a Mac making a sound in CI.
class AlertSounds {
  AlertSounds({
    required this.store,
    MethodChannel? channel,
    this.now = _systemNow,
    this.gap = const Duration(milliseconds: 1500),
  }) : _channel = channel ?? const MethodChannel('harness/swarm_tabs');

  static DateTime _systemNow() => DateTime.now();

  final AlertSoundStore store;
  final MethodChannel _channel;
  final DateTime Function() now;

  /// The least time between two sounds of the same kind.
  ///
  /// A swarm is many agents, and a batch of them finishing together is the
  /// ordinary case rather than the rare one — without this it is a burst of
  /// beeps that says nothing more than one beep would. Per KIND, so an agent
  /// finishing never swallows the more urgent "somebody is waiting on you".
  final Duration gap;

  final _lastPlayed = <AlertKind, DateTime>{};

  /// Ask for a sound. Silent when the feature is off, and when the same kind
  /// played within [gap].
  ///
  /// Never throws and never awaits anything the caller depends on: this is
  /// called from the event dispatcher, and a platform that cannot make a noise
  /// must not break the frame that carried the news.
  void play(AlertKind kind) {
    if (!store.value) return;
    final at = now();
    final last = _lastPlayed[kind];
    if (last != null && at.difference(last) < gap) return;
    _lastPlayed[kind] = at;
    unawaited(
      _channel
          .invokeMethod<void>('playAlert', {'sound': kind.sound})
          .catchError((_) {}),
    );
  }

  /// For tests, and for a window that has been away long enough that the next
  /// event is news again rather than a continuation.
  @visibleForTesting
  void forget() => _lastPlayed.clear();
}
