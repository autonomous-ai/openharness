import 'package:dio/dio.dart';

import '../api/api_client.dart';
import '../api/access_token_source.dart';
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
  });

  final String token;
  final String? refreshToken;

  /// Seconds.
  final int? expiresIn;
  final String? autonomousEnv;

  static IssuedTokens? fromData(Object? data) {
    if (data is! Map) return null;
    final token = data['token'], refresh = data['refreshToken'];
    final expiresIn = data['expiresIn'], env = data['autonomousEnv'];
    if (token is! String || token.isEmpty) return null;
    return IssuedTokens(
      token: token,
      refreshToken: refresh is String && refresh.isNotEmpty ? refresh : null,
      expiresIn: expiresIn is int && expiresIn > 0 ? expiresIn : null,
      autonomousEnv: env is String ? env : null,
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

  static const _unavailable =
      'Could not renew your sign-in. That is usually the sign-in service having a moment — '
      'if it keeps happening, sign out and sign in again.';

  Future<({String authorizeUrl, String tx})> authorizeNative(
    String redirectUri,
  ) async {
    final data = unwrapApiResponse(
      await _dio.post(
        '/api/auth/authorize-native',
        data: {
          'redirectUri': redirectUri,
          'autonomousEnv': config.autonomousEnv,
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
    return (authorizeUrl: url, tx: tx);
  }

  Future<({String authorizeUrl, String tx})> authorizeWeb(String origin) async {
    final data = unwrapApiResponse(
      await _dio.post(
        '/api/auth/authorize',
        data: {
          'origin': origin,
          'next': '/',
          'autonomousEnv': config.autonomousEnv,
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
    return (authorizeUrl: url, tx: tx);
  }

  /// A one-time code a signed-in machine put in its QR (`h`) — `harness link qr` or Add Phone — traded
  /// for a session of this browser's own: scan to sign in, no SSO page. [label] is what this browser
  /// calls itself in the account's list of devices. A spent or expired code is the backend's 401.
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
    throw const DirectAuthException('That code didn’t work. Scan the new one.');
  }

  /// This browser asks to be signed in by a phone (`POST /api/device-auth/start`, kind `viewer`):
  /// [label] and [fingerprint] are what the phone's confirm screen shows. The user code goes in the
  /// QR; the device code is this browser's alone, for [pollSignInRequest].
  Future<SignInRequest> startSignInRequest({
    required String label,
    required String fingerprint,
    required String pub,
  }) async {
    final data = unwrapApiResponse(
      await _dio.post(
        '/api/device-auth/start',
        data: {
          'kind': 'viewer',
          'label': label,
          'fingerprint': fingerprint,
          'pub': pub,
        },
      ),
    );
    final user = data is Map ? data['userCode'] : null;
    final device = data is Map ? data['deviceCode'] : null;
    final expires = data is Map ? data['expiresIn'] : null;
    if (user is! String || device is! String) {
      throw const DirectAuthException('Could not start a sign-in. Try again.');
    }
    return SignInRequest(
      userCode: user,
      deviceCode: device,
      expiresIn: Duration(
        seconds: expires is int && expires > 0 ? expires : 180,
      ),
    );
  }

  /// Where [deviceCode]'s request stands. Approved hands the session over — once.
  Future<SignInRequestAnswer> pollSignInRequest(String deviceCode) async {
    final data = unwrapApiResponse(
      await _dio.post(
        '/api/device-auth/poll',
        data: {'deviceCode': deviceCode},
      ),
    );
    final status = data is Map ? data['status'] : null;
    switch (status) {
      case 'pending':
        return const SignInRequestAnswer.pending();
      case 'denied':
        return const SignInRequestAnswer.denied();
      case 'approved':
        final tokens = IssuedTokens.fromData(data);
        if (tokens == null) return const SignInRequestAnswer.expired();
        final roster = (data as Map)['sealedRoster'];
        return SignInRequestAnswer.approved(
          tokens,
          sealedRoster: roster is String && roster.isNotEmpty ? roster : null,
        );
      default:
        return const SignInRequestAnswer.expired();
    }
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

  /// authSession.ts `refreshRequest`, down to its one subtle rule: only a 401 or
  /// `REFRESH_TOKEN_INVALID` means the session is dead. An unusable refresh token and a real outage
  /// both come back as the same 503, and reading that as dead would delete a refresh token nothing
  /// can bring back — on a blip.
  Future<IssuedTokens> refresh(
    String refreshToken, {
    required String autonomousEnv,
  }) async {
    final Response<dynamic> res;
    try {
      res = await _dio.post(
        '/api/auth/refresh',
        data: {'refreshToken': refreshToken, 'autonomousEnv': autonomousEnv},
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

/// A browser's sign-in request, as started — see [DirectAuthApi.startSignInRequest].
class SignInRequest {
  const SignInRequest({
    required this.userCode,
    required this.deviceCode,
    required this.expiresIn,
  });

  final String userCode;
  final String deviceCode;
  final Duration expiresIn;
}

enum SignInRequestStatus { pending, approved, denied, expired }

/// One poll's answer. Approved carries the session and the approving phone's trust-group roster,
/// sealed under the QR's pairing code (`viewer/group_sync.dart` `openHandedRoster`).
class SignInRequestAnswer {
  const SignInRequestAnswer.pending()
    : status = SignInRequestStatus.pending,
      tokens = null,
      sealedRoster = null;
  const SignInRequestAnswer.denied()
    : status = SignInRequestStatus.denied,
      tokens = null,
      sealedRoster = null;
  const SignInRequestAnswer.expired()
    : status = SignInRequestStatus.expired,
      tokens = null,
      sealedRoster = null;
  const SignInRequestAnswer.approved(
    IssuedTokens this.tokens, {
    this.sealedRoster,
  }) : status = SignInRequestStatus.approved;

  final SignInRequestStatus status;
  final IssuedTokens? tokens;
  final String? sealedRoster;
}
