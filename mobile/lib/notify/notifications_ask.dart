import 'dart:async';
import 'dart:io' show Platform;

import 'package:harness_mobile/core/harness_file_store.dart';
import 'package:harness_mobile/core/local_key_value_store.dart';

/// When the phone asks to notify: once per install, a moment after the first thing it sends to a
/// harness — a Return, a take that went (`phone/terminal_page.dart`).
///
/// ⚠️ **Not during the onboarding, and not with the tips any more** (owner, 2026-10-12). It used to
/// come straight after Focus's first-time tips, before the person had done anything here; now it
/// waits until they have talked to an agent — the moment "a harness asking you something" is worth
/// a notice to them. Asked once and remembered here: iOS would ask only once anyway, but Android
/// asks again each time it is told to, and a phone asking on every launch is nagging.
class NotificationsAsk {
  NotificationsAsk({LocalKeyValueStore? storage})
    : _storage = storage ?? HarnessFileStore.shared;

  static const _key = 'phone_notifications_asked_v1';
  final LocalKeyValueStore _storage;

  /// Shared by every page, so two sends before the first read lands ask once.
  static final shared = NotificationsAsk();

  /// The ask follows the send by this much: the send lands, and is felt, before a system dialog
  /// comes over it.
  static const after = Duration(milliseconds: 1200);

  bool _asked = false;

  /// Something was sent: [ask] — the OS's own prompt — if it has never been asked on this install.
  Future<void> afterSend(Future<void> Function() ask) async {
    if (_asked) return;
    // Settled before any await, so a second send meanwhile does not ask again.
    _asked = true;
    // Under `flutter test` the shared store is the real one in the home directory: never read or
    // write it there.
    if (identical(this, shared) &&
        Platform.environment.containsKey('FLUTTER_TEST')) {
      return;
    }
    try {
      if (await _storage.read(_key) == 'yes') return;
      await _storage.write(_key, 'yes');
    } on Exception {
      // No memory to keep it in: asked this run, and the OS keeps the answer.
    }
    await Future<void>.delayed(after);
    await ask();
  }
}
