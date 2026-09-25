import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import 'harness_file_store.dart';
import 'local_key_value_store.dart';

/// Whether the app keeps its machine connection alive while it is in another
/// app's shadow — off unless the person asks for it.
///
/// WHAT IT FIXES. Switching to another app and back used to cost a reconnect.
/// Android makes a backgrounded app a "cached" process and freezes cached
/// processes — measured on a Pixel 8 Pro at around 30 seconds. A frozen process
/// runs no code, so it cannot answer the backend's liveness ping, and the
/// backend drops a client that has gone quiet past its deadline
/// (`CLIENT_IDLE_DEADLINE_MS`, `backend/src/lib/hub.ts`). Coming back then costs
/// the whole chain again: dial, machine select, E2EE handshake, desk read,
/// terminal re-attach. Android exempts a process holding a foreground service
/// from the freezer, so with this on none of that happens.
///
/// ⚠️ **WHY IT IS A SETTING AND NOT SIMPLY THE BEHAVIOUR.** Running while out of
/// sight costs a notification the person cannot dismiss — that is Android's
/// bargain, not our choice, and there is no version of this feature without it.
/// A notification nobody asked for, appearing every time they leave the app, is
/// worse than the reconnect it saves for somebody who never noticed the
/// reconnect. So it defaults off and says what it costs.
///
/// ⚠️ **Android only.** iOS does not offer this bargain at all: a backgrounded
/// app is suspended, and no entitlement short of a real background mode (audio,
/// location, VoIP) changes that. [available] is false there and the row is not
/// drawn, rather than a switch that would quietly do nothing.
class BackgroundHoldStore extends ValueNotifier<bool> {
  BackgroundHoldStore({LocalKeyValueStore? storage, MethodChannel? channel})
    : _storage = storage ?? HarnessFileStore.shared,
      _channel = channel ?? const MethodChannel(_channelName),
      super(false);

  static const _key = 'background_hold';
  static const _channelName = 'harness/awake';

  /// How long ONE hold may last, handed to the service so it expires by itself.
  ///
  /// ⚠️ **A hold has to end even if nothing releases it.** The complaint this
  /// answers is an errand in another app; a phone put in a pocket for the
  /// afternoon does not need its socket held, and holding it anyway would sit on
  /// the `dataSync` allowance Android 14 caps at six hours a day — with the
  /// notification showing the whole time — and then be cut off by the system
  /// mid-afternoon anyway. Past this the app is frozen like any other and the
  /// ordinary reconnect takes over, which is what used to happen at 30 seconds.
  static const limit = Duration(minutes: 10);

  final LocalKeyValueStore _storage;
  final MethodChannel _channel;

  /// Whether this platform offers the bargain at all — see the note above.
  bool get available =>
      !kIsWeb && defaultTargetPlatform == TargetPlatform.android;

  Future<void> load() async {
    if (!available) return;
    try {
      value = await _storage.read(_key) == 'on';
    } on Exception {
      // The default stands for this run.
    }
  }

  Future<void> setEnabled(bool enabled) async {
    if (!available || enabled == value) return;
    value = enabled;
    // Turned off while a hold is live — the app is on screen, so there is
    // normally nothing to drop, but a hold left running would keep its
    // notification until its own clock ran out.
    if (!enabled) await release();
    try {
      await _storage.write(_key, enabled ? 'on' : 'off');
    } on Exception {
      // Kept in memory for this run.
    }
  }

  /// Asks the OS to keep this process running. Called on the way OUT of the
  /// foreground, and a no-op when the setting is off.
  ///
  /// ⚠️ **Must be asked while the app is still visible.** Since Android 12 a
  /// foreground service may not be STARTED from the background, so this belongs
  /// to `inactive` — the activity paused but still on screen — and not to
  /// `paused`, which is one step too late. The native side answers false rather
  /// than throwing when the system refuses; see MainActivity.kt.
  Future<bool> hold() async {
    if (!available || !value) return false;
    try {
      final taken = await _channel.invokeMethod<bool>('hold', {
        'limitMs': limit.inMilliseconds,
      });
      return taken ?? false;
    } on PlatformException {
      return false;
    } on MissingPluginException {
      return false;
    }
  }

  /// Lets go, and takes the notification with it. Safe to call with no hold
  /// outstanding, which is the common case.
  Future<void> release() async {
    if (!available) return;
    try {
      await _channel.invokeMethod<bool>('release');
    } on PlatformException {
      // Nothing to release.
    } on MissingPluginException {
      // Nothing to release.
    }
  }
}

final backgroundHoldStore = BackgroundHoldStore();
