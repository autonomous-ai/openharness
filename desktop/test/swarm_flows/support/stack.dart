import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/auth/cli_login.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/state/pane_layout_store.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/ws/local_cli_discovery.dart';
import 'package:harness/ws/local_daemon_transport.dart';
import 'package:harness/ws/ws_conn.dart';

import '../../swarm_state_test.dart' show MemoryStore;

/// The header every control request carries the run's token in.
const controlTokenHeader = 'x-swarm-flows-token';

/// The repository's cli/ folder: set by scripts/swarm-flows.sh. Without it
/// every flow skips, so the ordinary unit suite never boots a backend.
final cliRoot = Platform.environment['HARNESS_SWARM_FLOWS_CLI_ROOT'];
const skipReason = 'Swarm flows run through scripts/swarm-flows.sh.';

/// The disposable backend and daemon of scripts/swarm-flows-stack.mts, one per
/// test file. Nothing in it is the person's own login, daemon or data.
class SwarmStack {
  SwarmStack._(this._process, this.config, this._errors);
  final Process _process;
  final Map<String, dynamic> config;
  final StringBuffer _errors;

  String get machineId => config['machineId'] as String;
  Map<String, dynamic> get owner => config['owner'] as Map<String, dynamic>;
  Map<String, dynamic> get teammate =>
      config['teammate'] as Map<String, dynamic>;

  /// Where the backend's log is, and what the stack said, for a failing flow.
  String get diagnostics => 'backend log ${config['logs']}\n$_errors';

  static Future<SwarmStack> start() async {
    final process = await Process.start('node', [
      '--import',
      'tsx',
      '../scripts/swarm-flows-stack.mts',
    ], workingDirectory: cliRoot);
    final errors = StringBuffer();
    process.stderr.transform(utf8.decoder).listen(errors.write);
    final ready = Completer<Map<String, dynamic>>();
    process.stdout
        .transform(utf8.decoder)
        .transform(const LineSplitter())
        .listen(
          (line) {
            if (ready.isCompleted) return;
            try {
              final value = jsonDecode(line);
              if (value is Map<String, dynamic> &&
                  value.containsKey('socketPath')) {
                ready.complete(value);
              }
            } on FormatException {
              // Dependency diagnostics, not the ready line.
            }
          },
          onDone: () {
            if (!ready.isCompleted) {
              ready.completeError(StateError('Swarm stack exited: $errors'));
            }
          },
        );
    final config = await ready.future.timeout(
      const Duration(minutes: 4),
      onTimeout: () => throw TimeoutException('Swarm stack start: $errors'),
    );
    return SwarmStack._(process, config, errors);
  }

  Future<void> stop() async {
    await _process.stdin.close();
    await _process.exitCode.timeout(
      const Duration(seconds: 30),
      onTimeout: () {
        _process.kill();
        return -1;
      },
    );
  }

  Future<Map<String, dynamic>> _control(String path, Object body) async {
    final client = HttpClient();
    try {
      final request = await client
          .post('127.0.0.1', config['controlPort'] as int, path)
          .timeout(const Duration(seconds: 10));
      request.headers.contentType = ContentType.json;
      request.write(jsonEncode(body));
      final response = await request.close().timeout(
        const Duration(seconds: 60),
      );
      final text = await response.transform(utf8.decoder).join();
      return jsonDecode(text) as Map<String, dynamic>;
    } finally {
      client.close(force: true);
    }
  }

  /// A backend call as [as] ('owner' or 'teammate'): setup a person did
  /// elsewhere, never the step under test.
  Future<Map<String, dynamic>> api(
    String path, {
    String as = 'owner',
    String method = 'GET',
    Object? body,
  }) async {
    final result = await _control('/api', {
      'as': as,
      'path': path,
      'method': method,
      'body': ?body,
    });
    final status = result['status'] as int;
    if (status >= 300) {
      throw StateError('$method $path as $as: $status ${result['body']}');
    }
    return (result['body'] as Map).cast<String, dynamic>();
  }

  /// A new Swarm of [as]'s, as New Swarm makes it; its tab id.
  Future<String> newSwarm(String name, {String as = 'owner'}) async {
    final created = await api(
      '/api/super-tabs',
      as: as,
      method: 'POST',
      body: {
        'operationId': 'flow-swarm-${DateTime.now().microsecondsSinceEpoch}',
        'name': name,
      },
    );
    return (created['data'] as Map)['id'] as String;
  }

  /// One Swarm command as [as], with a fresh operation id.
  Future<Map<String, dynamic>> command(
    String tabId,
    Map<String, Object?> command, {
    String as = 'owner',
    String? asAgentId,
  }) => api(
    '/api/super-tabs/$tabId/commands',
    as: as,
    method: 'POST',
    body: {
      'operationId': 'flow-${DateTime.now().microsecondsSinceEpoch}',
      'command': command,
      'asAgentId': ?asAgentId,
    },
  );

  /// Makes the fake engine [name] crash when it starts, or work again.
  Future<void> engineCrashes(String name, bool crashes) =>
      _control('/engine', {'name': name, 'crashes': crashes});

  /// What an agent runs: `harness super-tab --tab TAB --agent AGENT …args`.
  Future<String> asAgent(
    String tabId,
    String agentId,
    List<String> args,
  ) async {
    final result = await _control('/agent', {
      'tab': tabId,
      'agent': agentId,
      'args': args,
    });
    if (result['code'] != 0) {
      throw StateError('agent $agentId ${args.first}: ${result['out']}');
    }
    return result['out'] as String;
  }
}

