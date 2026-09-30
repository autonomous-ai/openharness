import 'dart:js_interop';

import 'package:web/web.dart' as web;

import '../auth/auth_session.dart';
import '../core/browser_lock.dart';
import 'direct_auth.dart';
import 'direct_auth_api.dart';

DirectAuth createViewerAuth({
  required AuthSession session,
  required DirectAuthApi api,
}) => BrowserAuth(session: session, api: api);

/// Shares one persisted session across tabs while keeping refresh-token
/// rotation, login, and logout mutually exclusive. The existing DirectAuth
/// still owns expiry and provider errors inside that browser-wide lock.
class BrowserAuth extends DirectAuth {
  BrowserAuth({
    required super.session,
    required super.api,
    void Function()? reload,
  }) : _delegate = DirectAuth(session: session, api: api),
       _reload = reload ?? (() => web.window.location.reload()) {
    _generation = web.window.localStorage.getItem(_generationKey);
    _listener = ((web.Event event) {
      final change = event as web.StorageEvent;
      if (change.storageArea == web.window.localStorage &&
          (change.key == null || change.key == _generationKey)) {
        _checkGeneration();
      }
    }).toJS;
    web.window.addEventListener('storage', _listener);
  }

  static const _generationKey = 'harness.web.v1.auth_generation';
  static const _changed = DirectAuthException('Sign-in changed. Try again.');
  final DirectAuth _delegate;
  final void Function() _reload;
  late final JSFunction _listener;
  String? _generation;
  int _revision = 0;
  bool _reloading = false;

  bool _checkGeneration() {
    if (web.window.localStorage.getItem(_generationKey) == _generation) {
      return !_reloading;
    }
    if (!_reloading) {
      _reloading = true;
      ++_revision;
      // Close this account's live transports and restore the new session via
      // normal bootstrap, including when another tab explicitly signs out.
      _reload();
    }
    return false;
  }

  Future<T> _run<T>(
    Future<T> Function() action, {
    bool changesSession = false,
  }) {
    final revision = _revision;
    return withBrowserLock('auth', () async {
      if (!_checkGeneration() || revision != _revision) throw _changed;
      final before = await session.accessToken();
      try {
        final result = await action();
        if (revision != _revision) throw _changed;
        return result;
      } finally {
        if (changesSession ||
            (before != null && await session.accessToken() == null)) {
          _generation = web.window.crypto.randomUUID();
          web.window.localStorage.setItem(_generationKey, _generation!);
        }
      }
    });
  }

  @override
  Future<bool> hasSession() => _run(_delegate.hasSession);

  @override
  bool consumeFreshSignIn() => _delegate.consumeFreshSignIn();

  @override
  Future<void> signIn(IssuedTokens tokens, {bool Function()? stillCurrent}) {
    final revision = ++_revision;
    return _run(
      () => _delegate.signIn(
        tokens,
        stillCurrent: () =>
            revision == _revision && (stillCurrent?.call() ?? true),
      ),
      changesSession: true,
    );
  }

  @override
  Future<void> signOut() {
    ++_revision;
    return _run(_delegate.signOut, changesSession: true);
  }

  @override
  Future<String> accessToken({bool force = false, String? failedToken}) async {
    final revision = _revision;
    // Capture the failed token before waiting, so a second tab can reuse a
    // refresh that finished while it was queued instead of rotating again.
    final previous =
        failedToken ?? (force ? await session.accessToken() : null);
    if (revision != _revision) throw _changed;
    return _run(
      () => _delegate.accessToken(force: force, failedToken: previous),
    );
  }

  @override
  void dispose() {
    ++_revision;
    _reloading = true;
    web.window.removeEventListener('storage', _listener);
  }
}
