import 'dart:async';

import '../api/access_token_source.dart';
import '../logging/app_log.dart';
import '../auth/auth_session.dart';
import 'direct_auth_api.dart';

/// A viewer build's SSO session — authSession.ts's `AuthSessionManager`, moved into the app because
/// a device with no harness CLI has nobody else to hold it: the tokens `/api/auth/exchange` issued,
/// kept in [AuthSession], refreshed [_refreshSkew] before they lapse, one refresh at a time.
class DirectAuth implements AccessTokenSource {
  DirectAuth({required this.session, required this.api});

  final AuthSession session;
  final DirectAuthApi api;
  Future<String>? _refreshing;
  Future<void> _writes = Future<void>.value();
  int _revision = 0;

  static const _refreshSkew = Duration(seconds: 60);

  /// Browser adapters release their cross-tab session listener here.
  void dispose() {}

  Future<bool> hasSession() async {
    final revision = _revision;
    await _writes;
    final token = await session.accessToken();
    _requireCurrent(revision);
    return (token ?? '').isNotEmpty;
  }

  /// Whether a sign-in by hand happened since this was last asked — the device key log reads it to
  /// tell signing in again after a removal from an app opening under a removed key
  /// (`device_log_sync.dart` `register`). Asking clears it.
  bool consumeFreshSignIn() {
    final fresh = _freshSignIn;
    _freshSignIn = false;
    return fresh;
  }

  bool _freshSignIn = false;

  Future<void> signIn(IssuedTokens tokens, {bool Function()? stillCurrent}) {
    _freshSignIn = true;
    final revision = ++_revision;
    _refreshing = null;
    return _write(revision, () async {
      if (stillCurrent?.call() == false) throw _changed;
      await session.saveLogin(
        token: tokens.token,
        refreshToken: tokens.refreshToken,
        autonomousEnv: tokens.autonomousEnv ?? api.config.autonomousEnv,
        expiresIn: tokens.expiresIn,
        ssoClientId: tokens.clientId,
      );
      // Cancel can land during a disk write. These writes are serialized, so
      // clearing this incomplete login cannot erase a newer queued login.
      if (stillCurrent?.call() == false) {
        await session.clear();
        throw _changed;
      }
    });
  }

  /// Signs this device out, and ends a Harness session on the server too. The server's part is
  /// best effort and not waited on: signing out never waits on, or fails over, the network.
  Future<void> signOut() async {
    final revision = ++_revision;
    _refreshing = null;
    String? ended;
    await _write(revision, () async {
      ended = await session.refreshToken();
      await session.clear();
    });
    final refreshToken = ended;
    if (refreshToken != null &&
        DirectAuthApi.isHarnessRefreshToken(refreshToken)) {
      unawaited(_endOnServer(refreshToken));
    }
  }

  Future<void> _endOnServer(String refreshToken) async {
    var ended = false;
    try {
      ended = await api.revoke(refreshToken);
    } catch (_) {}
    if (!ended) {
      appLog.warn(
        'auth',
        'Could not end this sign-in on the server; it can no longer be used from here, '
            'and ends on its own after 90 days unused.',
      );
    }
  }

  // A stale request is no longer allowed to decide that the CURRENT account
  // is signed out. Its caller may discard or retry it without losing a login.
  static const _changed = DirectAuthException('Sign-in changed. Try again.');

  void _requireCurrent(int revision) {
    if (revision != _revision) throw _changed;
  }

  Future<void> _write(int revision, Future<void> Function() action) {
    final result = _writes.then((_) async {
      _requireCurrent(revision);
      await action();
      _requireCurrent(revision);
    });
    // Keep the queue usable after an I/O failure or a cancelled operation.
    _writes = result.then<void>((_) {}, onError: (Object _) {});
    return result;
  }

  @override
  Future<String> accessToken({bool force = false, String? failedToken}) async {
    final revision = _revision;
    await _writes;
    final current = await session.accessToken();
    _requireCurrent(revision);
    if (current == null || current.isEmpty) {
      throw const DirectAuthException('Not signed in.', signedOut: true);
    }
    // Someone else already refreshed past the token that failed — use theirs.
    if (failedToken != null && failedToken != current) return current;
    if (!force) {
      final stale = await _isStale();
      _requireCurrent(revision);
      if (!stale) return current;
    }
    if (_refreshing case final pending?) return pending;
    late final Future<String> refreshing;
    refreshing = _refresh(revision).whenComplete(() {
      if (identical(_refreshing, refreshing)) _refreshing = null;
    });
    return _refreshing = refreshing;
  }

  Future<bool> _isStale() async {
    final expiresAt = await session.accessTokenExpiresAt();
    return expiresAt != null &&
        expiresAt.isBefore(DateTime.now().toUtc().add(_refreshSkew));
  }

  Future<String> _refresh(int revision) async {
    final refreshToken = await session.refreshToken();
    _requireCurrent(revision);
    if (refreshToken == null || refreshToken.isEmpty) {
      await signOut();
      throw const DirectAuthException(
        'Your sign-in expired. Sign in again.',
        signedOut: true,
      );
    }
    try {
      final autonomousEnv = await session.autonomousEnv();
      _requireCurrent(revision);
      final tokens = await api.refresh(
        refreshToken,
        autonomousEnv: autonomousEnv,
        clientId: await session.ssoClientId(),
      );
      _requireCurrent(revision);
      await _write(
        revision,
        () => session.saveRefresh(
          token: tokens.token,
          refreshToken: tokens.refreshToken,
          autonomousEnv: autonomousEnv,
          expiresIn: tokens.expiresIn,
        ),
      );
      return tokens.token;
    } on DirectAuthException catch (error) {
      _requireCurrent(revision);
      if (error.signedOut) await signOut();
      rethrow;
    }
  }
}
