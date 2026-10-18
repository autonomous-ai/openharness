import 'dart:async';

import 'package:flutter/foundation.dart' show debugPrint;
import 'package:flutter/services.dart';

/// A short sound the app plays of its own — over `harness/chime` (`ios/Runner/AppDelegate.swift`,
/// `android/…/MainActivity.kt`).
///
/// There is one: [joined], the two soft glass notes when a computer joins during the onboarding —
/// the only sound in setup (`docs/research/2026-10-11-phone-onboarding`).
///
/// ⚠️ **Muted means silent, and the haptics stay.** iOS plays it through System Sound Services,
/// which the Ring/Silent switch silences, and which leaves the audio session — the voice input's
/// recorder's — alone; Android plays it only in the ringer's normal mode. The caller's haptic is
/// felt either way.
abstract final class Chime {
  static const _channel = MethodChannel('harness/chime');

  /// A computer joined: A5 then E6, a fifth apart (`scripts/make_joined_chime.py`).
  static const joined = 'assets/sound/joined.wav';

  /// Plays [asset] once, and does not wait for it. Nothing happens on a runner without the channel.
  static Future<void> play(String asset) async {
    try {
      await _channel.invokeMethod<bool>('play', asset);
    } on MissingPluginException {
      // A test, or a runner from before the chime: the haptic beside it is the whole moment.
    } on PlatformException catch (error) {
      debugPrint('Chime.play($asset): $error');
    }
  }
}
