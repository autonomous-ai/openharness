import '../test/support/launch_menu.dart';

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:window_manager/window_manager.dart';
import 'package:xterm/xterm.dart';

import 'package:harness/auth/auth_session.dart';
import 'package:harness/auth/cli_link.dart';
import 'package:harness/auth/peer_link_client.dart';
import 'package:harness/bootstrap/environment_provisioner.dart';
import 'package:harness/screens/login_screen.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/dsh_catalog.dart';
import 'package:harness/core/models.dart';
import 'package:harness/core/project_folder.dart';
import 'package:harness/core/test_run.dart';
import 'package:harness/core/snapshot_store.dart';
import 'package:harness/settings/sections/usage_section.dart';
import 'package:harness/stats/harness_stats.dart';
import 'package:harness/usage/ledger/ledger_types.dart';
import 'package:harness/usage/ledger/usage_ledger_store.dart';
import 'package:harness/usage/ledger/usage_ledger_controller.dart';
import 'package:harness/usage/ledger/usage_report.dart';
import 'package:harness/usage/ledger/opencode_ledger_scanner.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/models/models_panel.dart';
import 'package:harness/settings/settings_nav.dart';
import 'package:harness/settings/settings_screen.dart';
import 'package:harness/settings/settings_section.dart';
import 'package:harness/settings/sections/shortcuts_section.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/widgets/app_select_field.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/state/pane_preset.dart';
import 'package:harness/state/swarm_catalog.dart';
import 'package:harness/state/workspace_learning.dart';
import 'package:harness/store/store_screen.dart';
import 'package:harness/widgets/workspace_welcome.dart';
import 'package:harness/shortcuts/keyboard_practice.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/terminal/terminal_session.dart';
import 'package:harness/widgets/new_harness_form.dart';
import 'package:harness/widgets/environment_setup_screen.dart';
import 'package:harness/widgets/terminal_find_bar.dart';
import 'package:harness/ws/ws_conn.dart';

import '../test/keymap_host_test.dart' show key;
import '../test/support/mixed_agents.dart';
import '../test/support/password_cli.dart';
import '../test/support/machine_api.dart';
import '../test/support/rename_connection.dart';
import '../test/support/stop_connection.dart';
import '../test/support/fork_connection.dart';
import '../test/support/restart_connection.dart';
import '../test/swarm_screen_test.dart' show terminal;
import '../test/machine_loading_test.dart' show DiscoveryConnection;
import '../test/environment_setup_screen_test.dart'
    show SetupLogin, SetupProvisioner, setupReview;
import '../test/terminal_find_test.dart' show terminalView;
import '../test/swarm_state_test.dart' show createApp, MemoryStore;
import '../test/workspace_account_lifecycle_test.dart'
    show
        WorkspaceAccountFixture,
        WorkspaceAccountLogin,
        arrangeAccountWorkspace;
import '../test/usage_ledger_lifecycle_test.dart' show HeldScanner, figures;
import '../test/usage_ledger_test.dart' show MemorySettings;
import '../test/usage_scanners_test.dart' show createUsageDatabase, addUsage;
import '../test/usage_jsonl_scanners_test.dart'
    show jsonlRoot, jsonlRow, jsonlScanner;
import '../test/signout_recovery_test.dart'
    show SignOutFixture, signOutApp, signOutHost;

class _CreationConnection extends WsConn {
  _CreationConnection({this.products = const []})
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );

  final creates = <Map<String, dynamic>>[];
  final List<Map<String, dynamic>> products;
  final input = <TerminalBinaryFrame>[];

  @override
  Future<bool> sendTerminalFrame(
    String type,
    Map<String, dynamic> payload,
  ) async => true;

  @override
  Future<bool> sendTerminalBinary(Uint8List bytes) async {
    final frame = decodeTerminalLocal(bytes);
    if (frame?.kind == TerminalBinaryKind.input) input.add(frame!);
    return true;
  }

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    if (type == 'engines_probe') {
      return {
        'engines': [
          {'engine': 'codex', 'installed': true},
          {'engine': 'claude', 'installed': true},
        ],
      };
    }
    if (type == 'dsh_list') return {'dsh': products};
    if (type == 'agent_create') {
      creates.add(Map.of(payload));
      return {
        'creationId': payload['creationId'],
        'state': 'created',
        'agent': {
          'id': 'made',
          'name': 'Refine terminal workspace',
          'engine': payload['engine'],
          'dsh': payload['dsh'],
          'terminal': {'available': true},
        },
      };
    }
    return {};
  }
}

/// A machine that lacks one harness and installs it when asked, narrating
/// through `dsh_install_status` pushes the test sends while the request is
/// held. The first install fails in setup; the second lands.
class _InstallingConnection extends _CreationConnection {
  _InstallingConnection()
    : super(
        products: [
          {
            'id': 'autonomous/circuit',
            'name': 'Autonomous Circuit',
            'engine': 'claude',
            'engines': ['claude', 'codex'],
            'installed': false,
          },
        ],
      );

  final installs = <String>[];
  Completer<Map<String, dynamic>>? reply;

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    if (type != 'dsh_install') {
      return super.request(type, payload: payload, timeout: timeout);
    }
    installs.add(payload['id'] as String);
    reply = Completer();
    final answer = await reply!.future;
    if (answer['ok'] == true) products.single['installed'] = true;
    return answer;
  }
}

class _FirstCreationApp extends AppNotifier {
  _FirstCreationApp(WsConn connection)
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
        connectionForTest: (_) => connection,
      ) {
    const machine = Machine(
      machineId: 'm',
      name: 'This Mac',
      authMode: MachineAuthMode.remote,
    );
    machines = [machine];
    machineStates['m'] = MachineState(machine)
      ..localOnly = true
      ..nodeOnline = true
      ..agentLoadStatus = AgentLoadStatus.loaded;
    status = AppStatus.authenticated;
  }

  @override
  Future<String> prepareLocalProjectFolder(
    ProjectFolderRequest request, {
    String label = 'harness',
  }) async => '/fixture/harnesses/${request.folderName}';
}

class _WorkspaceLinks implements PeerLinkClient {
  final requests = <String>[];
  final replies = <Completer<CliLinkConnectResult>>[];

  @override
  Future<CliLinkConnectResult> connect(
    String machineId,
    String password, {
    void Function(String stage)? onProgress,
    String? displayName,
  }) {
    requests.add(machineId);
    final reply = Completer<CliLinkConnectResult>();
    replies.add(reply);
    onProgress?.call('verifying');
    return reply.future;
  }

  @override
  Future<CliLinkListResult> list() async => const CliLinkListResult();

  @override
  Future<String?> unlink(String machineId) async => null;
}

