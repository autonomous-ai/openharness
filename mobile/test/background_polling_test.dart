import 'dart:async';

import 'package:fake_async/fake_async.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/auth/auth_session.dart';
import 'package:harness_mobile/core/config.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/phone/usage_page.dart';
import 'package:harness_mobile/phone/welcome/your_computer.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/swarm/swarm_leaderboard.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';
import 'package:harness_mobile/usage/usage_accounts.dart';
import 'package:harness_mobile/viewer/device_log.dart';
import 'package:harness_mobile/viewer/device_log_sync.dart';

import 'swarm/swarm_fixture.dart' hide settle;
import 'viewer_app_fixture.dart';
import 'voice_fakes.dart' show MemoryKeyValueStore;

/// The phone in a pocket (`paused`, `hidden`) asks nothing on a timer — of the backend or of a
/// machine. Android keeps a backgrounded app running, so the OS suspending it is not to be counted
/// on. Back in front (`resumed`) each poller reads once at once and then keeps its interval; a
/// moment on the app switcher (`inactive`) is not a time away (#2953).
void main() {
  group('the app model', () {
    test(
      'agent sync: paused — no request for 3 intervals; resumed — one read',
      () {
        fakeAsync((async) {
          final rig = _phone();
          rig.app.bootstrap();
          async.flushMicrotasks();
          rig.app.connectionStatusForTest('m', ConnectionStatus.connected);
          async.flushMicrotasks();
          final conn = rig.conn('m');
          int lists() => conn.payloadsOf('agents_list').length;
          final before = lists();

          rig.app.handleAppPaused();
          _ageList(rig.app, 'm');
          async.elapse(AppNotifier.agentSyncInterval * 3);
          expect(lists(), before, reason: 'nothing asked from a pocket');

          rig.app.handleAppResumed();
          async.flushMicrotasks();
          expect(lists(), before + 1, reason: 'one read at once, and only one');

          _ageList(rig.app, 'm');
          async.elapse(AppNotifier.agentSyncInterval);
          expect(lists(), before + 2, reason: 'then on its interval again');

          rig.app.dispose();
        });
      },
    );

    test('agent sync: connected while paused — no request for 3 intervals; '
        'resumed — one read', () {
      fakeAsync((async) {
        final rig = _phone();
        rig.app.bootstrap();
        async.flushMicrotasks();
        rig.app.handleAppPaused();
        // The socket comes up with the phone in a pocket: its first list is read, as it was.
        rig.app.connectionStatusForTest('m', ConnectionStatus.connected);
        async.flushMicrotasks();
        final conn = rig.conn('m');
        int lists() => conn.payloadsOf('agents_list').length;
        final before = lists();

        _ageList(rig.app, 'm');
        async.elapse(AppNotifier.agentSyncInterval * 3);
        expect(lists(), before, reason: 'no timer armed from a pocket');

        rig.app.handleAppResumed();
        async.flushMicrotasks();
        expect(lists(), before + 1);

        _ageList(rig.app, 'm');
        async.elapse(AppNotifier.agentSyncInterval);
        expect(lists(), before + 2);

        rig.app.dispose();
      });
    });

    test('agent sync: a moment on the app switcher changes nothing', () {
      fakeAsync((async) {
        final rig = _phone();
        rig.app.bootstrap();
        async.flushMicrotasks();
        rig.app.connectionStatusForTest('m', ConnectionStatus.connected);
        async.flushMicrotasks();
        final conn = rig.conn('m');
        int lists() => conn.payloadsOf('agents_list').length;
        final before = lists();

        // `inactive`, then `resumed`, with no `paused` between: the list was just read.
        rig.app.handleAppInactive();
        rig.app.handleAppResumed();
        async.flushMicrotasks();
        expect(lists(), before);

        _ageList(rig.app, 'm');
        async.elapse(AppNotifier.agentSyncInterval);
        expect(lists(), before + 1, reason: 'the timer kept running');

        rig.app.dispose();
      });
    });

    test(
      'offline retry: paused — no request for 3 intervals; resumed — one read',
      () {
        fakeAsync((async) {
          final rig = _phone();
          rig.app.bootstrap();
          async.flushMicrotasks();
          rig.app.stateOf('m')!.pendingOfflineAgentId = 'a';
          rig.api.onMachines = () async => [
            remoteMachine('m', status: 'offline'),
          ];
          rig.app.handleEventForTest('m', {
            'type': 'node_status',
            'payload': {'online': false},
          });
          async.flushMicrotasks();
          final before = rig.api.machineFetches;
          async.elapse(AppNotifier.offlineRetryInterval);
          expect(
            rig.api.machineFetches,
            before + 1,
            reason: 'in front: polled',
          );

          rig.app.handleAppPaused();
          async.elapse(AppNotifier.offlineRetryInterval * 3);
          expect(
            rig.api.machineFetches,
            before + 1,
            reason: 'in a pocket: not',
          );

          // The resume's own read of the list (no machine is connected) is the one read: the
          // offline poll does not ask the same question beside it.
          rig.app.handleAppResumed();
          async.flushMicrotasks();
          expect(rig.api.machineFetches, before + 2);

          async.elapse(AppNotifier.offlineRetryInterval);
          expect(rig.api.machineFetches, before + 3, reason: 'polled again');

          rig.app.dispose();
        });
      },
    );

    test(
      'key watch: paused — no request for 3 intervals; resumed — one read',
      () {
        fakeAsync((async) {
          final rig = _phone();
          rig.app
            ..trustSettleRound = Duration.zero
            ..onRedialForTest = (id) => scheduleMicrotask(
              () => rig.app.localFailureForTest(id, 4404, 'NO_PEER_LINK'),
            );
          rig.app.bootstrap();
          async.flushMicrotasks();
          // A computer that signed in a moment ago, its key not in the log yet.
          rig.app.localFailureForTest('m', 4404, 'NO_PEER_LINK');
          async.elapse(const Duration(seconds: 1));
          expect(rig.app.stateOf('m')!.awaitingKey, isTrue);
          final api = rig.app.api as _Api;
          final before = api.keyReads;
          async.elapse(rig.app.keyWatchEvery);
          expect(api.keyReads, before + 1, reason: 'in front: the log re-read');

          rig.app.handleAppPaused();
          async.elapse(rig.app.keyWatchEvery * 3);
          expect(api.keyReads, before + 1, reason: 'in a pocket: not');

          // The resume reads the log once anyway (a `device_keys_changed` sent while away reached
          // nobody): that is the watch's read, not one beside it.
          rig.app.handleAppResumed();
          async.flushMicrotasks();
          expect(api.keyReads, before + 2);

          async.elapse(rig.app.keyWatchEvery);
          expect(api.keyReads, before + 3, reason: 'watched again');

          rig.app.dispose();
        });
      },
    );
  });

  group('the pages', () {
    testWidgets(
      'usage: paused — no request for 3 intervals; resumed — one read',
      (tester) async {
        final app = _UsageApp();
        addTearDown(app.dispose);
        await tester.pumpWidget(
          MaterialApp(
            theme: buildAppTheme(brightness: Brightness.dark),
            home: UsagePage(notifier: app),
          ),
        );
        await tester.pump();
        final before = app.reads;

        await _toBackground(tester);
        await tester.pump(const Duration(seconds: 60) * 3);
        expect(app.reads, before, reason: 'nothing asked from a pocket');

        await _toFront(tester);
        await tester.pump();
        expect(app.reads, before + 1, reason: 'one read at once');

        // The app switcher, and back: not a time away.
        tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.inactive,
        );
        tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.resumed,
        );
        await tester.pump();
        expect(app.reads, before + 1);

        await tester.pumpWidget(const SizedBox());
      },
    );

    testWidgets(
      'computer watch: paused — no request for 3 intervals; resumed — one read',
      (tester) async {
        final rig = _phone(machines: false);
        await tester.runAsync(() async {
          await rig.app.bootstrap();
          await settle();
        });
        await tester.pumpWidget(
          MaterialApp(
            home: ComputerWatch(notifier: rig.app, child: const SizedBox()),
          ),
        );
        await tester.pump(ComputerWatch.every);
        final before = rig.api.machineFetches;
        expect(before, greaterThan(0), reason: 'in front: watched');

        // The shell passes the lifecycle to the app model as well ([PhoneShell]).
        await _toBackground(tester);
        rig.app.handleAppPaused();
        await tester.pump(ComputerWatch.every * 3);
        expect(rig.api.machineFetches, before, reason: 'nothing from a pocket');

        // The app model reads the list on its own return (no machine connected): the watch's
        // read is that one, not a second beside it.
        await _toFront(tester);
        rig.app.handleAppResumed();
        await tester.pump();
        expect(rig.api.machineFetches, before + 1);

        await tester.pump(ComputerWatch.every);
        expect(rig.api.machineFetches, before + 2, reason: 'watched again');

        await tester.pumpWidget(const SizedBox());
        rig.app.dispose();
      },
    );

    testWidgets(
      'leaderboard: paused — no request for 3 intervals; resumed — one read',
      (tester) async {
        const board = '/api/super-tabs/$tab/leaderboard?projectId=$project';
        final fake = FakeSwarm();
        fake.routes['/api/super-tabs/list'] = (_) => {
          'tabs': [
            {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
          ],
          'next': null,
        };
        fake.routes['/api/super-tabs/$tab/parts'] = (_) => {
          ...firstLoad(),
          'members': [part(me, 1, person(me))],
        };
        fake.routes['/api/super-tabs/$tab/changes'] = (_) =>
            changes(cursor: 'c2');
        fake.routes[board] = (_) => leaderboardData();
        final account = ValueNotifier<String?>(me);
        final host = SwarmHost(
          accountId: () => account.value,
          account: account,
          request: fake.request,
          notices: SilentSystemNotices(),
          features: ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
            ..value = {PhoneExperiment.swarm},
        )..foreground = false;
        addTearDown(host.dispose);
        await host.session!.inbox.refresh();
        await tester.pumpWidget(
          MaterialApp(
            builder: (context, child) =>
                SwarmScope(notifier: host, child: child!),
            home: const SwarmLeaderboardPage(swarmId: tab, projectId: project),
          ),
        );
        await tester.pump();
        int boards() => fake.paths.where((p) => p.startsWith(board)).length;
        final before = boards();
        expect(before, 1, reason: 'read on opening');

        // The shell tells Swarm the app went behind ([PhoneShell]); the page hears the lifecycle.
        await _toBackground(tester);
        host.foreground = false;
        await tester.pump(const Duration(minutes: 5) * 3);
        expect(boards(), before, reason: 'nothing asked from a pocket');

        host.foreground = true;
        await _toFront(tester);
        await tester.pump();
        expect(boards(), before + 1, reason: 'one read at once');

        await tester.pump(const Duration(minutes: 5));
        expect(boards(), before + 2, reason: 'then on its interval again');

        host.foreground = false;
        await tester.pumpWidget(const SizedBox());
      },
    );
  });
}

