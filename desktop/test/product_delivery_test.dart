import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:dio/dio.dart' show Headers;
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
  String? code, vocabulary, retryAfter;
  Completer<void>? hold;
  late DateTime clock;
  var random = 0.5;
  setUp(() async {
    clock = DateTime.utc(2026, 10, 28, 6);
    random = 0.5;
    retryAfter = null;
    attempts = [];
    accepted = [];
    status = 200;
    code = null;
    vocabulary = null;
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
      final responseVocabulary = vocabulary, responseRetryAfter = retryAfter;
      await hold?.future;
      if (responseRetryAfter != null) {
        request.response.headers.set('retry-after', responseRetryAfter);
      }
      if (responseStatus == 200) accepted.add(report);
      if (responseVocabulary != null) {
        request.response.headers.set(
          ApiClient.usageVocabularyHeader,
          responseVocabulary,
        );
      }
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
      now: () => clock,
      random: () => random,
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
    clock = clock.add(const Duration(minutes: 30));
    await usage.flush();
    expect(jsonEncode(attempts.last), first);
    await usage.flush();
    expect(totals()['ui_desktop_viewer_load_ok'], 1);
    expect(totals()['ui_desktop_connect_user_ok'], 1);
    expect(totals()['health_desktop_report_failure_write_conflict'], 1);
    expect(jsonEncode(accepted), isNot(contains('PRIVATE_')));
  });

  test('a busy answer holds the next report until its Retry-After', () async {
    (status, code, retryAfter) = (429, 'USAGE_BUSY', '90');
    usage.begin(ProductFlow.viewerLoad)(ProductOutcome.ok);
    await usage.flush();
    final first = attempts.single['id'];
    (status, code, retryAfter) = (200, null, null);
    // Without Retry-After this draw would wait 60 s; the answer asked for 90.
    clock = clock.add(const Duration(seconds: 89));
    await usage.flush();
    expect(attempts, hasLength(1));
    clock = clock.add(const Duration(seconds: 1));
    await usage.flush();
    expect(attempts, hasLength(2));
    expect(attempts.last['id'], first);
    expect(totals()['ui_desktop_viewer_load_ok'], 1);
  });

  test(
    'refusals in a row wait under a doubling ceiling up to half an hour',
    () async {
      (status, code) = (503, 'USAGE_UNAVAILABLE');
      random = 0.75;
      usage.begin(ProductFlow.viewerLoad)(ProductOutcome.ok);
      // 0.75 of 2, 4, 8 and 16 minutes, then of the 30-minute ceiling.
      for (final wait in const [90, 180, 360, 720, 1350, 1350]) {
        final before = attempts.length;
        await usage.flush();
        expect(attempts, hasLength(before + 1));
        clock = clock.add(Duration(seconds: wait - 1));
        await usage.flush();
        expect(attempts, hasLength(before + 1), reason: 'held for $wait s');
        clock = clock.add(const Duration(seconds: 1));
      }
      // An answer ends the run: the next refusal waits from the start again.
      (status, code) = (200, null);
      await usage.flush();
      expect(totals()['ui_desktop_viewer_load_ok'], 1);
      (status, code) = (503, 'USAGE_UNAVAILABLE');
      usage.begin(ProductFlow.connectUser)(ProductOutcome.ok);
      await usage.flush();
      final refused = attempts.length;
      clock = clock.add(const Duration(seconds: 90));
      await usage.flush();
      expect(attempts, hasLength(refused + 1));
    },
  );

  test('an unreachable CLI is a refusal to wait out as well', () async {
    await server.close(force: true);
    await expectLater(
      api.productUsageReport({'counters': {}}),
      throwsA(
        isA<ProductReportFailure>()
            .having(
              (e) => e.measure,
              'category',
              ProductHealthMeasure.reportFailureUnreachable,
            )
            .having((e) => e.backOff, 'waits', true),
      ),
    );
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

  test(
    'frame-phase names are counted only after the CLI says it forwards them',
    () async {
      // An older CLI refused a whole report for one name it did not know,
      // and this app drops a refused packet for good.
      usage.account(
        'PRIVATE_ACCOUNT_CANARY_WIRED',
        choice: () async => {'enabled': true, 'revision': 0},
        send: (report) => api.productUsageReport(
          report,
          onVocabulary: (value) => usage.proxyVocabulary = value,
        ),
      );
      await usage.flush();
      void slowFrame() {
        usage.health(ProductHealthMeasure.frame50msTo250ms);
        usage.health(ProductHealthMeasure.frameSlowWait);
      }

      slowFrame();
      await usage.flush(); // an older CLI: no header
      expect(usage.proxyVocabulary, 1);
      slowFrame();
      vocabulary = '2';
      await usage.flush();
      expect(usage.proxyVocabulary, 2);
      slowFrame();
      await usage.flush();
      expect(totals()['health_desktop_frame_50ms_to_250ms'], 3);
      expect(totals()['health_desktop_frame_slow_wait'], 1);
      expect(
        attempts.take(2).map((r) => r['counters'] as Map),
        everyElement(isNot(contains('health_desktop_frame_slow_wait'))),
      );
      // Replaced by an older CLI: after an answer that says nothing, the
      // names stop until one says so again, which a refusal does too.
      vocabulary = null;
      usage.health(ProductHealthMeasure.frame50msTo250ms);
      await usage.flush();
      expect(usage.proxyVocabulary, 1);
      slowFrame();
      (status, vocabulary) = (400, '2');
      await usage.flush();
      expect(usage.proxyVocabulary, 2);
      expect(totals()['health_desktop_frame_slow_wait'], 1);
    },
  );

  test('the vocabulary header reads as 1 unless it names a later one', () {
    int read(List<String>? value) => ApiClient.usageVocabulary(
      Headers.fromMap({'x-harness-usage-vocabulary': ?value}),
    );
    expect(read(null), 1);
    expect(read(['2']), 2);
    expect(read(['3']), 3);
    for (final junk in ['0', '-2', '', 'PRIVATE', '2.5']) {
      expect(read([junk]), 1, reason: junk);
    }
  });

  for (final (http, errorCode, measure) in [
    (401, 'PRIVATE_CODE', ProductHealthMeasure.reportFailureAuth),
    (403, null, ProductHealthMeasure.reportFailureAuth),
    (429, 'USAGE_BUSY', ProductHealthMeasure.reportFailureRateLimited),
    // A busy backend answers these 429 since 2026-10-28: the cause is kept.
    (
      429,
      'USAGE_WRITE_CONFLICT',
      ProductHealthMeasure.reportFailureWriteConflict,
    ),
    (
      429,
      'USAGE_TRANSACTION_FAILED',
      ProductHealthMeasure.reportFailureTransaction,
    ),
    (503, 'AUTH_SERVICE_UNAVAILABLE', ProductHealthMeasure.reportFailureAuth),
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
                .having((e) => e.backOff, 'waits', http == 429 || http >= 500)
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
