import 'dart:async';

import 'package:flutter/services.dart';

import 'package:harness_mobile/logging/app_log.dart';

import 'system_notices.dart';

/// This phone's push token on the server, so a thread reply or a tag reaches
/// it while the app is closed (task #2905; backend `push/`).
///
/// `harness/push` (Swift: `PushChannel` in `ios/Runner/AppDelegate.swift`;
/// Kotlin: `MainActivity.kt`). Dart asks `token` (`{platform, token}`, or null
/// on a build without push), `delivered` (the keys of pushes in the
/// notification centre) and `launchLink` (the link of the push whose tap
/// launched the app). Native says `token` when the token changes and `opened`
/// (`{link}`) when a push is tapped.
///
/// A push says what the app's own notices say, with the same key
/// (`swarm_notices.dart`), and is never drawn while the app is in front: there
/// the app's notices decide, as they did before.
class PushRegistration {
  PushRegistration({
    this.channel = const MethodChannel('harness/push'),
    required this.register,
    required this.drop,
    required this.open,
    this.dropTimeout = const Duration(seconds: 5),
  });

  final MethodChannel channel;

  /// Keeps the token on the server for the signed-in person.
  final Future<bool> Function(String platform, String token) register;

  /// Takes it off: the person is signing out.
  final Future<bool> Function(String platform, String token) drop;

  /// Opens where a tapped push leads.
  final void Function(SwarmNoticeTarget target) open;

  /// How long a sign-out waits for the server, as the device log's leave does.
  final Duration dropTimeout;

  bool _signedIn = false;
  ({String platform, String token})? _registered;

  /// Listens to the native side, and opens the push whose tap launched the app.
  Future<void> start() async {
    channel.setMethodCallHandler(_fromNative);
    _openLink(await _ask<String>('launchLink'));
  }

  /// Signed in: the server keeps this phone's token for the person.
  Future<void> signedIn() async {
    _signedIn = true;
    final raw = await _ask<Map<Object?, Object?>>('token');
    if (_signedIn) await _send(_tokenOf(raw));
  }

  /// Signing out, while the sign-in still works to say so: the server forgets
  /// this phone's token. Best effort, and brief.
  Future<void> signedOut() async {
    _signedIn = false;
    final registered = _registered;
    _registered = null;
    if (registered == null) return;
    try {
      await drop(registered.platform, registered.token).timeout(dropTimeout);
    } catch (error) {
      appLog.warn('push', 'token not dropped at sign-out', error: error);
    }
  }

  /// The keys of this app's pushes still in the notification centre: told
  /// already, never posted again by the app.
  Future<Set<String>> deliveredKeys() async =>
      {...?(await _ask<List<Object?>>('delivered'))?.whereType<String>()};

  Future<void> _fromNative(MethodCall call) async {
    switch (call.method) {
      case 'token' when _signedIn:
        await _send(_tokenOf(call.arguments));
      case 'opened':
        final arguments = call.arguments;
        _openLink(arguments is Map ? arguments['link'] : null);
    }
  }

  Future<void> _send(({String platform, String token})? token) async {
    if (token == null || token == _registered) return;
    try {
      if (await register(token.platform, token.token)) {
        _registered = token;
      } else {
        appLog.warn('push', 'token not kept by the server');
      }
    } catch (error) {
      appLog.warn('push', 'token not registered', error: error);
    }
  }

  void _openLink(Object? link) {
    if (link is! String) return;
    if (decodeSwarmPayload(link) case final target?) open(target);
  }

  static ({String platform, String token})? _tokenOf(Object? raw) {
    if (raw is! Map) return null;
    final platform = raw['platform'], token = raw['token'];
    if (platform is! String || token is! String || token.isEmpty) return null;
    return (platform: platform, token: token);
  }

  /// Null where the native side is missing (a test, a desktop) or failed.
  Future<T?> _ask<T>(String method) async {
    try {
      return await channel.invokeMethod<T>(method);
    } on MissingPluginException {
      return null;
    } catch (error) {
      appLog.warn('push', '$method failed', error: error);
      return null;
    }
  }
}
