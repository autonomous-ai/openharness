import 'dart:async';
import 'dart:convert';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/measurement/hub_usage.dart';

void main() {
  late List<({Map<String, dynamic> report, String? authorization})> sent;
  late bool enabled;
  var now = DateTime.utc(2026, 10, 20, 9);

  HubUsage usage() => HubUsage(
    enabled: () => enabled,
    post: (body, authorization) => sent.add((
      report: jsonDecode(body) as Map<String, dynamic>,
      authorization: authorization,
    )),
    now: () => now,
    receipt: () => '0f8fad5b-d9cb-469f-a165-70867728950e',
  );

  setUp(() {
    sent = [];
    enabled = true;
    now = DateTime.utc(2026, 10, 20, 9);
  });

  test('adds up a day and sends it once, as the backend reads a report', () {
    fakeAsync((async) {
      final hub = usage();
      hub
        ..count(sharedViewMetric(member: false))
        ..count(SharedOpen.offline.metric)
        ..count(SharedOpen.offline.metric)
        ..flush()
        ..flush();
      expect(sent.single.report, {
        'schemaVersion': 1,
        'id': '0f8fad5b-d9cb-469f-a165-70867728950e',
        'day': '2026-10-20',
        'counters': {
          'hub_view_shared_visitor': 1,
          'hub_shared_open_offline': 2,
        },
      });
      expect(sent.single.authorization, isNull);
    });
  });

  test('sends on its own a minute after the first count', () {
    fakeAsync((async) {
      usage().count(SharedAction.getApp.metric);
      async.elapse(const Duration(seconds: 59));
      expect(sent, isEmpty);
      async.elapse(const Duration(seconds: 1));
      expect(sent.single.report['counters'], {'hub_shared_get_app': 1});
    });
  });

  test('a new UTC day sends the last one first', () {
    fakeAsync((async) {
      final hub = usage()..count(SharedAction.retry.metric);
      now = DateTime.utc(2026, 10, 21, 0, 1);
      hub
        ..count(SharedAction.retry.metric)
        ..flush();
      expect(sent.map((s) => s.report['day']), ['2026-10-20', '2026-10-21']);
    });
  });

  test(
    'a member\'s sign-in rides along, and nothing leaves before it is read',
    () {
      fakeAsync((async) {
        final token = Completer<String?>();
        final hub = usage()..accessToken = (() => token.future);
        hub
          ..count(sharedViewMetric(member: true))
          ..flush();
        // Unread, a member could be one who turned sharing off: dropped, not sent as a visitor.
        expect(sent, isEmpty);
        token.complete('member');
        async.flushMicrotasks();
        hub
          ..count(sharedViewMetric(member: true))
          ..flush();
        expect(sent.single.authorization, 'Bearer member');
        hub.accessToken = null;
        async.flushMicrotasks();
        hub
          ..count(sharedViewMetric(member: false))
          ..flush();
        expect(sent.last.authorization, isNull);
      });
    },
  );

  test('counts nothing when switched off, and caps a counter', () {
    fakeAsync((async) {
      enabled = false;
      usage()
        ..count(SharedAction.commentPost.metric)
        ..flush();
      expect(sent, isEmpty);
      enabled = true;
      final hub = usage();
      for (var i = 0; i < hubReportMaxValue + 5; i++) {
        hub.count(SharedAction.viewerShown.metric);
      }
      hub.flush();
      expect(sent.single.report['counters'], {
        'hub_shared_viewer_shown': hubReportMaxValue,
      });
    });
  });

  test('time in view is bucketed as the backend\'s and reported once', () {
    expect(
      sharedDwellMetric(const Duration(milliseconds: 9999)),
      'hub_shared_dwell_under_10s',
    );
    expect(
      sharedDwellMetric(const Duration(seconds: 10)),
      'hub_shared_dwell_10s_to_1m',
    );
    expect(
      sharedDwellMetric(const Duration(minutes: 1)),
      'hub_shared_dwell_over_1m',
    );
    final shown = <Duration>[];
    VisibleTime(shown.add)
      ..finish()
      ..finish();
    expect(shown, hasLength(1));
  });
}