/// One flow, as a person on a Mac does it. The name is what a failing release
/// gate reports (scripts/swarm-flows.sh).
/// [skip] names the bug a flow found, until its fix lands; the flow keeps
/// asserting what is right.
void flowTest(
  String name,
  Future<void> Function(WidgetTester tester) body, {
  String? skip,
}) => testWidgets(
  name,
  body,
  skip: skip != null,
  variant: TargetPlatformVariant.only(TargetPlatform.macOS),
  timeout: const Timeout(Duration(minutes: 3)),
);

/// A person's sign-in that is always signed in and never runs the real CLI.
class FakeSignIn extends CliLogin {
  @override
  Future<CliAuthStatus> checkStatus() async => CliAuthStatus(loggedIn: true);

  @override
  Future<void> logout() async {}
}

/// The real app, its machine this computer's daemon of [stack], reached over
/// the daemon's socket exactly as the shipped app reaches it.
class FlowApp {
  FlowApp._(this._tester, this.stack, this.app, this.connection);
  final WidgetTester _tester;
  final SwarmStack stack;
  final AppNotifier app;
  final WsConn connection;

  static Future<FlowApp> open(WidgetTester tester, SwarmStack stack) async {
    // What the shipped app does: New Harness in the box ([flowTest] gives it
    // a Mac's keys and layout).
    newHarnessOpensInBox = true;
    addTearDown(() => newHarnessOpensInBox = false);
    late final AppNotifier app;
    final machineId = stack.machineId;
    final connection = WsConn(
      wsBaseUrl: '',
      autonomousEnv: 'prod',
      machineId: machineId,
      accessTokenProvider: (_, _) async => '',
      onAuthFailure: (message) => throw StateError('auth failure: $message'),
      onEvent: (event) => app.handleEventForTest(machineId, event),
      onStatus: (status) => app.connectionStatusForTest(machineId, status),
      transportKind: WsTransportKind.localPlaintext,
      localWsUri: Uri.parse(
        'ws://127.0.0.1:${stack.config['localPort']}/api/local-ws',
      ),
      localTransport: LocalDaemonTransport(
        candidate: stack.config['socketPath'] as String,
      ),
    );
    // Every store in memory: nothing reads or writes ~/.harness.
    final store = MemoryStore();
    app = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(storage: store),
      paneLayoutStore: PaneLayoutStore(storage: store),
      configStore: null,
      cliLogin: FakeSignIn(),
      connectionForTest: (_) => connection,
    )..hasNavigationRail = false;
    final machine = Machine(
      machineId: machineId,
      authMode: MachineAuthMode.remote,
      name: 'Studio Mac',
    );
    app.machines = [machine];
    app.machineStates[machineId] = MachineState(machine)
      ..localOnly = true
      ..nodeOnline = true
      ..localEndpoint = LocalCliEndpoint(
        computerId: 'swarm-flows',
        machineId: machineId,
        wsUri: Uri.parse(
          'ws://127.0.0.1:${stack.config['localPort']}/api/local-ws',
        ),
        protocolVersion: localWsProtocolVersion,
        terminalProtocolVersion: localTerminalProtocolVersion,
      );
    app.currentUser = CurrentUserProfile(
      id: stack.owner['id'] as String,
      email: stack.owner['email'] as String,
    );
    // The dial runs in real time; [until] below waits for it to be up.
    await tester.runAsync(() async => unawaited(connection.connect()));
    await tester.binding.setSurfaceSize(const Size(1440, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
      MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: grid.buildAppTheme(brightness: Brightness.light),
        home: SwarmScreen(notifier: app, nativeTabs: false),
      ),
    );
    final flow = FlowApp._(tester, stack, app, connection);
    await flow.until(
      'the daemon connection',
      () =>
          app.machineStates[machineId]?.connectionStatus ==
          ConnectionStatus.connected,
    );
    return flow;
  }

  /// The open Swarm [tabId]'s view state, once loaded.
  SuperTabController? swarm(String tabId) => app.superTabs.peek(tabId);

  /// Pumps frames, with real time passing for the backend and daemon, until
  /// [check] holds; a flow that never gets there fails naming [what].
  Future<void> until(
    String what,
    bool Function() check, {
    Duration timeout = const Duration(seconds: 30),
  }) async {
    final tester = _tester;
    final deadline = DateTime.now().add(timeout);
    while (true) {
      await tester.pump(const Duration(milliseconds: 16));
      if (check()) return;
      if (DateTime.now().isAfter(deadline)) {
        fail('Timed out waiting for $what\n${stack.diagnostics}');
      }
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 40)),
      );
    }
  }

  /// Waits for [finder] to show.
  Future<void> see(Finder finder, {String? what}) =>
      until(what ?? finder.toString(), () => finder.evaluate().isNotEmpty);

  /// Types [text] into [field] once it shows, as a person does.
  Future<void> type(Finder field, String text) async {
    await see(field);
    await _tester.enterText(field.first, text);
    await _tester.pump();
  }

  /// Fails at once, naming it, if a message containing [words] shows: a
  /// flow that dead-ends says why instead of timing out.
  void refuse(String words) {
    final shown = find.textContaining(words).evaluate();
    if (shown.isEmpty) return;
    final widget = shown.first.widget;
    fail(
      'The app said: ${widget is Text ? widget.data ?? widget.textSpan?.toPlainText() : words}',
    );
  }

  /// Taps what a person would tap once it shows.
  Future<void> tap(Finder finder, {String? what}) async {
    await see(finder, what: what);
    await _tester.tap(finder.first);
    await _tester.pump();
  }

  Future<void> close() async {
    await _tester.pumpWidget(const SizedBox());
    await _tester.runAsync(connection.close);
    app.dispose();
    // A request a closing view still sent can never be answered now: its
    // timeout (a fake-clock timer, at most a minute) ends it here.
    await _tester.pump(const Duration(minutes: 1, seconds: 1));
  }
}
