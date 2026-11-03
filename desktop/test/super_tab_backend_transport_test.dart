// The web's Swarm transport (docs/specs/2026-10-30-web-swarm-direct.md): the
// browser asks the backend itself, with its own sign-in, instead of relaying
// through one of the person's machines. Run against a real local HTTP server,
// so the header, the body and the backend's envelope are the real ones.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/api/access_token_source.dart';
import 'package:harness/api/api_client.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/super_tabs/attention.dart';
import 'package:harness/super_tabs/backend_transport.dart';
import 'package:harness/super_tabs/client.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/model.dart';

import 'super_tab_attention_test.dart' show projectServer, unreadThread;
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

  Future<SuperTabFailure> refusal(Future<Object?> call, {String? what}) async {
    try {
      await call;
    } on SuperTabFailure catch (failure) {
      return failure;
    }
    fail('expected a SuperTabFailure${what == null ? '' : ' for $what'}');
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
      ('GET', '/api/super-tabs/routing-policy'),
      ('POST', '/api/super-tabs/routing-policy'),
      ('GET', '/api/super-tabs/tab1/projects/p1/roles/r1'),
      ('POST', '/api/super-tabs/tab1/projects/p1/roles/r1'),
      // A file link names one message and one file, nothing above or past it.
      ('GET', '/api/super-tabs/tab1/conversations/c1/messages/m1/attachments'),
      ('GET', '/api/super-tabs/tab1/conversations/c1/attachments/a1'),
      (
        'GET',
        '/api/super-tabs/tab1/conversations/c1/messages/m1/attachments/a1/x',
      ),
      // Next to Activity, Threads, Follow, per-chat notifications and the
      // deleted Swarms (#2434, #2453, #2457): nothing above, past or beside
      // the exact routes, and never under a daemon's own prefix.
      ('GET', '/api/super-tabs/hosts/activity'),
      ('GET', '/api/super-tabs/hosts/m1/activity'),
      ('POST', '/api/super-tabs/hosts/activity/read'),
      ('GET', '/api/super-tabs/hosts/threads'),
      ('GET', '/api/super-tabs/hosts/inbox'),
      ('GET', '/api/super-tabs/hosts/m1/inbox'),
      ('POST', '/api/super-tabs/hosts/conversations/c1/notifications'),
      ('POST', '/api/super-tabs/hosts/conversations/c1/threads/m1/follow'),
      ('GET', '/api/super-tabs/tab1/activity/x'),
      ('POST', '/api/super-tabs/tab1/activity/read/x'),
      ('GET', '/api/super-tabs/tab1/threads/m1'),
      ('GET', '/api/super-tabs/tab1/inbox/x'),
      ('POST', '/api/super-tabs/tab1/conversations/c1/notifications/x'),
      ('POST', '/api/super-tabs/tab1/conversations/notifications'),
      ('POST', '/api/super-tabs/tab1/notifications'),
      ('POST', '/api/super-tabs/tab1/conversations/c1/threads/follow'),
      ('POST', '/api/super-tabs/tab1/conversations/c1/threads/m1/follow/x'),
      ('POST', '/api/super-tabs/tab1/conversations/c1/threads/m1/m2/follow'),
      ('POST', '/api/super-tabs/tab1/conversations/c1/threads/../follow'),
      ('POST', '/api/super-tabs/tab1/threads/m1/follow'),
      ('GET', '/api/super-tabs/tab1/deleted'),
      ('GET', '/api/super-tabs/deleted/x'),
      ('GET', '/api/super-tabs/deleted/parts'),
      ('GET', '/api/super-tabs/deleted/threads'),
      ('GET', '/api/super-tabs/tab1/agents/a1/deliveries/d1'),
      ('POST', '/api/super-tabs/tab1/agents/a1/deliveries/d1'),
      ('POST', '/api/super-tabs/tab1/starts/s1'),
      ('POST', '/api/super-tabs/hosts/m1/starts/tab1/s1'),
      ('POST', '/api/super-tabs/hosts/m1/readings'),
      ('GET', '/api/super-tabs/hosts/m1/assignments'),
    ]) {
      final failure = await refusal(
        transport(method, path),
        what: '$method $path',
      );
      expect(failure.code, 'INVALID_REQUEST', reason: '$method $path');
    }
    expect(backend.requests, isEmpty);
  });

  test('every Swarm route the web uses goes to the backend', () async {
    const routes = [
      ('GET', '/api/super-tabs/list?mentions=1&after=abc'),
      ('GET', '/api/super-tabs/invitations'),
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
      // A fresh short-lived link to one file (backend fileLinks.ts).
      (
        'GET',
        '/api/super-tabs/tab1/conversations/c1/messages/m1/attachments/a1',
      ),
      ('POST', '/api/super-tabs/tab1/conversations/c1/read'),
      ('POST', '/api/super-tabs/tab1/conversations/c1/threads/m1/read'),
      ('GET', '/api/super-tabs/tab1/projects/p1/github'),
      ('POST', '/api/super-tabs/tab1/projects/p1/github/approve'),
      ('GET', '/api/super-tabs/tab1/projects/p1/instructions'),
      ('GET', '/api/super-tabs/tab1/projects/p1/instructions/revisions'),
      ('GET', '/api/super-tabs/tab1/projects/p1/instructions/revisions/4'),
      ('GET', '/api/super-tabs/tab1/route-decisions/d1'),
      ('POST', '/api/super-tabs/tab1/machines/m1/removal'),
      ('POST', '/api/super-tabs/tab1/join'),
      ('GET', '/api/super-tabs/tab1/join/preview'),
      ('POST', '/api/super-tabs/tab1/native'),
      // Activity, Threads, Follow, per-chat notifications (#2434, #2453) and
      // the owner's deleted Swarms (#2457).
      ('GET', '/api/super-tabs/tab1/activity'),
      ('POST', '/api/super-tabs/tab1/activity/read'),
      ('GET', '/api/super-tabs/tab1/threads'),
      ('GET', '/api/super-tabs/tab1/inbox'),
      ('POST', '/api/super-tabs/tab1/conversations/c1/threads/m1/follow'),
      ('POST', '/api/super-tabs/tab1/conversations/c1/notifications'),
      ('GET', '/api/super-tabs/deleted'),
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
          failure.statusCode,
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

  // Every Swarm path the app builds goes through this transport on the web,
  // so a route added to the client and not here fails here, not in a browser
  // (Activity, Threads, Follow, per-chat notifications and Restore said
  // "Could not load" on the web for this, 11-01).
  test(
    'every Swarm path the app\'s code builds is one the web may send',
    () async {
      final paths = swarmPathsInSource(
        Directory('lib'),
        // Uploads post a form straight through ApiClient, never this transport.
        skip: const {
          'lib/super_tabs/attachment_upload.dart',
          'lib/super_tabs/avatar_upload.dart',
        },
      );
      // The walk finds what it should, so a broken walk cannot pass.
      expect(paths.length, greaterThan(40));
      expect(
        paths,
        containsAll([
          '/api/super-tabs/1/threads',
          '/api/super-tabs/1/inbox',
          '/api/super-tabs/1/conversations/1/threads/1/follow',
          '/api/super-tabs/1/conversations/1/notifications',
          '/api/super-tabs/deleted',
          '/api/super-tabs/1/projects/1/instructions/revisions/1',
          '/api/super-tabs/list?1',
          '/api/super-tabs/1/projects/1/github?refresh=1',
        ]),
      );
      final refused = <String>[];
      for (final path in paths) {
        try {
          await transport('GET', path);
        } on SuperTabFailure catch (failure) {
          if (failure.code == 'INVALID_REQUEST') refused.add(path);
        }
      }
      expect(refused, isEmpty, reason: 'refused before sending on the web');
      for (final file in [
        'lib/super_tabs/attachment_upload.dart',
        'lib/super_tabs/avatar_upload.dart',
      ]) {
        final source = File(file).readAsStringSync();
        expect(source, isNot(contains('request(')), reason: file);
        expect(source, contains('postForm('), reason: file);
      }
    },
  );

  /// [server] behind the fake backend, answering as the backend does, and a
  /// Swarm on the web read through this transport.
  Future<SuperTabController> webSwarm(ConversationServer server) async {
    backend.handle = (method, path, body) async {
      try {
        final data = await server.request(
          method,
          path,
          body: body as Map<String, dynamic>?,
        );
        return (200, {'success': true, 'data': data});
      } on SuperTabFailure catch (failure) {
        return (
          failure.statusCode == 0 ? 500 : failure.statusCode,
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
      request: (method, path, {body}) async =>
          superTabMap(await transport(method, path, body: body)),
      save: server.save,
      pollInterval: Duration.zero,
    );
    addTearDown(() async {
      await c.flush();
      c.dispose();
    });
    await c.refresh();
    return c;
  }

  group('on the web, through the backend', () {
    test(
      'Threads on a backend before followed threads reads its inbox',
      () async {
        final server = projectServer();
        server.followedThreads = null;
        server.inbox = {
          'threads': [unreadThread('message-1', 2)],
          'latest': null,
          'more': false,
        };
        final c = await webSwarm(server);
        final attention = SuperTabAttention.of(c);
        await attention.load();
        expect(attention.error, isNull);
        expect(attention.followSupported, isFalse);
        expect(attention.unread.map((t) => t.rootId), ['message-1']);
        expect(sent(), contains('GET /api/super-tabs/tab/inbox'));
      },
    );

    test('a chat\'s notifications are kept on the backend; a refused one goes '
        'back, and a chat this Swarm does not list sends nothing', () async {
      final server = projectServer();
      final c = await webSwarm(server);
      expect(await c.setNotify('lead', SuperTabNotify.muted), isTrue);
      expect(server.notifyPosts, [
        {'conversationId': 'lead', 'notify': 'muted'},
      ]);
      expect(c.notifyOf('lead'), SuperTabNotify.muted);
      server.failNotify = true;
      expect(await c.setNotify('lead', SuperTabNotify.all), isFalse);
      expect(c.notifyOf('lead'), SuperTabNotify.muted);
      backend.requests.clear();
      expect(
        await c.setNotify('someone-else-buddy', SuperTabNotify.all),
        isFalse,
      );
      expect(backend.requests, isEmpty);
    });

    test(
      'Restore reads the owner\'s deleted Swarms from the backend',
      () async {
        final deleted = {
          'swarms': [
            {
              'id': 'tab9',
              'name': 'Old',
              'purgeAt': '2026-11-08T00:00:00.000Z',
            },
          ],
        };
        backend.answer = {'success': true, 'data': deleted};
        expect(await transport('GET', '/api/super-tabs/deleted'), deleted);
        expect(sent(), ['GET /api/super-tabs/deleted']);
        expect(
          backend.requests.single.headers['authorization'],
          'Bearer browser-token',
        );
      },
    );
  });
}

/// Every Swarm path the code under [root] builds, read from its source: each
/// string that starts `/api/super-tabs`, joined with the literals beside it.
/// A getter, function or local whose body is a literal (`_path`,
/// `_messagesPath(id)`, `base`) is filled in from it, both sides of a
/// `? :` are taken, and any other value reads `1`.
Set<String> swarmPathsInSource(Directory root, {Set<String> skip = const {}}) {
  final paths = <String>{};
  for (final file in root.listSync(recursive: true).whereType<File>()) {
    final name = file.path.replaceAll(r'\', '/');
    if (!name.endsWith('.dart') || skip.contains(name)) continue;
    final source = file.readAsStringSync();
    final tokens = _DartStrings.scan(source);
    final defs = <String, List<List<_Literal>>>{};
    // Literals that only name a prefix (`_path`, `base`), interpolated into
    // the paths this file sends: not a path on their own.
    final prefixes = <int>{};
    for (var i = 0; i + 1 < tokens.length; i++) {
      final code = tokens[i];
      if (code is! String || tokens[i + 1] is! _Literal) continue;
      final def = RegExp(r'(\w+)\s*(?:\([^()]*\))?\s*(?:=>|=)\s*$')
          .firstMatch(code);
      if (def == null) continue;
      final name = def.group(1)!;
      (defs[name] ??= []).add(_DartStrings.adjacent(tokens, i + 1).$1);
      if (RegExp('\\\$\\{?${RegExp.escape(name)}\\b').hasMatch(source)) {
        prefixes.add(i + 1);
      }
    }
    final expand = _Expander(defs);
    for (var i = 0; i < tokens.length;) {
      if (tokens[i] is! _Literal) {
        i++;
        continue;
      }
      final (group, end) = _DartStrings.adjacent(tokens, i);
      final prefix = prefixes.contains(i);
      i = end;
      if (prefix) continue;
      for (final text in expand.literals(group)) {
        if (text.startsWith('/api/super-tabs')) paths.add(text);
      }
    }
  }
  return paths;
}

/// One string literal: its text pieces (String) and interpolations
/// ([_Interpolation]).
class _Literal {
  _Literal(this.pieces);
  final List<Object> pieces;
}

class _Interpolation {
  _Interpolation(this.source);
  final String source;
}

/// Splits Dart source into code (String) and string literals ([_Literal]),
/// dropping comments.
class _DartStrings {
  _DartStrings(this.s);
  final String s;
  var i = 0;

  static List<Object> scan(String source) => _DartStrings(source)._tokens();

  /// The literals that start at [start] and sit side by side, only blank
  /// code between them, and the index past the last.
  static (List<_Literal>, int) adjacent(List<Object> tokens, int start) {
    final group = <_Literal>[tokens[start] as _Literal];
    var j = start + 1;
    while (j < tokens.length) {
      final token = tokens[j];
      if (token is _Literal) {
        group.add(token);
      } else if (!(token is String &&
          token.trim().isEmpty &&
          j + 1 < tokens.length &&
          tokens[j + 1] is _Literal)) {
        break;
      }
      j++;
    }
    return (group, j);
  }

  List<Object> _tokens() {
    final out = <Object>[];
    final code = StringBuffer();
    void flush() {
      if (code.isNotEmpty) out.add(code.toString());
      code.clear();
    }

    while (i < s.length) {
      if (_comment()) continue;
      final literal = _literal();
      if (literal != null) {
        flush();
        out.add(literal);
        continue;
      }
      code.write(s[i++]);
    }
    flush();
    return out;
  }

  bool _comment() {
    if (s.startsWith('//', i)) {
      final end = s.indexOf('\n', i);
      i = end < 0 ? s.length : end;
      return true;
    }
    if (s.startsWith('/*', i)) {
      final end = s.indexOf('*/', i + 2);
      i = end < 0 ? s.length : end + 2;
      return true;
    }
    return false;
  }

  _Literal? _literal() {
    var j = i;
    final raw = j < s.length && s[j] == 'r';
    if (raw) j++;
    if (j >= s.length || (s[j] != "'" && s[j] != '"')) return null;
    // An identifier ending in r (`for'`) is not a raw string.
    if (raw && i > 0 && RegExp(r'\w').hasMatch(s[i - 1])) return null;
    final quote = s.startsWith("${s[j]}${s[j]}${s[j]}", j)
        ? '${s[j]}${s[j]}${s[j]}'
        : s[j];
    i = j + quote.length;
    final pieces = <Object>[];
    final text = StringBuffer();
    void flushText() {
      if (text.isNotEmpty) pieces.add(text.toString());
      text.clear();
    }

    while (i < s.length && !s.startsWith(quote, i)) {
      final c = s[i];
      if (!raw && c == r'\' && i + 1 < s.length) {
        text.write(s[i + 1]);
        i += 2;
      } else if (!raw && c == r'$' && s.startsWith(r'${', i)) {
        flushText();
        final start = i + 2;
        i = start;
        var depth = 0;
        while (i < s.length) {
          if (_comment()) continue;
          if (_literal() != null) continue;
          if (s[i] == '{') depth++;
          if (s[i] == '}') {
            if (depth == 0) break;
            depth--;
          }
          i++;
        }
        pieces.add(_Interpolation(s.substring(start, i)));
        i++;
      } else if (!raw && c == r'$') {
        flushText();
        final name = RegExp(r'[A-Za-z_]\w*').matchAsPrefix(s, i + 1);
        pieces.add(_Interpolation(name?.group(0) ?? ''));
        i = name?.end ?? i + 1;
      } else {
        text.write(c);
        i++;
      }
    }
    i += quote.length;
    flushText();
    return _Literal(pieces);
  }
}

class _Expander {
  _Expander(this.defs);
  final Map<String, List<List<_Literal>>> defs;
  var _depth = 0;

  Set<String> literals(List<_Literal> group) {
    var out = {''};
    for (final literal in group) {
      for (final piece in literal.pieces) {
        final options = piece is String
            ? {piece}
            : expression((piece as _Interpolation).source);
        out = {
          for (final a in out)
            // A value unknown here: an id, or right after a path's last
            // segment a query string (`_query(id)`), or none.
            for (final b
                in options ??
                    (RegExp(r'[A-Za-z]$').hasMatch(a) ? {'', '?1'} : {'1'}))
              a + b,
        };
        if (out.length > 256) out = out.take(256).toSet();
      }
    }
    return out;
  }

  /// The values [source] can have, or null when they are not known here.
  Set<String>? expression(String source) {
    if (_depth > 8) return null;
    _depth++;
    try {
      final tokens = _DartStrings.scan(source.trim());
      final code = tokens.whereType<String>().join(' ');
      if (tokens.isNotEmpty &&
          tokens.every((t) => t is _Literal || (t as String).trim().isEmpty)) {
        return literals(tokens.whereType<_Literal>().toList());
      }
      // cond ? a : b, both sides.
      final question = _topLevel(tokens, '?');
      if (question != null) {
        final colon = _topLevel(tokens, ':', from: question);
        if (colon != null) {
          return {
            ...(expression(_join(tokens, question, colon)) ?? {'1'}),
            ...(expression(_join(tokens, colon, null)) ?? {'1'}),
          };
        }
      }
      final name = RegExp(r'^(\w+)\s*(?:\(.*\))?$').firstMatch(code.trim());
      final bodies = name == null ? null : defs[name.group(1)!];
      if (bodies != null) {
        return {for (final body in bodies) ...literals(body)};
      }
      return null;
    } finally {
      _depth--;
    }
  }

  /// Where a top-level [mark] (not `?.`, `??` or inside brackets) is, as
  /// (token, offset).
  (int, int)? _topLevel(List<Object> tokens, String mark, {(int, int)? from}) {
    var depth = 0;
    for (var t = from?.$1 ?? 0; t < tokens.length; t++) {
      final code = tokens[t];
      if (code is! String) continue;
      final start = from != null && t == from.$1 ? from.$2 + 1 : 0;
      for (var k = start; k < code.length; k++) {
        final c = code[k];
        if ('([{'.contains(c)) depth++;
        if (')]}'.contains(c)) depth--;
        if (depth != 0 || c != mark) continue;
        if (mark == '?') {
          final next = k + 1 < code.length ? code[k + 1] : '';
          final prev = k > 0 ? code[k - 1] : '';
          if (next == '.' || next == '?' || prev == '?') continue;
        }
        return (t, k);
      }
    }
    return null;
  }

  /// The source between two marks, literals put back as code.
  String _join(List<Object> tokens, (int, int) from, (int, int)? to) {
    final out = StringBuffer();
    for (var t = from.$1; t < (to?.$1 ?? tokens.length - 1) + 1; t++) {
      final token = tokens[t];
      if (token is String) {
        final start = t == from.$1 ? from.$2 + 1 : 0;
        final end = to != null && t == to.$1 ? to.$2 : token.length;
        if (start < end) out.write(token.substring(start, end));
      } else if (to == null || t < to.$1) {
        if (t == from.$1) continue;
        out.write(_source(token as _Literal));
      }
    }
    return out.toString();
  }

  static String _source(_Literal literal) {
    final out = StringBuffer("'");
    for (final piece in literal.pieces) {
      if (piece is String) {
        out.write(
          piece
              .replaceAll(r'\', r'\\')
              .replaceAll("'", r"\'")
              .replaceAll(r'$', r'\$'),
        );
      } else {
        out.write('\${${(piece as _Interpolation).source}}');
      }
    }
    out.write("'");
    return out.toString();
  }
}
