import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/api/api_client.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/measurement/product_measurement.dart';
import 'package:harness/measurement/product_report_failure.dart';

void main() {
  late HttpServer server;
  late StreamSubscription<HttpRequest> listener;
  late ApiClient api;
  late ProductMeasurement usage;
  late List<Map<String, dynamic>> attempts, accepted;
  var status = 200;
  String? code;
  Completer<void>? hold;
  setUp(() async {
    attempts = [];
    accepted = [];
    status = 200;
    code = null;
    hold = null;
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    listener = server.listen((request) async {
      final report = jsonDecode(
        await utf8.decoder.bind(request).join(),
      ) as Map<String, dynamic>;
      expect(request.uri.path, '/api/product-usage/report');
      expect(request.headers.value('x-adapter-local'), '1');
      attempts.add(report);
      final responseStatus = status, responseCode = code;
      await hold?.future;
      if (responseStatus == 200) accepted.add(report);
      request.response
        ..statusCode = responseStatus
        ..headers.contentType = ContentType.json
        ..write(
          jsonEncode(
            responseStatus == 200
                ? {
                    'success': true,
                    'data': {'accepted': true},
                  }
                : {
                    'success': false,
                    'error': {
                      'code': responseCode,
                      'message': 'PRIVATE_ERROR_CANARY',
                    },
                  },
          ),
        );
      await request.response.close();
    });
    api = ApiClient(
      config: AppConfig(
        apiBaseUrl: 'http://unused.invalid',
        localCliBaseUrl: 'http://127.0.0.1:${server.port}',
      ),
      session: AuthSession(),
    );
    usage = ProductMeasurement(
      surface: 'desktop',
      automatic: false,
      context: ProductUsageContext(
        release: '1.2.77',
        platform: 'macos',
        production: true,
      ),
      sendSetup: (_) async =>
          throw StateError('No signed-out request expected'),
    );
    usage.account(
      'PRIVATE_ACCOUNT_CANARY',
      choice: () async => {'enabled': true, 'revision': 0},
      send: api.productUsageReport,
    );
    await usage.flush();
  });
  tearDown(() async {
    usage.dispose();
    if (hold != null && !hold!.isCompleted) hold!.complete();
    await listener.cancel();
    await server.close(force: true);
  });
  Map<String, int> totals() {
    final result = <String, int>{};
    for (final r in accepted) {
      for (final e in (r['counters'] as Map).entries) {
        result[e.key as String] = (result[e.key] ?? 0) + (e.value as int);
      }
    }
    return result;
  }

  for (final (http, reason) in [(400, 'invalid'), (413, 'too_large')]) {
    test(
      'HTTP $http discards only the rejected packet and later reports progress',
      () async {
        status = http;
        usage.begin(ProductFlow.viewerLoad)(ProductOutcome.ok);
        await usage.flush();
        final rejected = attempts.single;
        status = 200;
        usage.begin(ProductFlow.connectUser)(ProductOutcome.ok);
        await usage.flush();
        expect(attempts, hasLength(2));
        expect(attempts.last['id'], isNot(rejected['id']));
        expect(totals()['ui_desktop_connect_user_ok'], 1);
        expect(totals()['ui_desktop_viewer_load_ok'], isNull);
        expect(totals()['health_desktop_report_failure_$reason'], 1);
        expect(jsonEncode(accepted), isNot(contains('PRIVATE_')));
      },
    );
  }

  test('transient conflict retries the same receipt and counters before draining new work', () async {
    status = 503;
    code = 'USAGE_WRITE_CONFLICT';
    usage.begin(ProductFlow.viewerLoad)(ProductOutcome.ok);
    await usage.flush();
    final first = jsonEncode(attempts.single);
    usage.begin(ProductFlow.connectUser)(ProductOutcome.ok);
    status = 200;
    await usage.flush();
    expect(jsonEncode(attempts.last), first);
    await usage.flush();
    expect(totals()['ui_desktop_viewer_load_ok'], 1);
    expect(totals()['ui_desktop_connect_user_ok'], 1);
    expect(totals()['health_desktop_report_failure_write_conflict'], 1);
    expect(jsonEncode(accepted), isNot(contains('PRIVATE_')));
  });

  test(
    'a failure from an old account cannot enter the next account counters',
    () async {
      status = 400;
      hold = Completer<void>();
      usage.begin(ProductFlow.viewerLoad)(ProductOutcome.ok);
      final flushing = usage.flush();
      while (attempts.isEmpty) {
        await Future<void>.delayed(const Duration(milliseconds: 1));
      }
      usage.account(
        'OTHER_PRIVATE_ACCOUNT',
        choice: () async => {'enabled': true, 'revision': 0},
        send: api.productUsageReport,
      );
      usage.savedChoice({'enabled': true, 'revision': 0});
      usage.begin(ProductFlow.connectUser)(ProductOutcome.ok);
      hold!.complete();
      hold = null;
      await flushing;
      status = 200;
      await usage.flush();
      expect(totals()['ui_desktop_connect_user_ok'], 1);
      expect(totals()['health_desktop_report_failed'], isNull);
      expect(totals()['health_desktop_report_failure_invalid'], isNull);
    },
  );

  for (final (http, errorCode, measure) in [
    (401, 'PRIVATE_CODE', ProductHealthMeasure.reportFailureAuth),
    (403, null, ProductHealthMeasure.reportFailureAuth),
    (429, 'USAGE_BUSY', ProductHealthMeasure.reportFailureRateLimited),
    (504, 'BACKEND_TIMEOUT', ProductHealthMeasure.reportFailureTimeout),
    (502, 'BACKEND_UNREACHABLE', ProductHealthMeasure.reportFailureUnreachable),
    (
      503,
      'USAGE_TRANSACTION_FAILED',
      ProductHealthMeasure.reportFailureTransaction,
    ),
    (500, 'PRIVATE_CODE', ProductHealthMeasure.reportFailureServer),
    (409, 'ACCOUNT_CHANGED', ProductHealthMeasure.reportFailureAuth),
    (409, 'PRIVATE_CODE', ProductHealthMeasure.reportFailureOther),
  ]) {
    test(
      'HTTP $http/$errorCode retains only its fixed delivery category',
      () async {
        status = http;
        code = errorCode;
        await expectLater(
          api.productUsageReport({'counters': {}}),
          throwsA(
            isA<ProductReportFailure>()
                .having((e) => e.measure, 'category', measure)
                .having((e) => e.permanent, 'retryable', false)
                .having(
                  (e) => e.toString(),
                  'safe error',
                  isNot(contains('PRIVATE')),
                ),
          ),
        );
      },
    );
  }
}
