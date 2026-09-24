// Interactive QA host for the production workspace. Launch only in an isolated
// bundle with FLUTTER_TEST=1 and HARNESS_REVIEW_CATALOG pointing at fixture JSON.
// No provider calls, installs, credentials, or user preferences are accessed.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/widgets/engine_identity.dart';
import 'package:harness/core/local_key_value_store.dart';
import 'package:harness/core/models.dart';
import 'package:harness/core/test_run.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/shortcuts/app_keymap.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/state/pane_layout_store.dart';
import 'package:harness/state/swarm_catalog.dart';
import 'package:harness/terminal/terminal_session.dart';
import 'package:harness/ws/ws_conn.dart';

class _Memory implements LocalKeyValueStore {
  final values = <String, String>{};
  @override
  Future<String?> read(String key) async => values[key];
  @override
  Future<void> write(String key, String value) async => values[key] = value;
  @override
  Future<void> delete(String key) async => values.remove(key);
}

class _Connection extends WsConn {
  _Connection(this.catalog)
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'review',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );
  final List<dynamic> catalog;
  int _creates = 0;
  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    if (type == 'dsh_list') return {'dsh': catalog};
    if (type == 'engines_probe') {
      return {
        'engines': [
          for (final engine in allEngines)
            {'engine': engine.id, 'installed': true},
        ],
      };
    }
    if (type == 'grid_models_list') {
      return {
        'supportsModelLaunch': true,
        'gridName': 'review-grid',
        'localModelEngines': [
          'claude',
          'codex',
          'opencode',
          'pi',
          'hermes',
          'grok',
          'commandcode',
        ],
        'grids': [
          {
            'name': 'review-grid',
            'own': true,
            'models': [
              {'id': 'Qwen-35B', 'node': 'Mac Studio'},
              {'id': 'DeepSeek', 'node': 'GPU Server'},
            ],
          },
          {
            'name': 'Team grid',
            'own': false,
            'models': [
              {'id': 'Qwen-35B', 'node': 'Team GPU'},
            ],
          },
        ],
      };
    }
    if (type == 'git_project_info') return {'isGit': false};
    if (type == 'fs_list_dir') {
      return {'path': '/tmp/harness-review', 'entries': []};
    }
    if (type == 'codex_profiles') return {'profiles': []};
    if (type == 'agent_create') {
      return {
        'creationId': payload['creationId'],
        'state': 'created',
        'agent': {
          'id': 'review-created-${++_creates}',
          'name':
              'Review: ${payload['dsh'] ?? 'Coding'} on ${payload['engine']} · ${payload['gridModel'] ?? 'Subscription'}',
          'engine': payload['engine'],
          if (payload['gridModel'] != null)
            'grid': {
              'baseUrl': 'https://fixture.invalid',
              'model': payload['gridModel'],
            },
          'dsh': payload['dsh'],
          'project': {
            'name': payload['projectName'] ?? 'Review project',
            'cwd': payload['cwd'] ?? '/tmp/harness-review',
          },
        },
      };
    }
    return {};
  }
}

Future<void> main() async {
  if (!kUnderTest) {
    throw StateError('The review host requires FLUTTER_TEST=1');
  }
  WidgetsFlutterBinding.ensureInitialized();
  final catalog = jsonDecode(
    await File(Platform.environment['HARNESS_REVIEW_CATALOG']!).readAsString(),
  ) as List;
  final connection = _Connection(catalog);
  final app = AppNotifier(
    config: const AppConfig(
      apiBaseUrl: 'http://127.0.0.1:1',
      localCliBaseUrl: 'http://127.0.0.1:1',
    ),
    authSession: AuthSession(),
    configStore: null,
    paneLayoutStore: PaneLayoutStore(storage: _Memory()),
    connectionForTest: (_) => connection,
  )..hasNavigationRail = false;
  const machine = Machine(
    machineId: 'review',
    name: 'Review Mac',
    authMode: MachineAuthMode.remote,
  );
  const other = Machine(
    machineId: 'studio',
    name: 'Remote workstation',
    authMode: MachineAuthMode.remote,
  );
  app.machines = [machine, other];
  app.machineStates['studio'] = MachineState(other)
    ..nodeOnline = true
    ..connectionStatus = ConnectionStatus.connected
    ..agentLoadStatus = AgentLoadStatus.loaded;
  app.machineStates['review'] = MachineState(machine)
    ..nodeOnline = true
    ..connectionStatus = ConnectionStatus.connected
    ..agentLoadStatus = AgentLoadStatus.loaded
    ..agents = const [
      Agent(
        id: 'review-coding',
        name: 'Portability review',
        engine: 'codex',
        terminalAvailable: true,
        project: AgentProject(
          name: 'Review project',
          cwd: '/tmp/harness-review',
        ),
      ),
    ];
  final session = TerminalSession(
    machineId: 'review',
    agentId: 'review-coding',
    agentName: 'Portability review',
    engineId: 'codex',
    send: (_, _) async => true,
    sendBinary: (_) async => true,
  )..streamId = 'review-stream';
  session.terminal.write(
    'Harness portability review\r\n\r\nCmd+N: choose Harness, Agent, Model, Machine, Project.\r\nAll store packages and 14 engines are fixture data.\r\nCreate reports the captured selection; it never starts an agent.\r\n',
  );
  // ignore: invalid_use_of_visible_for_testing_member
  app.adoptSessionForTest(session);
  await app.probeEngines('review', force: true);
  await app.probeDsh('review', force: true);
  await const MethodChannel('harness/swarm_tabs')
      .invokeMethod<void>('configure');
  newHarnessOpensInBox = true;
  final keymap = AppKeymap();
  final keyLog = Platform.environment['HARNESS_REVIEW_KEY_LOG'];
  if (keyLog != null) {
    HardwareKeyboard.instance.addHandler((event) {
      final focus = FocusManager.instance.primaryFocus;
      final context = focus?.context;
      File(keyLog).writeAsStringSync(
        '${event.runtimeType} ${event.logicalKey.debugName} '
        'focus=${focus?.debugLabel} '
        'keymap=${context == null ? "none" : identical(KeymapTheme.of(context, listen: false), keymap)} '
        'lifecycle=${WidgetsBinding.instance.lifecycleState}\n',
        mode: FileMode.append,
      );
      return false;
    });
  }
  runApp(
    grid.BrightnessScope(
      child: MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        builder: (_, child) => KeymapProvider(keymap: keymap, child: child!),
        home: SwarmScreen(
          notifier: app,
          nativeTabs: true,
          projectStore: SwarmProjectStore(),
        ),
      ),
    ),
  );
}
