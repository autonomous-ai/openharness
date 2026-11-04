import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/api/access_token_source.dart';
import 'package:harness/api/api_client.dart';
import 'package:harness/api/bearer_auth_interceptor.dart';
import 'package:harness/viewer/direct_auth_api.dart';

class _Auth implements AccessTokenSource {
  Object? initialFailure, refreshFailure;
  String token = 'old';
  int refreshes = 0;
  @override
  Future<String> accessToken({bool force = false, String? failedToken}) async {
    if (!force && initialFailure != null) throw initialFailure!;
    if (force) {
      refreshes++;
      expect(failedToken, 'old');
      if (refreshFailure != null) throw refreshFailure!;
      token = 'renewed';
    }
    return token;
  }
}

class _Adapter implements HttpClientAdapter {
  final seen = <String>[];

  /// Runs while a request is out, before its answer arrives.
  void Function()? whileOut;
  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    final token = options.headers['authorization'] as String;
    seen.add(token);
    whileOut?.call();
    whileOut = null;
    return ResponseBody.fromString(
      '{}',
      token == 'Bearer renewed' ? 200 : 401,
      headers: {
        'content-type': ['application/json'],
      },
    );
  }

  @override
  void close({bool force = false}) {}
}

void main() {
  late _Auth auth;
  late _Adapter adapter;
  late Dio dio;
  setUp(() {
    auth = _Auth();
    adapter = _Adapter();
    dio = Dio(
      BaseOptions(
        baseUrl: 'https://fixture.invalid',
        validateStatus: (_) => true,
      ),
    );
    dio.httpClientAdapter = adapter;
    dio.interceptors.add(
      BearerAuthInterceptor(auth, dio, autonomousEnv: 'prod'),
    );
  });
  tearDown(() => dio.close());

  test('renews one refused token and retries with the replacement', () async {
    expect((await dio.get('/api/machines')).statusCode, 200);
    expect(adapter.seen, ['Bearer old', 'Bearer renewed']);
    expect(auth.refreshes, 1);
  });

  for (final expired in [false, true]) {
    test(
      'refresh failure distinguishes ${expired ? 'expiry' : 'service outage'}',
      () async {
        auth.refreshFailure = DirectAuthException(
          'refresh failed',
          signedOut: expired,
        );
        await expectLater(
          dio.get('/api/machines'),
          throwsA(
            isA<DioException>()
                .having(isUnauthorizedError, 'requires sign-in', expired)
                .having(isTransientApiError, 'can retry', !expired),
          ),
        );
        expect(adapter.seen, ['Bearer old']);
      },
    );
  }

  test(
    'an expired session is recognized even before an HTTP request can be sent',
    () async {
      auth.initialFailure = const DirectAuthException(
        'Not signed in.',
        signedOut: true,
      );
      await expectLater(
        dio.get('/api/machines'),
        throwsA(
          isA<DioException>().having(
            isUnauthorizedError,
            'requires sign-in',
            true,
          ),
        ),
      );
      expect(adapter.seen, isEmpty);
    },
  );

  group('a retry never goes out as another sign-in', () {
    late _Switching switching;
    late _Adapter seen;
    late Dio signed;
    setUp(() {
      switching = _Switching();
      seen = _Adapter();
      signed = Dio(
        BaseOptions(
          baseUrl: 'https://fixture.invalid',
          validateStatus: (_) => true,
        ),
      );
      signed.httpClientAdapter = seen;
      signed.interceptors.add(
        BearerAuthInterceptor(switching, signed, autonomousEnv: 'prod'),
      );
    });
    tearDown(() => signed.close());

    test('A signs out and B signs in while A\'s request is out: its 401 is '
        'not retried with B\'s token', () async {
      seen.whileOut = () => switching.signInAs('renewed');
      await expectLater(
        signed.post('/api/super-tabs/tab/commands'),
        throwsA(
          isA<DioException>().having(
            (e) => e.error,
            'error',
            isA<SignInChanged>(),
          ),
        ),
      );
      expect(seen.seen, ['Bearer old']);
    });

    test(
      'the sign-in changes during the refresh itself: not retried',
      () async {
        switching.duringRefresh = () => switching.signInAs('renewed');
        await expectLater(
          signed.post('/api/super-tabs/tab/commands'),
          throwsA(
            isA<DioException>().having(
              (e) => e.error,
              'error',
              isA<SignInChanged>(),
            ),
          ),
        );
        expect(seen.seen, ['Bearer old']);
      },
    );

    test('the same sign-in renews and retries as before', () async {
      expect((await signed.get('/api/machines')).statusCode, 200);
      expect(seen.seen, ['Bearer old', 'Bearer renewed']);
    });
  });
}

/// A token source that says which sign-in is current, as DirectAuth does:
/// asked for a token after one failed, it hands back whatever is current now.
class _Switching implements AccessTokenSource, SignInRevision {
  String token = 'old';
  int revision = 0;
  void Function()? duringRefresh;

  void signInAs(String next) {
    revision++;
    token = next;
  }

  @override
  int get signInRevision => revision;

  @override
  Future<String> accessToken({bool force = false, String? failedToken}) async {
    if (failedToken != null && failedToken != token) return token;
    if (force) {
      duringRefresh?.call();
      if (duringRefresh == null) token = 'renewed';
    }
    return token;
  }
}
