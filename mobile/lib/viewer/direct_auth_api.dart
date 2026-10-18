import 'package:dio/dio.dart';

import '../auth/sign_in_provider.dart';
import '../core/config.dart';
import '../logging/http_log.dart';

/// A sign-in or refresh that produced no usable session.
class DirectAuthException implements Exception {
  const DirectAuthException(
    this.message, {
    this.signedOut = false,
    this.unreachable = false,
  });

  final String message;

  /// The session is gone for good: retrying cannot help, only signing in again.
  final bool signedOut;

  /// The request never reached the backend — no connection, no name lookup — so nothing it
  /// carried was spent, and the same request may be sent again.
  final bool unreachable;

  @override
  String toString() => message;
}

/// What `/api/auth/exchange`, `/api/auth/refresh` and `/api/auth/handoff/redeem` hand back.
class IssuedTokens {
  const IssuedTokens({
    required this.token,
    this.refreshToken,
    this.expiresIn,
    this.autonomousEnv,
    this.clientId,
  });

  final String token;
  final String? refreshToken;

  /// Seconds.
  final int? expiresIn;
  final String? autonomousEnv;

  /// The auth-service client an exchange issued these to, which every refresh must name again.
  /// Null is the backend's configured one — and what a backend from before the clients were
  /// split answers, so this is kept as answered, never assumed from what was asked for.
  final String? clientId;

  static IssuedTokens? fromData(Object? data) {
    if (data is! Map) return null;
    final token = data['token'], refresh = data['refreshToken'];
    final expiresIn = data['expiresIn'], env = data['autonomousEnv'];
    final clientId = data['clientId'];
    if (token is! String || token.isEmpty) return null;
    return IssuedTokens(
      token: token,
      refreshToken: refresh is String && refresh.isNotEmpty ? refresh : null,
      expiresIn: expiresIn is int && expiresIn > 0 ? expiresIn : null,
      autonomousEnv: env is String ? env : null,
      clientId: clientId is String && clientId.isNotEmpty ? clientId : null,
    );
  }
}

/// The backend's auth endpoints, called by the app itself — in a desktop build the harness CLI
/// calls them (cli.ts `loginCommand`, authSession.ts `refreshRequest`). No bearer rides these:
/// they are how one is got.
class DirectAuthApi {
  DirectAuthApi({required this.config, Dio? dio})
    : _dio =
          dio ??
          attachHttpLog(
            Dio(
              BaseOptions(
                baseUrl: config.apiBaseUrl,
                connectTimeout: const Duration(seconds: 15),
                receiveTimeout: const Duration(seconds: 30),
                validateStatus: (status) => status != null && status < 600,
              ),
            ),
          );

  final AppConfig config;
  final Dio _dio;

  /// auth-service's client for this app (backend `SSO_CLIENT_IDS`), as the desktop's
  /// `auth/sso_client.dart` names it on a phone: the sign-in is made as the phone. What the
  /// tokens are actually issued to comes back from [exchange] ([IssuedTokens.clientId]).
  static const ssoClientId = 'harness-mobile';

  static const _unavailable =
      'Could not renew your sign-in. That is usually the sign-in service having a moment — '
      'if it keeps happening, sign out and sign in again.';

  static const _unreachable =
      'Could not reach Harness. Check your connection and try again.';

  /// The SSO page to show for a sign-in that redirects back to [redirectUri] — a loopback
  /// address, the only kind `/api/auth/authorize-native` takes — and the transaction [exchange]
  /// names. [provider] is the account the page opens on.
  Future<({String authorizeUrl, String tx})> authorizeNative(
    String redirectUri, {
    required SignInProvider provider,
  }) async {
    final Response<dynamic> res;
    try {
      res = await _dio.post(
        '/api/auth/authorize-native',
        data: {
          'redirectUri': redirectUri,
          'autonomousEnv': config.autonomousEnv,
          'clientId': ssoClientId,
          'provider': provider.name,
        },
      );
    } on DioException {
      throw const DirectAuthException(_unreachable);
    }
    final body = res.data is Map ? res.data as Map : const {};
    final data = body['success'] == true && body['data'] is Map
        ? body['data'] as Map
        : const {};
    final url = data['authorizeUrl'], tx = data['tx'];
    if (url is! String || url.isEmpty || tx is! String || tx.isEmpty) {
      throw const DirectAuthException(
        'Could not start signing in. Try again in a moment.',
      );
    }
    return (authorizeUrl: _openingOn(url, provider), tx: tx);
  }

