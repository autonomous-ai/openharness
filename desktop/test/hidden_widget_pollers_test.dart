// #2953: a widget that reads on a timer reads nothing while the app is hidden (a minimised,
// occluded or closed window; a hidden web tab), reads once at once when it is shown again, and
// then goes on with its interval. Each poller ticks through VisibleTick, or through the widget
// that owns its controller. Every fake here counts requests; nothing reaches a machine or the
// network.
import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/autonomous_device/autonomous_device_cli.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/machine_resources.dart';
import 'package:harness/core/models.dart';
import 'package:harness/devices/devices_controller.dart';
import 'package:harness/devices/devices_screen.dart';
import 'package:harness/devices/wifi_robots.dart';
import 'package:harness/orchestrator/orchestrator_controller.dart';
import 'package:harness/orchestrator/orchestrator_workspace.dart';
import 'package:harness/settings/sections/tab_invites_section.dart';
import 'package:harness/sharing/harness_comments.dart';
import 'package:harness/sharing/share_harness_dialog.dart';
import 'package:harness/sharing/shared_agent_location.dart';
import 'package:harness/sharing/shared_agent_page.dart';
import 'package:harness/sharing/shared_terminal_watch.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/dial_status.dart';
import 'package:harness/state/swarm_search.dart';
import 'package:harness/store/store_controller.dart';
import 'package:harness/store/store_models.dart';
import 'package:harness/store/store_screen.dart';
import 'package:harness/super_tabs/client.dart';
import 'package:harness/terminal/terminal_session.dart';
import 'package:harness/widgets/desktop_chrome.dart';
import 'package:harness/widgets/swarm_resource_preview.dart';
import 'package:harness/widgets/swarm_switcher.dart';
import 'package:harness/widgets/workspace_welcome.dart';

import 'session_search_rendering_test.dart' show TailConnection;
import 'support/model_manager.dart';
import 'swarm_state_test.dart' show MemoryStore, createApp;

AppNotifier _plainApp() => AppNotifier(
  config: AppConfig.dev,
  authSession: AuthSession(),
  configStore: null,
);

/// Well before any interval: what "at once" means here.
Future<void> _soon(WidgetTester tester) async {
  for (var i = 0; i < 5; i++) {
    await tester.pump(const Duration(milliseconds: 20));
  }
}

void _lifecycle(WidgetTester tester, AppLifecycleState state) =>
    tester.binding.handleAppLifecycleStateChanged(state);

/// Shown, hidden for three intervals, shown again. [reads] counts requests; [per] is how many
/// one read sends (one per row or machine).
Future<void> _expectQuietWhileHidden(
  WidgetTester tester, {
  required Duration every,
  required int Function() reads,
  int per = 1,
}) async {
  addTearDown(() => _lifecycle(tester, AppLifecycleState.resumed));
  var before = reads();
  await tester.pump(every);
  await _soon(tester);
  expect(reads(), before + per, reason: 'reads on its interval while shown');

  // Unfocused, still in sight: it keeps reading.
  _lifecycle(tester, AppLifecycleState.inactive);
  await tester.pump();
  before = reads();
  await tester.pump(every);
  await _soon(tester);
  expect(reads(), before + per, reason: 'an unfocused window still reads');

  _lifecycle(tester, AppLifecycleState.hidden);
  await tester.pump();
  before = reads();
  await tester.pump(every * 3);
  await _soon(tester);
  expect(reads(), before, reason: 'no request while the app is hidden');

  _lifecycle(tester, AppLifecycleState.inactive);
  _lifecycle(tester, AppLifecycleState.resumed);
  await _soon(tester);
  expect(reads(), before + per, reason: 'one read at once when it is shown');
  await tester.pump(every);
  await _soon(tester);
  expect(reads(), before + 2 * per, reason: 'then on its interval again');
}

Widget _host(Widget child) => MaterialApp(home: Scaffold(body: child));

class _DevicesApp extends AppNotifier {
  _DevicesApp()
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      );
  int reads = 0;
  @override
  Future<void> refreshDevices() async => reads++;
}

