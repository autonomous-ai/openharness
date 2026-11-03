import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/api/access_token_source.dart';
import 'package:harness_mobile/api/api_client.dart';
import 'package:harness_mobile/auth/auth_session.dart';
import 'package:harness_mobile/core/config.dart';
import 'package:harness_mobile/swarm/swarm_asks.dart';
import 'package:harness_mobile/swarm/swarm_conversation.dart';
import 'package:harness_mobile/swarm/swarm_reader.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/ws/ws_conn.dart';

import '../viewer_app_fixture.dart';
import '../voice_fakes.dart' show MemoryKeyValueStore;
import 'swarm_fixture.dart' show changes, firstLoad, groupData, me, tab;

const _commands = '/api/super-tabs/$tab/commands';
const _post = {
  'operationId': 'same-post',
  'command': {'type': 'message.send', 'conversationId': 'g1', 'text': 'Hello'},
};

class _PhoneToken implements AccessTokenSource {
  @override
  Future<String> accessToken({bool force = false, String? failedToken}) async =>
      'phone-person-token';
}

/// Only the HTTP boundary is replaced: real API serialization, authentication,
/// routing, chat outbox and decision retry logic run above it. No real accounts.
class _Backend implements HttpClientAdapter {
  final writes = <Map<String, dynamic>>[];
  final paths = <String>[];
  final bearers = <Object?>[];
  FutureOr<({int status, Object? body})> Function(RequestOptions)? onWrite;

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? stream,
    Future<void>? cancelFuture,
  ) async {
    final bytes = await stream?.fold<List<int>>([], (a, b) => a..addAll(b));
    Object? data;
    var status = 200;
    if (options.method == 'POST') {
      writes.add(
        Map<String, dynamic>.from(jsonDecode(utf8.decode(bytes!)) as Map),
      );
      paths.add(options.uri.path);
      bearers.add(options.headers['authorization']);
      final answer = await onWrite?.call(options);
      if (answer != null) {
        return _reply(answer.status, answer.body);
      }
      data = {
        'result': {'messageId': 'posted-1'},
      };
    } else if (options.path.endsWith('/parts')) {
      data = firstLoad(groups: [groupData('g1')]);
    } else if (options.path.endsWith('/changes')) {
      data = changes();
    } else if (options.path.endsWith('/messages')) {
      data = {'messages': <Object>[], 'next': null};
    } else {
      data = <String, Object?>{};
    }
    return _reply(status, {'success': true, 'data': data});
  }

  ResponseBody _reply(int status, Object? body) => ResponseBody.fromString(
    jsonEncode(body),
    status,
    headers: {
      Headers.contentTypeHeader: [Headers.jsonContentType],
    },
  );

  @override
  void close({bool force = false}) {}
}

