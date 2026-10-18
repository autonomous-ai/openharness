import 'dart:async';
import 'dart:io' show Platform;

import 'package:flutter/foundation.dart' show debugPrint;
import 'package:flutter/services.dart';

/// A web page offered to the person's other Apple devices — Handoff — over `harness/handoff`
/// (`ios/Runner/AppDelegate.swift`).
///
/// While "On your computer, go to" is up, a Mac nearby signed in to the same Apple account shows
/// the download page in its Dock: one click, nothing typed (`docs/research/2026-10-11-phone-
/// onboarding`). iOS only: Android has nothing like it, and there the address is shared or typed.
///
/// ⚠️ **Offered again each time the app comes back to the front.** iOS stops advertising an
/// activity while the app is in the background, and the page that offered it may be up long
/// after — the person away installing Harness.
abstract final class Handoff {
  static const _channel = MethodChannel('harness/handoff');

  /// Whatever is offering the page now. Two screens can offer it at once — home's "On your
  /// computer, go to" and the same step pushed from Computers over it — and the page is withdrawn
  /// only once neither does.
  static final _holders = <Object>{};

  /// Offer [url] — an https page — on behalf of [holder], until it [withdraw]s. Offering again
  /// for the same holder (the app back in front) only offers it again.
  static Future<void> offer(Object holder, Uri url) {
    _holders.add(holder);
    return _call('offer', url.toString());
  }

  /// [holder] no longer offers the page; it is withdrawn once nothing does.
  static Future<void> withdraw(Object holder) {
    if (!_holders.remove(holder) || _holders.isNotEmpty) return Future.value();
    return _call('withdraw');
  }

  static Future<void> _call(String method, [Object? argument]) async {
    if (!Platform.isIOS) return;
    try {
      await _channel.invokeMethod<void>(method, argument);
    } on MissingPluginException {
      // A runner without the channel (an older build, a test): nothing nearby is offered the page,
      // which is all Handoff ever adds.
    } on PlatformException catch (error) {
      debugPrint('Handoff.$method: $error');
    }
  }
}
