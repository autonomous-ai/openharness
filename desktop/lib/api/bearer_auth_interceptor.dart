import 'package:dio/dio.dart';

import 'access_token_source.dart';

/// Signs each request with the SSO bearer and the environment header the backend routes on, and
/// retries a 401 once with a refreshed token — for a viewer build, what the harness CLI's
/// `controlPlaneAuth` does for a desktop one.
class BearerAuthInterceptor extends Interceptor {
  BearerAuthInterceptor(this._auth, this._dio, {required this.autonomousEnv});

  final AccessTokenSource _auth;
  final Dio _dio;
  final String autonomousEnv;

  static const _tokenKey = 'bearer.token';
  static const _retriedKey = 'bearer.retried';
  static const _signInKey = 'bearer.signIn';

  /// Whether someone signed in or out here since [options] went out (as the
  /// daemon's account fence asks): its retry would then go out as another
  /// account. A source that cannot say is taken as unchanged.
  bool _signInMoved(RequestOptions options) => switch (_auth) {
    final SignInRevision source =>
      options.extra[_signInKey] != source.signInRevision,
    _ => false,
  };

  @override
  Future<void> onRequest(
    RequestOptions options,
    RequestInterceptorHandler handler,
  ) async {
    try {
      if (_auth case final SignInRevision source) {
        options.extra[_signInKey] = source.signInRevision;
      }
      final token = await _auth.accessToken();
      options.headers['authorization'] = 'Bearer $token';
      options.headers['x-autonomous-env'] = autonomousEnv;
      options.extra[_tokenKey] = token;
      handler.next(options);
    } catch (error) {
      handler.reject(DioException(requestOptions: options, error: error));
    }
  }

  @override
  Future<void> onResponse(
    Response<dynamic> response,
    ResponseInterceptorHandler handler,
  ) async {
    final options = response.requestOptions;
    if (response.statusCode != 401 || options.extra[_retriedKey] == true) {
      handler.next(response);
      return;
    }
    // A 401 for an account that has since signed out is not the current
    // account's to retry: A's command must never run as B.
    final changed = DioException(
      requestOptions: options,
      error: const SignInChanged(),
    );
    if (_signInMoved(options)) {
      handler.reject(changed);
      return;
    }
    try {
      await _auth.accessToken(
        force: true,
        failedToken: options.extra[_tokenKey] as String?,
      );
      if (_signInMoved(options)) {
        handler.reject(changed);
        return;
      }
      options.extra[_retriedKey] = true;
      // A form is read once: the retry sends a copy, as the first try did.
      if (options.data case final FormData form) options.data = form.clone();
      handler.resolve(await _dio.fetch<dynamic>(options));
    } catch (error) {
      // The old access token's 401 does not mean a refresh service outage revoked the session.
      // Preserve the refresh failure so a browser can retry without deleting valid credentials.
      final expired = error is AccessTokenFailure && error.signedOut;
      handler.reject(
        DioException(
          requestOptions: options,
          response: expired ? response : null,
          error: error,
          type: expired
              ? DioExceptionType.badResponse
              : DioExceptionType.connectionError,
        ),
      );
    }
  }
}
