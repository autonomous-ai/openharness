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
import 'package:harness/super_tabs/model.dart';

import 'support/super_tab_fixture.dart';
import 'swarm_state_test.dart' show MemoryStore;

class _Token implements AccessTokenSource, SignInRevision {
  String token = 'browser-token';
  Object? failure;
  @override
  int signInRevision = 0;
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

  /// Runs as each request arrives, before it is answered.
  void Function()? onRequest;

  /// Answers each request in place of [status] and [answer], when set.
  Future<(int, Object?)> Function(String method, String path, Object? body)?
  handle;
  Object? answer = {
    'success': true,
    'data': {'ok': 1},
  };

  Future<void> start() async {
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((request) async {
      final text = await utf8.decoder.bind(request).join();
      onRequest?.call();
      requests.add((
        method: request.method,
        path: request.uri.toString(),
        headers: {
          for (final name in ['authorization', 'x-autonomous-env'])
            name: ?request.headers.value(name),
        },
        body: text.isEmpty ? null : jsonDecode(text),
      ));
      final (code, reply) =
          await handle?.call(
            request.method,
            request.uri.toString(),
            text.isEmpty ? null : jsonDecode(text),
          ) ??
          (status, answer);
      request.response
        ..statusCode = code
        ..headers.contentType = ContentType.json
        ..write(jsonEncode(reply));
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

  // The routes a machine's daemon and its agents use (hosts, starts, GitHub
  // tokens, deliveries) and the ones the web has no screen for never get the
  // browser's sign-in: refused before anything is sent.
  test('only the Swarm routes the web uses get the browser sign-in', () async {
    for (final (method, path) in [
      ('GET', '/api/machines'),
      ('POST', '/api/super-tabs/../auth/logout'),
      ('GET', 'https://elsewhere.example/api/super-tabs/list'),
      ('DELETE', '/api/super-tabs/tab1'),
      ('GET', '/api/super-tabs/tab1'),
      ('GET', '/api/super-tabsx/list'),
      ('GET', '/api/super-tabs/hosts/m1/changes'),
      ('GET', '/api/super-tabs/hosts/changes'),
      ('POST', '/api/super-tabs/hosts/m1/terminal'),
      ('POST', '/api/super-tabs/hosts/m1/starts/tab1/s1/github-token'),
      ('POST', '/api/super-tabs/tab1/github-token'),
      ('GET', '/api/super-tabs/tab1/starts/s1'),
      ('POST', '/api/super-tabs/tab1/agents/a1/deliveries'),
      ('POST', '/api/super-tabs/tab1/native/ctx1'),
      ('POST', '/api/super-tabs/tab1/terminal/r1'),
      ('GET', '/api/super-tabs/tab1/costs'),
      ('GET', '/api/super-tabs/workspaces'),
      ('GET', '/api/super-tabs/grids'),
    ]) {
      final failure = await refusal(transport(method, path));
      expect(failure.code, 'INVALID_REQUEST', reason: '$method $path');
    }
    expect(backend.requests, isEmpty);
  });

  test('every Swarm route the web uses goes to the backend', () async {
    const routes = [
      ('GET', '/api/super-tabs/list?mentions=1&after=abc'),
      ('GET', '/api/super-tabs/invitations'),
      ('GET', '/api/super-tabs/routing-policy'),
      ('POST', '/api/super-tabs/routing-policy'),
      ('POST', '/api/super-tabs'),
      ('GET', '/api/super-tabs/tab1/parts'),
      ('GET', '/api/super-tabs/tab1/changes?cursor=c%3D1'),
      ('POST', '/api/super-tabs/tab1/commands'),
      ('GET', '/api/super-tabs/tab1/mentions?state=waiting'),
      ('GET', '/api/super-tabs/tab1/decisions?state=open'),
      ('GET', '/api/super-tabs/tab1/leaderboard'),
      ('GET', '/api/super-tabs/tab1/sharing'),
      ('POST', '/api/super-tabs/tab1/sharing'),
      ('GET', '/api/super-tabs/tab1/routing-policy'),
      ('POST', '/api/super-tabs/tab1/routing-policy'),
      ('GET', '/api/super-tabs/tab1/groups?dormant=1&projectId=p1'),
      ('GET', '/api/super-tabs/tab1/groups/g1'),
      ('GET', '/api/super-tabs/tab1/conversations/c1/messages?before=5'),
      ('GET', '/api/super-tabs/tab1/conversations/c1/catch-up?after=4'),
      ('POST', '/api/super-tabs/tab1/conversations/c1/read'),
      ('POST', '/api/super-tabs/tab1/conversations/c1/threads/m1/read'),
      ('GET', '/api/super-tabs/tab1/projects/p1/github'),
      ('POST', '/api/super-tabs/tab1/projects/p1/github/approve'),
      ('POST', '/api/super-tabs/tab1/projects/p1/roles/r1'),
      ('GET', '/api/super-tabs/tab1/route-decisions/d1'),
      ('POST', '/api/super-tabs/tab1/machines/m1/removal'),
      ('POST', '/api/super-tabs/tab1/join'),
      ('GET', '/api/super-tabs/tab1/join/preview'),
      ('POST', '/api/super-tabs/tab1/native'),
    ];
    for (final (method, path) in routes) {
      await transport(method, path, body: method == 'POST' ? {} : null);
    }
    expect(backend.requests.map((r) => '${r.method} ${r.path}'), [
      for (final (method, path) in routes) '$method $path',
    ]);
  });

  // A thread read on the web reads as read on the person's other devices
  // (#2327): its mark goes to the backend like the chat's own mark.
  test('a thread\'s read mark goes to the backend, and only that exact '
      'route', () async {
    final value = await transport(
      'POST',
      '/api/super-tabs/tab1/conversations/c1/threads/m1/read',
      body: {'sequence': 7},
    );
    expect(value, {'ok': 1});
    final sent = backend.requests.single;
    expect(sent.method, 'POST');
    expect(sent.path, '/api/super-tabs/tab1/conversations/c1/threads/m1/read');
    expect(sent.body, {'sequence': 7});
    expect(sent.headers['authorization'], 'Bearer browser-token');
    backend.requests.clear();
    for (final path in [
      '/api/super-tabs/hosts/conversations/c1/threads/m1/read',
      '/api/super-tabs/hosts/m1/conversations/c1/threads/m1/read',
      '/api/super-tabs/tab1/conversations/c1/threads/read',
      '/api/super-tabs/tab1/conversations/c1/threads//read',
      '/api/super-tabs/tab1/conversations/c1/threads/m1',
      '/api/super-tabs/tab1/conversations/c1/threads/m1/read/x',
      '/api/super-tabs/tab1/conversations/c1/threads/m1/m2/read',
      '/api/super-tabs/tab1/conversations/c1/threads/../read',
      '/api/super-tabs/tab1/conversations/c1/threads/m%2F1/read',
      '/api/super-tabs/tab1/conversations/c1/threads/m1/messages',
      '/api/super-tabs/tab1/threads/m1/read',
    ]) {
      final failure = await refusal(
        transport('POST', path, body: {'sequence': 7}),
      );
      expect(failure.code, 'INVALID_REQUEST', reason: path);
    }
    expect(backend.requests, isEmpty);
  });

  /// A chat on the web, read through this transport from a backend holding
  /// a root and one reply in its thread; [refuseThreadMarks] answers each
  /// thread mark as a backend that no longer lets this person in.
  Future<(ConversationServer, SuperTabController)> webChat({
    bool refuseThreadMarks = false,
  }) async {
    final server = ConversationServer()..threads = true;
    server.append('Should we do thread replies?');
    server.append('Yes, like Slack.');
    server.messages.last
      ..['thread'] = 'message-1'
      ..['replyTo'] = 'message-1'
      ..['author'] = {
        'kind': 'person',
        'id': 'peer',
        'name': 'peer@example.com',
      };
    server.markReadElsewhere('lead', 1);
    backend.handle = (method, path, body) async {
      if (refuseThreadMarks && path.contains('/threads/')) {
        return (
          403,
          {
            'success': false,
            'error': {'code': 'FORBIDDEN', 'message': 'No access.'},
          },
        );
      }
      try {
        final data = await server.request(
          method,
          path,
          body: body as Map<String, dynamic>?,
        );
        return (200, {'success': true, 'data': data});
      } on SuperTabFailure catch (failure) {
        return (
          failure.statusCode ?? 500,
          {
            'success': false,
            'error': {'code': failure.code, 'message': failure.message},
          },
        );
      }
    };
    final c = SuperTabController(
      tabId: 'tab',
      accountId: 'owner',
      // As the web's Swarm client hands the transport's answer to a chat.
      request: (method, path, {body}) async =>
          superTabMap(await transport(method, path, body: body)),
      save: server.save,
      pollInterval: Duration.zero,
    );
    addTearDown(c.dispose);
    await c.refresh();
    await c.loadMessages('lead');
    c.select('lead');
    return (server, c);
  }

  const threadMark =
      'POST /api/super-tabs/tab/conversations/lead/threads/message-1/read';
  Iterable<String> sent() =>
      backend.requests.map((r) => '${r.method} ${r.path}');
  Future<void> settle() async {
    for (var i = 0; i < 20; i++) {
      await Future<void>.delayed(const Duration(milliseconds: 10));
    }
  }

  test('on the web, opening a thread sends its mark to the backend, and the '
      'next poll reads it back as every device does', () async {
    final (server, c) = await webChat();
    c.openThread('message-1');
    await settle();
    expect(server.threadMarkPosts, [
      {'conversationId': 'lead', 'root': 'message-1', 'sequence': 2},
    ]);
    expect(sent().where((r) => r == threadMark), hasLength(1));
    await c.refresh();
    expect(c.snapshot!.threadMarks['lead'], {'message-1': 2});
  });

  test('on the web, a thread mark the backend refuses leaves the thread read '
      'here, and is not sent again within the minute', () async {
    final (server, c) = await webChat(refuseThreadMarks: true);
    c.openThread('message-1');
    await settle();
    expect(c.threadUnread(c.thread('lead', 'message-1')!), isFalse);
    c.closeThread();
    c.openThread('message-1');
    await settle();
    expect(sent().where((r) => r == threadMark), hasLength(1));
    expect(server.threadMarkPosts, isEmpty);
    expect(c.snapshot!.threadMarks, isEmpty);
  });

  test('a refused call whose sign-in changed meanwhile is not retried as the '
      'new account, and says the account changed', () async {
    backend
      ..status = 401
      ..answer = {
        'success': false,
        'error': {'code': 'UNAUTHORIZED', 'message': 'Unauthorized'},
      }
      ..onRequest = () {
        token
          ..signInRevision += 1
          ..token = 'another-account';
      };
    final failure = await refusal(
      transport('POST', '/api/super-tabs/tab1/commands', body: {'x': 1}),
    );
    expect(failure.code, 'ACCOUNT_CHANGED');
    expect(backend.requests, hasLength(1));
    expect(
      backend.requests.single.headers['authorization'],
      'Bearer browser-token',
    );
  });
}
