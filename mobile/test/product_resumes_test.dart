import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';

import 'package:harness_mobile/measurement/product_measurement.dart';
import 'package:harness_mobile/measurement/product_resumes.dart';

void main() {
  late ProductMeasurement usage;
  late ProductResumes resumes;
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
    resumes = ProductResumes(usage);
  });
  tearDown(() {
    resumes.dispose();
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

  Future<Map<String, int>> sent() async {
    await usage.flush();
    await usage.flush();
    final total = <String, int>{};
    for (final report in reports) {
      (report['counters'] as Map).forEach((metric, value) {
        total[metric as String] = (total[metric] ?? 0) + (value as int);
      });
    }
    return total;
  }

  test('a resume is recovered by the first turn it starts', () async {
    await signIn();
    resumes.sent('m/a');
    resumes.worked('m/b');
    resumes.worked('m/a');
    resumes.worked('m/a');
    expect(await sent(), {
      'ui_phone_resume_recovery_started': 1,
      'ui_phone_resume_recovery_ok': 1,
      'ui_phone_resume_recovery_under_1s': 1,
    });
  });

  test(
    'a refused resume is failed; sending again gives up the first',
    () async {
      await signIn();
      resumes.sent('m/a');
      resumes.refused('m/a');
      resumes.sent('m/b');
      resumes.sent('m/b');
      resumes.worked('m/b');
      final counted = await sent();
      expect(counted['ui_phone_resume_recovery_started'], 3);
      expect(counted['ui_phone_resume_recovery_failed'], 1);
      expect(counted['ui_phone_resume_recovery_cancelled'], 1);
      expect(counted['ui_phone_resume_recovery_ok'], 1);
    },
  );

  test('the oldest of too many open resumes gives way as unknown', () async {
    await signIn();
    for (var i = 0; i < 65; i++) {
      resumes.sent('m/$i');
    }
    final counted = await sent();
    expect(counted['ui_phone_resume_recovery_unknown'], 1);
    resumes.worked('m/0');
    expect(
      (await sent())['ui_phone_resume_recovery_ok'],
      isNull,
      reason: 'the one that gave way is not open any more',
    );
  });

  test('nothing is counted unshared, nor across a sign-out', () async {
    resumes.sent('m/a');
    await signIn();
    resumes.worked('m/a');
    expect(await sent(), isEmpty);

    resumes.sent('m/a');
    usage.account(null);
    resumes.worked('m/a');
    expect(reports, isEmpty);
  });
}
