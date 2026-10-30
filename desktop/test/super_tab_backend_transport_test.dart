// The web's Swarm transport (docs/specs/2026-10-30-web-swarm-direct.md): the
// browser asks the backend itself, with its own sign-in, instead of relaying
// through one of the person's machines. Run against a real local HTTP server,
// so the header, the body and the backend's envelope are the real ones.
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/api/access_token_source.dart';
import 'package:harness/api/api_client.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/super_tabs/backend_transport.dart';
import 'package:harness/super_tabs/client.dart';
import 'package:harness/super_tabs/controller.dart';

import 'swarm_state_test.dart' show MemoryStore;

class _Token implements AccessTokenSource {
  String token = 'browser-token';
  Object? failure;
  @override
  Future<String> accessToken({bool force = false, String? failedToken}) async {
    if (failure != null) throw failure!;
    return token;
  }
}

class _SignedOut implements AccessTokenFailure {
  @override
  bool get signedOut => true;
}

/// What the backend got, and what it answers next.
class _Backend {
  late HttpServer server;
  final requests =
      <
        ({
          String method,
          String path,
          Map<String, String> headers,
          Object? body,
        })
      >[];
  int status = 200;
  Object? answer = {
    'success': true,
    'data': {'ok': 1},
  };

  Future<void> start() async {
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((request) async {
      final text = await utf8.decoder.bind(request).join();
      requests.add((
        method: request.method,
        path: request.uri.toString(),
        headers: {
          for (final name in ['authorization', 'x-autonomous-env'])
            name: ?request.headers.value(name),
        },
        body: text.isEmpty ? null : jsonDecode(text),
      ));
      request.response
        ..statusCode = status
        ..headers.contentType = ContentType.json
        ..write(jsonEncode(answer));
      await request.response.close();
    });
  }

  String get url => 'http://127.0.0.1:${server.port}';
}

void main() {
  late _Backend backend;
  late _Token token;
  late SuperTabTransport transport;

  setUp(() async {
    backend = _Backend();
    await backend.start();
    token = _Token();
    final api = ApiClient(
      config: AppConfig(apiBaseUrl: backend.url, autonomousEnv: 'test'),
      session: AuthSession(storage: MemoryStore()),
      auth: token,
    );
    transport = superTabBackendTransport(() => api);
  });
  tearDown(() => backend.server.close(force: true));

  Future<SuperTabFailure> refusal(Future<Object?> call) async {
    try {
      await call;
    } on SuperTabFailure catch (failure) {
      return failure;
    }
    fail('expected a SuperTabFailure');
  }

  test(
    'a read goes to the backend signed as the browser, and answers its data',
    () async {
      backend.answer = {
        'success': true,
        'data': {'format': 2, 'tabs': []},
      };
      final value = await transport('GET', '/api/super-tabs/list?mentions=1');
      expect(value, {'format': 2, 'tabs': []});
      final sent = backend.requests.single;
      expect(sent.method, 'GET');
      expect(sent.path, '/api/super-tabs/list?mentions=1');
      expect(sent.headers['authorization'], 'Bearer browser-token');
      expect(sent.headers['x-autonomous-env'], 'test');
    },
  );

  test('a command posts its body as given', () async {
    final body = {
      'operationId': 'op-1',
      'command': {
        'type': 'message.send',
        'conversationId': 'buddy',
        'text': 'hi',
      },
    };
    backend.answer = {
      'success': true,
      'data': {
        'result': {'messageId': 'm1'},
      },
    };
    final value = await transport(
      'POST',
      '/api/super-tabs/tab1/commands',
      body: body,
    );
    expect(value, {
      'result': {'messageId': 'm1'},
    });
    expect(backend.requests.single.method, 'POST');
    expect(backend.requests.single.path, '/api/super-tabs/tab1/commands');
    expect(backend.requests.single.body, body);
  });

  test('a refusal keeps the backend code, message and status', () async {
    backend
      ..status = 403
      ..answer = {
        'success': false,
        'error': {'code': 'FORBIDDEN', 'message': 'You are not in this Swarm.'},
      };
    final failure = await refusal(
      transport('GET', '/api/super-tabs/tab1/parts'),
    );
    expect(failure.code, 'FORBIDDEN');
    expect(failure.message, 'You are not in this Swarm.');
    expect(failure.statusCode, 403);
  });

  test('426 asks for an update', () async {
    backend
      ..status = 426
      ..answer = {
        'success': false,
        'error': {'code': 'UPDATE_REQUIRED', 'message': 'Update Harness.'},
      };
    final failure = await refusal(
      transport('GET', '/api/super-tabs/tab1/parts'),
    );
    expect(failure.code, 'UPDATE_REQUIRED');
    expect(failure.statusCode, 426);
  });

  test('a 200 that says it failed is a refusal, not data', () async {
    backend.answer = {
      'success': false,
      'error': {'code': 'SWARM_BUSY', 'message': 'This Swarm is busy.'},
    };
    final failure = await refusal(
      transport('GET', '/api/super-tabs/tab1/parts'),
    );
    expect(failure.code, 'SWARM_BUSY');
    expect(failure.message, 'This Swarm is busy.');
  });

  test(
    'no backend at all says to check the connection, not the catch-all',
    () async {
      await backend.server.close(force: true);
      final failure = await refusal(transport('GET', '/api/super-tabs/list'));
      expect(failure.code, 'NETWORK');
      expect(
        failure.message,
        'Could not reach Harness. Check your connection.',
      );
    },
  );

  test('a sign-in that ended says to sign in again', () async {
    token.failure = _SignedOut();
    final failure = await refusal(transport('GET', '/api/super-tabs/list'));
    expect(failure.code, 'SIGNED_OUT');
    expect(failure.message, 'Sign in to use Swarm.');
    expect(backend.requests, isEmpty);
  });

  test('only Swarm routes, read or posted, get the browser sign-in', () async {
    for (final (method, path) in [
      ('GET', '/api/machines'),
      ('POST', '/api/super-tabs/../auth/logout'),
      ('GET', 'https://elsewhere.example/api/super-tabs/list'),
      ('DELETE', '/api/super-tabs/tab1'),
      ('GET', '/api/super-tabsx/list'),
    ]) {
      final failure = await refusal(transport(method, path));
      expect(failure.code, 'INVALID_REQUEST', reason: '$method $path');
    }
    expect(backend.requests, isEmpty);
  });
}
