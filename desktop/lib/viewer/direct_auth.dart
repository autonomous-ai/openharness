import '../api/access_token_source.dart';
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

  Future<bool> hasSession() async {
    final revision = _revision;
    await _writes;
    final token = await session.accessToken();
    _requireCurrent(revision);
    return (token ?? '').isNotEmpty;
  }

  Future<void> signIn(IssuedTokens tokens, {bool Function()? stillCurrent}) {
    final revision = ++_revision;
    _refreshing = null;
    return _write(revision, () async {
      if (stillCurrent?.call() == false) throw _changed;
      await session.saveLogin(
        token: tokens.token,
        refreshToken: tokens.refreshToken,
        autonomousEnv: tokens.autonomousEnv ?? api.config.autonomousEnv,
        expiresIn: tokens.expiresIn,
      );
      // Cancel can land during a disk write. These writes are serialized, so
      // clearing this incomplete login cannot erase a newer queued login.
      if (stillCurrent?.call() == false) {
        await session.clear();
        throw _changed;
      }
    });
  }

  Future<void> signOut() {
    final revision = ++_revision;
    _refreshing = null;
    return _write(revision, session.clear);
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
