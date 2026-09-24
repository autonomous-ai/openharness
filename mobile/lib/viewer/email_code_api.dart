import 'package:dio/dio.dart';

import '../core/config.dart';
import '../logging/http_log.dart';
import 'direct_auth_api.dart';

/// Signing in with a code emailed to the person — the Autonomous account API's own sign-in, the
/// one the Autonomous companion app uses (`ecm-sds-mobile`, `features/auth`), called straight from
/// the app.
///
/// Why a phone signs in this way and not through the browser: the SSO flow redirects back to a
/// loopback listener inside the app (`direct_login.dart`), and a phone is not obliged to keep that
/// listener alive while a browser is in front of it. Google Play's review saw exactly that —
/// "127.0.0.1 took too long to respond" — and rejected the build for a sign-in that could not
/// finish. A code typed into the app never leaves it.
///
/// The token it returns is an ordinary Autonomous access token: the Harness backend checks it
/// against the same account API's `/me` endpoints it checks an SSO token against
/// (`backend/src/lib/ssoAuth.ts` `fetchSsoProfile`), so nothing downstream can tell the two apart.
/// Its refresh token, though, only renews HERE — see [refresh].
class EmailCodeApi {
  EmailCodeApi({required this.config, Dio? dio})
    : _dio =
          dio ??
          attachHttpLog(
            Dio(
              BaseOptions(
                baseUrl: accountApiUrl(config.autonomousEnv),
                connectTimeout: const Duration(seconds: 15),
                receiveTimeout: const Duration(seconds: 30),
                headers: const {
                  'Accept': 'application/json',
                  'Content-Type': 'application/json',
                  // The account API reads its language from this header; the
                  // companion app sends it on every call.
                  'Location': 'en-US',
                },
                validateStatus: (status) => status != null && status < 600,
              ),
            ),
          );

  final AppConfig config;
  final Dio _dio;

  /// The Autonomous account API for [autonomousEnv] — the hosts the backend validates tokens
  /// against (`backend/src/config/env.ts`, `SSO_PROFILE_URL` / `STAGING_SSO_PROFILE_URL`).
  static String accountApiUrl(String autonomousEnv) => autonomousEnv == 'stag'
      ? 'https://apiv2.staging.autonomousdev.xyz'
      : 'https://apiv2.autonomous.ai';

  static const _sendPath = '/api/v1/customers/send-login-verification';
  static const _signInPath = '/api/v1/customers/sign-in';

  static const _unreachable =
      'Could not reach the sign-in service. Check your connection and try again.';

  /// Emails a one-time sign-in code to [email].
  Future<void> sendCode(String email) async {
    await _call(_sendPath, {'email': email});
  }

  /// Trades the emailed [code] for a session.
  Future<IssuedTokens> signIn({
    required String email,
    required String code,
  }) async {
    final data = await _call(_signInPath, {
      'email': email,
      'otp': code,
      'grant_type': 'otp',
    });
    return _tokens(data) ??
        (throw const DirectAuthException('Sign-in returned no access token.'));
  }

  /// Renews a session this API issued.
  ///
  /// Held to the rule `DirectAuthApi.refresh` keeps: only the service ANSWERING that the token is
  /// no good ends the session. A network failure or a 5xx is an outage, and reading an outage as
  /// dead would delete a refresh token nothing can bring back — on a blip.
  Future<IssuedTokens> refresh(String refreshToken) async {
    final Response<dynamic> res;
    try {
      res = await _dio.post(
        _signInPath,
        data: {'refresh_token': refreshToken, 'grant_type': 'refresh_token'},
      );
    } on DioException {
      throw const DirectAuthException(_unreachable);
    }
    if ((res.statusCode ?? 500) >= 500) {
      throw const DirectAuthException(_unreachable);
    }
    final body = res.data is Map ? res.data as Map : const {};
    final tokens = body['status'] == 1 ? _tokens(body['data']) : null;
    return tokens ??
        (throw const DirectAuthException(
          'Your sign-in expired. Sign in again.',
          signedOut: true,
        ));
  }

  /// POSTs [body] and returns the envelope's `data` — `{status, error_code, message, data}`,
  /// where `status` 1 is success. Anything else is thrown with the service's own message, which
  /// is written for the person ("Invalid OTP", "Email is invalid").
  Future<Object?> _call(String path, Map<String, Object?> body) async {
    final Response<dynamic> res;
    try {
      res = await _dio.post(path, data: body);
    } on DioException {
      throw const DirectAuthException(_unreachable);
    }
    final envelope = res.data is Map ? res.data as Map : const {};
    if (envelope['status'] == 1) return envelope['data'];
    final message = envelope['message'];
    throw DirectAuthException(
      message is String && message.trim().isNotEmpty
          ? message.trim()
          : _unreachable,
    );
  }

  IssuedTokens? _tokens(Object? data) {
    if (data is! Map) return null;
    final token = data['access_token'];
    if (token is! String || token.isEmpty) return null;
    final refresh = data['refresh_token'], expiresIn = data['expire_in'];
    return IssuedTokens(
      token: token,
      refreshToken: refresh is String && refresh.isNotEmpty ? refresh : null,
      expiresIn: expiresIn is num && expiresIn > 0 ? expiresIn.toInt() : null,
      autonomousEnv: config.autonomousEnv,
    );
  }
}
