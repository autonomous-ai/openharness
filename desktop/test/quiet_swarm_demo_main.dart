// A browser build of the Quiet Swarm screens on made-up data, for the pictures
// Dee looks at before merging (task #2190). Nothing here reaches a server.
//
//   flutter build web -t test/quiet_swarm_demo_main.dart
//
// Then serve build/web and open it with ?screen=0|1|8|10|10b|10c|12.
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:harness/api/api_client.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/core/local_key_value_store.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/pane_layout_store.dart';
import 'package:harness/web/shell/web_chrome.dart';

import 'support/humans_fixture.dart';
import 'support/super_tab_fixture.dart';

const _tabs = ['lampOS', 'strategies', 'autonomous.ai', 'hardware', 'growth'];
const _people = [
  'ken15',
  'diego',
  'dee',
  'tony',
  'scholes',
  'phamngochuy.1989',
];
const _projects = [
  'computer',
  'lamp',
  'openharness',
  'physical-router',
  'spaceship',
];
const _machines = [
  ("Diego's Mac", 'diego', true),
  ('Mac 1', 'dee', true),
  ('MacBookPro2021', 'phamngochuy.1989', true),
  ('MacBooks-MacBook-Pro-9', 'scholes', true),
  ('MacBooks-MacBook-Pro-10', 'diego', true),
  ('MacBooks-MacBook-Pro-19', 'tony', true),
  ('MACs-Mac-Studio', 'ken15', true),
  ('Mac 3', 'dee', false),
  ('MacbookPro', 'ken15', false),
];

ConversationServer _swarm(String id, String name) {
  final server = ConversationServer();
  final now = DateTime.now().millisecondsSinceEpoch;
  server.state
    ..['id'] = id
    ..['name'] = name
    ..['ownerId'] = 'ken15'
    ..['swarmBuddy'] = true
    ..['people'] = [
      for (final person in _people)
        {
          'id': person,
          'email': '$person@example.com',
          'role': person == 'ken15' ? 'owner' : 'collaborator',
        },
    ]
    ..['projects'] = [
      for (final project in _projects)
        projectFixture(
          project == 'openharness' ? 'lead' : project,
          project,
          project == 'openharness' ? 'lead' : '$project-lead',
        ),
    ]
    ..['machines'] = [
      for (final (machine, owner, online) in _machines)
        {
          'machineId': machine,
          'name': machine,
          'contributorId': owner,
          'maxAgents': 4,
          'scope': 'swarm',
          'observation': {
            'receivedAt': online ? now : now - 3600000,
            'resources': {'cpuPercent': 20},
          },
        },
    ];
  final groups = server.state['conversations'] as List;
  for (final project in _projects) {
    if (project == 'openharness') continue;
    groups.add({
      'id': '$project-lead',
      'title': project,
      'brief': '',
      'leadId': null,
      'archived': false,
      'agentIds': <String>[],
      'projectId': project,
    });
  }
  server
    ..append('Prod DB profile: five slow reads to fix.')
    ..append('Three fixes are on main.')
    ..append('ok i like a. let\'s make it perfect.');
  server.leaderboard = {
    ...humansSwarm().leaderboard!,
    'byModel': [
      modelScore('claude', 'claude-opus-5-5', 'high', attempts: 62),
      modelScore('claude', 'claude-sonnet-5-5', 'high', attempts: 21),
      modelScore('codex', 'gpt-6.1-sol', 'high', attempts: 11),
      modelScore('claude', 'deepseek-v4.1', 'high', attempts: 6),
    ],
  };
  return server;
}

class _Memory implements LocalKeyValueStore {
  final values = <String, String>{};
  @override
  Future<String?> read(String key) async => values[key];
  @override
  Future<void> write(String key, String value) async => values[key] = value;
  @override
  Future<void> delete(String key) async => values.remove(key);
}

class _DemoApi extends ApiClient {
  _DemoApi(this.servers, {required super.config, required super.session});
  final Map<String, ConversationServer> servers;

