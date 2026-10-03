import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/sign_in_provider.dart';
import 'package:harness/core/config.dart';
import 'package:harness/viewer/direct_auth_api.dart';

/// Answers every request with [reply] and remembers what was sent.
class _Backend implements HttpClientAdapter {
  Map<String, Object?> reply = {
    'success': true,
    'data': {'authorizeUrl': 'https://sso.example/authorize', 'tx': 'tx-1'},
  };
  final sent = <({String path, Map<String, Object?> body})>[];

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    sent.add((
      path: options.path,
      body: Map<String, Object?>.from(options.data as Map),
    ));
    return ResponseBody.fromString(
      jsonEncode(reply),
      200,
      headers: {
        Headers.contentTypeHeader: [Headers.jsonContentType],
      },
    );
  }

  @override
  void close({bool force = false}) {}
}

/// What a build that signs in by itself — the web app, a viewer — tells the backend: which
/// auth-service client it is, which account the person chose, and, on a refresh, which client its
/// session was issued to.
void main() {
  late _Backend backend;
  late DirectAuthApi api;

  setUp(() {
    backend = _Backend();
    api = DirectAuthApi(
      config: AppConfig.dev,
      clientId: 'harness-web',
      dio: Dio(BaseOptions(baseUrl: 'https://h.invalid'))
        ..httpClientAdapter = backend,
    );
  });

  test(
    'a sign-in names this surface\'s client and the account chosen',
    () async {
      final web = await api.authorizeWeb(
        'https://harness.example',
        provider: SignInProvider.google,
      );
      // This backend's page does not name the account (one from before `provider`): the page
      // the browser is sent to names it all the same.
      expect(web.authorizeUrl, 'https://sso.example/authorize?provider=google');
      expect(backend.sent.single.path, '/api/auth/authorize');
      expect(backend.sent.single.body, {
        'origin': 'https://harness.example',
        'next': '/',
        'autonomousEnv': AppConfig.dev.autonomousEnv,
        'clientId': 'harness-web',
        'provider': 'google',
      });

      await api.authorizeNative(
        'http://127.0.0.1:5000/callback',
        provider: SignInProvider.apple,
      );
      expect(backend.sent.last.path, '/api/auth/authorize-native');
      expect(backend.sent.last.body, {
        'redirectUri': 'http://127.0.0.1:5000/callback',
        'autonomousEnv': AppConfig.dev.autonomousEnv,
        'clientId': 'harness-web',
        'provider': 'apple',
      });
    },
  );

  test(
    'no account chosen names none: the sign-in page\'s own chooser',
    () async {
      final page = await api.authorizeNative('http://127.0.0.1:5000/callback');
      expect(page.authorizeUrl, 'https://sso.example/authorize');
      expect(backend.sent.single.body.containsKey('provider'), isFalse);
      expect(backend.sent.single.body['clientId'], 'harness-web');
    },
  );

  test('the exchange says which client the tokens were issued to', () async {
    backend.reply = {
      'success': true,
      'data': {'token': 'access', 'clientId': 'harness-web'},
    };
    final issued = await api.exchange(code: 'c', state: 's', tx: 't');
    expect(issued.clientId, 'harness-web');

    // A backend from before the clients were split names none, whatever was asked for.
    backend.reply = {
      'success': true,
      'data': {'token': 'access'},
    };
    expect(
      (await api.exchange(code: 'c', state: 's', tx: 't')).clientId,
      isNull,
    );
  });

  test('a refresh names the session\'s client, or none', () async {
    backend.reply = {
      'success': true,
      'data': {'token': 'renewed'},
    };
    await api.refresh('r1', autonomousEnv: 'prod', clientId: 'harness-web');
    expect(backend.sent.single.body, {
      'refreshToken': 'r1',
      'autonomousEnv': 'prod',
      'clientId': 'harness-web',
    });
    await api.refresh('r1', autonomousEnv: 'prod');
    expect(backend.sent.last.body, {
      'refreshToken': 'r1',
      'autonomousEnv': 'prod',
    });
  });
}