  /// [authorizeUrl], naming [provider]. The backend writes it into the page it hands back — but
  /// only one that knows the field does. It is the browser's to carry and changes nothing the
  /// backend holds (state, PKCE, client), so it is set here as well — as the desktop does.
  static String _openingOn(String authorizeUrl, SignInProvider provider) {
    final uri = Uri.tryParse(authorizeUrl);
    if (uri == null) return authorizeUrl;
    return uri
        .replace(
          queryParameters: {...uri.queryParameters, 'provider': provider.name},
        )
        .toString();
  }

  /// Trade the code the SSO page redirected back with for this phone's tokens. The backend checks
  /// [state] against the transaction [tx] it started, which works once.
  Future<IssuedTokens> exchange({
    required String code,
    required String state,
    required String tx,
  }) async {
    final Response<dynamic> res;
    try {
      res = await _dio.post(
        '/api/auth/exchange',
        data: {'code': code, 'state': state, 'tx': tx},
      );
    } on DioException catch (error) {
      // Only a request that never left: the backend spends [tx] on the first exchange that
      // reaches it, so one that may have arrived is not one to send twice.
      throw DirectAuthException(
        _unreachable,
        unreachable:
            error.type == DioExceptionType.connectionError ||
            error.type == DioExceptionType.connectionTimeout,
      );
    }
    final body = res.data is Map ? res.data as Map : const {};
    final tokens = body['success'] == true
        ? IssuedTokens.fromData(body['data'])
        : null;
    if (tokens != null) return tokens;
    final error = body['error'] is Map ? body['error'] as Map : const {};
    final message = error['message'];
    // Its own words only where they are written for a person: the account is not allowed on
    // this environment. The rest (`invalid_state`, a token endpoint's status) are not.
    final forPerson =
        res.statusCode == 403 && message is String && message.isNotEmpty;
    throw DirectAuthException(
      forPerson ? message : 'Sign-in didn’t finish. Try again.',
    );
  }

  /// Trade the one-time code in a signed-in computer's Add Phone QR for a
  /// session of this phone's own — scan to sign in, no emailed code. [label]
  /// is what the phone calls itself, for the account's list of devices.
  ///
  /// A spent or expired code is the backend's 401 and its own sentence.
  Future<IssuedTokens> redeemHandoff(
    String code, {
    required String label,
  }) async {
    final Response<dynamic> res;
    try {
      res = await _dio.post(
        '/api/auth/handoff/redeem',
        data: {'code': code, 'label': label},
      );
    } on DioException {
      throw const DirectAuthException(
        'Could not reach Harness. Check your connection and scan again.',
      );
    }
    final body = res.data is Map ? res.data as Map : const {};
    final tokens = body['success'] == true
        ? IssuedTokens.fromData(body['data'])
        : null;
    if (tokens != null) return tokens;
    final error = body['error'] is Map ? body['error'] as Map : const {};
    final message = error['message'];
    throw DirectAuthException(
      message is String && message.isNotEmpty
          ? message
          : 'That code didn’t work. Scan the new one.',
    );
  }

  /// End a session the backend issued itself ([SessionIssuer.harness]).
  /// Best effort: the caller clears this phone's copy whatever the answer.
  Future<void> revoke(String refreshToken) async {
    await _dio.post('/api/auth/revoke', data: {'refreshToken': refreshToken});
  }

  /// authSession.ts `refreshRequest`, down to its one subtle rule: only a 401 or
  /// `REFRESH_TOKEN_INVALID` means the session is dead. An unusable refresh token and a real outage
  /// both come back as the same 503, and reading that as dead would delete a refresh token nothing
  /// can bring back — on a blip.
  ///
  /// [clientId] is the client the session was issued to ([IssuedTokens.clientId]): a refresh
  /// under any other is refused.
  Future<IssuedTokens> refresh(
    String refreshToken, {
    required String autonomousEnv,
    String? clientId,
  }) async {
    final Response<dynamic> res;
    try {
      res = await _dio.post(
        '/api/auth/refresh',
        data: {
          'refreshToken': refreshToken,
          'autonomousEnv': autonomousEnv,
          'clientId': ?clientId,
        },
      );
    } on DioException {
      throw const DirectAuthException(_unavailable);
    }
    final body = res.data is Map ? res.data as Map : const {};
    final error = body['error'] is Map ? body['error'] as Map : const {};
    if (res.statusCode == 401 || error['code'] == 'REFRESH_TOKEN_INVALID') {
      throw const DirectAuthException(
        'Your sign-in expired. Sign in again.',
        signedOut: true,
      );
    }
    final tokens = body['success'] == false
        ? null
        : IssuedTokens.fromData(body['data']);
    return tokens ?? (throw const DirectAuthException(_unavailable));
  }
}