/// The account's REST API, counting the device key log's reads and never reaching a backend.
class _Api extends FakeApi {
  int keyReads = 0;

  @override
  Future<DeviceLogFetched?> deviceKeys(int since, {String? self}) async {
    keyReads++;
    return null;
  }

  @override
  Future<DeviceLogAppendAnswer?> appendDeviceKey(DevLogEntry entry) async =>
      null;
}

/// A signed-in phone (memory store, fake sign-in, scripted sockets) on an account with one
/// machine, `m`, running agent `a` — or none when [machines] is false. The machine list re-read
/// that runs while no machine is connected is put a day off, so it counts only where a test means
/// it to: on the way back from a pocket.
({AppNotifier app, _Api api, ScriptedConn Function(String) conn}) _phone({
  bool machines = true,
}) {
  final rig = viewerApp();
  final api = _Api();
  rig.app.api = api;
  api.onMachines = () async => [if (machines) remoteMachine('m')];
  rig.conn('m').answers['agents_list'] = (_) => {
    'agents': [agentJson('a')],
  };
  rig.conn('m').answers['terminal_capabilities'] = (_) => capabilities();
  rig.app
    ..deafMachineListInterval = const Duration(days: 1)
    ..asleepMachineListInterval = const Duration(days: 1)
    ..asleepMachinesListInterval = const Duration(days: 1);
  return (app: rig.app, api: api, conn: rig.conn);
}