void main() {
  Future<({ViewerRig rig, _Backend backend})> phone({
    bool online = false,
  }) async {
    final rig = await signedInWith({'mac': []});
    addTearDown(rig.app.dispose);
    if (!online) {
      rig.app.connectionStatusForTest('mac', ConnectionStatus.disconnected);
      await settle();
    }
    final backend = _Backend();
    rig.app.api = ApiClient(
      config: const AppConfig(apiBaseUrl: 'https://phone-backend.invalid'),
      session: AuthSession(storage: MemoryKeyValueStore()),
      auth: _PhoneToken(),
      httpClientAdapter: backend,
    );
    return (rig: rig, backend: backend);
  }

  Future<SwarmReader> reader(ViewerRig rig) async {
    final reader = SwarmReader(
      tabId: tab,
      accountId: me,
      request: rig.app.swarmRequest,
    );
    addTearDown(reader.dispose);
    await reader.refresh();
    return reader;
  }

  test('a chat posts with every account machine offline', () async {
    final p = await phone();
    final r = await reader(p.rig);
    final chat = SwarmConversation(r, 'g1');
    addTearDown(chat.dispose);
    await chat.load();
    chat.draft = 'A message from the offline-machine phone';

    expect(await chat.send(), isTrue);
    expect(chat.error, isNull);
    final sent = p.backend.writes.single;
    expect(
      sent['operationId'],
      isA<String>().having((s) => s.isNotEmpty, 'nonempty', isTrue),
    );
    expect(sent['command'], containsPair('type', 'message.send'));
    expect(
      sent['command'],
      containsPair('text', 'A message from the offline-machine phone'),
    );
    expect(p.backend.bearers, ['Bearer phone-person-token']);
    expect(p.rig.conn('mac').payloadsOf('super_tabs'), isEmpty);
  });

  test(
    'a decision answer reaches the backend with every machine offline',
    () async {
      final p = await phone();
      final asks = SwarmAsks(await reader(p.rig));
      addTearDown(asks.dispose);
      final decision = SuperTabDecision.fromJson({
        'id': 'decision-1',
        'conversationId': 'g1',
        'question': 'Ship?',
        'options': ['Yes', 'No'],
      });

      expect(await asks.answer(decision, 1), isTrue);
      expect(p.backend.writes.single['command'], {
        'type': 'decision.answer',
        'decisionId': 'decision-1',
        'choice': 1,
      });
      expect(p.backend.bearers, ['Bearer phone-person-token']);
      expect(p.rig.conn('mac').payloadsOf('super_tabs'), isEmpty);
      await settle();
    },
  );

  for (final action in ['post', 'answer']) {
    test(
      'retrying an unconfirmed $action retains its command and operation ID',
      () async {
        final p = await phone();
        var lost = true;
        p.backend.onWrite = (options) {
          if (lost)
            throw DioException.connectionError(
              requestOptions: options,
              reason: 'reply lost',
            );
          return (
            status: 200,
            body: {
              'success': true,
              'data': {
                'result': {'messageId': 'posted-1'},
              },
            },
          );
        };
        final r = await reader(p.rig);
        if (action == 'post') {
          final chat = SwarmConversation(r, 'g1');
          addTearDown(chat.dispose);
          await chat.load();
          chat.draft = 'Send exactly once';
          expect(await chat.send(), isFalse);
          lost = false;
          expect(await chat.send(), isTrue);
        } else {
          final asks = SwarmAsks(r);
          addTearDown(asks.dispose);
          final decision = SuperTabDecision.fromJson({
            'id': 'd1',
            'conversationId': 'g1',
          });
          expect(await asks.answer(decision, 1), isFalse);
          lost = false;
          // A changed tap cannot silently change an answer whose receipt is pending.
          expect(await asks.answer(decision, 0), isTrue);
        }
        expect(p.backend.writes, hasLength(2));
        expect(p.backend.writes[1], p.backend.writes[0]);
        expect(p.backend.writes[0]['operationId'], isNotEmpty);
        expect(p.rig.conn('mac').payloadsOf('super_tabs'), isEmpty);
        await settle();
      },
    );
  }

  for (final status in [0, 500, 503]) {
    test(
      'unavailable direct write ($status) falls back with the same operation ID',
      () async {
        final p = await phone(online: true);
        p.backend.onWrite = (options) {
          if (status == 0)
            throw DioException.connectionError(
              requestOptions: options,
              reason: 'offline',
            );
          return (
            status: status,
            body: {
              'success': false,
              'error': {'code': 'UNAVAILABLE'},
            },
          );
        };
        p.rig.conn('mac').answers['super_tabs'] = (_) => {
          'ok': true,
          'value': {
            'result': {'messageId': 'from-machine'},
          },
        };

        expect(await p.rig.app.swarmRequest('POST', _commands, body: _post), {
          'result': {'messageId': 'from-machine'},
        });
        expect(p.backend.writes, [_post]);
        expect(p.rig.conn('mac').payloadsOf('super_tabs').single, {
          'action': 'backend',
          'method': 'POST',
          'path': _commands,
          'body': _post,
        });
      },
    );
  }

  for (final status in [400, 401, 403, 404, 426, 429]) {
    test(
      'a direct write refusal ($status) cannot gain access through a machine',
      () async {
        final p = await phone(online: true);
        p.backend.onWrite = (_) => (
          status: status,
          body: {
            'success': false,
            'error': {'code': 'REFUSED', 'message': 'Cannot write.'},
          },
        );
        p.rig.conn('mac').answers['super_tabs'] = (_) => {
          'ok': true,
          'value': 'wrong privileges',
        };

        await expectLater(
          p.rig.app.swarmRequest('POST', _commands, body: _post),
          throwsA(
            isA<SuperTabFailure>().having(
              (f) => f.statusCode,
              'status',
              status,
            ),
          ),
        );
        expect(p.rig.conn('mac').payloadsOf('super_tabs'), isEmpty);
      },
    );
  }

  for (final status in [200, 401, 503]) {
    test(
      'sign-out cancels a held write ($status) and forbids fallback or token replay',
      () async {
        final p = await phone(online: true);
        final reached = Completer<void>();
        final release = Completer<void>();
        p.backend.onWrite = (_) async {
          reached.complete();
          await release.future;
          return (
            status: status,
            body: {
              'success': status == 200,
              'data': {'result': {}},
            },
          );
        };
        final writing = p.rig.app.swarmRequest('POST', _commands, body: _post);
        final stopped = expectLater(
          writing,
          throwsA(
            isA<SuperTabFailure>().having(
              (f) => f.code,
              'code',
              'ACCOUNT_CHANGED',
            ),
          ),
        );
        await reached.future;
        await p.rig.app.logout();
        release.complete();
        await stopped;
        await settle();
        expect(p.backend.writes, hasLength(1));
        expect(p.rig.conn('mac').payloadsOf('super_tabs'), isEmpty);
      },
    );
  }

  test(
    'non-command Swarm writes also use the phone while machines are offline',
    () async {
      final p = await phone();
      const path = '/api/super-tabs/$tab/conversations/g1/read';
      await p.rig.app.swarmRequest('POST', path, body: {'sequence': 42});
      expect(p.backend.paths, [path]);
      expect(p.backend.writes, [
        {'sequence': 42},
      ]);
    },
  );
}
