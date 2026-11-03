// The upload of a file to the backend's attachments route, against a real
// loopback server standing in for it. Its own file, with no `testWidgets`: under
// the widget binding every HttpClient answers 400 without touching the network.
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math' show min;
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:file_selector/file_selector.dart' show XFile;
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/api/api_client.dart';
import 'package:harness/api/access_token_source.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/logging/app_log.dart';
import 'package:harness/state/harness_attachments.dart';
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
  // Answers by path, before `reply`: the steps of a file sent to storage.
  final replies = <String, (int, Map<String, Object?>)>{};
  // Answers a request, given the one before it; null keeps `reply`.
  (int, Map<String, Object?>)? Function(String? bearer)? answer;

  setUp(() async {
    seen.clear();
    replies.clear();
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
      final (status, payload) = chosen ?? replies[request.uri.path] ?? reply;
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
        file: HarnessAttachment(
          'shot.png',
          Uint8List.fromList(List.filled(2000, 7)),
        ),
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
          'message': 'Files can be up to 256 MB.',
        },
      },
    );

    await expectLater(
      send(),
      throwsA(
        isA<SuperTabFailure>()
            .having((f) => f.code, 'code', 'ATTACHMENT_TOO_LARGE')
            .having((f) => f.message, 'message', 'Files can be up to 256 MB.')
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

  group('a file over 10 MB goes straight to storage', () {
    const size = 10 * 1024 * 1024 + 1;
    const secret = 'X-Goog-Signature=s3cr3t';
    late HttpServer storage;
    late String link;
    final puts =
        <
          ({String method, String path, Map<String, String> headers, int sent})
        >[];
    var storageStatus = 200;
    // Told once storage has the request's headers, before its body is in.
    Completer<void>? putStarted;
    final signed = {
      'content-type': 'application/octet-stream',
      'content-disposition': 'attachment; filename="AC4 - 26 Oct v2.step"',
      'cache-control': 'private, max-age=0',
      'x-goog-content-length-range': '$size,$size',
      'x-goog-if-generation-match': '0',
    };
    final logged = <String>[];
    late AppLog log;

    setUp(() async {
      puts.clear();
      logged.clear();
      storageStatus = 200;
      putStarted = null;
      log = appLog;
      appLog = _Recorder(logged);
      storage = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      storage.listen((request) async {
        putStarted?.complete();
        var sent = 0;
        try {
          await for (final chunk in request) {
            sent += chunk.length;
          }
        } catch (_) {
          // The sender gave up mid-body.
        }
        final headers = <String, String>{};
        request.headers.forEach(
          (name, values) => headers[name] = values.join(','),
        );
        puts.add((
          method: request.method,
          path: request.uri.toString(),
          headers: headers,
          sent: sent,
        ));
        try {
          request.response
            ..statusCode = storageStatus
            // Storage's refusal can quote the link it was sent on.
            ..write(storageStatus == 200 ? '' : '<Error>$link</Error>');
          await request.response.close();
        } catch (_) {}
      });
      link = 'http://127.0.0.1:${storage.port}/bucket/key?$secret';
      replies['/api/super-tabs/tab%201/attachments/uploads'] = (
        200,
        {
          'success': true,
          'data': {
            'upload': {
              'id': 'u1',
              'url': link,
              'method': 'PUT',
              'headers': signed,
              'expiresAt': 1793436000000,
            },
          },
        },
      );
      replies['/api/super-tabs/tab%201/attachments/uploads/u1/complete'] = (
        200,
        {
          'success': true,
          'data': {
            'attachment': {
              'id': 'u1',
              'name': 'AC4 - 26 Oct v2.step',
              'mime': 'application/octet-stream',
              'size': size,
              'url': 'https://cdn.harness.autonomous.ai/k/AC4.step',
            },
          },
        },
      );
    });
    tearDown(() async {
      appLog = log;
      await storage.close(force: true);
    });

    Future<Map<String, dynamic>> sendLarge({
      int length = size,
      CancelToken? cancel,
      Completer<void>? hold,
      void Function(double)? onProgress,
    }) => upload(
      tabId: 'tab 1',
      conversationId: 'lead',
      name: 'AC4 - 26 Oct v2.step',
      mime: 'application/octet-stream',
      file: HarnessAttachment.onDisk(
        'AC4 - 26 Oct v2.step',
        _Sized(length, hold: hold),
        length,
      ),
      cancel: cancel ?? CancelToken(),
      onProgress: onProgress ?? (_) {},
    );

    test('asks for a link, sends the file on it with exactly its headers '
        'and no token, then finishes', () async {
      final progress = <double>[];

      final answer = await sendLarge(onProgress: progress.add);

      expect((answer['attachment'] as Map)['id'], 'u1');
      expect(seen.map((r) => r.path), [
        '/api/super-tabs/tab%201/attachments/uploads',
        '/api/super-tabs/tab%201/attachments/uploads/u1/complete',
      ]);
      // Through the daemon, as JSON, each with its header.
      expect(seen.map((r) => r.type), ['application/json', 'application/json']);
      expect(seen.map((r) => r.local), ['1', '1']);
      expect(jsonDecode(seen.first.body), {
        'conversationId': 'lead',
        'name': 'AC4 - 26 Oct v2.step',
        'mime': 'application/octet-stream',
        'size': size,
      });
      expect(jsonDecode(seen.last.body), <String, Object?>{});

      final put = puts.single;
      expect(put.method, 'PUT');
      expect(put.path, '/bucket/key?$secret');
      expect(put.sent, size);
      expect(put.headers['content-length'], '$size');
      for (final MapEntry(:key, :value) in signed.entries) {
        expect(put.headers[key], value, reason: key);
      }
      expect(put.headers, isNot(contains('authorization')));
      expect(put.headers, isNot(contains('x-adapter-local')));
      expect(progress, isNotEmpty);
      expect(progress.last, 1);
    });

    test('storage refusing it fails plainly, never quoting the link, and '
        'nothing is finished', () async {
      storageStatus = 403;

      await expectLater(
        sendLarge(),
        throwsA(
          isA<SuperTabFailure>()
              .having((f) => f.code, 'code', 'UPLOAD_FAILED')
              .having(
                (f) => f.message,
                'message',
                'Could not upload AC4 - 26 Oct v2.step. Try again.',
              ),
        ),
      );
      expect(seen.map((r) => r.path), [
        '/api/super-tabs/tab%201/attachments/uploads',
      ]);
      expect(logged, contains(contains('status 403')));
      expect(logged.where((line) => line.contains('s3cr3t')), isEmpty);
      expect(logged.where((line) => line.contains('bucket')), isEmpty);
    });

    test(
      'a link that cannot be reached fails plainly, never quoting it',
      () async {
        link = 'http://127.0.0.1:1/bucket/key?$secret';
        final (status, body) =
            replies['/api/super-tabs/tab%201/attachments/uploads']!;
        ((body['data'] as Map)['upload'] as Map)['url'] = link;
        replies['/api/super-tabs/tab%201/attachments/uploads'] = (status, body);

        Object? failure;
        try {
          await sendLarge();
        } catch (error) {
          failure = error;
        }

        expect(failure, isA<SuperTabFailure>());
        expect((failure as SuperTabFailure).code, 'UPLOAD_FAILED');
        expect('$failure', isNot(contains('s3cr3t')));
        expect(logged.where((line) => line.contains('s3cr3t')), isEmpty);
      },
    );

    test(
      'given up mid-file, the transfer stops and nothing is finished',
      () async {
        final cancel = CancelToken();
        final hold = Completer<void>();
        putStarted = Completer<void>();

        final sending = sendLarge(cancel: cancel, hold: hold);
        await putStarted!.future;
        cancel.cancel('given up');

        await expectLater(
          sending,
          throwsA(
            isA<DioException>().having(
              (f) => f.type,
              'type',
              DioExceptionType.cancel,
            ),
          ),
        );
        // The cancel error names the link request, not storage.
        expect(
          cancel.cancelError!.requestOptions.uri.toString(),
          isNot(contains('s3cr3t')),
        );
        hold.complete();
        // Storage saw the transfer end short.
        await Future<void>.delayed(const Duration(milliseconds: 100));
        expect(puts.single.sent, lessThan(size));
        expect(seen.map((r) => r.path), [
          '/api/super-tabs/tab%201/attachments/uploads',
        ]);
      },
    );

    test('a link that is not https is refused before a byte is sent, never '
        'quoting it', () async {
      // Plain http to a host that is not this computer by name: reachable
      // here, so a client that sent to it would be seen doing so.
      final plain = await HttpServer.bind(InternetAddress.loopbackIPv6, 0);
      addTearDown(() => plain.close(force: true));
      final reached = <String>[];
      plain.listen((request) async {
        reached.add(request.method);
        await request.drain<void>();
        await request.response.close();
      });
      link = 'http://[::1]:${plain.port}/bucket/key?$secret';
      final (status, body) =
          replies['/api/super-tabs/tab%201/attachments/uploads']!;
      ((body['data'] as Map)['upload'] as Map)['url'] = link;
      replies['/api/super-tabs/tab%201/attachments/uploads'] = (status, body);

      await expectLater(
        sendLarge(),
        throwsA(
          isA<SuperTabFailure>()
              .having((f) => f.code, 'code', 'UPLOAD_FAILED')
              .having(
                (f) => f.message,
                'message',
                'Could not upload AC4 - 26 Oct v2.step. Try again.',
              ),
        ),
      );
      expect(reached, isEmpty);
      expect(seen.map((r) => r.path), [
        '/api/super-tabs/tab%201/attachments/uploads',
      ]);
      expect(logged.where((line) => line.contains('s3cr3t')), isEmpty);
    });

    test('storage links: https, or plain http to this computer from a '
        'computer only', () {
      expect(
        superTabStorageLinkAllowed('https://storage.googleapis.com/b/k?s=1'),
        isTrue,
      );
      expect(superTabStorageLinkAllowed('http://127.0.0.1:9000/b/k'), isTrue);
      expect(superTabStorageLinkAllowed('http://localhost:9000/b/k'), isTrue);
      expect(
        superTabStorageLinkAllowed('http://127.0.0.1:9000/b/k', web: true),
        isFalse,
      );
      for (final refused in [
        'http://storage.googleapis.com/b/k',
        'http://[::1]:9000/b/k',
        'ftp://storage.googleapis.com/b/k',
        'https://user:pw@storage.googleapis.com/b/k',
        'https:///b/k',
        'not a link',
      ]) {
        expect(superTabStorageLinkAllowed(refused), isFalse, reason: refused);
      }
    });

    test('over 256 MB it is refused before any request', () async {
      await expectLater(
        sendLarge(length: 256 * 1024 * 1024 + 1),
        throwsA(
          isA<SuperTabFailure>()
              .having((f) => f.code, 'code', 'ATTACHMENT_TOO_LARGE')
              .having(
                (f) => f.message,
                'message',
                'Files can be up to 256 MB.',
              ),
        ),
      );
      expect(seen, isEmpty);
      expect(puts, isEmpty);
    });

    test('a daemon without the route says to update Harness', () async {
      replies['/api/super-tabs/tab%201/attachments/uploads'] = (
        404,
        {'error': 'not found'},
      );

      await expectLater(
        sendLarge(),
        throwsA(
          isA<SuperTabFailure>()
              .having((f) => f.code, 'code', 'UPDATE_HARNESS')
              .having(
                (f) => f.message,
                'message',
                'Update Harness on this computer to send files over 10 MB.',
              ),
        ),
      );
      expect(puts, isEmpty);
    });

    test('a link the backend refuses carries its words, and nothing goes to '
        'storage', () async {
      replies['/api/super-tabs/tab%201/attachments/uploads'] = (
        413,
        {
          'success': false,
          'error': {
            'code': 'ATTACHMENT_TOO_LARGE',
            'message': 'Files can be up to 256 MB.',
          },
        },
      );

      await expectLater(
        sendLarge(),
        throwsA(
          isA<SuperTabFailure>()
              .having((f) => f.code, 'code', 'ATTACHMENT_TOO_LARGE')
              .having((f) => f.statusCode, 'status', 413),
        ),
      );
      expect(puts, isEmpty);
    });

    test('10 MB itself still goes as one form', () async {
      reply = (
        200,
        {
          'success': true,
          'data': {
            'attachment': {'id': 'a1'},
          },
        },
      );
      final answer = await upload(
        tabId: 'tab 1',
        conversationId: 'lead',
        name: 'edge.bin',
        mime: 'application/octet-stream',
        file: HarnessAttachment('edge.bin', Uint8List(10 * 1024 * 1024)),
        cancel: CancelToken(),
        onProgress: (_) {},
      );

      expect((answer['attachment'] as Map)['id'], 'a1');
      expect(seen.single.path, '/api/super-tabs/tab%201/attachments');
      expect(seen.single.type, 'multipart/form-data');
      expect(puts, isEmpty);
    });
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

    test('a file over 10 MB: the token goes to the backend, never to '
        'storage', () async {
      final storage = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      addTearDown(() => storage.close(force: true));
      final storageHeaders = <String, String>{};
      storage.listen((request) async {
        request.headers.forEach(
          (name, values) => storageHeaders[name] = values.join(','),
        );
        await request.drain<void>();
        await request.response.close();
      });
      const size = 10 * 1024 * 1024 + 1;
      replies['/api/super-tabs/tab%201/attachments/uploads'] = (
        200,
        {
          'success': true,
          'data': {
            'upload': {
              'id': 'u1',
              'url': 'http://127.0.0.1:${storage.port}/bucket/key?sig=1',
              'method': 'PUT',
              'headers': {'content-type': 'application/octet-stream'},
              'expiresAt': 1793436000000,
            },
          },
        },
      );
      replies['/api/super-tabs/tab%201/attachments/uploads/u1/complete'] = (
        200,
        {
          'success': true,
          'data': {
            'attachment': {'id': 'u1'},
          },
        },
      );

      final answer = await upload(
        tabId: 'tab 1',
        conversationId: 'lead',
        name: 'big.step',
        mime: 'application/octet-stream',
        file: HarnessAttachment.onDisk('big.step', _Sized(size), size),
        cancel: CancelToken(),
        onProgress: (_) {},
      );

      expect((answer['attachment'] as Map)['id'], 'u1');
      expect(seen.map((r) => r.bearer), ['Bearer old', 'Bearer old']);
      expect(seen.map((r) => r.local), [null, null]);
      expect(storageHeaders['content-length'], '$size');
      expect(storageHeaders, isNot(contains('authorization')));
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

/// A file of [size] zero bytes on disk, never read whole: reading it so fails
/// the test. With [hold], it stops after its first part until that completes.
class _Sized extends XFile {
  _Sized(this.size, {this.hold}) : super('/picked/large.step');

  final int size;
  final Completer<void>? hold;

  @override
  Future<int> length() async => size;

  @override
  Future<Uint8List> readAsBytes() => throw StateError('read whole');

  @override
  Stream<Uint8List> openRead([int? start, int? end]) async* {
    const chunk = 256 * 1024;
    final last = end ?? size;
    for (var at = start ?? 0; at < last; at += chunk) {
      yield Uint8List(min(chunk, last - at));
      if (hold case final hold?) await hold.future;
    }
  }
}

/// The app log's lines, as they would be written.
class _Recorder implements AppLog {
  _Recorder(this.lines);
  final List<String> lines;

  @override
  void record(
    AppLogLevel level,
    String category,
    String message, {
    Object? error,
    StackTrace? stackTrace,
  }) => lines.add('$level $category $message ${error ?? ''}');
}
