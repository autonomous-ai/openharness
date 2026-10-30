import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';

import 'package:harness_mobile/measurement/product_connections.dart';
import 'package:harness_mobile/measurement/product_measurement.dart';

void main() {
  late ProductMeasurement usage;
  late ProductConnections connections;
  late List<Map<String, dynamic>> reports;
  late Map<String, dynamic> choice;

  setUp(() {
    reports = [];
    choice = {'enabled': true, 'revision': 0};
    usage = ProductMeasurement(
      surface: 'phone',
      automatic: false,
      now: () => DateTime.utc(2026, 10, 16, 12),
      sendSetup: (_) async => {'accepted': true},
    );
    connections = ProductConnections(
      usage,
      manualDeadline: const Duration(milliseconds: 1),
    );
  });
  tearDown(() {
    connections.dispose();
    usage.dispose();
  });

  Future<void> signIn() async {
    usage.account(
      'PRIVATE_ACCOUNT',
      choice: () async => choice,
      send: (r) async {
        reports.add(jsonDecode(jsonEncode(r)));
        return {'accepted': true};
      },
    );
    await usage.flush();
  }

  /// The connect_* counters sent, summed across reports.
  Future<Map<String, int>> sent() async {
    await usage.flush();
    await usage.flush();
    final total = <String, int>{};
    for (final report in reports) {
      (report['counters'] as Map).forEach((metric, value) {
        if ('$metric'.contains('_connect_')) {
          total[metric as String] = (total[metric] ?? 0) + (value as int);
        }
      });
    }
    return total;
  }

  void dial(
    String key, {
    bool up = false,
    bool down = false,
    bool failed = false,
  }) => connections.status(
    key,
    connecting: !up && !down,
    connected: up,
    failed: failed,
  );

  test(
    'the app\'s own dial is one episode, however many re-dials it takes',
    () async {
      await signIn();
      dial('m');
      dial('m');
      dial('m');
      dial('m', up: true);
      expect(await sent(), {
        'ui_phone_connect_auto_started': 1,
        'ui_phone_connect_auto_ok': 1,
        'ui_phone_connect_auto_under_1s': 1,
      });
    },
  );

  test(
    'a dropped dial is failed when the phone knows why, unknown when not',
    () async {
      await signIn();
      dial('locked');
      dial('locked', down: true, failed: true);
      dial('lost');
      dial('lost', down: true);
      final counted = await sent();
      expect(counted['ui_phone_connect_auto_started'], 2);
      expect(counted['ui_phone_connect_auto_failed'], 1);
      expect(counted['ui_phone_connect_auto_unknown'], 1);
    },
  );

  test('Try again is the person\'s, and takes over a dial under way', () async {
    await signIn();
    dial('m');
    connections.manual('m');
    dial('m');
    dial('m', up: true);
    final counted = await sent();
    expect(counted['ui_phone_connect_auto_cancelled'], 1);
    expect(counted['ui_phone_connect_user_started'], 1);
    expect(counted['ui_phone_connect_user_ok'], 1);
    expect(counted, isNot(contains('ui_phone_connect_auto_ok')));
  });

  test('Try again on a computer already up is answered at once', () async {
    await signIn();
    connections.manual('m', connected: true);
    expect(await sent(), {
      'ui_phone_connect_user_started': 1,
      'ui_phone_connect_user_ok': 1,
      'ui_phone_connect_user_under_1s': 1,
    });
  });

  test('Try again that drops, or never answers, is failed', () async {
    await signIn();
    connections.manual('dropped');
    dial('dropped', down: true);
    connections.manual('silent');
    dial('silent');
    await Future<void>.delayed(const Duration(milliseconds: 20));
    // Settled by its deadline: the late answer is no second outcome.
    dial('silent', up: true);
    final counted = await sent();
    expect(counted['ui_phone_connect_user_started'], 2);
    expect(counted['ui_phone_connect_user_failed'], 2);
    expect(counted, isNot(contains('ui_phone_connect_user_ok')));
  });

  test('a second Try again ends the first as cancelled', () async {
    await signIn();
    connections.manual('m');
    connections.manual('m');
    dial('m', up: true);
    final counted = await sent();
    expect(counted['ui_phone_connect_user_started'], 2);
    expect(counted['ui_phone_connect_user_cancelled'], 1);
    expect(counted['ui_phone_connect_user_ok'], 1);
  });

  test(
    'nothing is counted unshared, and a choice change drops what was open',
    () async {
      dial('m');
      connections.manual('n');
      await signIn();
      dial('m', up: true);
      expect(await sent(), isEmpty);

      dial('m');
      choice = {'enabled': true, 'revision': 1};
      usage.savedChoice(choice);
      dial('m', up: true);
      expect(await sent(), isEmpty, reason: 'begun under the old choice');

      dial('m');
      dial('m', up: true);
      expect(await sent(), containsPair('ui_phone_connect_auto_ok', 1));
    },
  );

  group('the app going to the background', () {
    /// How many dials of [flow] started and ended each way, apart from the duration buckets.
    Future<Map<String, int>> outcomes(String flow) async {
      final all = await sent();
      return {
        for (final outcome in const [
          'started',
          'ok',
          'failed',
          'cancelled',
          'unknown',
        ])
          if (all.containsKey('ui_phone_${flow}_$outcome'))
            outcome: all['ui_phone_${flow}_$outcome']!,
      };
    }

    test(
      'ends the app\'s own dial and the person\'s as cancelled, once each',
      () async {
        await signIn();
        dial('own');
        connections.manual('asked');
        dial('asked');

        connections.cancelOpen();
        connections.cancelOpen();

        expect(await outcomes('connect_auto'), {'started': 1, 'cancelled': 1});
        expect(await outcomes('connect_user'), {'started': 1, 'cancelled': 1});
      },
    );

    test('leaves nothing for the socket\'s answer, or the asked-for deadline, to count', () async {
      await signIn();
      dial('own');
      connections.manual('asked');
      connections.cancelOpen();

      dial('own', up: true);
      dial('asked', down: true);
      dial('asked', up: true);
      // Past the 1 ms deadline the dial would otherwise have been failed at.
      await Future<void>.delayed(const Duration(milliseconds: 20));

      expect(await outcomes('connect_auto'), {'started': 1, 'cancelled': 1});
      expect(await outcomes('connect_user'), {'started': 1, 'cancelled': 1});
    });

    test('keeps the outcome of a dial that had finished', () async {
      await signIn();
      dial('up');
      dial('up', up: true);
      dial('locked');
      dial('locked', down: true, failed: true);
      connections.manual('answered', connected: true);

      connections.cancelOpen();

      expect(await outcomes('connect_auto'), {
        'started': 2,
        'ok': 1,
        'failed': 1,
      });
      expect(await outcomes('connect_user'), {'started': 1, 'ok': 1});
    });

    test('is followed by a new count when the app dials again', () async {
      await signIn();
      dial('m');
      connections.cancelOpen();

      dial('m');
      dial('m', up: true);

      expect(await outcomes('connect_auto'), {
        'started': 2,
        'cancelled': 1,
        'ok': 1,
      });
    });

    test('with nothing open counts nothing', () async {
      await signIn();
      connections.cancelOpen();
      expect(await outcomes('connect_auto'), isEmpty);
      expect(await outcomes('connect_user'), isEmpty);
    });
  });

  test('no connection key ever reaches a report', () async {
    await signIn();
    dial('PRIVATE_MACHINE');
    dial('PRIVATE_MACHINE', up: true);
    await sent();
    expect(jsonEncode(reports), isNot(contains('PRIVATE')));
  });
}