class _StoreApp extends AppNotifier {
  _StoreApp()
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      ) {
    const local = Machine(
      machineId: 'm',
      authMode: MachineAuthMode.remote,
      name: 'This Mac',
    );
    machines = [local];
    machineStates['m'] = MachineState(local)
      ..localOnly = true
      ..connectionStatus = ConnectionStatus.connected
      ..agentLoadStatus = AgentLoadStatus.loaded;
  }
  int probes = 0;
  @override
  Future<void> probeDsh(
    String machineId, {
    bool force = false,
    bool userAction = false,
  }) async => probes++;
  @override
  Future<void> probeEngines(String machineId, {bool force = false}) async {}
}

class _StoreApi implements StoreApi {
  @override
  Future<List<StoreRating>> ratings() async => [];
  @override
  Future<StoreReviews> reviews(String id) async =>
      StoreReviews(rating: StoreRating.none(id), reviews: const [], mine: null);
  @override
  Future<void> deleteReview(String id) async {}
  @override
  Future<StoreReview> putReview(
    String id, {
    required int rating,
    String? title,
    String? body,
  }) => throw UnimplementedError();
}

/// Its Swarm client answers from [paths] and counts every request.
class _InvitesApp extends AppNotifier {
  _InvitesApp()
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      );
  final paths = <String>[];
  late final SuperTabClient _client = SuperTabClient(
    transport: (method, path, {body}) async {
      paths.add(path);
      return path.endsWith('/invitations') ? <Object>[] : {'tabs': <Object>[]};
    },
    storage: MemoryStore(),
    discoveryInterval: Duration.zero,
  )..bind('account');
  @override
  SuperTabClient get superTabs => _client;
}

class _ResourcesApp extends ModelManagerTestApp {
  _ResourcesApp() : super(ModelManagerConnection());
  int reads = 0;
  @override
  Future<MachineResources?> readMachineResources(String machineId) async {
    reads++;
    return const MachineResources(cpuPercent: 33);
  }
}

class _Cli extends AutonomousDeviceCli {
  int statusCalls = 0;
  @override
  Future<Map<String, dynamic>> status() async {
    statusCalls++;
    return {'transport': 'direct', 'connected': true, 'paired': 0};
  }

  @override
  Future<Map<String, dynamic>> list() async => {'devices': const []};
  @override
  Future<Map<String, dynamic>> discover() async => {'devices': const []};
}