/// A tick waits until the list is an interval old on the real clock (`DateTime.now()`), which the
/// fake clock does not move: the list is aged by hand instead.
void _ageList(AppNotifier app, String machineId) =>
    app.stateOf(machineId)!.agentsListedAt = DateTime.now().subtract(
      AppNotifier.agentSyncInterval * 4,
    );

/// Into a pocket, the way the OS says it: `inactive`, `hidden`, `paused`.
Future<void> _toBackground(WidgetTester tester) async {
  for (final state in const [
    AppLifecycleState.inactive,
    AppLifecycleState.hidden,
    AppLifecycleState.paused,
  ]) {
    tester.binding.handleAppLifecycleStateChanged(state);
  }
}

/// Back in front: `hidden`, `inactive`, `resumed`.
Future<void> _toFront(WidgetTester tester) async {
  for (final state in const [
    AppLifecycleState.hidden,
    AppLifecycleState.inactive,
    AppLifecycleState.resumed,
  ]) {
    tester.binding.handleAppLifecycleStateChanged(state);
  }
}

/// A phone whose linked machines are asked what their accounts spent, counted.
class _UsageApp extends AppNotifier {
  _UsageApp()
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      );

  int reads = 0;

  @override
  Future<List<MachineUsage>> readRemoteUsage({String? machineId}) async {
    reads++;
    return const [];
  }
}
