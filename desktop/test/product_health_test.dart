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

  test(
    'a first arrival waits for initial consent without observing earlier work',
    () async {
      usage.firstRunStarted();
      usage.firstRunReady('m', 'a');
      usage.firstRunWork('m', 'a');
      usage.firstRunResponse('m', 'a');
      await usage.flush();
      usage.proxyVocabulary = 5;
      await usage.flush();
      expect(totals()['health_desktop_first_run_started'], 1);
      expect(totals()['health_desktop_first_run_ready'], 1);
      expect(totals()['health_desktop_first_run_response'], isNull);
      usage.firstRunWork('m', 'a');
      usage.firstRunResponse('m', 'a');
      await usage.flush();
      expect(totals()['health_desktop_first_run_response'], 1);
    },
  );

  test(
    'an initial opt-out discards pending first-arrival eligibility',
    () async {
      usage.firstRunStarted();
      usage.firstRunReady('m', 'a');
      choice = {'enabled': false, 'revision': 0};
      await usage.flush();
      choice = {'enabled': true, 'revision': 1};
      await usage.flush();
      usage.proxyVocabulary = 5;
      usage.firstRunWork('m', 'a');
      usage.firstRunResponse('m', 'a');
      await usage.flush();
      expect(
        totals().keys.where((name) => name.contains('first_run')),
        isEmpty,
      );
    },
  );

  test('first-run response follows only the opened harness and never counts retries twice', () async {
    await usage.flush();
    usage.proxyVocabulary = 5;
    usage.firstRunStarted();
    usage.firstRunStarted();
    usage.firstRunReady('PRIVATE_MACHINE', 'PRIVATE_AGENT');
    usage.firstRunWork('OTHER_MACHINE', 'PRIVATE_AGENT');
    usage.firstRunResponse('PRIVATE_MACHINE', 'PRIVATE_AGENT');
    await usage.flush();
    expect(totals()['health_desktop_first_run_response'], isNull);
    usage.firstRunWork('PRIVATE_MACHINE', 'PRIVATE_AGENT');
    now = now.add(const Duration(seconds: 45));
    usage.firstRunResponse('PRIVATE_MACHINE', 'PRIVATE_AGENT');
    usage.firstRunResponse('PRIVATE_MACHINE', 'PRIVATE_AGENT');
    await usage.flush();
    expect(totals()['health_desktop_first_run_started'], 1);
    expect(totals()['health_desktop_first_run_ready'], 1);
    expect(totals()['health_desktop_first_run_work'], 1);
    expect(totals()['health_desktop_first_run_response'], 1);
    expect(totals()['health_desktop_first_run_response_under_1m'], 1);
    expect(jsonEncode(reports), isNot(contains('PRIVATE')));
  });

  test('first-run counters wait for vocabulary 5 while version 4 still sends phone offers', () async {
    await usage.flush();
    usage.proxyVocabulary = 4;
    usage.begin(ProductFlow.phoneOfferAfterWork)(ProductOutcome.ok);
    usage.firstRunStarted();
    usage.firstRunReady('m', 'a');
    usage.firstRunWork('m', 'a');
    usage.firstRunResponse('m', 'a');
    await usage.flush();
    expect(totals().keys.where((name) => name.contains('first_run')), isEmpty);
    expect(totals()['ui_desktop_phone_offer_after_work_ok'], 1);
    usage.proxyVocabulary = 5;
    await usage.flush();
    expect(totals()['health_desktop_first_run_started'], 1);
    expect(totals()['health_desktop_first_run_response'], 1);
  });

  test('invite counters wait for vocabulary 5', () async {
    await usage.flush();
    usage.proxyVocabulary = 4;
    usage.begin(ProductFlow.shareInvite)(ProductOutcome.ok);
    usage.begin(ProductFlow.shareAccept)(ProductOutcome.ok);
    usage.sharedInvites(sent: 2, refused: 1);
    await usage.flush();
    expect(totals().keys.where((name) => name.contains('share')), isEmpty);
    usage.proxyVocabulary = 5;
    await usage.flush();
    expect(totals()['ui_desktop_share_invite_ok'], 1);
    expect(totals()['ui_desktop_share_accept_ok'], 1);
    expect(totals()['health_desktop_shared_invites_sent'], 2);
    expect(totals()['health_desktop_shared_invites_refused'], 1);
  });

  test('first-run stages cross midnight on their start day and stop after 24 hours', () async {
    await usage.flush();
    usage.proxyVocabulary = 5;
    now = DateTime.utc(2026, 10, 14, 23, 59);
    usage.firstRunStarted();
    usage.firstRunReady('m', 'a');
    now = now.add(const Duration(minutes: 2));
    usage.firstRunWork('m', 'a');
    usage.firstRunResponse('m', 'a');
    await usage.flush();
    expect(
      reports
          .where(
            (r) => (r['counters'] as Map).containsKey(
              'health_desktop_first_run_response',
            ),
          )
          .single['day'],
      '2026-10-14',
    );
    expect(totals()['health_desktop_first_run_response_1m_to_5m'], 1);
    now = now.add(const Duration(days: 2));
    usage.firstRunReady('m', 'another');
    usage.firstRunWork('m', 'another');
    await usage.flush();
    expect(totals()['health_desktop_first_run_work'], 1);
  });

  test('opt-out and account changes discard the first-run target and queued counts', () async {
    await usage.flush();
    usage.firstRunStarted();
    usage.firstRunReady('PRIVATE_MACHINE', 'PRIVATE_AGENT');
    usage.savedChoice({'enabled': false, 'revision': 1});
    choice = {'enabled': true, 'revision': 2};
    usage.savedChoice(choice);
    usage.proxyVocabulary = 5;
    usage.firstRunWork('PRIVATE_MACHINE', 'PRIVATE_AGENT');
    usage.firstRunResponse('PRIVATE_MACHINE', 'PRIVATE_AGENT');
    await usage.flush();
    expect(totals().keys.where((name) => name.contains('first_run')), isEmpty);
  });

  test('normal readiness probes do not say setup was shown', () async {
    await usage.flush();
    usage.setupFacts({
      ProductFlow.setup: 'ready',
      ProductFlow.setupHarness: 'ready',
    });
    await usage.flush();
    expect(totals()['health_desktop_funnel_setup_seen'], isNull);
    usage.setupShown();
    usage.setupShown();
    await usage.flush();
    expect(totals()['health_desktop_funnel_setup_seen'], 1);
  });

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
      runtime.framesForTest([
        frame(900),
        for (var i = 1; i < 59; i++) frame(5),
      ]);
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
      runtime.framesForTest([
        frame(700),
        for (var i = 0; i < 60; i++) frame(5),
      ]);
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

  group('Add Phone', () {
    test(
      'returning flow, every skip and pairing way wait for vocabulary 6',
      () async {
        await usage.flush();
        usage.proxyVocabulary = 5;
        final flow = ProductFlow.values.singleWhere(
          (f) => f.wire == 'phone_offer_returning',
        );
        expect(flow.vocabulary, 6);
        expect(flow.unbounded, isTrue);
        for (final outcome in [
          ProductOutcome.ok,
          ProductOutcome.cancelled,
          ProductOutcome.unknown,
        ]) {
          usage.begin(flow)(outcome);
        }
        for (final reason in [
          'has_phone',
          'no_device_list',
          'already_shown',
          'stopped',
          'cap_reached',
          'not_signed_in',
          'viewer',
          'card_showing',
          'no_storage',
          'account_changed',
          'read_limit',
        ]) {
          usage.phoneOfferSkipped(reason);
        }
        usage.phoneOfferSkipped('PRIVATE_CANARY');
        for (final from in AddPhoneOpening.values) {
          usage.addPhonePaired(from);
        }
        final pending = usage.begin(flow);
        now = now.add(const Duration(minutes: 40));
        await usage.flush();
        expect(
          totals().keys.where(
            (n) =>
                n.contains('returning') ||
                n.contains('skipped') ||
                n.contains('paired'),
          ),
          isEmpty,
        );
        usage.proxyVocabulary = 6;
        pending(ProductOutcome.ok);
        await usage.flush();
        await usage.flush();
        expect(totals()['ui_desktop_phone_offer_returning_started'], 4);
        expect(totals()['ui_desktop_phone_offer_returning_ok'], 2);
        expect(totals()['ui_desktop_phone_offer_returning_cancelled'], 1);
        expect(totals()['ui_desktop_phone_offer_returning_unknown'], 1);
        for (final reason in [
          'has_phone',
          'no_device_list',
          'already_shown',
          'stopped',
          'cap_reached',
          'not_signed_in',
          'viewer',
          'card_showing',
          'no_storage',
          'account_changed',
          'read_limit',
        ]) {
          expect(totals()['ui_desktop_phone_offer_skipped_$reason'], 1);
        }
        for (final from in AddPhoneOpening.values) {
          expect(totals()['ui_desktop_add_phone_paired_${from.wire}'], 1);
        }
        expect(reports.toString(), isNot(contains('PRIVATE_CANARY')));
      },
    );

    test('new phone counters respect sharing and disposal', () async {
      await usage.flush();
      usage.proxyVocabulary = 6;
      usage.savedChoice({'enabled': false, 'revision': 1});
      usage.addPhonePaired(AddPhoneOpening.offer);
      usage.phoneOfferSkipped('has_phone');
      await usage.flush();
      expect(totals()['ui_desktop_add_phone_paired_offer'], isNull);
      expect(totals()['ui_desktop_phone_offer_skipped_has_phone'], isNull);
      usage.account(null);
      usage.addPhonePaired(AddPhoneOpening.menu);
      usage.phoneOfferSkipped('has_phone');
    });

    Iterable<String> addPhoneNames() => totals().keys.where(
      (key) =>
          key.startsWith('ui_desktop_phone_offer_') ||
          key.startsWith('ui_desktop_add_phone_'),
    );

    test(
      'the card and its openings wait for a CLI that forwards them, then go',
      () async {
        await usage.flush();
        // Counted from the start: the card shows once per computer, often
        // before the CLI's first answer has said which names it forwards.
        usage.begin(ProductFlow.phoneOffer)(ProductOutcome.ok);
        usage.addPhoneOpened(AddPhoneOpening.offer);
        await usage.flush();
        // The day's coverage goes; the names wait.
        expect(totals()['health_desktop_collector_days'], 1);
        expect(addPhoneNames(), isEmpty);
        final sent = reports.length;
        await usage.flush();
        // Only waiting names are left, and a report of none is not sent.
        expect(reports, hasLength(sent));
        for (final vocabulary in [1, 2]) {
          usage.proxyVocabulary = vocabulary;
          usage.health(ProductHealthMeasure.asyncError);
          await usage.flush();
          expect(totals()['health_desktop_async_error'], vocabulary);
          expect(addPhoneNames(), isEmpty, reason: 'vocabulary $vocabulary');
        }
        usage.proxyVocabulary = 3;
        await usage.flush();
        expect(
          {for (final name in addPhoneNames()) name: totals()[name]},
          {
            'ui_desktop_phone_offer_started': 1,
            'ui_desktop_phone_offer_ok': 1,
            'ui_desktop_phone_offer_under_1s': 1,
            'ui_desktop_add_phone_offer': 1,
          },
        );
        expect(reports.last['context'], isNotNull);
      },
    );

    test(
      'waiting names do not hold back a later day or other counts',
      () async {
        await usage.flush();
        usage.health(ProductHealthMeasure.asyncError);
        await usage.flush();
        // The day's coverage is counted already: the day holds only a
        // waiting name now.
        usage.addPhoneOpened(AddPhoneOpening.menu);
        now = now.add(const Duration(days: 1));
        usage.health(ProductHealthMeasure.asyncError);
        await usage.flush();
        expect(reports.last['day'], '2026-10-15');
        expect(totals()['health_desktop_async_error'], 2);
        expect(addPhoneNames(), isEmpty);
        usage.proxyVocabulary = 3;
        await usage.flush();
        expect(reports.last['day'], '2026-10-14');
        expect(totals()['ui_desktop_add_phone_menu'], 1);
      },
    );

    test(
      'the card offered after work waits for a CLI that forwards it, at 4',
      () async {
        await usage.flush();
        usage.begin(ProductFlow.phoneOfferAfterWork)(ProductOutcome.ok);
        usage.begin(ProductFlow.phoneOffer)(ProductOutcome.cancelled);
        // A CLI at 3 forwards the first card's names, not this one's.
        usage.proxyVocabulary = 3;
        await usage.flush();
        expect(addPhoneNames(), {
          'ui_desktop_phone_offer_started',
          'ui_desktop_phone_offer_cancelled',
          'ui_desktop_phone_offer_under_1s',
        });
        usage.proxyVocabulary = 4;
        await usage.flush();
        expect(
          {
            for (final name in addPhoneNames())
              if (name.contains('after_work')) name: totals()[name],
          },
          {
            'ui_desktop_phone_offer_after_work_started': 1,
            'ui_desktop_phone_offer_after_work_ok': 1,
            'ui_desktop_phone_offer_after_work_under_1s': 1,
          },
        );
      },
    );

    test('the cards after time away wait for 4, each read as itself', () async {
      await usage.flush();
      usage.begin(ProductFlow.phoneOfferAwayWaited)(ProductOutcome.ok);
      usage.begin(ProductFlow.phoneOfferAwayFinished)(ProductOutcome.unknown);
      usage.proxyVocabulary = 3;
      await usage.flush();
      expect(addPhoneNames().where((name) => name.contains('away')), isEmpty);
      usage.proxyVocabulary = 4;
      await usage.flush();
      expect(
        {
          for (final name in addPhoneNames())
            if (name.contains('away') && !name.contains('under_1s'))
              name: totals()[name],
        },
        {
          'ui_desktop_phone_offer_away_waited_started': 1,
          'ui_desktop_phone_offer_away_waited_ok': 1,
          'ui_desktop_phone_offer_away_finished_started': 1,
          'ui_desktop_phone_offer_away_finished_unknown': 1,
        },
      );
      expect(ProductFlow.phoneOfferAwayWaited.unbounded, isTrue);
      expect(ProductFlow.phoneOfferAwayFinished.unbounded, isTrue);
    });

    test(
      'the card offered after work is not ended by the 15-minute bound',
      () async {
        await usage.flush();
        usage.proxyVocabulary = 4;
        final card = usage.begin(ProductFlow.phoneOfferAfterWork);
        now = now.add(const Duration(minutes: 40));
        await usage.flush();
        await usage.flush();
        expect(totals()['ui_desktop_phone_offer_after_work_unknown'], isNull);
        card(ProductOutcome.cancelled);
        await usage.flush();
        expect(totals()['ui_desktop_phone_offer_after_work_cancelled'], 1);
      },
    );

    test('the card is not ended by the 15-minute observation bound', () async {
      await usage.flush();
      usage.proxyVocabulary = 3;
      final card = usage.begin(ProductFlow.phoneOffer);
      // A bounded flow begun beside it is ended unknown, as before.
      usage.begin(ProductFlow.connectUser);
      now = now.add(const Duration(minutes: 40));
      await usage.flush();
      await usage.flush();
      expect(totals()['ui_desktop_connect_user_unknown'], 1);
      expect(totals()['ui_desktop_phone_offer_unknown'], isNull);
      // Put away 40 minutes later, and counted as that.
      card(ProductOutcome.cancelled);
      card(ProductOutcome.ok);
      await usage.flush();
      expect(totals()['ui_desktop_phone_offer_started'], 1);
      expect(totals()['ui_desktop_phone_offer_cancelled'], 1);
      expect(totals()['ui_desktop_phone_offer_ok'], isNull);
    });

    test('every way in has its own name, and nothing else is sent', () async {
      await usage.flush();
      usage.proxyVocabulary = 3;
      for (final from in AddPhoneOpening.values) {
        usage.addPhoneOpened(from);
      }
      usage.addPhoneOpened(AddPhoneOpening.titlebar);
      await usage.flush();
      expect(
        {for (final name in addPhoneNames()) name: totals()[name]},
        {
          'ui_desktop_add_phone_offer': 1,
          'ui_desktop_add_phone_titlebar': 2,
          'ui_desktop_add_phone_menu': 1,
          'ui_desktop_add_phone_account': 1,
          'ui_desktop_add_phone_machines': 1,
          'ui_desktop_add_phone_command': 1,
        },
      );
    });

    test(
      'nothing is counted without sharing, an account or a Desktop',
      () async {
        await usage.flush();
        usage.proxyVocabulary = 3;
        usage.savedChoice({'enabled': false, 'revision': 1});
        usage.begin(ProductFlow.phoneOffer)(ProductOutcome.ok);
        usage.addPhoneOpened(AddPhoneOpening.offer);
        choice = {'enabled': true, 'revision': 2};
        await usage.flush();
        expect(addPhoneNames(), isEmpty);

        // Signed out: no account to count it under, and no signed-out name.
        usage.account(null);
        usage.begin(ProductFlow.phoneOffer)(ProductOutcome.ok);
        usage.addPhoneOpened(AddPhoneOpening.offer);
        await usage.flush();
        expect(addPhoneNames(), isEmpty);
        expect(jsonEncode(setup), isNot(contains('phone_offer')));
        expect(jsonEncode(setup), isNot(contains('add_phone')));

        // The browser has no health context, and no names for these.
        final web = ProductMeasurement(
          surface: 'web',
          automatic: false,
          now: () => now,
          sendSetup: (report) async => {'accepted': true},
        );
        addTearDown(web.dispose);
        final sentByWeb = <Map<String, dynamic>>[];
        web.account(
          'PRIVATE_ACCOUNT',
          choice: () async => choice,
          send: (report) async {
            sentByWeb.add(report);
            return {'accepted': true};
          },
        );
        await web.flush();
        web.proxyVocabulary = 3;
        web.begin(ProductFlow.phoneOffer)(ProductOutcome.ok);
        web.addPhoneOpened(AddPhoneOpening.command);
        await web.flush();
        expect(sentByWeb, isEmpty);
      },
    );
  });
}