void main() {
  testWidgets(
    'harness comments: hidden app — no request for 3 intervals; resumed — one read at once',
    (tester) async {
      var reads = 0;
      await tester.pumpWidget(
        _host(
          HarnessComments(
            manage: (action, _) async {
              if (action == 'comments') reads++;
              return {'comments': const [], 'canComment': true};
            },
          ),
        ),
      );
      await _soon(tester);
      expect(reads, 1);
      await _expectQuietWhileHidden(
        tester,
        every: const Duration(seconds: 5),
        reads: () => reads,
      );
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'share harness dialog: hidden app — no request for 3 intervals; resumed — one read at once',
    (tester) async {
      var reads = 0;
      await tester.pumpWidget(
        _host(
          ShareHarnessDialog(
            name: 'Climate dashboard',
            manage: (action, _) async {
              if (action == 'list') reads++;
              return {'shares': const [], 'link': null};
            },
          ),
        ),
      );
      await _soon(tester);
      expect(reads, 1);
      await _expectQuietWhileHidden(
        tester,
        every: const Duration(seconds: 5),
        reads: () => reads,
      );
      await tester.pumpWidget(const SizedBox());
    },
  );

  // The shared pane (SharedHarnessPanel) sets `seen` from its VisibleTick: a hidden app or a
  // tab not showing is unseen.
  testWidgets(
    'shared terminal watch: hidden app (unseen) — no reopen for 3 intervals; seen — one reopen at once',
    (tester) async {
      final sent = <String>[];
      final session = TerminalSession(
        machineId: 'shared',
        agentId: 'agent',
        agentName: 'Demo',
        engineId: 'codex',
        readOnly: true,
        send: (type, payload) async {
          sent.add(type);
          return true;
        },
        sendBinary: (_) async => false,
      );
      final watch = SharedTerminalWatch(
        session,
        canRetry: () => true,
        onChanged: () {},
      );
      int opens() => sent.where((type) => type == 'terminal_open').length;
      await session.open();
      await session.handleFrame('terminal_error', {
        'requestId': null,
        'code': 'TERMINAL_RUNTIME_UNAVAILABLE',
      });
      expect(watch.stopped, isTrue);
      await tester.pump(const Duration(seconds: 10));
      expect(opens(), 2, reason: 'asks again while seen');

      watch.seen = false;
      await tester.pump(const Duration(seconds: 30));
      expect(opens(), 2, reason: 'no reopen while unseen');
      watch.seen = true;
      await tester.pump();
      expect(opens(), 3, reason: 'one reopen at once when seen');
      await tester.pump(const Duration(seconds: 10));
      expect(opens(), 4, reason: 'then on its interval again');
      watch.dispose();
      session.dispose();
    },
  );

  testWidgets(
    'shared link page (owner offline): hidden app — no request for 3 intervals; resumed — one read at once',
    (tester) async {
      final app = _plainApp();
      addTearDown(app.dispose);
      var reads = 0;
      final dio = Dio()
        ..interceptors.add(
          InterceptorsWrapper(
            onRequest: (request, handler) {
              reads++;
              handler.resolve(
                Response(
                  requestOptions: request,
                  statusCode: 200,
                  data: {
                    'data': {
                      'ownerPublicKey': base64Encode(List.filled(32, 1)),
                      'online': false,
                    },
                  },
                ),
              );
            },
          ),
        );
      addTearDown(dio.close);
      await tester.pumpWidget(
        MaterialApp(
          home: SharedAgentPage(
            app: app,
            dio: dio,
            location: SharedAgentLocation(
              '11111111-1111-4111-8111-111111111111',
              base64Encode(List.filled(32, 1)),
              'stag',
            ),
            openHarness: () async {},
          ),
        ),
      );
      await _soon(tester);
      expect(reads, 1);
      await _expectQuietWhileHidden(
        tester,
        every: const Duration(seconds: 10),
        reads: () => reads,
      );
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'tab invites: hidden app — no request for 3 intervals; resumed — one read at once',
    (tester) async {
      final app = _InvitesApp();
      addTearDown(app.dispose);
      int reads() =>
          app.paths.where((p) => p == '/api/super-tabs/invitations').length;
      await tester.pumpWidget(_host(TabInvitesSection(notifier: app)));
      await _soon(tester);
      expect(reads(), 1);
      await _expectQuietWhileHidden(
        tester,
        every: const Duration(seconds: 15),
        reads: reads,
      );
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'orchestrator workspace: hidden app — no request for 3 intervals; resumed — one read at once',
    (tester) async {
      final app = createApp();
      addTearDown(app.dispose);
      var reads = 0;
      final controller = OrchestratorController(
        id: 'p',
        request: (payload) async {
          if (payload['action'] == 'status') reads++;
          return {
            'project': {'id': 'p', 'revision': reads, 'state': 'active'},
          };
        },
      );
      addTearDown(controller.dispose);
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(1280, 850);
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        _host(
          OrchestratorWorkspace(
            notifier: app,
            machineId: 'm',
            projectId: 'p',
            controller: controller,
          ),
        ),
      );
      await _soon(tester);
      expect(reads, 1);
      await _expectQuietWhileHidden(
        tester,
        every: const Duration(seconds: 3),
        reads: () => reads,
      );
      await tester.pumpWidget(const SizedBox());
    },
  );

  for (final picker in [false, true]) {
    testWidgets(
      'session activity (${picker ? 'Cmd-P results' : 'Welcome'}): hidden app — no request for 3 intervals; resumed — one read at once',
      (tester) async {
        final now = tester.binding.clock.now();
        var reads = 0;
        final hit = <String, dynamic>{
          'agentId': '',
          'sessionId': 'claude-session',
          'engine': 'claude',
          'field': 'name',
          'snippet': '',
          'lastAt': now.millisecondsSinceEpoch,
          'external': {
            'title': 'Pane connection losses',
            'cwd': '/work/api',
            'origin': 'terminal',
            'open': true,
            'openIn': 'terminal',
          },
        };
        final connection = TailConnection(
          {
            '': [hit],
            'Pane': [hit],
          },
          tail: (_) {
            reads++;
            return {
              'lastAt': now.millisecondsSinceEpoch,
              'external': {'open': true, 'working': true},
              'rows': <Object>[],
              'total': 0,
              'hasMore': false,
            };
          },
        );
        final app = createApp(
          connected: true,
          connectionForTest: (_) => connection,
        );
        addTearDown(app.dispose);
        final search = SwarmSearchController(
          app,
          const [],
          adding: true,
          activityFirst: true,
        );
        addTearDown(search.dispose);
        if (picker) search.setQuery('Pane');
        await tester.pumpWidget(
          MaterialApp(
            home: DesktopChrome(
              child: Scaffold(
                body: picker
                    ? SwarmSearchResults(
                        search: search,
                        onChoose: (_) {},
                        onRefocus: () {},
                        showPreview: false,
                        now: tester.binding.clock.now,
                      )
                    : WorkspaceWelcome(
                        app: app,
                        onCommand: (_) {},
                        onOpen: (_) {},
                        now: tester.binding.clock.now,
                        composerBuilder: (recents) =>
                            recents ?? const SizedBox(),
                      ),
              ),
            ),
          ),
        );
        await tester.pump(const Duration(milliseconds: 200));
        await _soon(tester);
        expect(reads, greaterThan(0), reason: 'the row is read');
        await _expectQuietWhileHidden(
          tester,
          every: const Duration(seconds: 5),
          reads: () => reads,
        );
        await tester.pumpWidget(const SizedBox());
        await tester.pump(const Duration(seconds: 1));
      },
    );
  }

  testWidgets(
    'devices tab: hidden app — no request for 3 intervals; resumed — one read at once',
    (tester) async {
      final app = _DevicesApp();
      addTearDown(app.dispose);
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(1280, 900);
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        _host(
          DevicesTab(notifier: app, refreshEvery: const Duration(seconds: 10)),
        ),
      );
      await _soon(tester);
      expect(app.reads, 1);
      await _expectQuietWhileHidden(
        tester,
        every: const Duration(seconds: 10),
        reads: () => app.reads,
      );
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'store catalog: hidden app — no request for 3 intervals; resumed — one read at once',
    (tester) async {
      final app = _StoreApp();
      addTearDown(app.dispose);
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(1280, 900);
      addTearDown(tester.view.reset);
      await tester.pumpWidget(_host(StoreTab(notifier: app, api: _StoreApi())));
      await _soon(tester);
      expect(app.probes, 1, reason: 'the Store asks once as it opens');
      await _expectQuietWhileHidden(
        tester,
        every: const Duration(minutes: 1),
        reads: () => app.probes,
      );
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'resource preview machine metrics: hidden app — no request for 3 intervals; resumed — one read at once',
    (tester) async {
      final app = _ResourcesApp();
      addTearDown(app.dispose);
      final search = SwarmSearchController(app, const [], adding: true)
        ..setQuery('@This Mac');
      addTearDown(search.dispose);
      await tester.pumpWidget(
        _host(
          SizedBox(
            width: 600,
            height: 600,
            child: SwarmResourcePreview(
              search: search,
              controls: SearchPreviewControls(),
              onChoose: (_) {},
              onRefocus: () {},
              onModalChanged: (_) {},
              onCommands: () {},
              resourcePollInterval: const Duration(seconds: 10),
            ),
          ),
        ),
      );
      await _soon(tester);
      await _expectQuietWhileHidden(
        tester,
        every: const Duration(seconds: 10),
        reads: () => app.reads,
        per: app.machineStates.length,
      );
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'wifi robots: hidden app — no request for 3 intervals; resumed — one read at once',
    (tester) async {
      final cli = _Cli();
      final wifi = WifiRobotsController(
        cli: cli,
        refreshEvery: const Duration(seconds: 60),
      );
      final dial = DialState();
      addTearDown(dial.dispose);
      final controller = DevicesController(
        dial: dial,
        accountId: 'a',
        sendSettings: (_, _) async => true,
      );
      addTearDown(controller.dispose);
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(1280, 900);
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        _host(DevicesScreen(controller: controller, wifi: wifi)),
      );
      await _soon(tester);
      expect(cli.statusCalls, 1);
      await _expectQuietWhileHidden(
        tester,
        every: const Duration(seconds: 60),
        reads: () => cli.statusCalls,
      );
      await tester.pumpWidget(const SizedBox());
      wifi.dispose();
    },
  );
}
