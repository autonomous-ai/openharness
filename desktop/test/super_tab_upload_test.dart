// The upload of a file to the backend's attachments route, against a real
// loopback server standing in for it. Its own file, with no `testWidgets`: under
// the widget binding every HttpClient answers 400 without touching the network.
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/api/api_client.dart';
import 'package:harness/api/access_token_source.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/super_tabs/attachment_upload.dart';
import 'package:harness/super_tabs/avatar_upload.dart';
import 'package:harness/super_tabs/controller.dart';

void main() {
  late HttpServer server;
  late SuperTabUpload upload;
  final seen =
      <
        ({
          String method,
          String path,
          String? type,
          String? local,
          String? bearer,
          String body,
        })
      >[];
  var reply = (200, <String, Object?>{});
  // Answers a request, given the one before it; null keeps `reply`.
  (int, Map<String, Object?>)? Function(String? bearer)? answer;

  setUp(() async {
    seen.clear();
    answer = null;
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((request) async {
      final bytes = BytesBuilder();
      await for (final chunk in request) {
        bytes.add(chunk);
      }
      seen.add((
        method: request.method,
        path: request.uri.path,
        type: request.headers.contentType?.mimeType,
        local: request.headers.value('x-adapter-local'),
        bearer: request.headers.value('authorization'),
        body: latin1.decode(bytes.takeBytes()),
      ));
      // Like the daemon, which refuses a request that lacks its header.
      final chosen = request.headers.value('authorization') != null
          ? answer?.call(request.headers.value('authorization'))
          : request.headers.value('x-adapter-local') == null
          ? (403, <String, Object?>{'error': 'FORBIDDEN'})
          : null;
      final (status, payload) = chosen ?? reply;
      request.response
        ..statusCode = status
        ..headers.contentType = ContentType.json
        ..write(jsonEncode(payload));
      await request.response.close();
    });
    upload = uploadWith(
      () => ApiClient(
        config: AppConfig(
          apiBaseUrl: 'http://unused.invalid',
          localCliBaseUrl: 'http://127.0.0.1:${server.port}',
        ),
        session: AuthSession(),
      ),
    );
  });
  tearDown(() => server.close(force: true));

  Future<Map<String, dynamic>> send({void Function(double)? onProgress}) =>
      upload(
        tabId: 'tab 1',
        conversationId: 'lead',
        name: 'shot.png',
        mime: 'image/png',
        bytes: Uint8List.fromList(List.filled(2000, 7)),
        cancel: CancelToken(),
        onProgress: onProgress ?? (_) {},
      );

  test(
    'posts the conversation, then the file, as one multipart form',
    () async {
      reply = (
        200,
        {
          'success': true,
          'data': {
            'attachment': {
              'id': 'a1',
              'name': 'shot.png',
              'mime': 'image/png',
              'size': 2000,
              'url': 'https://cdn.harness.autonomous.ai/k/shot.png',
            },
          },
        },
      );
      final progress = <double>[];

      final answer = await send(onProgress: progress.add);

      expect((answer['attachment'] as Map)['id'], 'a1');
      final request = seen.single;
      expect(request.method, 'POST');
      expect(request.path, '/api/super-tabs/tab%201/attachments');
      expect(request.type, 'multipart/form-data');
      final conversation = request.body.indexOf('name="conversationId"');
      final file = request.body.indexOf('name="file"');
      expect(conversation, greaterThan(-1));
      expect(file, greaterThan(conversation));
      expect(request.body, contains('filename="shot.png"'));
      expect(request.body, contains('content-type: image/png'));
      expect(progress, isNotEmpty);
      expect(progress.last, 1);
    },
  );

  test('a refusal carries the backend\'s code, message and status', () async {
    reply = (
      413,
      {
        'success': false,
        'error': {
          'code': 'ATTACHMENT_TOO_LARGE',
          'message': 'Files can be at most 10 MB.',
        },
      },
    );

    await expectLater(
      send(),
      throwsA(
        isA<SuperTabFailure>()
            .having((f) => f.code, 'code', 'ATTACHMENT_TOO_LARGE')
            .having((f) => f.message, 'message', 'Files can be at most 10 MB.')
            .having((f) => f.statusCode, 'status', 413),
      ),
    );
  });

  test('an answer without a body still reads as a refusal', () async {
    reply = (503, <String, Object?>{});

    await expectLater(
      send(),
      throwsA(
        isA<SuperTabFailure>()
            .having((f) => f.code, 'code', 'UPLOAD_FAILED')
            .having((f) => f.statusCode, 'status', 503),
      ),
    );
  });

  test('on a computer the daemon\'s header goes with it, and a 403 reads '
      'plainly', () async {
    reply = (403, {'error': 'FORBIDDEN'});

    await expectLater(
      send(),
      throwsA(
        isA<SuperTabFailure>()
            .having((f) => f.code, 'code', 'FORBIDDEN')
            .having(
              (f) => f.message,
              'message',
              'You can’t send files in this conversation.',
            )
            .having((f) => f.statusCode, 'status', 403),
      ),
    );
    expect(seen.single.local, '1');
  });

  group('a profile picture', () {
    late SuperTabAvatarUpload avatar;

    setUp(() {
      avatar = uploadAvatarWith(
        () => ApiClient(
          config: AppConfig(
            apiBaseUrl: 'http://unused.invalid',
            localCliBaseUrl: 'http://127.0.0.1:${server.port}',
          ),
          session: AuthSession(),
        ),
      );
    });

    Future<Map<String, dynamic>> sendPicture() =>
        avatar(tabId: 'tab 1', png: Uint8List.fromList(List.filled(500, 7)));

    test('goes through the daemon as a one-file form', () async {
      reply = (
        200,
        {
          'success': true,
          'data': {
            'avatar': {'id': 'p1', 'url': 'https://signed.example/p1'},
          },
        },
      );

      final answer = await sendPicture();

      expect((answer['avatar'] as Map)['id'], 'p1');
      final request = seen.single;
      expect(request.path, '/api/super-tabs/tab%201/avatars');
      expect(request.local, '1');
      expect(request.type, 'multipart/form-data');
      expect(request.body, contains('filename="avatar.png"'));
    });

    // Desktop 1.3.30 on a CLI that did not pass /avatars on: the daemon's
    // own 404 read only "Could not upload the file. Try again.", which no
    // retry fixes.
    test('a daemon without the route says to update Harness', () async {
      reply = (404, {'error': 'not found'});

      await expectLater(
        sendPicture(),
        throwsA(
          isA<SuperTabFailure>()
              .having((f) => f.code, 'code', 'UPDATE_HARNESS')
              .having(
                (f) => f.message,
                'message',
                'Update Harness on this computer to upload pictures.',
              )
              .having((f) => f.statusCode, 'status', 404),
        ),
      );
    });

    test('a backend refusal keeps its own words', () async {
      reply = (
        503,
        {
          'success': false,
          'error': {
            'code': 'AVATARS_UNAVAILABLE',
            'message': 'Uploading pictures is not set up on this server yet.',
          },
        },
      );

      await expectLater(
        sendPicture(),
        throwsA(
          isA<SuperTabFailure>()
              .having((f) => f.code, 'code', 'AVATARS_UNAVAILABLE')
              .having(
                (f) => f.message,
                'message',
                'Uploading pictures is not set up on this server yet.',
              ),
        ),
      );
    });
  });

  group('from a browser, straight to the backend', () {
    late AccessTokenSource tokens;
    final refreshes = <bool>[];

    setUp(() {
      refreshes.clear();
      tokens = _Tokens(refreshes);
      upload = uploadWith(
        () => ApiClient(
          config: AppConfig(
            apiBaseUrl: 'http://127.0.0.1:${server.port}',
            localCliBaseUrl: 'http://127.0.0.1:1',
          ),
          session: AuthSession(),
          auth: tokens,
        ),
      );
    });

    test('sends the bearer and not the daemon\'s header', () async {
      reply = (
        200,
        {
          'success': true,
          'data': {'attachment': <String, Object?>{}},
        },
      );

      await send();

      expect(seen.single.bearer, 'Bearer old');
      expect(seen.single.local, isNull);
    });

    test(
      'a token that expired is renewed and the file goes again, whole',
      () async {
        reply = (
          200,
          {
            'success': true,
            'data': {
              'attachment': {'id': 'a1'},
            },
          },
        );
        answer = (bearer) =>
            bearer == 'Bearer old' ? (401, <String, Object?>{}) : null;

        final result = await send();

        expect((result['attachment'] as Map)['id'], 'a1');
        expect(seen.map((r) => r.bearer), ['Bearer old', 'Bearer new']);
        expect(refreshes, [true]);
        // The second try carried the same form, file and all.
        expect(seen.last.body, contains('filename="shot.png"'));
        expect(seen.last.body.length, seen.first.body.length);
      },
    );
  });
}

/// Tokens that go stale: the first is refused, a forced renewal gives a new one.
class _Tokens implements AccessTokenSource {
  _Tokens(this.refreshes);
  final List<bool> refreshes;
  var _renewed = false;

  @override
  Future<String> accessToken({bool force = false, String? failedToken}) async {
    if (force) {
      refreshes.add(true);
      _renewed = true;
    }
    return _renewed ? 'new' : 'old';
  }
}
