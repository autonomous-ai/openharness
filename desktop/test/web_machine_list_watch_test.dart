// A browser with no computer connected hears no push, so it asks for the machine list on its own
// while the connect page or the asleep band shows. One loop does that, in the app model, backing
// off as the wait goes on; these count its reads second by second, with the real app model and the
// real workspace.
//
// Measured on main before the loop (five simulated minutes): the connect page read the list 15
// times a minute, 15 with the tab hidden too; the asleep band 18 (the screen's 4 s timer beside the
// app's 20 s one); with the backend down 10 to 15, beside recovery's own. Each read is two requests
// (`/api/machines`, `/api/harness-shares`). A computer coming online showed within 4 s.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/api/api_client.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/state/workspace_chrome.dart';
import 'package:harness/viewer/viewer_key_store.dart';
import 'package:harness/viewer/viewer_services.dart';
import 'package:harness/ws/local_cli_discovery.dart';
import 'package:harness/ws/ws_conn.dart';

import 'swarm_state_test.dart' show MemoryStore;

const _studioId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

/// The account's one computer, set up before and asleep now.
const _asleep = Machine(
  machineId: _studioId,
  authMode: MachineAuthMode.remote,
  name: 'Studio',
  status: 'offline',
);

/// The same computer, signed in and online.
const _online = Machine(
  machineId: _studioId,
  authMode: MachineAuthMode.remote,
  name: 'Studio',
  status: 'online',
);

class _Api extends ApiClient {
  _Api() : super(config: AppConfig.dev, session: AuthSession());

  List<Machine> answer = const [];

  /// The backend is down: every read answers 503, which recovery retries.
  bool down = false;

  /// `GET /api/machines` asked.
  int reads = 0;

  @override
  Future<Map<String, dynamic>?> me() async => null;

  @override
  Future<List<Machine>> machines() async {
    reads++;
    if (down) throw ApiException('Service unavailable', status: 503);
    return answer;
  }
}

/// A computer this window has no daemon on.
class _NoDaemon extends LocalCliDiscovery {
  _NoDaemon() : super(config: AppConfig.dev);
  @override
  Future<String?> computerId() async => null;
  @override
  Future<LocalCliEndpoint?> discover({String? expectedComputerId}) async =>
      null;
}

/// A dial that never opens: the computer is asleep, or still starting. Waits give up when their
/// timeout runs out, as the real connection's do.
class _Unanswered extends WsConn {
  _Unanswered(String machineId)
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: machineId,
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );

  @override
  bool get isReady => false;
  @override
  Future<void> waitUntilReady({required Duration timeout}) =>
      Future.delayed(timeout, () => throw TimeoutException('dial', timeout));
  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) => Future.delayed(timeout, () => throw TimeoutException(type, timeout));
  @override
  Future<void> close() async {}
}

const _connectPage = Key('connect-page');

