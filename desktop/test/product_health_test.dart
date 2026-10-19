import 'dart:convert';
import 'dart:ui' show AppLifecycleState, FrameTiming;

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/measurement/product_measurement.dart';
import 'package:harness/measurement/product_connections.dart';
import 'package:harness/measurement/product_runtime_health.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late ProductMeasurement usage;
  late List<Map<String, dynamic>> reports, setup;
  late DateTime now;
  late Map<String, dynamic> choice;
  setUp(() {
    now = DateTime.utc(2026, 10, 14, 12);
    reports = [];
    choice = {'enabled': true, 'revision': 0};
    setup = [];
    usage = ProductMeasurement(
      surface: 'desktop',
      automatic: false,
      context: ProductUsageContext(
        release: '1.2.73',
        platform: 'macos',
        production: true,
      ),
      now: () => now,
      sendSetup: (report) async {
        setup.add(report);
        return {'accepted': true};
      },
    );
    usage.account(
      'PRIVATE_ACCOUNT',
      choice: () async => choice,
      send: (report) async {
        reports.add(jsonDecode(jsonEncode(report)));
        return {'accepted': true};
      },
    );
  });
  tearDown(() => usage.dispose());
  test('development builds do not send anonymous setup counts', () async {
    usage.account(null);
    usage.context = ProductUsageContext(
      release: 'unknown',
      platform: 'macos',
      production: false,
    );
    await usage.setSignedOutSharing(true);
    usage.begin(ProductFlow.setup)(ProductOutcome.ok);
    usage.milestone(ProductHealthMeasure.funnelSetupSeen);
    await usage.flush();
    expect(setup, isEmpty);
  });
  Map<String, int> totals() {
    final all = <String, int>{};
    for (final report in [...reports, ...setup]) {
      for (final e in (report['counters'] as Map).entries)
        all[e.key as String] = (all[e.key] ?? 0) + (e.value as int);
    }
    return all;
  }

  test('connection observations restart cleanly after off/on with the same machine', () async {
    await usage.flush();
    final connections = ProductConnections(usage);
    connections.status('PRIVATE_MACHINE', connecting: true, connected: false);
    usage.savedChoice({'enabled': false, 'revision': 1});
    choice = {'enabled': true, 'revision': 2};
    usage.savedChoice(choice);
    connections.status('PRIVATE_MACHINE', connecting: true, connected: false);
    connections.status('PRIVATE_MACHINE', connecting: false, connected: true);
    await usage.flush();
    expect(totals()['ui_desktop_connect_auto_started'], 1);
    expect(totals()['ui_desktop_connect_auto_ok'], 1);
    connections.dispose();
  });

  test(
    'setup funnel is once per local episode, with coarse waits and no identity',
    () async {
      usage.milestone(ProductHealthMeasure.funnelFirstWork);
      expect(totals(), isEmpty);
      usage.account(null);
      await usage.setSignedOutSharing(true);
      usage.milestone(ProductHealthMeasure.funnelSetupSeen);
      now = now.add(const Duration(minutes: 2));
      usage.milestone(ProductHealthMeasure.funnelFirstWork);
      usage.milestone(ProductHealthMeasure.funnelFirstWork);
      now = now.add(const Duration(minutes: 4));
      usage.milestone(ProductHealthMeasure.funnelFirstResponse);
      await usage.flush();
      expect(totals()['setup_desktop_funnel_first_work'], 1);
      expect(totals()['setup_desktop_first_work_1m_to_5m'], 1);
      expect(totals()['setup_desktop_first_response_over_5m'], 1);
      expect(jsonEncode(setup), isNot(contains('PRIVATE')));
    },
  );

  test(
    'signed-in milestones remain in account-controlled health totals',
    () async {
      await usage.flush();
      usage.milestone(ProductHealthMeasure.funnelWorkspaceReady);
      usage.milestone(ProductHealthMeasure.funnelFirstWork);
      await usage.flush();
      expect(setup, isEmpty);
      expect(totals()['health_desktop_funnel_first_work'], 1);
    },
  );

  test('manual connect and automatic retries remain separate; missing outcomes expire as unknown', () async {
    await usage.flush();
    final connections = ProductConnections(usage);
    connections.status('PRIVATE_MACHINE', connecting: true, connected: false);
    connections.status(
      'PRIVATE_MACHINE',
      connecting: false,
      connected: false,
      failure: ProductHealthMeasure.connectErrorUnlinked,
    );
    final manual = connections.manual('PRIVATE_MACHINE');
    connections.status('PRIVATE_MACHINE', connecting: true, connected: false);
    connections.status('PRIVATE_MACHINE', connecting: false, connected: true);
    manual(ProductOutcome.ok);
    manual(ProductOutcome.failed);
    usage.begin(ProductFlow.resumeRecovery);
    now = now.add(const Duration(minutes: 16));
    await usage.flush();
    await usage.flush();
    expect(totals()['ui_desktop_connect_auto_failed'], 1);
    expect(totals()['ui_desktop_connect_user_ok'], 1);
    expect(totals()['ui_desktop_connect_auto_started'], 1);
    expect(totals()['ui_desktop_resume_recovery_unknown'], 1);
    expect(jsonEncode(reports), isNot(contains('PRIVATE')));
    expect(reports.first['context'], usage.context!.toJson());
  });

  test('known unlinked probes preserve the first outcome without counting each retry', () async {
    await usage.flush();
    final connections = ProductConnections(usage);
    addTearDown(connections.dispose);
    connections.status('PRIVATE_MACHINE', connecting: true, connected: false);
    connections.refused(
      'PRIVATE_MACHINE',
      ProductHealthMeasure.connectErrorUnlinked,
    );
    connections.status(
      'PRIVATE_MACHINE',
      connecting: true,
      connected: false,
      suppressStart: true,
    );
    connections.status('PRIVATE_MACHINE', connecting: false, connected: false);
    for (var retry = 0; retry < 10; retry++) {
      connections.status(
        'PRIVATE_MACHINE',
        connecting: true,
        connected: false,
        suppressStart: true,
      );
      connections.refused(
        'PRIVATE_MACHINE',
        ProductHealthMeasure.connectErrorUnlinked,
      );
      connections.status(
        'PRIVATE_MACHINE',
        connecting: false,
        connected: false,
        failure: ProductHealthMeasure.connectErrorUnlinked,
      );
    }
    final manual = connections.manual('PRIVATE_MACHINE');
    connections.status(
      'PRIVATE_MACHINE',
      connecting: true,
      connected: false,
      suppressStart: true,
    );
    connections.status('PRIVATE_MACHINE', connecting: false, connected: true);
    manual(ProductOutcome.ok);
    // A later ordinary connection remains measurable.
    connections.status('PRIVATE_MACHINE', connecting: true, connected: false);
    connections.status('PRIVATE_MACHINE', connecting: false, connected: true);
    await usage.flush();
    expect(totals()['ui_desktop_connect_auto_started'], 2);
    expect(totals()['ui_desktop_connect_auto_failed'], 1);
    expect(totals()['health_desktop_connect_error_unlinked'], 1);
    expect(totals()['ui_desktop_connect_auto_ok'], 1);
    expect(totals()['ui_desktop_connect_user_ok'], 1);
    expect(jsonEncode(reports), isNot(contains('PRIVATE')));
  });

  test('opt-out and account changes fence delayed callbacks, counters, and retries', () async {
    await usage.flush();
    final old = usage.begin(ProductFlow.viewerLoad);
    final feedback = usage.observer(
      ProductHealthMeasure.feedbackOutcomeAnswered,
    );
    usage.savedChoice({'enabled': false, 'revision': 1});
    usage.savedChoice({'enabled': true, 'revision': 2});
    old(ProductOutcome.ok);
    feedback();
    await usage.flush();
    expect(totals()['ui_desktop_viewer_load_ok'], isNull);
    expect(totals()['health_desktop_feedback_outcome_answered'], isNull);
    usage.health(ProductHealthMeasure.frameworkError);
    usage.account('DIFFERENT_PRIVATE_ACCOUNT');
    await usage.flush();
    expect(totals()['health_desktop_framework_error'], isNull);
  });

  testWidgets(
    'runtime stores only last-run control flags and removes them after opt-out',
    (tester) async {
      Map<String, dynamic> saved = {};
      final runtime = ProductRuntimeHealth(
        usage,
        readState: () async => Map.of(saved),
        writeState: (value) async {
          saved = Map.of(value);
        },
        readVersion: () async => '1.2.73',
      );
      runtime.account('PRIVATE_ACCOUNT');
      runtime.ready();
      ProductRuntimeHealth.launched();
      await usage.flush();
      await tester.pump();
      expect(saved.keys.toSet(), {'scope', 'revision', 'release', 'clean'});
      expect(saved['clean'], false);
      expect(jsonEncode(saved), isNot(contains('PRIVATE')));
      runtime.expectUpdate('1.2.74');
      await tester.pump();
      expect(saved['pendingUpdate'], '1.2.74');
      usage.savedChoice({'enabled': false, 'revision': 1});
      await tester.pump();
      expect(saved, isEmpty);
      runtime.dispose();
      await tester.pump();
      expect(saved, isEmpty);
    },
  );

  testWidgets(
    'frames sample every 60th visible frame, never the first or a hidden one',
    (tester) async {
      var lifecycle = AppLifecycleState.resumed;
      final runtime = ProductRuntimeHealth(
        usage,
        readState: () async => {},
        writeState: (_) async {},
        readVersion: () async => '1.2.73',
        lifecycle: () => lifecycle,
      );
      runtime.account('PRIVATE_ACCOUNT');
      await usage.flush();
      await tester.pump();
      FrameTiming frame(int ms) => FrameTiming(
        vsyncStart: 0,
        buildStart: 0,
        buildFinish: 0,
        rasterStart: 0,
        rasterFinish: ms * 1000,
        rasterFinishWallTime: ms * 1000,
      );
      // A launch's first frame is its heavy workspace restore: not a sample
      // (frames 1–59 are not sampled; the 60th is).
      runtime.framesForTest([frame(900), for (var i = 1; i < 59; i++) frame(5)]);
      // Minimised, then shown: the first frame back is the catch-up, and would
      // otherwise be the 60th, the sampled one.
      runtime.lifecycleChanged(AppLifecycleState.hidden);
      runtime.lifecycleChanged(AppLifecycleState.inactive);
      runtime.framesForTest([frame(700), frame(5)]);
      // A batch reported while hidden is the OS's throttling: none of it counts.
      lifecycle = AppLifecycleState.hidden;
      runtime.framesForTest([for (var i = 0; i < 120; i++) frame(400)]);
      // Visible but without focus (inactive) still counts: a person sees it.
      lifecycle = AppLifecycleState.inactive;
      runtime.framesForTest([frame(700), for (var i = 0; i < 60; i++) frame(5)]);
      await usage.flush();
      expect(totals()['health_desktop_frame_under_16ms'], 2);
      expect(totals()['health_desktop_frame_over_250ms'], isNull);
      runtime.dispose();
      await tester.pump();
    },
  );

  testWidgets(
    'a slow sample counts its longest phase, and a long one once a day, '
    'only once the CLI forwards the names',
    (tester) async {
      final runtime = ProductRuntimeHealth(
        usage,
        readState: () async => {},
        writeState: (_) async {},
        readVersion: () async => '1.2.73',
        lifecycle: () => AppLifecycleState.resumed,
      );
      runtime.account('PRIVATE_ACCOUNT');
      await usage.flush();
      await tester.pump();
      // Milliseconds from vsync: waiting for the UI thread, building, the
      // raster thread's queue, rastering.
      FrameTiming frame({
        int wait = 0,
        int build = 0,
        int queue = 0,
        int raster = 0,
      }) {
        final buildStart = wait * 1000;
        final buildFinish = buildStart + build * 1000;
        final rasterStart = buildFinish + queue * 1000;
        final rasterFinish = rasterStart + raster * 1000;
        return FrameTiming(
          vsyncStart: 0,
          buildStart: buildStart,
          buildFinish: buildFinish,
          rasterStart: rasterStart,
          rasterFinish: rasterFinish,
          rasterFinishWallTime: rasterFinish,
        );
      }

      // The 60th frame is the sample.
      void sample(FrameTiming timing) => runtime.framesForTest([
        for (var i = 0; i < 59; i++) frame(build: 1),
        timing,
      ]);
      Iterable<String> newNames() => totals().keys.where(
        (key) => key.contains('_slow_') || key.contains('_long_'),
      );
      // A CLI that has not said it forwards them would refuse the report.
      sample(frame(wait: 300));
      await usage.flush();
      expect(totals()['health_desktop_frame_over_250ms'], 1);
      expect(newNames(), isEmpty);
      usage.proxyVocabulary = 2;
      for (final timing in [
        frame(wait: 40, build: 10, raster: 5),
        frame(wait: 20, build: 20, raster: 20), // a tie: the earlier phase
        frame(wait: 5, build: 60, raster: 20),
        frame(wait: 10, build: 300), // the day's first long sample
        frame(wait: 5, build: 10, queue: 30, raster: 20),
        frame(raster: 400), // long again: the day is counted already
        frame(wait: 10, build: 30), // 40 ms is not slow
      ]) {
        sample(timing);
      }
      await usage.flush();
      expect(totals()['health_desktop_frame_slow_wait'], 2);
      expect(totals()['health_desktop_frame_slow_build'], 2);
      expect(totals()['health_desktop_frame_slow_raster'], 2);
      expect(totals()['health_desktop_frame_long_collector'], 1);
      // Every slow sample since has one phase.
      expect(
        totals()['health_desktop_frame_50ms_to_250ms']! +
            totals()['health_desktop_frame_over_250ms']! -
            1,
        6,
      );
      // The next UTC day's first long sample counts again, once.
      now = now.add(const Duration(days: 1));
      sample(frame(wait: 260));
      sample(frame(wait: 260));
      // One report a flush: yesterday's expired workspace observation first.
      await usage.flush();
      await usage.flush();
      expect(totals()['health_desktop_frame_long_collector'], 2);
      expect(totals()['health_desktop_collector_days'], 2);
      expect(jsonEncode(reports), isNot(contains('PRIVATE')));
      runtime.dispose();
      await tester.pump();
    },
  );

  testWidgets(
    'relaunch confirms only the expected public version and sharing revision',
    (tester) async {
      Map<String, dynamic> saved = {};
      ProductRuntimeHealth create(String version) => ProductRuntimeHealth(
        usage,
        readState: () async => Map.of(saved),
        writeState: (value) async {
          saved = Map.of(value);
        },
        readVersion: () async => version,
      );
      var runtime = create('1.2.73');
      runtime.account('PRIVATE_ACCOUNT');
      await usage.flush();
      await tester.pump();
      runtime.expectUpdate('1.2.74');
      await tester.pump();
      runtime.dispose();
      await tester.pump();
      runtime = create('1.2.74');
      runtime.account('PRIVATE_ACCOUNT');
      await tester.pump();
      await usage.flush();
      await usage.flush();
      expect(totals()['ui_desktop_update_relaunch_ok'], 1);
      expect(totals()['health_desktop_install_upgrade'], 1);
      expect(jsonEncode(reports), isNot(contains('scope')));
      runtime.dispose();
      await tester.pump();
    },
  );
}