  Response<dynamic> _ok(Object? data) => Response(
    requestOptions: RequestOptions(path: ''),
    statusCode: 200,
    data: {'success': true, 'data': data},
  );

  @override
  Future<Response<dynamic>> superTabCall(
    String method,
    String path, {
    Map<String, dynamic>? body,
  }) async {
    final uri = Uri.parse(path);
    if (uri.path == '/api/super-tabs/list') {
      return _ok({
        'tabs': [
          for (final id in servers.keys)
            {'id': id, 'name': servers[id]!.state['name'], 'ownerId': 'ken15'},
        ],
        'next': null,
      });
    }
    if (uri.path == '/api/super-tabs/deleted') {
      return _ok({'tabs': <dynamic>[]});
    }
    final id = RegExp(r'^/api/super-tabs/([^/]+)/').firstMatch(uri.path);
    final server = servers[id?.group(1)];
    if (server == null) return _ok(<String, dynamic>{});
    return _ok(await server.request(method, path, body: body));
  }
}

/// Presses what has [key] on screen, as a click would.
bool _press(String key) {
  var done = false;
  void visit(Element element) {
    if (done) return;
    final widget = element.widget;
    if (widget.key == ValueKey(key) && widget is InkWell) {
      widget.onTap?.call();
      done = true;
      return;
    }
    element.visitChildren(visit);
  }

  WidgetsBinding.instance.rootElement?.visitChildren(visit);
  return done;
}

Future<void> _pressWhenThere(String key) async {
  for (var i = 0; i < 100; i++) {
    if (_press(key)) return;
    await Future<void>.delayed(const Duration(milliseconds: 100));
  }
}

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final servers = {
    for (final name in _tabs)
      name.replaceAll('.', '-'): _swarm(name.replaceAll('.', '-'), name),
  };
  final app = AppNotifier(
    config: AppConfig.dev,
    authSession: AuthSession(),
    configStore: null,
    paneLayoutStore: PaneLayoutStore(storage: _Memory()),
  )..hasNavigationRail = false;
  const machine = Machine(
    machineId: 'm',
    authMode: MachineAuthMode.remote,
    name: 'This Mac',
  );
  app.machines = [machine];
  app.machineStates['m'] = MachineState(machine)
    ..nodeOnline = true
    ..connectionStatus = ConnectionStatus.connected
    ..agentLoadStatus = AgentLoadStatus.loaded
    ..localOnly = true;
  app.api = _DemoApi(servers, config: AppConfig.dev, session: AuthSession());
  app.status = AppStatus.authenticated;
  app.signedIn = true;
  app.currentUser = const CurrentUserProfile(
    id: 'dee',
    email: 'dee@example.com',
  );
  app.enterSuperTabs();
  runApp(
    MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: grid.buildAppTheme(brightness: Brightness.dark),
      home: SwarmScreen(
        notifier: app,
        nativeTabs: false,
        chrome: webWorkspaceChrome(app),
      ),
    ),
  );
  app.superTabs.bind('dee');
  try {
    await app.superTabs.refreshTabs().timeout(const Duration(seconds: 3));
  } catch (_) {
    // Whatever it read is drawn.
  }
  final shown = app.swarms.where((s) => s.superTabId == 'autonomous-ai');
  if (shown.isNotEmpty) app.selectSwarm(shown.first.id);
  for (final empty in app.swarms.where((s) => s.superTabId == null).toList()) {
    await app.requestCloseSwarm(empty.id);
  }
  final screen = Uri.base.queryParameters['screen'] ?? '1';
  await Future<void>.delayed(const Duration(seconds: 2));
  switch (screen) {
    case '8':
      await _pressWhenThere('super-swarm-switcher');
    case '10' || '10b' || '10c':
      await _pressWhenThere('super-manage');
      await Future<void>.delayed(const Duration(milliseconds: 300));
      if (screen == '10b') await _pressWhenThere('super-manage-tab-models');
      if (screen == '10c') await _pressWhenThere('super-manage-tab-swarm');
  }
}