void main() {
  late _Api api;
  late AppNotifier app;

  /// Simulated seconds since the first machine list answered.
  var now = 0;

  /// A browser (or, with [browser] false, Desktop) signed in, its first machine list answered
  /// with [machines], and the workspace up with the host's connect page.
  Future<void> mount(
    WidgetTester tester, {
    List<Machine> machines = const [],
    bool browser = true,
  }) async {
    now = 0;
    api = _Api()..answer = machines;
    app = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(storage: MemoryStore()),
      configStore: null,
      localCliDiscovery: browser ? null : _NoDaemon(),
      viewer: browser
          ? ViewerServices(
              config: AppConfig.dev,
              session: AuthSession(storage: MemoryStore()),
              keys: ViewerKeyStore(storage: MemoryStore()),
            )
          : null,
      connectionForTest: _Unanswered.new,
    );
    app.api = api;
    app.status = AppStatus.authenticated;
    app.newSwarm(newTabPage: true);
    tester.view.physicalSize = const Size(1280, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: SwarmScreen(
          notifier: app,
          chrome: browser
              ? WorkspaceChrome(
                  leadingWidth: (_) => 0,
                  leading: (_, _) => const SizedBox(),
                  firstMachine: (_) => const SizedBox(key: _connectPage),
                )
              : null,
        ),
      ),
    );
    await app.refreshMachines();
    await tester.pump();
  }

  Future<void> unmount(WidgetTester tester) async {
    await tester.pumpWidget(const SizedBox.shrink());
    app.dispose();
    await tester.pump(const Duration(minutes: 1));
  }

  /// The seconds, counted from the first answer, in which the list was read during the next
  /// [seconds].
  Future<List<int>> readsIn(WidgetTester tester, int seconds) async {
    final at = <int>[];
    for (var s = 0; s < seconds; s++) {
      final before = api.reads;
      await tester.pump(const Duration(seconds: 1));
      now++;
      if (api.reads != before) at.add(now);
    }
    return at;
  }

  /// Whether the list was read in this turn of the event loop, with no time passing.
  Future<bool> readAtOnce(WidgetTester tester, void Function() act) async {
    final before = api.reads;
    act();
    await tester.pump();
    return api.reads != before;
  }

  /// Seconds from [_online] being the backend's answer to it being in the app's list.
  Future<int> secondsToShow(WidgetTester tester) async {
    api.answer = const [_online];
    for (var s = 1; s <= 60; s++) {
      await tester.pump(const Duration(seconds: 1));
      now++;
      if (app.machines.any((m) => m.status == 'online')) return s;
    }
    return -1;
  }

  testWidgets('the connect page: 4 s, 8 s, then every 10 s', (tester) async {
    await mount(tester);
    expect(find.byKey(_connectPage), findsOneWidget);

    expect(await readsIn(tester, 60), [4, 12, 22, 32, 42, 52]);
    expect(await readsIn(tester, 60), [62, 72, 82, 92, 102, 112]);
    await unmount(tester);
  });

  testWidgets('the asleep band: 4 s, 8 s, 15 s, then every 30 s', (
    tester,
  ) async {
    await mount(tester, machines: const [_asleep]);
    expect(find.byKey(_connectPage), findsNothing);

    expect(await readsIn(tester, 120), [4, 12, 27, 57, 87, 117]);
    await unmount(tester);
  });

  testWidgets('a computer stuck connecting: every 20 s, as before', (
    tester,
  ) async {
    await mount(tester, machines: const [_online]);
    // What the pool reports while its dial is under way.
    app.connectionStatusForTest(_studioId, ConnectionStatus.connecting);
    await tester.pump();
    expect(find.byKey(_connectPage), findsNothing);

    // The first wait was set while the list had not answered (the connect page, looking); from
    // then on, every 20 s, as on main.
    expect(await readsIn(tester, 64), [4, 24, 44, 64]);
    await unmount(tester);
  });

  testWidgets('a hidden tab reads nothing; coming back reads at once', (
    tester,
  ) async {
    await mount(tester);
    app.appLifecycleChanged(AppLifecycleState.inactive);
    app.appLifecycleChanged(AppLifecycleState.hidden);

    expect(await readsIn(tester, 120), isEmpty);

    expect(
      await readAtOnce(
        tester,
        () => app.appLifecycleChanged(AppLifecycleState.resumed),
      ),
      isTrue,
    );
    expect(await readsIn(tester, 12), [124, 132]);
    await unmount(tester);
  });

  testWidgets('a window in sight but not focused keeps reading; focus reads '
      'at once and starts the pace over', (tester) async {
    await mount(tester, machines: const [_asleep]);
    app.appLifecycleChanged(AppLifecycleState.inactive);

    expect(await readsIn(tester, 60), [4, 12, 27, 57]);

    expect(
      await readAtOnce(
        tester,
        () => app.appLifecycleChanged(AppLifecycleState.resumed),
      ),
      isTrue,
    );
    expect(await readsIn(tester, 12), [64, 72]);
    await unmount(tester);
  });

  testWidgets(
    'a push reads once its copies from the other machines are in, and starts the pace over',
    (tester) async {
      await mount(tester, machines: const [_asleep]);
      expect(await readsIn(tester, 120), [4, 12, 27, 57, 87, 117]);

      unawaited(
        app.handleEventForTest(_studioId, const {
          'type': 'machines_changed',
          'payload': <String, dynamic>{},
        }),
      );
      // AppNotifier.machinesPushCollapse: the same push arrives once per connected machine.
      expect(await readsIn(tester, 2), [122]);
      expect(await readsIn(tester, 12), [126, 134]);
      await unmount(tester);
    },
  );

  testWidgets('the person\'s Retry reads at once and starts the pace over', (
    tester,
  ) async {
    await mount(tester);
    expect(await readsIn(tester, 120), [
      4,
      12,
      22,
      32,
      42,
      52,
      62,
      72,
      82,
      92,
      102,
      112,
    ]);

    expect(
      await readAtOnce(tester, () => unawaited(app.retryMachines())),
      isTrue,
    );
    expect(await readsIn(tester, 12), [124, 132]);
    await unmount(tester);
  });

  testWidgets('with the backend down, recovery alone reads, then the pace '
      'starts over once the list is back', (tester) async {
    await mount(tester, machines: const [_asleep]);
    api.down = true;

    // The loop's read at 4 s fails; from then on only recovery asks, at 2, 4, 8, 16, 30, 30 s.
    expect(await readsIn(tester, 130), [4, 6, 10, 18, 34, 64, 94, 124]);
    expect(app.machineRecoveryPending, isTrue);

    api.down = false;
    // Recovery's next read, at 154 s, answers and recovery stops. Its reload of the asleep
    // computer waits out the dial; then the loop reads again, its pace from the start.
    final after = await readsIn(tester, 60);
    expect(after.first, 154);
    expect(app.machineRecoveryPending, isFalse);
    expect(
      [for (var i = 2; i < after.length; i++) after[i] - after[i - 1]],
      [8, 15],
    );
    await unmount(tester);
  });

  testWidgets('a computer coming online on the connect page shows within '
      '10 s, however long the page has waited', (tester) async {
    await mount(tester);

    await readsIn(tester, 5);
    expect(await secondsToShow(tester), 7);
    await unmount(tester);

    await mount(tester);
    await readsIn(tester, 60);
    expect(await secondsToShow(tester), 2);
    await unmount(tester);

    await mount(tester);
    await readsIn(tester, 175);
    expect(await secondsToShow(tester), 7);
    await unmount(tester);
  });

  testWidgets('one asleep, waking after a minute, shows within 30 s', (
    tester,
  ) async {
    await mount(tester, machines: const [_asleep]);
    await readsIn(tester, 60);

    expect(await secondsToShow(tester), 27);
    await unmount(tester);
  });

  testWidgets('Desktop reads nothing on its own', (tester) async {
    await mount(tester, browser: false);

    expect(await readsIn(tester, 120), isEmpty);
    await unmount(tester);
  });
}
