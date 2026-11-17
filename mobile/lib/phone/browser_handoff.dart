import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';

import 'package:harness_mobile/state/app_state.dart';

/// A page a program in a harness's pane opened while this phone was the one typing there — Claude Code's
/// `/login`, `gh auth login` — opened here instead of on the computer (cli core/terminals/browser.ts).
///
/// The address is also put on the clipboard: it can be sent to somebody else to sign in for the person.
///
/// A sign-in that returns to the program at `http://localhost:PORT/callback` would land on this phone's own
/// localhost. So the phone listens there itself, as Settings ▸ Connectors does, catches the redirect, closes
/// the browser and hands the redirect to the computer (`browser_callback`), which gives it to the program
/// still waiting on that port. The code is no use without the secret the program kept on the computer.
class BrowserHandoff {
  BrowserHandoff(this.notifier, {required this.say});

  final AppNotifier notifier;

  /// A line for the person, in a snack bar.
  final void Function(String text) say;

  final List<HttpServer> _servers = [];
  Timer? _giveUp;

  /// How long a sign-in may take before the phone stops listening for its redirect.
  static const listenFor = Duration(minutes: 10);

  Future<void> open(String machineId, String url) async {
    final page = Uri.tryParse(url);
    if (page == null || !(page.scheme == 'https' || page.scheme == 'http')) {
      return;
    }
    unawaited(Clipboard.setData(ClipboardData(text: url)).catchError((_) {}));
    final redirect = Uri.tryParse(page.queryParameters['redirect_uri'] ?? '');
    await _stop();
    if (redirect != null && _loopback(redirect)) {
      await _listen(machineId, redirect);
    }
    final opened = await launchUrl(
      page,
      mode: LaunchMode.inAppBrowserView,
    ).catchError((_) => false);
    if (!opened) {
      say(
        'Could not open the browser. The address is copied: open it in a browser.',
      );
      await _stop();
      return;
    }
    say('Sign-in opened on this phone. The address is copied too.');
  }

  static bool _loopback(Uri uri) =>
      uri.scheme == 'http' &&
      (uri.host == 'localhost' || uri.host == '127.0.0.1') &&
      uri.hasPort;

  /// Both loopbacks: a browser may try `localhost` as ::1 before 127.0.0.1.
  Future<void> _listen(String machineId, Uri redirect) async {
    for (final address in [
      InternetAddress.loopbackIPv4,
      InternetAddress.loopbackIPv6,
    ]) {
      try {
        final server = await HttpServer.bind(address, redirect.port);
        _servers.add(server);
        server.listen(
          (request) => unawaited(_caught(machineId, redirect, request)),
        );
        debugPrint('browser: listening on ${address.address}:${redirect.port}');
      } on SocketException {
        // The port is taken on this phone (or there is no IPv6): the browser shows the redirect, and the
        // program still prints its own address to finish by hand.
      }
    }
    _giveUp = Timer(listenFor, () => unawaited(_stop()));
  }

  Future<void> _caught(
    String machineId,
    Uri redirect,
    HttpRequest request,
  ) async {
    if (request.uri.path != redirect.path) {
      request.response.statusCode = HttpStatus.notFound;
      await request.response.close();
      return;
    }
    request.response
      ..statusCode = HttpStatus.ok
      ..headers.contentType = ContentType.html
      ..headers.set('Cache-Control', 'no-store')
      ..write(
        '<!doctype html><meta charset=utf-8>'
        '<meta name=viewport content="width=device-width,initial-scale=1">'
        '<title>Harness</title>'
        "<body style='font:16px ui-monospace,monospace;background:#11140f;color:#e7e8de;padding:32px'>"
        '<h1>Signed in.</h1><p>Return to Harness to finish.</p>',
      );
    await request.response.close();
    await _stop();
    unawaited(closeInAppWebView().catchError((_) {}));
    final caught = redirect.replace(query: request.uri.query).toString();
    debugPrint('browser: caught the sign-in on port ${redirect.port}');
    // The line to the computer is often down while the browser covered the app: try until it is back.
    final deadline = DateTime.now().add(const Duration(minutes: 2));
    while (DateTime.now().isBefore(deadline)) {
      final reply = await notifier.browserCallback(machineId, caught);
      debugPrint(
        'browser: the computer answered ${reply['ok'] == true ? 'ok' : reply['error'] ?? reply['status']}',
      );
      if (reply['error'] == 'UNAVAILABLE') {
        await Future<void>.delayed(const Duration(seconds: 2));
        continue;
      }
      say(
        reply['ok'] == true
            ? 'Signed in on the computer.'
            : 'The computer did not accept the sign-in. Try again.',
      );
      return;
    }
    say('The computer could not be reached. Try signing in again.');
  }

  Future<void> _stop() async {
    _giveUp?.cancel();
    _giveUp = null;
    for (final server in _servers) {
      await server.close(force: true);
    }
    _servers.clear();
  }

  Future<void> dispose() => _stop();
}