/// Run with FLUTTER_TEST=1. This fixture never bootstraps the real CLI, loads a
/// Harness home, or creates real agents; it mounts the real native workspace
/// around in-memory sessions and simulates creation and machine-link requests.
void main() {
  if (!kUnderTest) {
    throw StateError('Native workspace fixtures require FLUTTER_TEST=1');
  }
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() async {
    await windowManager.ensureInitialized();
    await windowManager.setSize(const Size(1280, 800));
  });
  setUp(() async {
    newHarnessOpensInBox = true;
    // Each journey interacts with this fixture's own native window. A second
    // running Harness instance can otherwise leave it inactive at launch,
    // correctly suspending Find indexing and native frame delivery.
    await windowManager.show();
    await windowManager.focus();
  });
  tearDown(() => newHarnessOpensInBox = false);

  testWidgets(
    'native first setup retries checks and installs with keys and recovers from clipboard failure',
    (tester) async {
      final provisioner = SetupProvisioner();
      final app =
          AppNotifier(
              config: AppConfig.dev,
              authSession: AuthSession(),
              configStore: null,
              cliLogin: SetupLogin(),
              environmentProvisioner: provisioner,
            )
            ..status = AppStatus.preparingEnvironment
            ..environmentReadiness = setupReview.copyWith(
              phase: EnvironmentSetupPhase.failed,
              failure: const EnvironmentFailure(
                title: 'Checking this computer took too long',
                detail: 'The tmux check did not finish. Retry to check again.',
              ),
            );
      addTearDown(app.dispose);
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        (call) async {
          if (call.method == 'Clipboard.setData') {
            throw PlatformException(code: 'clipboard_unavailable');
          }
          return null;
        },
      );
      addTearDown(
        () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          SystemChannels.platform,
          null,
        ),
      );
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: ListenableBuilder(
            listenable: app,
            builder: (_, _) => app.status == AppStatus.unauthenticated
                ? const Scaffold(body: Text('Sign-in reached'))
                : EnvironmentSetupScreen(notifier: app),
          ),
        ),
      );
      await tester.pump(const Duration(milliseconds: 200));
      await key(tester, LogicalKeyboardKey.enter);
      expect(provisioner.attempts, hasLength(1));
      expect(provisioner.attempts.single.install, isFalse);
      await key(tester, LogicalKeyboardKey.enter);
      expect(provisioner.attempts, hasLength(1));
      provisioner.attempts.single.finish(setupReview);
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.text('Install 2 tools'), findsOneWidget);
      expect(provisioner.attempts, hasLength(1));
      await key(tester, LogicalKeyboardKey.enter);
      expect(provisioner.attempts, hasLength(2));
      expect(provisioner.attempts.last.install, isTrue);
      await key(tester, LogicalKeyboardKey.enter);
      expect(provisioner.attempts, hasLength(2));
      provisioner.attempts.last.finish(
        setupReview.copyWith(
          phase: EnvironmentSetupPhase.failed,
          failure: const EnvironmentFailure(
            title: 'Setup could not finish',
            detail: 'Check your connection, then retry setup.',
          ),
          output: const ['Connection interrupted'],
        ),
      );
      await tester.pump(const Duration(milliseconds: 100));
      await tester.ensureVisible(find.text('Copy diagnostics'));
      await tester.tap(find.text('Copy diagnostics'));
      await tester.pump();
      expect(
        find.text('Could not copy. Select the text to copy it, or try again.'),
        findsOneWidget,
      );
      bool retryFocused() => tester
          .widget<FilledButton>(find.byType(FilledButton))
          .focusNode!
          .hasFocus;
      for (var i = 0; i < 8 && !retryFocused(); i++) {
        await key(tester, LogicalKeyboardKey.tab);
      }
      expect(retryFocused(), isTrue);
      await key(tester, LogicalKeyboardKey.enter);
      expect(provisioner.attempts, hasLength(3));
      expect(provisioner.attempts.last.install, isTrue);
      provisioner.attempts.last.finish(
        const EnvironmentReadiness(
          steps: {
            EnvironmentStep.clipboard: EnvironmentStepStatus.notApplicable,
            EnvironmentStep.tmux: EnvironmentStepStatus.ready,
            EnvironmentStep.harness: EnvironmentStepStatus.ready,
          },
          phase: EnvironmentSetupPhase.ready,
        ),
      );
      await tester.pump(const Duration(milliseconds: 100));
      expect(app.status, AppStatus.unauthenticated);
      expect(find.text('Sign-in reached'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'native reconnect refreshes discovery and restores terminal input',
    (tester) async {
      final connection = DiscoveryConnection();
      final app = createApp(connectionForTest: (_) => connection);
      final projects = SwarmProjectStore();
      addTearDown(app.dispose);
      addTearDown(projects.dispose);
      app.machineStates['m']!
        ..nodeOnline = true
        ..terminalCapabilityAvailable = true;
      final input = <TerminalBinaryFrame>[];
      final session =
          TerminalSession(
              machineId: 'm',
              agentId: 'a0',
              agentName: 'Fixture',
              engineId: 'codex',
              send: connection.sendTerminalFrame,
              sendBinary: (frame) async {
                if (frame.kind == TerminalBinaryKind.input) input.add(frame);
                return true;
              },
            )
            ..status = TerminalSessionStatus.controlling
            ..streamId = 'old-stream';
      session.terminal.write(
        List.generate(180, (i) => 'Retained output $i\r\n').join(),
      );
      final pane = app.adoptSessionForTest(session);
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: SwarmScreen(
            notifier: app,
            nativeTabs: true,
            projectStore: projects,
          ),
        ),
      );
      await tester.pump(const Duration(milliseconds: 100));
      final view = terminalView(tester, session);
      final scroll = view.widget.scrollController!;
      scroll.jumpTo(80);
      final start = session.terminal.buffer.createAnchor(0, 1);
      final end = session.terminal.buffer.createAnchor(8, 1);
      addTearDown(start.dispose);
      addTearDown(end.dispose);
      view.widget.controller!.setSelection(start, end);
      await tester.pump();
      app.onMachineConnectedForTest('m');
      await tester.pump(const Duration(milliseconds: 100));
      expect(terminalView(tester, session), same(view));
      expect(scroll.offset, 80);
      expect(view.widget.controller!.selection, isNotNull);
      expect(session.streamId, isNull);
      await key(tester, LogicalKeyboardKey.arrowRight);
      await tester.pump(const Duration(milliseconds: 20));
      expect(input, isEmpty);

      connection.agents.single.complete({
        'agents': [
          {
            'id': 'a0',
            'name': 'Reconnected agent',
            'engine': 'codex',
            'terminal': {
              'runtimes': [
                {'backend': 'tmux', 'paneId': '%1'},
              ],
            },
          },
        ],
      });
      connection.capabilities.single.complete({
        'protocolVersion': 3,
        'backend': 'tmux',
        'available': true,
      });
      await tester.pump(const Duration(milliseconds: 100));
      final open = connection.frames
          .lastWhere((frame) => frame.type == 'terminal_open')
          .payload;
      await session.handleFrame('terminal_ready', {
        'requestId': open['requestId'],
        'agentId': 'a0',
        'protocolVersion': 3,
        'streamId': 'reconnected-stream',
      });
      await session.handleBinary(
        TerminalBinaryFrame(
          kind: TerminalBinaryKind.keyframe,
          streamId: 'reconnected-stream',
          seq: 0,
          bytes: utf8.encode('Fresh terminal screen\r\nready> '),
          compressed: false,
          cols: open['cols'] as int,
          rows: open['rows'] as int,
        ),
      );
      await tester.pump(const Duration(milliseconds: 100));
      expect(app.focusedPane, same(pane));
      expect(pane.session, same(session));
      expect(session.status, TerminalSessionStatus.controlling);
      expect(
        session.terminal.buffer.getText(),
        contains('Fresh terminal screen'),
      );
      await key(tester, LogicalKeyboardKey.arrowLeft);
      await tester.pump(const Duration(milliseconds: 50));
      expect(input.last.streamId, 'reconnected-stream');
      expect(input.last.bytes, [27, 91, 68]);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
    timeout: const Timeout(Duration(seconds: 60)),
  );

  testWidgets(
    'native session expiry restores the saved tabs and keyboard selection',
    (tester) async {
      final app = WorkspaceAccountFixture(
        MemoryStore(),
        WorkspaceAccountLogin(),
      );
      final projects = SwarmProjectStore();
      addTearDown(app.dispose);
      addTearDown(projects.dispose);
      await arrangeAccountWorkspace(app);
      final selected = app.activeSwarmId;
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context).copyWith(disableAnimations: true),
            child: grid.BrightnessScope(child: child!),
          ),
          home: ListenableBuilder(
            listenable: app,
            builder: (_, _) => app.status == AppStatus.authenticated
                ? SwarmScreen(
                    notifier: app,
                    nativeTabs: true,
                    projectStore: projects,
                  )
                : LoginScreen(notifier: app),
          ),
        ),
      );
      await tester.pump(const Duration(milliseconds: 100));
      await app.expire();
      await tester.pumpAndSettle();
      expect(app.allPanes, isEmpty);
      expect(find.text('Sign in'), findsOneWidget);
      expect(find.text('Could not sign in'), findsNothing);
      await key(tester, LogicalKeyboardKey.enter);
      // Restored panes wait for their machines with an indeterminate spinner.
      // Wait for sign-in itself, rather than for those animations to settle.
      for (var i = 0; i < 50 && app.signingIn; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }
      expect(app.signingIn, isFalse);
      await tester.pump();
      expect(find.byType(LoginScreen), findsNothing);
      expect(app.swarms.map((s) => s.name), ['Research', 'Build']);
      expect(app.allPanes.map((p) => p.agentId), ['a', 'b', 'c']);
      expect(app.activeSwarmId, selected);
      expect(
        find.textContaining('This machine isn’t available.'),
        findsOneWidget,
      );
      expect(find.byType(CircularProgressIndicator), findsNothing);
      final reads = app.inventoryRequests;
      // The native workspace also has pane-header controls in Tab order.
      // Reach Retry through that real order rather than assuming it is first.
      for (
        var i = 0;
        i < 8 && !Focus.of(tester.element(find.text('Retry'))).hasFocus;
        i++
      ) {
        await key(tester, LogicalKeyboardKey.tab);
      }
      expect(Focus.of(tester.element(find.text('Retry'))).hasFocus, isTrue);
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pump(const Duration(milliseconds: 100));
      expect(app.inventoryRequests, reads + 1);
      await key(tester, LogicalKeyboardKey.digit1, cmd: true);
      expect(app.activeSwarm.name, 'Research');
      expect(app.focusedPane!.agentId, 'b');
      await key(tester, LogicalKeyboardKey.digit2, cmd: true);
      expect(app.activeSwarmId, selected);
      expect(app.focusedPane!.agentId, 'c');
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
    timeout: const Timeout(Duration(seconds: 75)),
  );

  testWidgets('native sign-out waits, retries, and restores keyboard sign-in', (
    tester,
  ) async {
    final cli = SignOutFixture();
    final app = signOutApp(cli);
    addTearDown(app.dispose);
    final pending = app.logout();
    await tester.pumpWidget(signOutHost(app));
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.text('Signing out…'), findsOneWidget);
    await key(tester, LogicalKeyboardKey.enter);
    expect(cli.logins, 0);
    cli.attempts.single.completeError(StateError('fixture sign-out failure'));
    await pending;
    await tester.pumpAndSettle();
    expect(find.text('Retry sign out'), findsOneWidget);
    await key(tester, LogicalKeyboardKey.enter);
    expect(cli.attempts, hasLength(2));
    cli.attempts.last.complete();
    await tester.pumpAndSettle();
    expect(find.text('Sign in'), findsOneWidget);
    await key(tester, LogicalKeyboardKey.enter);
    expect(cli.logins, 1);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets(
    'native Usage retries, changes range with keys, and stops a pending scan',
    (tester) async {
      final scanner = HeldScanner();
      final settings = MemorySettings()
        ..values['usageLedger.claude.enabled'] = 'true';
      final snapshot = MemorySnapshotStore();
      final store = UsageLedgerStore(
        scanner: scanner,
        settings: settings,
        snapshots: snapshot,
      );
      final controller = UsageLedgerController(stores: [store]);
      final stats = HarnessStats(store: MemorySnapshotStore());
      addTearDown(controller.dispose);
      addTearDown(stats.dispose);
      final loading = controller.load();
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: Scaffold(
            body: UsageSection(controller: controller, stats: stats),
          ),
        ),
      );
      await tester.pump(const Duration(milliseconds: 100));
      final lens = find.byType(AppSelectField<LedgerProvider?>);
      await tester.tap(lens);
      await tester.pump(const Duration(milliseconds: 100));
      await key(tester, LogicalKeyboardKey.arrowDown);
      await key(tester, LogicalKeyboardKey.enter);
      expect(
        tester.widget<AppSelectField<LedgerProvider?>>(lens).value,
        LedgerProvider.claude,
      );
      expect(find.text('Scanning Claude logs…'), findsOneWidget);
      expect(find.text('No Claude usage in this range.'), findsNothing);
      scanner.replies.single.completeError(StateError('Fixture unavailable'));
      await tester.pump(const Duration(milliseconds: 100));
      await loading;
      expect(find.textContaining('Fixture unavailable'), findsOneWidget);
      final rescan = find.byTooltip('Rescan the local logs');
      await tester.tap(rescan);
      await tester.pump(const Duration(milliseconds: 50));
      expect(scanner.replies, hasLength(2));
      scanner.replies.last.complete(figures(1200));
      await tester.pump(const Duration(milliseconds: 100));
      final range = find.byType(AppSelectField<UsageRange>);
      await tester.tap(range);
      await tester.pump(const Duration(milliseconds: 100));
      await key(tester, LogicalKeyboardKey.arrowDown);
      await key(tester, LogicalKeyboardKey.arrowDown);
      await key(tester, LogicalKeyboardKey.enter);
      expect(
        tester.widget<AppSelectField<UsageRange>>(range).value,
        UsageRange.all,
      );
      expect(scanner.replies, hasLength(2));
      await tester.tap(rescan);
      await tester.pump(const Duration(milliseconds: 50));
      expect(scanner.replies, hasLength(3));
      await tester.tap(find.byTooltip('Stop reading Claude'));
      await tester.pump(const Duration(milliseconds: 50));
      scanner.replies.last.complete(figures(9900));
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.text('Enable Claude'), findsOneWidget);
      expect(store.ledger.hasData, isFalse);
      expect(snapshot.isEmpty, isTrue);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'native Usage refresh reads committed SQLite data through the worker',
    (tester) async {
      final fixture = await Directory.systemTemp.createTemp(
        'harness-native-usage-',
      );
      final writer = createUsageDatabase(
        '${fixture.path}/opencode.db',
        wal: true,
      );
      final store = UsageLedgerStore(
        scanner: OpenCodeLedgerScanner(dataDirectory: fixture.path),
        settings: MemorySettings(),
        snapshots: MemorySnapshotStore(),
      );
      final controller = UsageLedgerController(stores: [store]);
      final stats = HarnessStats(store: MemorySnapshotStore());
      addTearDown(() async {
        controller.dispose();
        stats.dispose();
        writer.dispose();
        await fixture.delete(recursive: true);
      });
      addUsage(writer, input: 1000);
      writer.execute('UPDATE session SET time_created=?', [
        DateTime.now().millisecondsSinceEpoch,
      ]);
      await controller.load();
      await store.setEnabled(true);
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: Scaffold(
            body: UsageSection(controller: controller, stats: stats),
          ),
        ),
      );
      await tester.pumpAndSettle();
      final lens = find.byType(AppSelectField<LedgerProvider?>);
      await tester.tap(lens);
      await tester.pump(const Duration(milliseconds: 100));
      for (var i = 0; i < 3; i++) {
        await key(tester, LogicalKeyboardKey.arrowDown);
      }
      await key(tester, LogicalKeyboardKey.enter);
      expect(
        tester.widget<AppSelectField<LedgerProvider?>>(lens).value,
        LedgerProvider.opencode,
      );
      expect(find.text('1.0k'), findsWidgets);
      final rescan = find.byTooltip('Rescan the local logs');
      writer.execute('UPDATE session SET tokens_input=5000');
      await tester.tap(rescan);
      await tester.pumpAndSettle();
      expect(store.state.status, LedgerStatus.ok);
      expect(store.ledger.totals.freshInput, 5000);
      expect(find.text('5.0k'), findsWidgets);
      final broken = File('${fixture.path}/opencode-copy.db');
      await broken.writeAsString('deliberately invalid fixture');
      await tester.tap(rescan);
      await tester.pumpAndSettle();
      expect(store.state.status, LedgerStatus.partial);
      expect(find.textContaining('Figures are incomplete.'), findsOneWidget);
      expect(find.text('5.0k'), findsWidgets);
      await broken.delete();
      await tester.tap(rescan);
      await tester.pumpAndSettle();
      expect(store.state.status, LedgerStatus.ok);
      expect(find.textContaining('Figures are incomplete.'), findsNothing);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );

  for (final provider in [LedgerProvider.claude, LedgerProvider.codex]) {
    testWidgets(
      'native Usage ${provider.label} reads live transcripts and recovers',
      (tester) async {
        final fixture = await Directory.systemTemp.createTemp(
          'harness-native-jsonl-',
        );
        final file = File('${jsonlRoot(provider, fixture.path)}/live.jsonl');
        await file.parent.create(recursive: true);
        final first =
            jsonDecode(jsonlRow(provider, 1000)) as Map<String, dynamic>;
        first['timestamp'] = DateTime.now().toIso8601String();
        await file.writeAsString('${jsonEncode(first)}\n');
        final store = UsageLedgerStore(
          scanner: jsonlScanner(provider, fixture.path),
          settings: MemorySettings(),
          snapshots: MemorySnapshotStore(),
        );
        final controller = UsageLedgerController(stores: [store]);
        final stats = HarnessStats(store: MemorySnapshotStore());
        addTearDown(() async {
          controller.dispose();
          stats.dispose();
          await fixture.delete(recursive: true);
        });
        await controller.load();
        await store.setEnabled(true);
        await tester.pumpWidget(
          MaterialApp(
            theme: grid.buildAppTheme(brightness: Brightness.dark),
            home: Scaffold(
              body: UsageSection(controller: controller, stats: stats),
            ),
          ),
        );
        await tester.pumpAndSettle();
        final lens = find.byType(AppSelectField<LedgerProvider?>);
        await tester.tap(lens);
        await tester.pump(const Duration(milliseconds: 100));
        for (var i = 0; i <= provider.index; i++) {
          await key(tester, LogicalKeyboardKey.arrowDown);
        }
        await key(tester, LogicalKeyboardKey.enter);
        expect(
          tester.widget<AppSelectField<LedgerProvider?>>(lens).value,
          provider,
        );
        expect(find.text('1.0k'), findsWidgets);
        final rescan = find.byTooltip('Rescan the local logs');
        final next =
            jsonDecode(jsonlRow(provider, 2000)) as Map<String, dynamic>;
        next['timestamp'] = DateTime.now().toIso8601String();
        next['fixtureText'] = '€';
        final bytes = utf8.encode(jsonEncode(next));
        final split = bytes.indexOf(0xe2) + 1;
        await file.writeAsBytes(bytes.sublist(0, split), mode: FileMode.append);
        await tester.tap(rescan);
        await tester.pumpAndSettle();
        expect(store.state.status, LedgerStatus.ok);
        expect(store.ledger.totals.freshInput, 1000);
        await file.writeAsBytes([
          ...bytes.sublist(split),
          10,
        ], mode: FileMode.append);
        await tester.tap(rescan);
        await tester.pumpAndSettle();
        expect(store.state.status, LedgerStatus.ok);
        expect(
          store.ledger.totals.freshInput,
          provider == LedgerProvider.claude ? 3000 : 2000,
        );
        final broken = File('${file.parent.path}/broken.jsonl');
        await broken.writeAsBytes([0xff, 10]);
        await tester.tap(rescan);
        await tester.pumpAndSettle();
        expect(store.state.status, LedgerStatus.partial);
        expect(find.textContaining('Figures are incomplete.'), findsOneWidget);
        await broken.delete();
        await tester.tap(rescan);
        await tester.pumpAndSettle();
        expect(store.state.status, LedgerStatus.ok);
        expect(find.textContaining('Figures are incomplete.'), findsNothing);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
      },
    );
  }

  testWidgets(
    'native Settings is searchable immediately and Escape restores terminal input',
    (tester) async {
      final app = createApp();
      seedMixedAgents(app);
      final input = <TerminalBinaryFrame>[];
      final pane = app.adoptSessionForTest(terminal('a0', input));
      addTearDown(app.dispose);
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: SwarmScreen(notifier: app, nativeTabs: true),
        ),
      );
      await tester.pump(const Duration(milliseconds: 200));
      await key(tester, LogicalKeyboardKey.comma, cmd: true);
      await tester.pump(const Duration(milliseconds: 200));
      final search = find.byKey(const Key('settings-search-field'));
      expect(
        tester.widget<TextField>(search).focusNode!.hasPrimaryFocus,
        isTrue,
      );
      await tester.enterText(search, 'keyboard');
      await key(tester, LogicalKeyboardKey.enter);
      expect(
        tester.widget<SettingsNav>(find.byType(SettingsNav)).section,
        SettingsSection.shortcuts,
      );
      final shortcutSearch = find.byKey(const ValueKey('shortcuts-search'));
      for (
        var i = 0;
        i < 4 && !tester.widget<TextField>(shortcutSearch).focusNode!.hasFocus;
        i++
      ) {
        await key(tester, LogicalKeyboardKey.tab);
      }
      expect(
        tester.widget<TextField>(shortcutSearch).focusNode!.hasFocus,
        isTrue,
      );
      final scroll = tester.state<ScrollableState>(
        find
            .descendant(
              of: find.byType(ShortcutsSection),
              matching: find.byType(Scrollable),
            )
            .last,
      );
      await key(tester, LogicalKeyboardKey.pageDown);
      await tester.pump(const Duration(milliseconds: 300));
      expect(scroll.position.pixels, greaterThan(0));
      await tester.enterText(shortcutSearch, 'Clone');
      await tester.pump();
      expect(find.text('Clone Harness'), findsOneWidget);
      await tester.enterText(shortcutSearch, '');
      await tester.pump();
      expect(input, isEmpty);
      for (
        var i = 0;
        i < 4 && !tester.widget<TextField>(search).focusNode!.hasPrimaryFocus;
        i++
      ) {
        await key(tester, LogicalKeyboardKey.tab, shift: true);
      }
      expect(
        tester.widget<TextField>(search).focusNode!.hasPrimaryFocus,
        isTrue,
      );
      await tester.enterText(search, 'About');
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      await key(tester, LogicalKeyboardKey.tab);
      await key(tester, LogicalKeyboardKey.tab);
      expect(
        FocusManager.instance.primaryFocus?.context
            ?.findAncestorWidgetOfExactType<OutlinedButton>()
            ?.key,
        const Key('settings-check-updates-button'),
      );
      expect(app.updateChecksEnabled, isFalse);
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(find.text('Updates are off for this build'), findsOneWidget);
      await key(tester, LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(find.byType(Dialog), findsNothing);
      expect(find.byType(SettingsScreen), findsOneWidget);
      expect(
        FocusManager.instance.primaryFocus?.context
            ?.findAncestorWidgetOfExactType<OutlinedButton>()
            ?.key,
        const Key('settings-check-updates-button'),
      );
      expect(input, isEmpty);
      await key(tester, LogicalKeyboardKey.escape);
      await tester.pump(const Duration(milliseconds: 200));
      expect(find.byType(SettingsScreen), findsNothing);
      expect(app.focusedPane, same(pane));
      await key(tester, LogicalKeyboardKey.arrowRight);
      expect(input.single.bytes, [27, 91, 67]);
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(milliseconds: 100));
    },
  );

  testWidgets(
    'native New Harness installs a missing harness, retries a failure, then starts',
    (tester) async {
      final connection = _InstallingConnection();
      final app = _FirstCreationApp(connection);
      addTearDown(app.dispose);
      addTearDown(connection.close);
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: SwarmScreen(notifier: app, nativeTabs: true),
        ),
      );
      await tester.pump(const Duration(milliseconds: 200));
      Future<void> settle() async {
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 200));
      }

      Future<void> say(Map<String, Object?> progress) => app.handleEventForTest(
        'm',
        {'type': 'dsh_install_status', 'payload': progress},
      );
      final pane = find.byKey(const ValueKey('new-harness-install'));
      Finder inPane(String text) =>
          find.descendant(of: pane, matching: find.text(text));

      await key(tester, LogicalKeyboardKey.keyN, cmd: true);
      await settle();
      await focusLaunchRow(tester, 'harness');
      await key(tester, LogicalKeyboardKey.enter);
      await settle();
      await tester.enterText(
        find.byKey(const ValueKey('new-harness-query')),
        'circuit',
      );
      await settle();
      await key(tester, LogicalKeyboardKey.enter);
      await settle();
      final box = tester
          .widget<NewHarnessForm>(find.byType(NewHarnessForm))
          .controller;
      expect(box.harnessId, 'autonomous/circuit');

      await key(tester, LogicalKeyboardKey.enter, shift: true);
      await settle();
      expect(connection.installs, ['autonomous/circuit']);
      expect(
        inPane('Installing Autonomous Circuit on This Mac'),
        findsOneWidget,
      );
      await say({
        'id': 'autonomous/circuit',
        'phase': 'setup',
        'line': 'npm ci',
      });
      await settle();
      expect(inPane('✓'), findsOneWidget);
      expect(inPane('npm ci'), findsWidgets);
      await say({
        'id': 'autonomous/circuit',
        'phase': 'failed',
        'error': 'DSH_SETUP_FAILED',
        'detail': 'setup exited 1',
      });
      connection.reply!.complete({
        'ok': false,
        'error': 'DSH_SETUP_FAILED',
        'detail': 'setup exited 1',
      });
      await settle();
      expect(inPane('✗'), findsOneWidget);
      expect(connection.creates, isEmpty);

      await key(tester, LogicalKeyboardKey.enter, shift: true);
      await settle();
      expect(connection.installs, hasLength(2));
      expect(inPane('✗'), findsNothing);
      await say({'id': 'autonomous/circuit', 'phase': 'done'});
      connection.reply!.complete({'ok': true});
      await settle();
      await settle();
      expect(connection.creates, hasLength(1));
      expect(connection.creates.single['dsh'], 'autonomous/circuit');
      expect(find.byType(NewHarnessForm), findsNothing);
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(milliseconds: 100));
    },
  );

  testWidgets(
    'native first workspace stays quiet until New Harness is requested',
    (tester) async {
      final connection = _CreationConnection();
      final app = _FirstCreationApp(connection);
      await app.agentPreference.select('codex');
      final projects = SwarmProjectStore();
      addTearDown(app.dispose);
      addTearDown(projects.dispose);
      addTearDown(connection.close);
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: SwarmScreen(
            notifier: app,
            nativeTabs: true,
            projectStore: projects,
          ),
        ),
      );
      await tester.pump(const Duration(milliseconds: 200));
      await tester.pump(const Duration(milliseconds: 200));
      expect(find.byType(NewHarnessForm), findsNothing);
      expect(find.byType(WorkspaceWelcome), findsOneWidget);
      await key(tester, LogicalKeyboardKey.keyN, cmd: true);
      await tester.pump(const Duration(milliseconds: 200));
      final box = tester
          .widget<NewHarnessForm>(find.byType(NewHarnessForm))
          .controller;
      expect(box.engine, 'codex');
      expect(box.projectLabel, startsWith('~/harnesses/codex-'));
      final proposedFolder = box.projectFolderRequest!.folderName;
      expect(connection.creates, isEmpty);
      expect(find.byType(WorkspaceWelcome), findsOneWidget);
      await startHarness(tester);
      await tester.pump(const Duration(milliseconds: 200));
      expect(connection.creates, hasLength(1));
      expect(
        connection.creates.single['cwd'],
        '/fixture/harnesses/$proposedFolder',
      );
      expect(connection.creates.single['engine'], 'codex');
      expect(find.byType(NewHarnessForm), findsNothing);
      await key(tester, LogicalKeyboardKey.keyS, cmd: true);
      await tester.pump(const Duration(milliseconds: 100));
      expect(app.activeSwarm.isStore, isTrue);
      expect(connection.creates, hasLength(1));
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(milliseconds: 100));
    },
  );

  testWidgets(
    'native JEV navigation returns to the original pane and hands off to New Tab',
    (tester) async {
      final app = createApp();
      final input = <TerminalBinaryFrame>[];
      final originalPane = app.adoptSessionForTest(terminal('a0', input));
      final original = app.activeSwarm;
      app.renameSwarm(original.id, 'Original work');
      app.newSwarm(name: 'JEV target');
      app.adoptSessionForTest(terminal('a1', []));
      final target = app.activeSwarm;
      app.selectSwarm(original.id);
      app.focusPane(originalPane.id);
      final projects = SwarmProjectStore();
      addTearDown(app.dispose);
      addTearDown(projects.dispose);
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: SwarmScreen(
            notifier: app,
            nativeTabs: true,
            projectStore: projects,
            commandResolver: (_, _) async =>
                throw StateError('Exact app commands must stay local'),
          ),
        ),
      );
      await tester.pump(const Duration(milliseconds: 200));
      final command = find.byKey(const ValueKey('jev-command-input'));
      await key(tester, LogicalKeyboardKey.keyJ, cmd: true, shift: true);
      await tester.enterText(command, 'Open JEV target');
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await tester.pumpAndSettle();
      expect(command, findsNothing);
      expect(app.activeSwarmId, target.id);
      expect(find.text('Go back'), findsOneWidget);
      await tester.tap(find.text('Go back'));
      await tester.pumpAndSettle();
      expect(app.activeSwarmId, original.id);
      expect(app.focusedPane, same(originalPane));
      expect(app.swarms, contains(target));
      await key(tester, LogicalKeyboardKey.arrowLeft);
      await tester.pump(const Duration(milliseconds: 100));
      expect(input.last.bytes, [27, 91, 68]);

      await key(tester, LogicalKeyboardKey.keyJ, cmd: true, shift: true);
      await tester.enterText(command, 'Open a new tab');
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await tester.pumpAndSettle();
      final chooser = find.byKey(const ValueKey('swarm-search-input'));
      expect(command, findsNothing);
      expect(chooser, findsNothing);
      expect(find.byType(WorkspaceWelcome), findsOneWidget);
      expect(app.activeSwarm.isNewTabPage, isTrue);
      expect(app.activeSwarmId, isNot(original.id));
      await key(tester, LogicalKeyboardKey.keyW, cmd: true);
      await tester.pump(const Duration(milliseconds: 100));
      expect(app.activeSwarmId, target.id);
      await key(tester, LogicalKeyboardKey.digit1, cmd: true);
      await tester.pump(const Duration(milliseconds: 100));
      expect(app.activeSwarmId, original.id);
      await key(tester, LogicalKeyboardKey.arrowRight);
      await tester.pump(const Duration(milliseconds: 100));
      expect(input.last.bytes, [27, 91, 67]);
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(milliseconds: 100));
    },
  );

  testWidgets(
    'native workspace learns keys without dispatching practice actions',
    (tester) async {
      final app = createApp();
      final learning = WorkspaceLearning();
      final input = <TerminalBinaryFrame>[];
      app.adoptSessionForTest(terminal('a0', []));
      app.adoptSessionForTest(terminal('a1', input));
      final original = app.activeSwarm;
      final panes = original.panes.toList();
      final projects = SwarmProjectStore();
      addTearDown(app.dispose);
      addTearDown(learning.dispose);
      addTearDown(projects.dispose);
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: SwarmScreen(
            notifier: app,
            nativeTabs: true,
            projectStore: projects,
            learning: learning,
          ),
        ),
      );
      await tester.pump(const Duration(milliseconds: 200));

      Future<void> command(String name) async {
        await key(tester, LogicalKeyboardKey.keyP, cmd: true, shift: true);
        await tester.enterText(
          find.byKey(const ValueKey('swarm-search-input')),
          '> $name',
        );
        await tester.pump();
        await key(tester, LogicalKeyboardKey.enter);
        await tester.pump(const Duration(milliseconds: 200));
      }

      // Same dispatch as Help > Quick Start, through the native workspace channel.
      final started = Completer<void>();
      tester.binding.defaultBinaryMessenger.handlePlatformMessage(
        'harness/swarm_tabs',
        const StandardMethodCodec().encodeMethodCall(
          const MethodCall('keymapCommand', {
            'command': 'keyboard.quick_start',
          }),
        ),
        (_) => started.complete(),
      );
      await started.future;
      await tester.pump();
      await tester.tap(find.text('Try the keyboard tour'));
      await tester.pump(const Duration(milliseconds: 200));
      expect(learning.next, WorkspaceLesson.zoom);
      await key(tester, LogicalKeyboardKey.enter, cmd: true);
      expect(learning.next, WorkspaceLesson.commands);
      await command('Keyboard practice');
      expect(learning.finished, isTrue);
      final filter = find.byKey(const ValueKey('practice-filter'));
      await tester.enterText(filter, 'New Tab');
      await tester.pump();
      await key(tester, LogicalKeyboardKey.enter);
      await key(tester, LogicalKeyboardKey.keyT, cmd: true);
      expect(find.text('[x] New Tab'), findsOneWidget);
      await key(tester, LogicalKeyboardKey.keyW, cmd: true);
      expect(app.swarms, [original]);
      expect(original.panes, panes);
      expect(input, isEmpty);
      await key(tester, LogicalKeyboardKey.escape);
      expect(filter, findsOneWidget);
      await key(tester, LogicalKeyboardKey.escape);
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.byType(KeyboardPractice), findsNothing);
      await command('Pause quick start');
      expect(learning.active, isFalse);
      await key(tester, LogicalKeyboardKey.arrowLeft);
      await tester.pump(const Duration(milliseconds: 100));
      expect(input.last.bytes, [27, 91, 68]);
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(milliseconds: 100));
    },
  );

  testWidgets(
    'native workspace keeps search, shared views and terminal input distinct',
    (tester) async {
      final app = createApp();
      seedMixedAgents(app);
      final codexInput = <TerminalBinaryFrame>[];
      final claudeInput = <TerminalBinaryFrame>[];
      final codex = terminal('a0', codexInput)
        ..agentName = 'Fix login redirect';
      final claude = terminal('a1', claudeInput)
        ..agentName = 'Fix login redirect';
      final firstPane = app.adoptSessionForTest(codex);
      final secondPane = app.adoptSessionForTest(claude);
      app.setPreset(2, PanePreset.columns);
      app.focusPane(firstPane.id);
      final source = app.activeSwarm;
      app.renameSwarm(source.id, 'Native review fixture');
      final projects = SwarmProjectStore();
      addTearDown(app.dispose);
      addTearDown(projects.dispose);

      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: SwarmScreen(
            notifier: app,
            nativeTabs: true,
            projectStore: projects,
          ),
        ),
      );
      await tester.pump(const Duration(milliseconds: 200));

      Finder viewFor(TerminalSession session) => find.byWidgetPredicate(
        (widget) =>
            widget is TerminalView &&
            identical(widget.terminal, session.terminal),
      );
      Future<void> output(
        TerminalSession session,
        int sequence,
        String text, {
        bool keyframe = false,
      }) => session.handleBinary(
        TerminalBinaryFrame(
          kind: keyframe
              ? TerminalBinaryKind.keyframe
              : TerminalBinaryKind.output,
          streamId: session.streamId!,
          seq: sequence,
          compressed: false,
          cols: keyframe ? 80 : null,
          rows: keyframe ? 24 : null,
          bytes: utf8.encode(text),
        ),
      );
      final history = List.generate(
        200,
        (i) => 'Line $i ${i % 50 == 0 ? 'checkpoint marker' : 'completed'}\r\n',
      ).join();
      await output(codex, 0, '${history}ready> ', keyframe: true);
      await output(
        claude,
        0,
        'Reviewing the same project\r\nready> ',
        keyframe: true,
      );
      await tester.pump(const Duration(milliseconds: 100));
      final view = tester.state<TerminalViewState>(viewFor(codex));
      final scroll = view.widget.scrollController!;
      final bottom = scroll.offset;
      expect(bottom, greaterThan(1000));
      await tester.sendEventToBinding(
        PointerScrollEvent(
          position: tester.getCenter(viewFor(codex)),
          scrollDelta: const Offset(0, -300),
        ),
      );
      await tester.pump(const Duration(milliseconds: 100));
      final reading = scroll.offset;
      expect(reading, lessThan(bottom));
      await output(codex, 1, '\r\nAnother response arrived');
      await tester.pump(const Duration(milliseconds: 100));
      expect(
        scroll.offset,
        closeTo(reading, .5),
        reason: 'Output must not pull a reader away',
      );

      await key(tester, LogicalKeyboardKey.keyF, cmd: true);
      final findInput = find.byKey(const ValueKey('terminal-find-editor'));
      await tester.enterText(findInput, 'checkpoint marker');
      // Native indexing and window layout run on the real event loop. Wait
      // for this query's completed snapshot rather than a fixed frame budget.
      final findDeadline = DateTime.now().add(const Duration(seconds: 5));
      while (DateTime.now().isBefore(findDeadline)) {
        await tester.pump(const Duration(milliseconds: 20));
        final search = tester
            .widget<TerminalFindBar>(find.byType(TerminalFindBar))
            .search!;
        if (search.query == 'checkpoint marker' &&
            search.hasSnapshot &&
            !search.searching) {
          break;
        }
      }
      final completedSearch = tester
          .widget<TerminalFindBar>(find.byType(TerminalFindBar))
          .search!;
      expect(completedSearch.query, 'checkpoint marker');
      expect(
        completedSearch.searching,
        isFalse,
        reason: 'Find must finish indexing before its result count is checked',
      );
      expect(completedSearch.hasSnapshot, isTrue);
      expect(
        tester
            .widget<TerminalFindBar>(find.byType(TerminalFindBar))
            .search!
            .count,
        4,
      );
      await key(tester, LogicalKeyboardKey.enter);
      await key(tester, LogicalKeyboardKey.escape);
      await tester.pump(const Duration(milliseconds: 100));
      expect(scroll.offset, closeTo(reading, .5));
      expect(codexInput, isEmpty);
      expect(claudeInput, isEmpty);
      tester.testTextInput.enterText('git status');
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pump(const Duration(milliseconds: 20));
      expect(
        utf8.decode([for (final frame in codexInput) ...frame.bytes]),
        'git status\r',
      );
      expect(claudeInput, isEmpty);
      codexInput.clear();

      final search = find.byKey(const ValueKey('swarm-search-input'));
      Future<void> command(String query) async {
        await key(tester, LogicalKeyboardKey.keyP, cmd: true, shift: true);
        await tester.enterText(search, '> $query');
        await tester.pump();
        await key(tester, LogicalKeyboardKey.enter);
        await tester.pump(const Duration(milliseconds: 80));
      }

      await key(tester, LogicalKeyboardKey.keyT, cmd: true);
      expect(find.byType(WorkspaceWelcome), findsOneWidget);
      await key(tester, LogicalKeyboardKey.keyP, cmd: true);
      await tester.enterText(search, 'login claude M2');
      await tester.pump();
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pump(const Duration(milliseconds: 80));
      final sharedTab = app.activeSwarm;
      expect(sharedTab, isNot(same(source)));
      expect(sharedTab.name, 'Fix login redirect');
      expect(sharedTab.panes.single.session, same(claude));
      expect(source.panes, [firstPane, secondPane]);
      await key(tester, LogicalKeyboardKey.keyW, cmd: true);
      await command('reopen tab');
      expect(app.activeSwarm.id, sharedTab.id);
      expect(app.focusedPane!.session, same(claude));
      await command('next tab');
      expect(app.activeSwarm, same(source));
      expect(app.focusedPane, same(firstPane));
      await key(tester, LogicalKeyboardKey.keyL, cmd: true);
      expect(app.focusedPane, same(secondPane));
      await key(tester, LogicalKeyboardKey.keyH, cmd: true);
      expect(app.focusedPane, same(firstPane));
      await key(tester, LogicalKeyboardKey.arrowRight, cmd: true, shift: true);
      expect(source.panes, [secondPane, firstPane]);
      expect(app.focusedPane, same(firstPane));
      await key(tester, LogicalKeyboardKey.enter, cmd: true);
      expect(app.zoomedPaneId, firstPane.id);
      await key(tester, LogicalKeyboardKey.enter, cmd: true);
      await command('resize panes');
      await key(tester, LogicalKeyboardKey.arrowRight);
      await key(tester, LogicalKeyboardKey.escape);
      await tester.pump(const Duration(milliseconds: 80));
      expect(tester.state<TerminalViewState>(viewFor(codex)), same(view));
      expect(codexInput, isEmpty);
      expect(claudeInput, isEmpty);
      await key(tester, LogicalKeyboardKey.arrowLeft);
      await tester.pump(const Duration(milliseconds: 20));
      expect(codexInput.single.bytes, [27, 91, 68]);
      expect(claudeInput, isEmpty);
      // The Store is a workspace destination, reached by the same command
      // from a native window without replacing either terminal.
      await command('browse harnesses');
      final storeTab = app.activeSwarm;
      expect(storeTab.isStore, isTrue);
      expect(source.panes, [secondPane, firstPane]);
      await command('install');
      expect(app.activeSwarm, same(storeTab));
      expect(app.swarms.where((tab) => tab.isStore), hasLength(1));
      await key(tester, LogicalKeyboardKey.keyW, cmd: true);
      await tester.pump(const Duration(milliseconds: 80));
      await key(tester, LogicalKeyboardKey.digit1, cmd: true);
      expect(app.activeSwarm, same(source));
      expect(tester.state<TerminalViewState>(viewFor(codex)), same(view));
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(milliseconds: 100));
    },
  );

  for (final (label, shortcut) in [
    ('New Tab', LogicalKeyboardKey.keyT),
    ('Open Harness', LogicalKeyboardKey.keyP),
  ]) {
    testWidgets('native created $label gets terminal input without a click', (
      tester,
    ) async {
      final connection = _CreationConnection();
      final app = createApp(connectionForTest: (_) => connection);
      app.gitProjectReaderForTest = (_, _) async => {'isGit': false};
      seedMixedAgents(app);
      app.machineStates['m']!
        ..localOnly = true
        ..terminalCapabilityAvailable = true;
      final originalInput = <TerminalBinaryFrame>[];
      app.adoptSessionForTest(terminal('a0', originalInput));
      final source = app.activeSwarm;
      addTearDown(app.dispose);
      addTearDown(connection.close);
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: SwarmScreen(notifier: app, nativeTabs: true),
        ),
      );
      await tester.pump(const Duration(milliseconds: 200));
      if (shortcut == LogicalKeyboardKey.keyT) {
        await key(tester, shortcut, cmd: true);
        expect(find.byType(WorkspaceWelcome), findsOneWidget);
        expect(find.byKey(const ValueKey('swarm-search-input')), findsNothing);
      }
      await key(tester, LogicalKeyboardKey.keyP, cmd: true);
      final search = find.byKey(const ValueKey('swarm-search-input'));
      await tester.enterText(search, 'Check retargeted keyboard input');
      await key(tester, LogicalKeyboardKey.keyP, cmd: true);
      await key(tester, LogicalKeyboardKey.keyP, cmd: true);
      final destination = app.activeSwarm;
      expect(find.text('Check retargeted keyboard input'), findsWidgets);
      expect(find.text('New Pane'), findsNothing);
      await key(tester, LogicalKeyboardKey.enter);
      expect(find.byType(NewHarnessForm), findsNothing);
      await key(tester, LogicalKeyboardKey.keyN, cmd: true);
      expect(find.byType(NewHarnessForm), findsOneWidget);
      expect(
        tester
            .widget<NewHarnessForm>(find.byType(NewHarnessForm))
            .controller
            .task,
        'Check retargeted keyboard input',
      );
      await startHarness(tester);
      await tester.pump(const Duration(milliseconds: 200));
      await tester.pump();
      expect(find.byType(NewHarnessForm), findsNothing);
      expect(app.activeSwarm, same(destination));
      expect(
        app.activeSwarm,
        shortcut == LogicalKeyboardKey.keyT
            ? isNot(same(source))
            : same(source),
      );
      final session = app.focusedPane!.session!;
      final view = tester.widget<TerminalView>(
        find.byWidgetPredicate(
          (widget) =>
              widget is TerminalView &&
              identical(widget.terminal, session.terminal),
        ),
      );
      expect(view.focusNode!.hasFocus, isTrue);
      session.status = TerminalSessionStatus.controlling;
      session.streamId = '00000000-0000-4000-8000-000000000002';
      session.notifyListeners();
      await tester.pump();
      await key(tester, LogicalKeyboardKey.arrowRight);
      await tester.pump(const Duration(milliseconds: 20));
      expect(connection.input.single.bytes, [27, 91, 67]);
      expect(originalInput, isEmpty);
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(milliseconds: 100));
    });
  }

  for (final (entry, task) in [
    ('Open', null),
    ('Try', 'Model a reading nook'),
    ('Models', null),
  ]) {
    testWidgets(
      entry == 'Models'
          ? 'native Models replaces pending creation with its overview without launching'
          : 'native Store $entry switches products and focuses the started pane',
      (tester) async {
        const products = [
          {
            'id': 'autonomous/workshop',
            'name': 'Autonomous Workshop',
            'engine': 'claude',
            'installed': true,
          },
          {
            'id': 'autonomous/blender',
            'name': 'Blender',
            'engine': 'claude',
            'installed': true,
          },
          {
            'id': AppNotifier.gridHarness,
            'name': 'Grid',
            'engine': 'claude',
            'installed': true,
          },
        ];
        final connection = _CreationConnection(products: products);
        final app = _FirstCreationApp(connection);
        seedMixedAgents(app);
        app.machineStates['m']!
          ..localOnly = true
          ..terminalCapabilityAvailable = true
          ..dsh.replace(products.map((json) => DshEntry.fromJson(json)!));
        final originalInput = <TerminalBinaryFrame>[];
        app.adoptSessionForTest(terminal('a0', originalInput));
        app.openStore();
        final store = app.activeSwarm;
        addTearDown(app.dispose);
        addTearDown(connection.close);
        await tester.pumpWidget(
          MaterialApp(
            theme: grid.buildAppTheme(brightness: Brightness.dark),
            home: SwarmScreen(notifier: app, nativeTabs: true),
          ),
        );
        await tester.pump(const Duration(milliseconds: 200));
        NewHarnessController prompt() => tester
            .widget<NewHarnessForm>(find.byType(NewHarnessForm))
            .controller;
        Future<void> open(String id, {String? task}) async {
          await openStoreAgent(
            tester.element(find.byType(StoreTab)),
            app,
            id,
            'm',
            prompt: task,
          );
          await tester.pump(const Duration(milliseconds: 200));
        }

        await open('autonomous/workshop');
        expect(
          prompt().projectLabel,
          startsWith('~/harnesses/autonomous-workshop-'),
        );
        if (entry == 'Models') {
          final reply = Completer<void>();
          tester.binding.defaultBinaryMessenger.handlePlatformMessage(
            'harness/swarm_tabs',
            const StandardMethodCodec().encodeMethodCall(
              const MethodCall('runLocalModel', {'machineId': 'm'}),
            ),
            (_) => reply.complete(),
          );
          await tester.pump(const Duration(milliseconds: 200));
          await reply.future;
          expect(find.byType(NewHarnessForm), findsNothing);
          expect(find.byType(ModelsPanel), findsOneWidget);
          expect(connection.creates, isEmpty);
          expect(app.activeSwarm, same(store));
          await key(tester, LogicalKeyboardKey.escape);
          await tester.pump(const Duration(milliseconds: 100));
          expect(find.byType(ModelsPanel), findsNothing);
          expect(connection.creates, isEmpty);
          expect(originalInput, isEmpty);
          await tester.pumpWidget(const SizedBox());
          await tester.pump(const Duration(milliseconds: 100));
          return;
        }
        await open('autonomous/blender', task: task);
        const product = 'autonomous/blender';
        const prefix = 'blender';
        expect(prompt().engine, product);
        expect(prompt().projectLabel, startsWith('~/harnesses/$prefix-'));
        expect(prompt().task, task ?? '');
        final folder = prompt().projectFolderRequest!.folderName;
        expect(app.activeSwarm, same(store));
        expect(connection.creates, isEmpty);
        await startHarness(tester);
        await tester.pump(const Duration(milliseconds: 200));
        await tester.pump();
        expect(connection.creates, hasLength(1));
        expect(connection.creates.single['dsh'], product);
        expect(connection.creates.single['prompt'], task);
        expect(connection.creates.single['cwd'], '/fixture/harnesses/$folder');
        expect(find.byType(NewHarnessForm), findsNothing);
        expect(app.activeSwarm.isStore, isFalse);
        final session = app.focusedPane!.session!;
        final view = tester.widget<TerminalView>(
          find.byWidgetPredicate(
            (widget) =>
                widget is TerminalView &&
                identical(widget.terminal, session.terminal),
          ),
        );
        expect(view.focusNode!.hasFocus, isTrue);
        session.status = TerminalSessionStatus.controlling;
        session.streamId = '00000000-0000-4000-8000-000000000002';
        session.notifyListeners();
        await tester.pump();
        await key(tester, LogicalKeyboardKey.arrowRight);
        expect(connection.input.single.bytes, [27, 91, 67]);
        expect(originalInput, isEmpty);
        await tester.pumpWidget(const SizedBox());
        await tester.pump(const Duration(milliseconds: 100));
      },
    );
  }

  testWidgets(
    'native creation retains edited defaults and uses the chosen destination',
    (tester) async {
      final connection = _CreationConnection();
      final app = createApp(connectionForTest: (_) => connection);
      seedMixedAgents(app);
      final input = <TerminalBinaryFrame>[];
      final original = app.adoptSessionForTest(terminal('a0', input));
      final source = app.activeSwarm;
      final projects = SwarmProjectStore();
      addTearDown(app.dispose);
      addTearDown(projects.dispose);
      addTearDown(connection.close);
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: SwarmScreen(
            notifier: app,
            nativeTabs: true,
            projectStore: projects,
          ),
        ),
      );
      await tester.pump(const Duration(milliseconds: 200));

      NewHarnessController prompt() =>
          tester.widget<NewHarnessForm>(find.byType(NewHarnessForm)).controller;
      const task = 'Refine terminal workspace; keep running sessions attached';
      await key(tester, LogicalKeyboardKey.keyP, cmd: true);
      await tester.enterText(
        find.byKey(const ValueKey('swarm-search-input')),
        task,
      );
      await key(tester, LogicalKeyboardKey.enter);
      expect(find.byType(NewHarnessForm), findsNothing);
      await key(tester, LogicalKeyboardKey.keyN, cmd: true);
      await tester.pump(const Duration(milliseconds: 80));
      expect(prompt().engine, 'codex');
      expect(prompt().machineId, 'm');
      expect(prompt().project.folder, '/work/openharness');
      expect(prompt().task, task);
      expect(app.swarms, [source]);
      expect(app.activeSwarm, same(source));
      expect(prompt().field, NewHarnessField.projectMenu);

      await openLaunchRow(tester, 'machine');
      await key(tester, LogicalKeyboardKey.enter);
      expect(prompt().machineId, 'm');
      await openLaunchRow(tester, 'project');
      await typeHarnessQuery(tester, 'openharness');
      await key(tester, LogicalKeyboardKey.enter);
      expect(prompt().project.folder, '/work/openharness');

      await openLaunchRow(tester, 'profile');
      expect(prompt().field, NewHarnessField.profile);
      await key(tester, LogicalKeyboardKey.escape);
      await openLaunchRow(tester, 'agent');
      await typeHarnessQuery(tester, 'claude');
      expect(prompt().engine, 'codex');
      expect(
        find.byKey(const ValueKey('new-harness-field-profile')),
        findsOneWidget,
      );
      await key(tester, LogicalKeyboardKey.enter);
      expect(prompt().engine, 'claude');
      expect(prompt().task, task);
      expect(
        find.byKey(const ValueKey('new-harness-field-profile')),
        findsNothing,
      );

      await openLaunchRow(tester, 'project');
      await typeHarnessQuery(tester, 'does-not-match-any-existing-project');
      for (
        var step = 0;
        prompt().selected?.id != NewHarnessController.existingProjectId &&
            step < 8;
        step++
      ) {
        await key(tester, LogicalKeyboardKey.arrowDown);
      }
      expect(prompt().selected?.id, NewHarnessController.existingProjectId);
      await key(tester, LogicalKeyboardKey.enter);
      expect(prompt().field, NewHarnessField.project);
      expect(prompt().options.single.id, NewHarnessController.browseId);
      await key(tester, LogicalKeyboardKey.escape);
      expect(prompt().field, NewHarnessField.projectMenu);

      await openLaunchRow(tester, 'approvals');
      await typeHarnessQuery(tester, 'Plan first');
      await key(tester, LogicalKeyboardKey.enter);
      expect(prompt().mode, 'plan');
      await key(tester, LogicalKeyboardKey.escape);
      expect(find.byType(NewHarnessForm), findsNothing);
      expect(app.swarms, [source]);
      expect(
        input,
        isEmpty,
        reason:
            'Picker input must stay out of the terminal: '
            '${input.map((frame) => (frame.kind.name, frame.bytes.toList())).toList()}',
      );
      expect(connection.creates, isEmpty);

      // Reopen from the same source. Escape kept the task and edited defaults
      // without creating a temporary tab.
      await key(tester, LogicalKeyboardKey.keyN, cmd: true);
      await tester.pump(const Duration(milliseconds: 80));
      expect(prompt().engine, 'claude');
      expect(prompt().mode, 'plan');
      expect(prompt().task, task);
      expect(prompt().project.folder, '/work/openharness');
      await startHarness(tester);
      await tester.pump(const Duration(milliseconds: 200));
      expect(find.byType(NewHarnessForm), findsNothing);
      expect(app.activeSwarm, same(source));
      expect(source.panes.length, 2);
      expect(source.panes.first, same(original));
      expect(app.focusedPane!.agentId, 'made');
      expect(connection.creates.single, containsPair('prompt', task));
      expect(connection.creates.single, containsPair('engine', 'claude'));
      expect(connection.creates.single, containsPair('permissionMode', 'plan'));
      expect(
        connection.creates.single,
        containsPair('cwd', '/work/openharness'),
      );

      // The just-created agent is immediately searchable and names a new tab.
      await key(tester, LogicalKeyboardKey.keyT, cmd: true);
      await key(tester, LogicalKeyboardKey.keyP, cmd: true);
      await tester.enterText(
        find.byKey(const ValueKey('swarm-search-input')),
        'Refine terminal workspace',
      );
      await key(tester, LogicalKeyboardKey.enter);
      expect(app.activeSwarm, isNot(same(source)));
      expect(app.activeSwarm.name, 'Refine terminal workspace');
      expect(app.focusedPane!.agentId, 'made');
      expect(connection.creates.length, 1);
      expect(input, isEmpty);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(milliseconds: 100));
    },
  );

  testWidgets(
    'native link prompt retries and resumes without losing terminal input',
    (tester) async {
      final links = _WorkspaceLinks();
      final app = AppNotifier(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
        peerLinks: links,
        cliLink: PasswordCli(),
      )..hasNavigationRail = false;
      seedMixedAgents(app);
      final input = <TerminalBinaryFrame>[];
      final session = terminal('a0', input);
      final pane = app.adoptSessionForTest(session);
      app.machineStates['studio']!.needsLink = true;
      app.selectedMachineId = 'studio';
      final projects = SwarmProjectStore();
      addTearDown(app.dispose);
      addTearDown(projects.dispose);
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: SwarmScreen(
            notifier: app,
            nativeTabs: true,
            projectStore: projects,
          ),
        ),
      );
      await tester.pump(const Duration(milliseconds: 200));
      final field = find.byKey(const ValueKey('connect-password-studio-input'));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('machines-panel')), findsOneWidget);
      expect(tester.widget<TextField>(field).focusNode!.hasFocus, isTrue);
      await tester.enterText(field, 'fixture password');
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await tester.pump();
      expect(links.requests, ['studio']);
      expect(tester.widget<TextField>(field).readOnly, isTrue);
      links.replies.first.complete(
        const CliLinkConnectResult(error: 'Incorrect password'),
      );
      await tester.pump(const Duration(milliseconds: 80));
      expect(find.text('Incorrect password'), findsOneWidget);
      expect(tester.widget<TextField>(field).focusNode!.hasFocus, isTrue);
      await tester.enterText(field, 'correct fixture password');
      await key(tester, LogicalKeyboardKey.enter);
      expect(links.requests, ['studio', 'studio']);
      await key(tester, LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('machines-panel')), findsNothing);
      expect(app.focusedPane, same(pane));
      expect(input, isEmpty);
      await key(tester, LogicalKeyboardKey.arrowLeft);
      expect(input.single.bytes, [27, 91, 68]);
      input.clear();
      await key(tester, LogicalKeyboardKey.keyM, cmd: true);
      await tester.pumpAndSettle();
      expect(tester.widget<TextField>(field).readOnly, isTrue);
      expect(tester.widget<TextField>(field).controller!.text, isEmpty);
      await key(tester, LogicalKeyboardKey.enter);
      expect(links.requests, ['studio', 'studio']);
      links.replies.last.complete(
        const CliLinkConnectResult(linkedMachineId: 'studio'),
      );
      await tester.pumpAndSettle();
      expect(app.machineStates['studio']!.needsLink, isFalse);
      expect(field, findsNothing);
      expect(pane.session, same(session));
      expect(input, isEmpty);
      await key(tester, LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      await key(tester, LogicalKeyboardKey.arrowRight);
      await tester.pump(const Duration(milliseconds: 20));
      expect(input.single.bytes, [27, 91, 67]);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(milliseconds: 100));
    },
  );

  testWidgets(
    'native local password prompt survives pending changes and returns to its terminal',
    (tester) async {
      final cli = PasswordCli()
        ..setReply = Completer<RemotePasswordSetResult>();
      final app = AppNotifier(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
        cliLink: cli,
      )..hasNavigationRail = false;
      seedMixedAgents(app);
      app.machineStates['m']!.localOnly = true;
      final input = <TerminalBinaryFrame>[];
      final session = terminal('a0', input);
      final pane = app.adoptSessionForTest(session);
      final projects = SwarmProjectStore();
      addTearDown(app.dispose);
      addTearDown(projects.dispose);
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: SwarmScreen(
            notifier: app,
            nativeTabs: true,
            projectStore: projects,
          ),
        ),
      );
      await tester.pumpAndSettle();
      await key(tester, LogicalKeyboardKey.keyM, cmd: true);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Set password'));
      await tester.pumpAndSettle();
      final password = find.byKey(const ValueKey('make-available-password'));
      expect(tester.widget<TextField>(password).focusNode!.hasFocus, isTrue);
      await tester.enterText(password, 'fixture password');
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await tester.pumpAndSettle();
      expect(cli.passwords, ['fixture password']);
      await key(tester, LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      await key(tester, LogicalKeyboardKey.keyM, cmd: true);
      await tester.pumpAndSettle();
      expect(find.text('Saving password…'), findsOneWidget);
      expect(cli.passwords, hasLength(1));
      cli.setReply!.complete(cli.setResult);
      await tester.pumpAndSettle();
      expect(find.text('Change password'), findsOneWidget);
      await tester.tap(find.text('Change password'));
      await tester.pumpAndSettle();
      expect(tester.widget<TextField>(password).focusNode!.hasFocus, isTrue);
      expect(tester.widget<TextField>(password).controller!.text, isEmpty);
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      expect(find.text('Change password'), findsOneWidget);
      await key(tester, LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(app.focusedPane, same(pane));
      expect(pane.session, same(session));
      expect(input, isEmpty);
      await key(tester, LogicalKeyboardKey.arrowRight);
      await tester.pump(const Duration(milliseconds: 20));
      expect(input.single.bytes, [27, 91, 67]);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(milliseconds: 100));
    },
  );

  testWidgets('native Machines keeps pending edits and terminal ownership', (
    tester,
  ) async {
    final api = MachineApi()
      ..renameReply = Completer<String?>()
      ..deleteReply = Completer<void>();
    final app = createApp()..api = api;
    seedMixedAgents(app);
    final input = <TerminalBinaryFrame>[];
    final session = terminal('a0', input);
    final pane = app.adoptSessionForTest(session);
    final projects = SwarmProjectStore();
    addTearDown(app.dispose);
    addTearDown(projects.dispose);
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: SwarmScreen(
          notifier: app,
          nativeTabs: true,
          projectStore: projects,
        ),
      ),
    );
    await tester.pumpAndSettle();
    await key(tester, LogicalKeyboardKey.keyM, cmd: true);
    await tester.pumpAndSettle();
    Future<void> action(String label) async {
      final options = find.byTooltip(
        'Options for ${app.stateOf('studio')!.machine.displayName}',
      );
      await tester.ensureVisible(options);
      await tester.tap(options);
      await tester.pumpAndSettle();
      await tester.tap(find.text(label));
      await tester.pumpAndSettle();
    }

    await action('Rename');
    final rename = find.byKey(const Key('machine-rename-input'));
    expect(tester.widget<TextField>(rename).focusNode!.hasFocus, isTrue);
    tester.testTextInput.enterText('Office builder');
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.pumpAndSettle();
    expect(api.renames, [('studio', 'Office builder')]);
    await key(tester, LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('machines-panel')), findsOneWidget);
    await action('Rename');
    expect(tester.widget<TextField>(rename).readOnly, isTrue);
    expect(api.renames, hasLength(1));
    api.renameReply!.complete('Office builder');
    await tester.pumpAndSettle();
    expect(find.text('Office builder'), findsOneWidget);
    await action('Remove from account…');
    await key(tester, LogicalKeyboardKey.enter); // Cancel is the default.
    await tester.pumpAndSettle();
    expect(api.deletes, isEmpty);
    await action('Remove from account…');
    await tester.tap(find.byKey(const Key('machine-delete-confirm')));
    await tester.pumpAndSettle();
    expect(api.deletes, ['studio']);
    await key(tester, LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    await action('Remove from account…');
    expect(find.text('Deleting machine…'), findsOneWidget);
    expect(api.deletes, hasLength(1));
    api.deleteReply!.complete();
    await tester.pumpAndSettle();
    expect(app.stateOf('studio'), isNull);
    expect(find.byKey(const ValueKey('machines-panel')), findsOneWidget);
    await key(tester, LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    expect(app.focusedPane, same(pane));
    expect(pane.session, same(session));
    expect(input, isEmpty);
    await key(tester, LogicalKeyboardKey.arrowLeft);
    await tester.pump(const Duration(milliseconds: 20));
    expect(input.single.bytes, [27, 91, 68]);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(milliseconds: 100));
  });
  testWidgets(
    'native rename prompts keep pending work and return terminal input',
    (tester) async {
      final connection = RenameConnection();
      final app = createApp(connectionForTest: (_) => connection);
      seedMixedAgents(app);
      final input = <TerminalBinaryFrame>[];
      final session = terminal('a0', input);
      final pane = app.adoptSessionForTest(session);
      final projects = SwarmProjectStore();
      addTearDown(app.dispose);
      addTearDown(projects.dispose);
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: SwarmScreen(
            notifier: app,
            nativeTabs: true,
            projectStore: projects,
          ),
        ),
      );
      await tester.pumpAndSettle();
      Future<void> command(String query) async {
        await key(tester, LogicalKeyboardKey.keyP, cmd: true, shift: true);
        await tester.enterText(
          find.byKey(const ValueKey('swarm-search-input')),
          '> $query',
        );
        await key(tester, LogicalKeyboardKey.enter);
        await tester.pumpAndSettle();
      }

      await command('rename tab');
      final tab = find.byKey(const Key('tab-rename-input'));
      expect(tester.widget<TextField>(tab).focusNode!.hasPrimaryFocus, isTrue);
      tester.testTextInput.enterText('Parser work');
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await tester.pumpAndSettle();
      expect(app.activeSwarm.name, 'Parser work');
      await command('rename agent');
      final agent = find.byKey(const Key('agent-rename-input'));
      expect(
        tester.widget<TextField>(agent).focusNode!.hasPrimaryFocus,
        isTrue,
      );
      tester.testTextInput.enterText('Resolve parser edge');
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await tester.pumpAndSettle();
      expect(connection.renames.single, {
        'agentId': 'a0',
        'name': 'Resolve parser edge',
      });
      await key(tester, LogicalKeyboardKey.escape);
      await command('rename agent');
      expect(tester.widget<TextField>(agent).readOnly, isTrue);
      expect(connection.renames, hasLength(1));
      connection.replies.single.complete({
        'error': 'OFFLINE',
        'detail': 'Reconnect and retry.',
      });
      await tester.pumpAndSettle();
      expect(
        tester.widget<TextField>(agent).focusNode!.hasPrimaryFocus,
        isTrue,
      );
      tester.testTextInput.enterText('Resolve parser edge');
      await key(tester, LogicalKeyboardKey.keyW, ctrl: true);
      expect(
        tester.widget<TextField>(agent).controller!.text,
        'Resolve parser ',
      );
      await key(tester, LogicalKeyboardKey.enter);
      connection.replies.last.complete({
        'agent': {'name': 'Resolve parser'},
      });
      await tester.pumpAndSettle();
      expect(agent, findsNothing);
      expect(session.agentName, 'Resolve parser');
      expect(app.focusedPane, same(pane));
      expect(app.activeSwarm.name, 'Parser work');
      expect(input, isEmpty);
      await key(tester, LogicalKeyboardKey.arrowLeft);
      await tester.pump(const Duration(milliseconds: 20));
      expect(input.single.bytes, [27, 91, 68]);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(milliseconds: 100));
    },
  );
  testWidgets(
    'native stop confirmation retains pending work and restores the other terminal',
    (tester) async {
      final connection = StopConnection();
      final app = createApp(connectionForTest: (_) => connection);
      seedMixedAgents(app);
      final input = <TerminalBinaryFrame>[];
      final session = terminal('a0', input);
      final retained = app.adoptSessionForTest(session);
      app.adoptSessionForTest(terminal('a1', input));
      final projects = SwarmProjectStore();
      addTearDown(app.dispose);
      addTearDown(projects.dispose);
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: SwarmScreen(
            notifier: app,
            nativeTabs: true,
            projectStore: projects,
          ),
        ),
      );
      await tester.pumpAndSettle();
      Future<void> openStop() async {
        await key(tester, LogicalKeyboardKey.keyP, cmd: true, shift: true);
        await tester.enterText(
          find.byKey(const ValueKey('swarm-search-input')),
          '> stop',
        );
        await key(tester, LogicalKeyboardKey.enter);
        await tester.pumpAndSettle();
      }

      await openStop();
      await key(tester, LogicalKeyboardKey.enter); // Cancel by default.
      await tester.pumpAndSettle();
      expect(connection.stops, isEmpty);
      expect(find.text('Stop Agent'), findsNothing);
      await openStop();
      await key(tester, LogicalKeyboardKey.tab);
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(connection.stops, ['a1']);
      expect(find.text('Stopping…'), findsOneWidget);
      await key(tester, LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      await openStop();
      expect(find.text('Stopping…'), findsOneWidget);
      expect(connection.stops, hasLength(1));
      connection.stopReplies.single.complete({
        'error': 'OFFLINE',
        'detail': 'Reconnect and retry.',
      });
      await tester.pumpAndSettle();
      expect(find.text('Stop failed: Reconnect and retry.'), findsOneWidget);
      await key(tester, LogicalKeyboardKey.tab);
      await key(tester, LogicalKeyboardKey.enter);
      connection.stopReplies.last.complete({'deleted': true});
      await tester.pumpAndSettle();
      expect(find.text('Stop Agent'), findsNothing);
      expect(app.allPanes, [retained]);
      expect(app.focusedPane, same(retained));
      expect(retained.session, same(session));
      expect(input, isEmpty);
      await key(tester, LogicalKeyboardKey.arrowLeft);
      await tester.pump(const Duration(milliseconds: 20));
      expect(input.single.streamId, 'stream-a0');
      expect(input.single.bytes, [27, 91, 68]);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(milliseconds: 100));
    },
  );
  testWidgets(
    'native fork prompt retains drafts and checks a lost receipt without duplication',
    (tester) async {
      final connection = ForkConnection();
      final app = createApp(connectionForTest: (_) => connection);
      seedMixedAgents(app);
      final input = <TerminalBinaryFrame>[];
      final session = terminal('a0', input);
      final source = app.adoptSessionForTest(session);
      final projects = SwarmProjectStore();
      addTearDown(app.dispose);
      addTearDown(projects.dispose);
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: SwarmScreen(
            notifier: app,
            nativeTabs: true,
            projectStore: projects,
          ),
        ),
      );
      await tester.pumpAndSettle();
      Future<void> openFork() async {
        await key(tester, LogicalKeyboardKey.keyP, cmd: true, shift: true);
        await tester.enterText(
          find.byKey(const ValueKey('swarm-search-input')),
          '> fork',
        );
        await key(tester, LogicalKeyboardKey.enter);
        await tester.pumpAndSettle();
      }

      final task = find.byKey(const ValueKey('fork-task'));
      await openFork();
      expect(tester.widget<TextField>(task).focusNode!.hasPrimaryFocus, isTrue);
      tester.testTextInput.enterText('Try a smaller change');
      await key(tester, LogicalKeyboardKey.enter, alt: true);
      expect(
        tester.widget<TextField>(task).controller!.text,
        'Try a smaller change\n',
      );
      await key(tester, LogicalKeyboardKey.escape);
      await openFork();
      expect(
        tester.widget<TextField>(task).controller!.text,
        'Try a smaller change\n',
      );
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await tester.pumpAndSettle();
      final id = connection.forks.single['creationId'] as String;
      expect(connection.forks.single['prompt'], 'Try a smaller change\n');
      await key(tester, LogicalKeyboardKey.escape);
      await openFork();
      expect(connection.forks, hasLength(1));
      expect(tester.widget<TextField>(task).readOnly, isTrue);
      connection.forkReplies.single.completeError(
        const WsRequestTimeout('agent_fork'),
      );
      await tester.pumpAndSettle();
      expect(find.text('enter  check status'), findsOneWidget);
      await key(tester, LogicalKeyboardKey.enter);
      expect(connection.checks, [
        {'creationId': id},
      ]);
      connection.checkReplies.single.complete(forkReceipt(id));
      // The new pane has no live PTY transport in this fixture, so its attaching
      // animation intentionally remains. The receipt and route still complete.
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 120));
      expect(task, findsNothing);
      expect(app.panes.map((pane) => pane.agentId), ['a0', 'forked']);
      expect(app.focusedPane!.agentId, 'forked');
      expect(source.session, same(session));
      expect(connection.forks, hasLength(1));
      expect(input, isEmpty);
      await key(tester, LogicalKeyboardKey.keyH, cmd: true);
      expect(app.focusedPane, same(source));
      await key(tester, LogicalKeyboardKey.arrowLeft);
      await tester.pump(const Duration(milliseconds: 20));
      expect(input.single.bytes, [27, 91, 68]);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(milliseconds: 100));
    },
  );
  testWidgets(
    'native restart rejoins pending work and recovers without replacing the terminal view',
    (tester) async {
      final connection = RestartConnection();
      final app = createApp(connectionForTest: (_) => connection);
      seedMixedAgents(app);
      final input = <TerminalBinaryFrame>[];
      final session = terminal('a0', input);
      final source = app.adoptSessionForTest(session);
      final projects = SwarmProjectStore();
      addTearDown(app.dispose);
      addTearDown(projects.dispose);
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: SwarmScreen(
            notifier: app,
            nativeTabs: true,
            projectStore: projects,
          ),
        ),
      );
      await tester.pumpAndSettle();
      Future<void> openRestart() async {
        await key(tester, LogicalKeyboardKey.keyP, cmd: true, shift: true);
        await tester.enterText(
          find.byKey(const ValueKey('swarm-search-input')),
          '> restart',
        );
        await key(tester, LogicalKeyboardKey.enter);
        await tester.pumpAndSettle();
      }

      await openRestart();
      expect(find.text('Restarting…'), findsOneWidget);
      await key(tester, LogicalKeyboardKey.escape);
      await openRestart();
      expect(connection.requests, hasLength(1));
      final id = connection.requests.single['creationId'] as String;
      connection.restartReplies.single.completeError(
        const WsRequestTimeout('agent_restart'),
      );
      await tester.pumpAndSettle();
      await key(tester, LogicalKeyboardKey.enter);
      expect(connection.checks, [
        {'creationId': id},
      ]);
      connection.checkReplies.single.complete(
        restartReceipt(id, resumed: false),
      );
      await tester.pumpAndSettle();
      expect(
        find.text(
          'Started a new conversation. The previous session could not be resumed.',
        ),
        findsOneWidget,
      );
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('agent-restart-prompt')), findsNothing);
      expect(app.panes, [source]);
      expect(source.session, same(session));
      expect(connection.requests, hasLength(1));
      expect(input, isEmpty);
      await key(tester, LogicalKeyboardKey.arrowLeft);
      await tester.pump(const Duration(milliseconds: 20));
      expect(input.single.bytes, [27, 91, 68]);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(milliseconds: 100));
    },
  );
}
