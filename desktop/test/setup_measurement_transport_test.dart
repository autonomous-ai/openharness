import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/measurement/setup_transport.dart';
import 'package:harness/measurement/product_report_failure.dart';
import 'package:harness/measurement/desktop_setup_report.dart';
import 'package:harness/measurement/product_measurement.dart';

void main() {
  test(
    'default Desktop counts cross the anonymous transport and stop on opt-out',
    () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      final reports = <Map<String, dynamic>>[];
      final listener = server.listen((request) async {
        expect(request.headers.value('authorization'), isNull);
        expect(request.headers.value('cookie'), isNull);
        reports.add(
          jsonDecode(await utf8.decoder.bind(request).join())
              as Map<String, dynamic>,
        );
        request.response.headers.contentType = ContentType.json;
        request.response.write(
          jsonEncode({
            'data': {'accepted': true},
          }),
        );
        await request.response.close();
      });
      final usage = ProductMeasurement(
        surface: 'desktop',
        automatic: false,
        sendSetup: (report) => sendDesktopSetupMeasurement(
          'http://127.0.0.1:${server.port}',
          report,
        ),
      );
      try {
        usage.begin(ProductFlow.signIn)(ProductOutcome.failed);
        await usage.flush();
        expect(reports.single.keys.toSet(), {
          'schemaVersion',
          'sharing',
          'id',
          'day',
          'counters',
        });
        expect(reports.single['sharing'], 'default');
        expect(
          (reports.single['counters'] as Map)['setup_desktop_sign_in_failed'],
          1,
        );
        final finish = usage.begin(ProductFlow.signIn);
        await usage.setSignedOutSharing(false);
        finish(ProductOutcome.ok);
        await usage.flush();
        expect(reports.length, 1);
      } finally {
        usage.dispose();
        await listener.cancel();
        await server.close(force: true);
      }
    },
  );
  test(
    'a permanent setup rejection is classified without keeping its body',
    () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      final received = server.first.then((request) async {
        await request.drain<void>();
        request.response
          ..statusCode = 400
          ..headers.contentType = ContentType.json
          ..write(
            jsonEncode({
              'error': {
                'message': 'PRIVATE_CANARY',
                'code': 'INVALID_SETUP_REPORT',
              },
            }),
          );
        await request.response.close();
      });
      try {
        await expectLater(
          sendDesktopSetupMeasurement('http://127.0.0.1:${server.port}', {}),
          throwsA(
            isA<ProductReportFailure>()
                .having((e) => e.permanent, 'permanent', true)
                .having(
                  (e) => e.toString(),
                  'safe',
                  isNot(contains('PRIVATE')),
                ),
          ),
        );
        await received;
      } finally {
        await server.close(force: true);
      }
    },
  );
  test('signed-out transport uses only a loopback fixture and sends no credentials', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final received = server.first.then((request) async {
      expect(request.uri.path, '/api/product-usage/setup');
      for (final header in [
        'authorization',
        'cookie',
        'x-device-id',
        'x-account-id',
      ]) {
        expect(request.headers.value(header), isNull);
      }
      final body = jsonDecode(await utf8.decoder.bind(request).join());
      expect(body, {
        'schemaVersion': 1,
        'consent': true,
        'counters': {'setup_desktop_sign_in_started': 1},
      });
      request.response.headers.contentType = ContentType.json;
      request.response.write(
        jsonEncode({
          'success': true,
          'data': {'accepted': true},
        }),
      );
      await request.response.close();
    });
    try {
      expect(
        await sendSetupMeasurement('http://127.0.0.1:${server.port}', {
          'schemaVersion': 1,
          'consent': true,
          'counters': {'setup_desktop_sign_in_started': 1},
        }),
        {'accepted': true},
      );
      await received;
      await expectLater(
        sendSetupMeasurement('https://not-a-fixture.invalid', {}),
        throwsStateError,
      );
    } finally {
      await server.close(force: true);
    }
  });
}
