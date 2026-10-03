import 'package:dio/dio.dart';

import '../api/api_client.dart';
import '../api/access_token_source.dart';
import '../auth/sign_in_provider.dart';
import '../auth/sso_client.dart';
import '../core/config.dart';
import '../logging/http_log.dart';

/// A sign-in or refresh that produced no usable session.
class DirectAuthException implements AccessTokenFailure {
  const DirectAuthException(this.message, {this.signedOut = false});

  final String message;

  /// The session is gone for good: retrying cannot help, only signing in again.
  @override
  final bool signedOut;

  @override
  String toString() => message;
}

/// What `/api/auth/exchange` and `/api/auth/refresh` hand back.
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
  DirectAuthApi({required this.config, Dio? dio, String? clientId})
    : clientId = clientId ?? ssoClientId,
      _dio =
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

  /// The auth-service client this build signs in as (`auth/sso_client.dart`).
  final String clientId;
  final Dio _dio;

  static const _unavailable =
      'Could not renew your sign-in. That is usually the sign-in service having a moment — '
      'if it keeps happening, sign out and sign in again.';

  /// [provider] is the account the SSO page opens on; without one it is the page's own chooser.
  Future<({String authorizeUrl, String tx})> authorizeNative(
    String redirectUri, {
    SignInProvider? provider,
  }) => _authorize('/api/auth/authorize-native', {
    'redirectUri': redirectUri,
  }, provider);

  Future<({String authorizeUrl, String tx})> authorizeWeb(
    String origin, {
    SignInProvider? provider,
  }) => _authorize('/api/auth/authorize', {
    'origin': origin,
    'next': '/',
  }, provider);

  Future<({String authorizeUrl, String tx})> _authorize(
    String path,
    Map<String, Object?> body,
    SignInProvider? provider,
  ) async {
    final data = unwrapApiResponse(
      await _dio.post(
        path,
        data: {
          ...body,
          'autonomousEnv': config.autonomousEnv,
          // The surface asking, as auth-service knows it. What the tokens are actually issued
          // to comes back from the exchange ([IssuedTokens.clientId]).
          'clientId': clientId,
          if (provider != null) 'provider': provider.name,
        },
      ),
    );
    final url = data is Map ? data['authorizeUrl'] : null;
    final tx = data is Map ? data['tx'] : null;
    if (url is! String || url.isEmpty || tx is! String || tx.isEmpty) {
      throw const DirectAuthException(
        'The server did not return a sign-in page.',
      );
    }
    return (authorizeUrl: _openingOn(url, provider), tx: tx);
  }

  /// [authorizeUrl], naming [provider]. The backend writes it into the page it hands back — but
  /// only one that knows the field does, and this build reaches people before the backend is
  /// redeployed. It is the browser's to carry and changes nothing the backend holds (state,
  /// PKCE, client), so it is set here as well.
  static String _openingOn(String authorizeUrl, SignInProvider? provider) {
    final uri = Uri.tryParse(authorizeUrl);
    if (provider == null || uri == null) return authorizeUrl;
    return uri
        .replace(
          queryParameters: {...uri.queryParameters, 'provider': provider.name},
        )
        .toString();
  }

  Future<IssuedTokens> exchange({
    required String code,
    required String state,
    required String tx,
  }) async {
    final data = unwrapApiResponse(
      await _dio.post(
        '/api/auth/exchange',
        data: {'code': code, 'state': state, 'tx': tx},
      ),
    );
    return IssuedTokens.fromData(data) ??
        (throw const DirectAuthException('Sign-in returned no access token.'));
  }

  // -- signing in by a QR a signed-in phone approves (backend routes/qrSignIn.ts) --

  Future<({String code, String pollToken, int expiresIn})> qrStart({required String label}) async {
    final data = unwrapApiResponse(
      await _dio.post('/api/auth/qr/start', data: {'label': label, 'kind': 'viewer'}),
    );
    final code = data is Map ? data['code'] : null, poll = data is Map ? data['pollToken'] : null;
    final expiresIn = data is Map ? data['expiresIn'] : null;
    if (code is! String || poll is! String || expiresIn is! int) {
      throw const DirectAuthException('Sign-in by phone is not available here.');
    }
    return (code: code, pollToken: poll, expiresIn: expiresIn);
  }

  /// `pending`, `denied`, `expired`, or `approved` with the account's email.
  Future<({String status, String? email})> qrPoll(String pollToken) async {
    final data = unwrapApiResponse(await _dio.post('/api/auth/qr/poll', data: {'pollToken': pollToken}));
    final status = data is Map ? data['status'] : null, email = data is Map ? data['email'] : null;
    return (status: status is String ? status : 'expired', email: email is String ? email : null);
  }

  /// The same code, alive a while longer; null when it can live no longer.
  Future<int?> qrExtend(String pollToken) async {
    try {
      final data = unwrapApiResponse(await _dio.post('/api/auth/qr/extend', data: {'pollToken': pollToken}));
      final expiresIn = data is Map ? data['expiresIn'] : null;
      return expiresIn is int ? expiresIn : null;
    } catch (_) {
      return null;
    }
  }

  Future<IssuedTokens> qrClaim(String pollToken) async {
    final data = unwrapApiResponse(await _dio.post('/api/auth/qr/claim', data: {'pollToken': pollToken}));
    return IssuedTokens.fromData(data) ??
        (throw const DirectAuthException('Sign-in returned no access token.'));
  }

  Future<void> qrCancel(String pollToken) async {
    try {
      await _dio.post('/api/auth/qr/cancel', data: {'pollToken': pollToken});
    } catch (_) {}
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
