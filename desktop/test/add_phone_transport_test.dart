import 'dart:convert';
import 'dart:io';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/api/api_client.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/widgets/add_phone_dialog.dart';

/// Add Phone's transport against a real loopback server standing in for the
/// daemon. Its own file, with no `testWidgets`: under the widget binding every
/// HttpClient answers 400 without touching the network.
void main() {
  group('the transport', () {
    ApiClient client(int port) => ApiClient(
      config: AppConfig(
        apiBaseUrl: 'http://unused.invalid',
        localCliBaseUrl: 'http://127.0.0.1:$port',
      ),
      session: AuthSession(),
    );

    test(
      'POSTs the code to /api/pair and reads the daemon\'s own codes',
      () async {
        final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
        final seen = <(String, String, String?, Object?)>[];
        final replies = [
          (409, {'error': 'NO_INTENT'}),
          (200, {'label': 'Dee’s iPhone', 'fingerprint': 'ab:cd'}),
          (404, {'error': 'not found'}),
        ];
        final subscription = server.listen((request) async {
          seen.add((
            request.method,
            request.uri.path,
            request.headers.value('x-adapter-local'),
            jsonDecode(await utf8.decodeStream(request)),
          ));
          final (status, body) = replies.removeAt(0);
          request.response
            ..statusCode = status
            ..headers.contentType = ContentType.json
            ..write(jsonEncode(body));
          await request.response.close();
        });
        try {
          final pair = phonePairOverDaemon(client(server.port));
          expect((await pair('CODE', CancelToken())).error, 'NO_INTENT');
          expect((await pair('CODE', CancelToken())).label, 'Dee’s iPhone');
          expect(
            (await pair('CODE', CancelToken())).error,
            PhonePairAnswer.unavailable,
            reason: 'a daemon from before /api/pair',
          );
          final (method, path, localHeader, body) = seen.first;
          expect((method, path), ('POST', '/api/pair'));
          // The daemon's CSRF gate refuses a write without it.
          expect(localHeader, '1');
          expect(body, {'code': 'CODE'});
        } finally {
          await subscription.cancel();
          await server.close(force: true);
        }
      },
    );

    test('nobody listening is a daemon that cannot pair', () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      final port = server.port;
      await server.close(force: true);
      final answer = await phonePairOverDaemon(client(port))(
        'CODE',
        CancelToken(),
      );
      expect(answer.error, PhonePairAnswer.unavailable);
    });
  });
}
