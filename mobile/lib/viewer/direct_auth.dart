import '../api/access_token_source.dart';
import '../auth/auth_session.dart';
import 'direct_auth_api.dart';
import 'email_code_api.dart';

/// A viewer build's SSO session — authSession.ts's `AuthSessionManager`, moved into the app because
/// a device with no harness CLI has nobody else to hold it: the tokens `/api/auth/exchange` issued,
/// kept in [AuthSession], refreshed [_refreshSkew] before they lapse, one refresh at a time.
class DirectAuth implements AccessTokenSource {
  DirectAuth({
    required this.session,
    required this.api,
    EmailCodeApi? emailCodes,
  }) : emailCodes = emailCodes ?? EmailCodeApi(config: api.config);

  final AuthSession session;
  final DirectAuthApi api;

  /// Where a session signed in with an emailed code is renewed — see [SessionIssuer].
  final EmailCodeApi emailCodes;
  Future<String>? _refreshing;

  static const _refreshSkew = Duration(seconds: 60);

  Future<bool> hasSession() async =>
      ((await session.accessToken()) ?? '').isNotEmpty;

  /// Which session [session] holds, counted: bumped every time it is replaced — a sign-in, a
  /// sign-out. A refresh that set off under one count and lands under another answers for a
  /// session this device no longer has, and must not touch the one it has now (see [_refresh]).
  int _generation = 0;

  /// Whether a sign-in by hand happened since this was last asked — the device key log reads it to
  /// tell signing in again after a removal from an app opening under a removed key
  /// (`device_log_sync.dart` `register`). Asking clears it.
  bool consumeFreshSignIn() {
    final fresh = _freshSignIn;
    _freshSignIn = false;
    return fresh;
  }

  bool _freshSignIn = false;

  Future<void> signIn(
    IssuedTokens tokens, {
    SessionIssuer issuer = SessionIssuer.sso,
  }) {
    _freshSignIn = true;
    _generation++;
    return session.saveLogin(
      token: tokens.token,
      refreshToken: tokens.refreshToken,
      autonomousEnv: tokens.autonomousEnv ?? api.config.autonomousEnv,
      expiresIn: tokens.expiresIn,
      issuer: issuer,
      ssoClientId: tokens.clientId,
    );
  }

  /// A session Harness issued itself is ended at the backend too, so its
  /// refresh token is dead even if a copy of this phone's storage turns up.
  /// Only briefly waited on: signing out never hangs on the network.
  ///
  /// ⚠️ Forgotten HERE before the backend is asked, not after. For the few
  /// seconds the revoke may take, the session used to still be on disk — and a
  /// socket redialling in that window refreshed it and saved the renewal, after
  /// the person had signed out.
  Future<void> signOut() async {
    _generation++;
    final revoke = await session.issuer() == SessionIssuer.harness
        ? await session.refreshToken()
        : null;
    await session.clear();
    if (revoke != null && revoke.isNotEmpty) {
      try {
        await api.revoke(revoke).timeout(const Duration(seconds: 3));
      } catch (_) {}
    }
  }

  @override
  Future<String> accessToken({bool force = false, String? failedToken}) async {
    // Token and expiry in one read: every WebSocket dial comes through here, and
    // the two of them live in the same file behind the same exclusive lock, so
    // asking separately doubled the disk work on the one call the launch and
    // every reconnect wait on. See [AuthSession.accessTokenWithExpiry].
    final saved = await session.accessTokenWithExpiry();
    final current = saved.token;
    if (current == null || current.isEmpty) {
      throw const DirectAuthException('Not signed in.', signedOut: true);
    }
    // Someone else already refreshed past the token that failed — use theirs.
    if (failedToken != null && failedToken != current) return current;
    if (!force && !_isStale(saved.expiresAt)) return current;
    return _refreshing ??= _refresh().whenComplete(() => _refreshing = null);
  }

  /// A token with no recorded expiry is taken at face value: it is what a
  /// session saved by a build that did not store one looks like, and refusing it
  /// would sign that user out for no reason. A server rejection still routes
  /// through `failedToken` above.
  bool _isStale(DateTime? expiresAt) =>
      expiresAt != null &&
      expiresAt.isBefore(DateTime.now().toUtc().add(_refreshSkew));

  /// ⚠️ **Nothing a refresh brings back is saved once the session it was for has gone.** It is
  /// the one network call here that WRITES the session, and it can be in the air for as long as
  /// the network takes: sign out meanwhile and its renewal put the session back (the next launch
  /// walked straight past the sign-in screen); sign in as somebody else and it overwrote them. Its
  /// refusal likewise cleared a session that was not the one refused. Either way, whoever asked is
  /// answered for the session there is now.
  Future<String> _refresh() async {
    final generation = _generation;
    final refreshToken = await session.refreshToken();
    if (generation != _generation) return await _currentToken();
    if (refreshToken == null || refreshToken.isEmpty) {
      await session.clear();
      throw const DirectAuthException(
        'Your sign-in expired. Sign in again.',
        signedOut: true,
      );
    }
    try {
      final autonomousEnv = await session.autonomousEnv();
      // A refresh token only renews where it was issued.
      final tokens = switch (await session.issuer()) {
        SessionIssuer.emailCode => await emailCodes.refresh(refreshToken),
        // An SSO session names the client it was issued to, or auth-service refuses it.
        SessionIssuer.sso => await api.refresh(
          refreshToken,
          autonomousEnv: autonomousEnv,
          clientId: await session.ssoClientId(),
        ),
        SessionIssuer.harness => await api.refresh(
          refreshToken,
          autonomousEnv: autonomousEnv,
        ),
      };
      if (generation != _generation) return await _currentToken();
      await session.saveRefresh(
        token: tokens.token,
        refreshToken: tokens.refreshToken,
        autonomousEnv: autonomousEnv,
        expiresIn: tokens.expiresIn,
      );
      return tokens.token;
    } on DirectAuthException catch (error) {
      if (generation != _generation) return await _currentToken();
      if (error.signedOut) await session.clear();
      rethrow;
    }
  }

  /// The token of the session this device holds now, for a refresh that outlived its own.
  Future<String> _currentToken() async {
    final token = await session.accessToken();
    if (token == null || token.isEmpty) {
      throw const DirectAuthException('Not signed in.', signedOut: true);
    }
    return token;
  }
}
