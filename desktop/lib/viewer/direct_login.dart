import 'dart:async';
import 'dart:io';

import '../auth/cli_login.dart';
import '../auth/sign_in_client.dart';
import 'direct_auth.dart';
import 'direct_auth_api.dart';

/// Signing in with no harness CLI — cli.ts `loginCommand`, run by the app: a loopback listener for
/// the SSO redirect, `authorize-native` for the page to show, `exchange` for the tokens.
///
/// It deliberately skips the CLI's closing `resolve-computer`, which registers the computer as a
/// Harness machine. A viewer is not one.
class DirectLogin implements SignInClient {
  DirectLogin({required this.auth});

  final DirectAuth auth;
  _LoopbackCallback? _pending;
  int _loginRevision = 0;

  static const _callbackTimeout = Duration(minutes: 5);

  @override
  Future<CliAuthStatus> checkStatus() async =>
      CliAuthStatus(loggedIn: await auth.hasSession());

  @override
  Future<void> login({
    required void Function(String url) onAuthorizeUrl,
  }) async {
    cancel();
    final revision = _loginRevision;
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    _LoopbackCallback? callback;
    try {
      _requireCurrent(revision);
      callback = _pending = _LoopbackCallback(server);
      final start = await auth.api.authorizeNative(
        'http://127.0.0.1:${server.port}/callback',
      );
      _requireCurrent(revision);
      onAuthorizeUrl(start.authorizeUrl);
      _requireCurrent(revision);
      final redirect = await callback.result.timeout(
        _callbackTimeout,
        onTimeout: () => throw const DirectAuthException('Sign-in timed out.'),
      );
      _requireCurrent(revision);
      if (redirect == null) throw callback.error!;
      final tokens = await auth.api.exchange(
        code: redirect.code,
        state: redirect.state,
        tx: start.tx,
      );
      _requireCurrent(revision);
      await auth.signIn(tokens, stillCurrent: () => revision == _loginRevision);
      _requireCurrent(revision);
    } finally {
      if (identical(_pending, callback)) _pending = null;
      await server.close(force: true);
    }
  }

  @override
  void cancel() {
    ++_loginRevision;
    final callback = _pending;
    _pending = null;
    callback?.cancel();
  }

  void _requireCurrent(int revision) {
    if (revision != _loginRevision) {
      throw const DirectAuthException('Sign-in was cancelled.');
    }
  }

  @override
  Future<void> logout() {
    cancel();
    return auth.signOut();
  }
}

/// The loopback end of the redirect: the first `/callback` carrying `code` and `state` completes
/// it and an `error` fails it; anything else the browser asks for (a favicon) is turned away.
class _LoopbackCallback {
  _LoopbackCallback(this._server) {
    _server.listen(_onRequest);
  }

  final HttpServer _server;
  // Cancellation can precede the authorization response and its listener.
  // Keep the outcome as data until login awaits it, without an unhandled error.
  final _completer = Completer<({String code, String state})?>();
  DirectAuthException? error;

  Future<({String code, String state})?> get result => _completer.future;

  Future<void> _onRequest(HttpRequest request) async {
    final response = request.response;
    if (request.uri.path != '/callback') {
      response.statusCode = HttpStatus.notFound;
      await response.close();
      return;
    }
    final query = request.uri.queryParameters;
    final code = query['code'], state = query['state'], error = query['error'];
    final signedIn = error == null && code != null && state != null;
    response
      ..statusCode = signedIn ? HttpStatus.ok : HttpStatus.badRequest
      ..headers.contentType = ContentType.html
      ..write(
        _page(
          signedIn ? 'Signed in to Harness' : 'Harness sign-in failed',
        ),
      );
    await response.close();
    if (_completer.isCompleted) return;
    if (signedIn) {
      _completer.complete((code: code, state: state));
    } else {
      this.error = DirectAuthException(
        'Sign-in failed: ${error ?? 'no code returned'}',
      );
      _completer.complete(null);
    }
  }

  void cancel() {
    if (!_completer.isCompleted) {
      error = const DirectAuthException('Sign-in was cancelled.');
      _completer.complete(null);
    }
    unawaited(_server.close(force: true));
  }
}

String _page(String title) =>
    '<!doctype html><meta charset="utf-8"><title>$title</title>'
    '<body style="font:16px system-ui,sans-serif;text-align:center;padding:4em 1em">'
    '<h1 style="font-weight:600">$title</h1>'
    '<p>You can close this window and go back to Harness.</p></body>';
