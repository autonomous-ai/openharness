import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/api/access_token_source.dart';
import 'package:harness_mobile/api/api_client.dart';
import 'package:harness_mobile/auth/auth_session.dart';
import 'package:harness_mobile/core/config.dart';
import 'package:harness_mobile/state/app_state.dart';

import 'viewer_app_fixture.dart';
import 'voice_fakes.dart' show MemoryKeyValueStore;

/// The default notifier's account lifecycle must not reach the retired remote
/// notification channel or registration API. Local notice behavior is covered
/// by local_system_notices_test and the phone shell notice navigation tests.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const method = MethodChannel('harness/push');
  final messenger =
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
  late List<String> nativeCalls;
  late _Backend backend;

  setUp(() {
    nativeCalls = [];
    backend = _Backend();
    messenger.setMockMethodCallHandler(method, (call) async {
      nativeCalls.add(call.method);
      return switch (call.method) {
        'address' => {'token': 'synthetic-token', 'platform': 'ios'},
        'take' => <Object?>[],
        _ => null,
      };
    });
  });
  tearDown(() => messenger.setMockMethodCallHandler(method, null));

  ViewerRig makeApp({bool signedIn = true}) {
    final rig = viewerApp(signedIn: signedIn);
    rig.app.api = ApiClient(
      config: const AppConfig(apiBaseUrl: 'https://api.invalid'),
      session: AuthSession(storage: MemoryKeyValueStore()),
      auth: _Tokens(),
      httpClientAdapter: backend,
    );
    addTearDown(rig.app.dispose);
    return rig;
  }

  void expectNoRemotePush() {
    expect(nativeCalls, isEmpty);
    expect(
      backend.requests.where((path) => path.startsWith('/api/push-devices')),
      isEmpty,
    );
  }

  test('sign-in, resume and sign-out never use remote push', () async {
    final rig = makeApp();
    await rig.app.bootstrap();
    await settle();
    expect(rig.app.status, AppStatus.authenticated);
    expect(backend.requests, containsAll(['/api/auth/me', '/api/machines']));
    expectNoRemotePush();

    rig.app.handleAppPaused();
    rig.app.handleAppResumed();
    await settle();
    await rig.app.logout();
    await settle();
    expect(rig.app.status, AppStatus.unauthenticated);
    expectNoRemotePush();
  });

  test('an expired session never uses remote push', () async {
    final rig = makeApp();
    await rig.app.bootstrap();
    await settle();
    expect(rig.app.status, AppStatus.authenticated);
    rig.app.authFailureForTest('Your sign-in expired. Sign in again.');
    await settle();
    expect(rig.app.status, AppStatus.unauthenticated);
    expectNoRemotePush();
  });

  test('a signed-out launch never uses remote push', () async {
    final rig = makeApp(signedIn: false);
    await rig.app.bootstrap();
    await settle();
    expect(rig.app.status, AppStatus.unauthenticated);
    expectNoRemotePush();
  });
}

class _Tokens implements AccessTokenSource {
  @override
  Future<String> accessToken({bool force = false, String? failedToken}) async =>
      'synthetic-token';
}

/// Real API serialization and authentication, with no network or account.
class _Backend implements HttpClientAdapter {
  final requests = <String>[];

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    await requestStream?.drain<void>();
    final path = options.uri.path;
    requests.add(path);
    final Object data = switch (path) {
      '/api/auth/me' => {
        'user': {'id': 'u1', 'email': 'pat@example.com', 'name': 'Pat'},
      },
      '/api/machines' => {'machines': <Object?>[]},
      '/api/desk' => {'revision': 0, 'tabs': <Object?>[]},
      '/api/zoo' => {'revision': 0, 'zoo': <Object?>[]},
      _ => <String, Object?>{},
    };
    return ResponseBody.fromString(
      jsonEncode({'success': true, 'data': data}),
      200,
      headers: {
        Headers.contentTypeHeader: [Headers.jsonContentType],
      },
    );
  }

  @override
  void close({bool force = false}) {}
}
