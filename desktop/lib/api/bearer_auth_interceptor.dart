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

  @override
  Future<void> onRequest(
    RequestOptions options,
    RequestInterceptorHandler handler,
  ) async {
    try {
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
    try {
      await _auth.accessToken(
        force: true,
        failedToken: options.extra[_tokenKey] as String?,
      );
      options.extra[_retriedKey] = true;
      handler.resolve(await _dio.fetch<dynamic>(options));
    } catch (_) {
      // The refresh itself failed, so the 401 is the honest answer to hand back.
      handler.next(response);
    }
  }
}
