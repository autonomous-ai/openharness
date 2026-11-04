import 'dart:async';

import 'dart:io';

import 'package:clock/clock.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/project_sidebar.dart';
import 'package:harness/super_tabs/machines.dart';
import 'package:harness/super_tabs/personal_machines.dart';
import 'package:harness/super_tabs/swarm_switcher.dart';
import 'package:harness/super_tabs/view.dart';
import 'package:harness/ws/ws_conn.dart';

import 'support/capture.dart';
import 'support/super_tab_fixture.dart';
import 'swarm_state_test.dart' show MemoryStore, createApp;

/// The backend as the Swarm dropdown meets it: the account's Swarm list, a
/// Swarm's own reads and commands, and Swarm creation, one Swarm per account
/// and request id (backend superTabs/store.ts `create`).
class _Backend {
  final tabs = <Map<String, dynamic>>[];
  final servers = <String, ConversationServer>{};

  /// Every creation request, with the account that sent it.
  final creates = <(String, Map<String, dynamic>)>[];

  /// What each machine was asked outside the backend, in order.
  final machineCalls = <(String, String)>[];
  Completer<void>? holdCreate;
  bool failCreate = false;

  /// While set, preparing a machine for a Swarm waits for it.
  Completer<void>? holdPrepare;

  /// The machine whose preparing fails.
  String? failPrepareOn;

  /// Machines answer preparing with this state ('ready' sets them up).
  String prepareState = 'ready';

  /// The Swarm an account's personal-swarm request already made, by account.
  final personalOf = <String, String>{};

  /// The account the next request is from.
  String account = 'owner';

  /// While set, every read of a Swarm's state fails so, as a backend
  /// restarting under it answers (task #2647).
  Object? stateReadFailure;

  /// While set, the account's Swarm list fails so.
  Object? listFailure;

  /// How many times the account's Swarm list was asked for, failed reads
  /// included.
  int listReads = 0;

  /// While true, this computer's Harness is restarting (a CLI update): every
  /// request to it fails as its dropped socket does.
  bool daemonRestarting = false;

  ConversationServer add(
    String id,
    String name, {
    String owner = 'owner',
    List<String> members = const ['owner'],
  }) {
    final server = ConversationServer();
    server.state
      ..['id'] = id
      ..['name'] = name
      ..['ownerId'] = owner
      ..['people'] = [
        for (final person in members)
          {
            'id': person,
            'email': '$person@example.com',
            'role': person == owner ? 'owner' : 'collaborator',
          },
      ];
    servers[id] = server;
    tabs.add({'id': id, 'name': name, 'ownerId': owner, 'members': members});
    return server;
  }

  /// The machine.contribute commands Swarm [id] received.
  List<Map<String, dynamic>> contributions(String id) => [
    for (final post in servers[id]!.posts)
      if ((post['command'] as Map?)?['type'] == 'machine.contribute')
        Map<String, dynamic>.from(post['command'] as Map),
  ];

  Future<Object?> request(
    String method,
    String path, {
    Map<String, dynamic>? body,
  }) async {
    final uri = Uri.parse(path);
    if (uri.path == '/api/super-tabs/list') {
      listReads++;
      if (listFailure case final failure?) throw failure;
      return {
        'tabs': [
          for (final tab in tabs)
            if ((tab['members'] as List).contains(account))
              {'id': tab['id'], 'name': tab['name'], 'ownerId': tab['ownerId']},
        ],
        'next': null,
      };
    }
    if (method == 'POST' && uri.path == '/api/super-tabs') {
      final asker = account;
      creates.add((asker, Map<String, dynamic>.from(body!)));
      if (holdCreate case final hold?) await hold.future;
      if (failCreate) {
        throw const SuperTabFailure(
          'SERVICE_UNAVAILABLE',
          'Swarm is busy. Try again.',
          statusCode: 503,
        );
      }
      final id =
          (body['operationId'] == kPersonalSwarmOperation
              ? personalOf[asker]
              : null) ??
          'swarm-$asker-${body['operationId']}';
      if (!servers.containsKey(id)) {
        add(id, body['name'] as String, owner: asker, members: [asker]);
      }
      return {'id': id, 'revision': 0};
    }
    final swarm = RegExp(r'^/api/super-tabs/([^/]+)/').firstMatch(uri.path);
    if (stateReadFailure case final failure?
        when method == 'GET' &&
            RegExp(r'/(parts|changes)$').hasMatch(uri.path)) {
      throw failure;
    }
    final server = servers[swarm?.group(1)];
    if (server == null) {
      throw const SuperTabFailure('NOT_FOUND', 'Swarm not found.');
    }
    return server.request(method, path, body: body);
  }
}

class _Connection extends WsConn {
  _Connection(this.backend, String machineId)
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: machineId,
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );
  final _Backend backend;

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    if (type != 'super_tabs') return {};
    if (backend.daemonRestarting) throw Exception('WS disconnected');
    final action = payload['action'] as String?;
    if (action == 'backend') {
      return {
        'value': await backend.request(
          payload['method'] as String,
          payload['path'] as String,
          body: payload['body'] as Map<String, dynamic>?,
        ),
      };
    }
    backend.machineCalls.add((machineId, action ?? ''));
    if (action == 'prepareContribution') {
      if (backend.holdPrepare case final hold?) await hold.future;
      if (backend.failPrepareOn == machineId) {
        throw const SuperTabFailure('SETUP_FAILED', 'Setup failed there.');
      }
      return {
        'state': backend.prepareState,
        'scope': 'swarm',
        'cwd': '/Users/person/harnesses/swarm',
        'engines': ['claude', 'codex'],
        'maxAgents': 4,
      };
    }
    return {};
  }
}

/// [id], one more of this account's machines: online and linked unless told.
void _ownMachine(
  AppNotifier app,
  String id, {
  bool online = true,
  bool team = false,
  bool shared = false,
  bool linked = true,
}) {
  final machine = Machine(
    machineId: id,
    authMode: MachineAuthMode.remote,
    name: 'Machine $id',
    sessionKind: team ? 'team' : null,
    machineShare: shared
        ? MachineShare(
            ownerName: 'Teammate',
            ownerEmail: 'teammate@example.com',
            via: 'email',
            added: true,
          )
        : null,
  );
  app.machines = [...app.machines, machine];
  app.machineStates[id] = MachineState(machine)
    ..nodeOnline = online
    ..needsLink = !linked
    ..connectionStatus = online
        ? ConnectionStatus.connected
        : ConnectionStatus.disconnected;
}

AppNotifier _computer(
  _Backend backend,
  MemoryStore store, {
  String account = 'owner',
  bool teamMachineToo = false,
}) {
  final app = createApp(
    store: store,
    connected: true,
    connectionForTest: (machineId) => _Connection(backend, machineId),
  );
  app.machineStates['m']!.localOnly = true;
  if (teamMachineToo) {
    // This Mac's Harness Team account, served by the same daemon.
    const team = Machine(
      machineId: 'team-m',
      authMode: MachineAuthMode.remote,
      name: 'Test host (Team)',
      sessionKind: 'team',
    );
    app.machines = [...app.machines, team];
    app.machineStates['team-m'] = MachineState(team)
      ..localOnly = true
      ..nodeOnline = true
      ..connectionStatus = ConnectionStatus.connected;
  }
  app.status = AppStatus.authenticated;
  app.currentUser = CurrentUserProfile(
    id: account,
    email: '$account@example.com',
  );
  app.enterSuperTabs();
  addTearDown(app.dispose);
  return app;
}

/// Lets requests through the fake transport and saved-state writes finish.
Future<void> _settle([WidgetTester? tester]) async {
  for (var i = 0; i < 30; i++) {
    if (tester != null) {
      await tester.pump();
    } else {
      await Future<void>.delayed(Duration.zero);
    }
  }
}

String _shown(AppNotifier app, String deskId) =>
    app.swarms.firstWhere((s) => s.id == deskId).superTabId!;

/// Alpha and Beta, both open in tabs, Alpha shown; Gamma closed here.
Future<(AppNotifier, _Backend)> _twoTabs({
  MemoryStore? store,
  bool teamMachineToo = false,
}) async {
  final backend = _Backend()
    ..add('alpha', 'Alpha')
    ..add('beta', 'Beta')
    ..add('gamma', 'Gamma');
  final app = _computer(
    backend,
    store ?? MemoryStore(),
    teamMachineToo: teamMachineToo,
  );
  await app.superTabs.setTabVisible('gamma', false);
  await app.superTabs.refreshTabs();
  final alpha = app.swarms.firstWhere((s) => s.superTabId == 'alpha');
  app.selectSwarm(alpha.id);
  return (app, backend);
}

/// A store whose reads of one key wait for [hold], as a slow disk does.
class _SlowStore extends MemoryStore {
  String? slowKey;
  Completer<void>? hold;
  @override
  Future<String?> read(String key) async {
    if (key == slowKey) await hold?.future;
    return super.read(key);
  }
}

Future<SuperTabController> _pumpBar(
  WidgetTester tester,
  AppNotifier app, {
  Brightness brightness = Brightness.dark,
  VoidCallback? onNewSwarm,
}) async {
  await tester.binding.setSurfaceSize(const Size(300, 900));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  late SuperTabController shown;
  await tester.runAsync(() async {
    shown = await app.superTabs.open(app.activeSwarm.superTabId!);
    await shown.refresh();
  });
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: brightness),
      home: Scaffold(
        body: ListenableBuilder(
          listenable: app,
          // The Swarm the tab shows, once opened, as the workspace gives it.
          builder: (context, _) =>
              switch (app.superTabs.peek(app.activeSwarm.superTabId!)) {
                null => const SizedBox(),
                final c => ListenableBuilder(
                  listenable: c,
                  builder: (context, _) => ProjectSidebar(
                    key: ValueKey(c.tabId),
                    controller: c,
                    app: app,
                    needsHuman: (_) => 0,
                    onSelect: c.select,
                    onNewProject: () {},
                    onNewSwarm: onNewSwarm ?? () {},
                  ),
                ),
              },
        ),
      ),
    ),
  );
  await tester.pump();
  await tester.pump();
  return shown;
}

/// Lets go of every Swarm opened, as closing their tabs does: no poll is
/// left running after a widget test.
Future<void> _releaseAll(WidgetTester tester, AppNotifier app) async {
  await tester.pumpWidget(const SizedBox());
  for (final c in app.superTabs.loadedControllers.toList()) {
    app.superTabs.release(c.tabId);
  }
  await tester.runAsync(() => _settle());
}

Finder _rowText(String text) => find.descendant(
  of: find.byKey(const ValueKey('super-swarm-switcher')),
  matching: find.text(text),
);

Future<void> _openMenu(WidgetTester tester) async {
  await tester.tap(find.byKey(const ValueKey('super-swarm-switcher')));
  await tester.pump();
  await tester.pump();
}

/// Set to a folder to write the PR's pictures of the dropdown there.
final _shots = Platform.environment['SWARM_SWITCHER_SHOTS'];

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() => loadCaptureFonts(_shots));

  for (final brightness in Brightness.values) {
    testWidgets('pictures of the Swarm dropdown, closed and open, in '
        '${brightness.name}', (tester) async {
      if (_shots == null) return;
      final previous = grid.AppTheme.brightness.value;
      grid.AppTheme.brightness.value = brightness;
      addTearDown(() => grid.AppTheme.brightness.value = previous);
      tester.view.devicePixelRatio = 2;
      tester.view.physicalSize = const Size(2400, 1300);
      addTearDown(tester.view.reset);
      late AppNotifier app;
      late SuperTabController shown;
      await tester.runAsync(() async {
        final backend = _Backend()
          ..add('openharness', 'openharness')
          ..add('robots', 'Autonomous Robots')
          ..add('crit', 'Design crit');
        backend.servers['robots']!.state['mentionsWaiting'] = 3;
        app = _computer(backend, MemoryStore());
        await app.superTabs.setTabVisible('crit', false);
        await app.superTabs.refreshTabs();
        app.selectSwarm(
          app.swarms.firstWhere((s) => s.superTabId == 'openharness').id,
        );
        await (await app.superTabs.open('robots')).refresh();
        shown = await app.superTabs.open('openharness');
        await shown.refresh();
      });
      await tester.pumpWidget(
        MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: grid.buildAppTheme(brightness: brightness),
          home: Scaffold(
            body: SuperTabView(
              controller: shown,
              app: app,
              onInvite: () {},
              onAddAgent: (_) {},
              onOpenTerminal: (_) {},
              onNewProject: () {},
              onNewSwarm: () {},
              machineName: (_) => 'Team Mac',
            ),
          ),
        ),
      );
      await tester.pump();
      await tester.pump();
      await captureWindow(
        tester,
        _shots,
        'swarm-dropdown-closed-${brightness.name}',
      );
      await _openMenu(tester);
      await captureWindow(
        tester,
        _shots,
        'swarm-dropdown-open-${brightness.name}',
      );
      await _releaseAll(tester, app);
    }, variant: TargetPlatformVariant.only(TargetPlatform.macOS));
  }

  testWidgets('the bar starts with the shown Swarm; its menu lists Personal, '
      'every Swarm with what waits, the shown one ticked, then New Swarm', (
    tester,
  ) async {
    late AppNotifier app;
    late _Backend backend;
    await tester.runAsync(() async {
      (app, backend) = await _twoTabs();
      backend.servers['beta']!.state['mentionsWaiting'] = 2;
      final beta = await app.superTabs.open('beta');
      await beta.refresh();
    });
    var newSwarm = 0;
    await _pumpBar(tester, app, onNewSwarm: () => newSwarm++);
    expect(_rowText('Alpha'), findsOneWidget);
    final bar = tester.getTopLeft(
      find.byKey(const ValueKey('super-swarm-switcher')),
    );
    expect(
      bar.dy,
      lessThan(
        tester
            .getTopLeft(find.byKey(const ValueKey('project-sidebar-projects')))
            .dy,
      ),
    );

    await _openMenu(tester);
    final order = [
      'swarm-switch-personal',
      'swarm-switch-alpha',
      'swarm-switch-beta',
      'swarm-switch-gamma',
      'swarm-switch-new',
    ];
    final tops = [
      for (final key in order) tester.getTopLeft(find.byKey(ValueKey(key))).dy,
    ];
    expect(tops, [...tops]..sort());
    expect(
      find.descendant(
        of: find.byKey(const ValueKey('swarm-switch-beta')),
        matching: find.text('2'),
      ),
      findsOneWidget,
    );
    await tester.tap(find.byKey(const ValueKey('swarm-switch-new')));
    await tester.pump();
    expect(newSwarm, 1);
    await _releaseAll(tester, app);
  });

  test('picking a Swarm open in another tab selects that tab; no tab is '
      'added, closed or moved', () async {
    final (app, _) = await _twoTabs();
    final before = [for (final s in app.swarms) (s.id, s.superTabId, s.name)];
    final alphaTab = app.activeSwarmId;
    app.showSuperTabIn(alphaTab, 'beta', 'Beta');
    expect([for (final s in app.swarms) (s.id, s.superTabId, s.name)], before);
    expect(app.activeSwarm.superTabId, 'beta');
  });

  test('picking a closed Swarm shows it in this same tab with its name; '
      'the Swarm it showed is closed here and not rediscovered', () async {
    final (app, _) = await _twoTabs();
    final count = app.swarms.length;
    final tab = app.activeSwarmId;
    final index = app.swarms.indexWhere((s) => s.id == tab);
    app.showSuperTabIn(tab, 'gamma', 'Gamma');
    await _settle();
    await app.superTabs.refreshTabs();
    expect(app.swarms, hasLength(count));
    expect(app.swarms.indexWhere((s) => s.id == tab), index);
    expect(_shown(app, tab), 'gamma');
    expect(app.activeSwarm.name, 'Gamma');
    expect(app.swarms.where((s) => s.superTabId == 'alpha'), isEmpty);
    expect(app.closedSuperTabs.map((c) => c.id), contains('alpha'));
    expect(swarmChoices(app).map((c) => c.id), containsAll(['alpha', 'gamma']));
  });

  test('a half-written message stays with its Swarm across a switch', () async {
    final (app, _) = await _twoTabs();
    final tab = app.activeSwarmId;
    final alpha = await app.superTabs.open('alpha');
    await alpha.refresh();
    alpha.setDraft('lead', 'Half a thought for Alpha');
    app.showSuperTabIn(tab, 'gamma', 'Gamma');
    await _settle();
    final gamma = await app.superTabs.open('gamma');
    await gamma.refresh();
    expect(gamma.draft('lead'), '');
    app.showSuperTabIn(tab, 'alpha', 'Alpha');
    await _settle();
    final back = await app.superTabs.open('alpha');
    expect(back, isNot(same(alpha)));
    expect(back.draft('lead'), 'Half a thought for Alpha');
  });

  test('Personal is created once under a double pick, shown in this tab, '
      'with this computer added and no Product Manager started', () async {
    final (app, backend) = await _twoTabs(teamMachineToo: true);
    final tab = app.activeSwarmId;
    final count = app.swarms.length;
    backend.holdCreate = Completer<void>();
    final personal = PersonalSwarm.of(app);
    final first = personal.show(tab);
    final second = personal.show(tab);
    await _settle();
    expect(personal.busy, isTrue);
    backend.holdCreate!.complete();
    await Future.wait([first, second]);
    await _settle();
    expect(backend.creates, hasLength(1));
    expect(backend.creates.single.$2, {
      'operationId': kPersonalSwarmOperation,
      'name': 'Personal',
    });
    final id = backend.creates.single.$1 == 'owner'
        ? 'swarm-owner-$kPersonalSwarmOperation'
        : null;
    expect(_shown(app, tab), id);
    expect(app.activeSwarm.name, 'Personal');
    expect(app.swarms, hasLength(count));
    // This Mac only: never its Harness Team account.
    expect(backend.contributions(id!).map((c) => c['machineId']), ['m']);
    expect(backend.machineCalls.where((c) => c.$1 == 'team-m'), isEmpty);
    expect(
      backend.servers[id]!.posts.where(
        (p) => (p['command'] as Map?)?['type'] == 'lead.start',
      ),
      isEmpty,
    );
    // Picked again: the same Swarm, nothing created or added again.
    app.showSuperTabIn(tab, 'alpha', 'Alpha');
    await personal.show(tab);
    await _settle();
    expect(backend.creates, hasLength(1));
    expect(backend.contributions(id), hasLength(1));
    expect(_shown(app, tab), id);
  });

  test('two windows picking Personal get the same Swarm', () async {
    final backend = _Backend()..add('alpha', 'Alpha');
    final one = _computer(backend, MemoryStore());
    final two = _computer(backend, MemoryStore());
    for (final app in [one, two]) {
      await app.superTabs.refreshTabs();
      app.selectSwarm(app.swarms.firstWhere((s) => s.superTabId == 'alpha').id);
    }
    await Future.wait([
      PersonalSwarm.of(one).show(one.activeSwarmId),
      PersonalSwarm.of(two).show(two.activeSwarmId),
    ]);
    await _settle();
    expect(backend.servers.keys.where((id) => id != 'alpha'), hasLength(1));
    expect(_shown(one, one.activeSwarmId), _shown(two, two.activeSwarmId));
  });

  test('a computer signed in as a Harness Team account sends no Personal '
      'request and adds no machine', () async {
    final backend = _Backend()..add('alpha', 'Alpha');
    final app = _computer(backend, MemoryStore());
    await app.superTabs.refreshTabs();
    app.selectSwarm(app.swarms.firstWhere((s) => s.superTabId == 'alpha').id);
    // This computer's daemon switched to the Team account (`harness team on`).
    const team = Machine(
      machineId: 'm',
      authMode: MachineAuthMode.remote,
      name: 'Test host',
      sessionKind: 'team',
    );
    app.machines = [team];
    app.machineStates['m'] = MachineState(team)
      ..localOnly = true
      ..nodeOnline = true
      ..connectionStatus = ConnectionStatus.connected;
    final personal = PersonalSwarm.of(app);
    await personal.show(app.activeSwarmId);
    await _settle();
    expect(backend.creates, isEmpty);
    expect(backend.machineCalls, isEmpty);
    expect(
      personal.errorIn(app.activeSwarmId),
      AppNotifier.teamComputerSwarmMessage,
    );
    expect(app.activeSwarm.superTabId, 'alpha');
  });

  test('two accounts never share a Personal Swarm', () async {
    final backend = _Backend()
      ..add('alpha', 'Alpha', members: ['owner', 'mate']);
    final app = _computer(backend, MemoryStore());
    await app.superTabs.refreshTabs();
    app.selectSwarm(app.swarms.firstWhere((s) => s.superTabId == 'alpha').id);
    await PersonalSwarm.of(app).show(app.activeSwarmId);
    await _settle();
    final mine = PersonalSwarm.of(app).id;
    expect(mine, isNotNull);

    app.currentUser = const CurrentUserProfile(
      id: 'mate',
      email: 'mate@example.com',
    );
    backend.account = 'mate';
    await app.superTabs.refreshTabs();
    expect(PersonalSwarm.of(app).id, isNull);
    expect(swarmChoices(app).map((c) => c.id), isNot(contains(mine)));
    final theirs = await PersonalSwarm.of(app).ensure();
    expect(theirs, isNot(mine));
    expect(backend.creates.map((c) => c.$1), ['owner', 'mate']);
  });

  test('a Swarm the person owns named Personal is their Personal, listed '
      'once; one someone else owns is an ordinary Swarm', () async {
    final backend = _Backend()
      ..add('alpha', 'Alpha')
      ..add('own-personal', 'Personal')
      ..add(
        'their-personal',
        'Personal',
        owner: 'mate',
        members: ['mate', 'owner'],
      );
    final app = _computer(backend, MemoryStore());
    await app.superTabs.refreshTabs();
    expect(PersonalSwarm.of(app).id, 'own-personal');
    expect(swarmChoices(app).map((c) => c.id), ['alpha', 'their-personal']);
    // The server confirms it is the one the personal-swarm request made.
    backend.personalOf['owner'] = 'own-personal';
    final tab = app.swarms.firstWhere((s) => s.superTabId == 'alpha').id;
    await PersonalSwarm.of(app).show(tab);
    await _settle();
    expect(backend.creates, hasLength(1));
    expect(backend.servers.keys, hasLength(3));
    // Open in its own tab already: that tab is shown.
    expect(app.activeSwarm.superTabId, 'own-personal');
  });

  test(
    'a Swarm the person owns named Personal is only taken for it when the '
    'server says so: one with teammates is never used, nor added to',
    () async {
      final backend = _Backend()
        ..add('alpha', 'Alpha')
        ..add('team-personal', 'Personal', members: ['owner', 'mate']);
      final app = _computer(backend, MemoryStore());
      await app.superTabs.refreshTabs();
      await (await app.superTabs.open('team-personal')).refresh();
      expect(PersonalSwarm.of(app).id, isNull);
      expect(swarmChoices(app).map((c) => c.id), contains('team-personal'));
      final tab = app.swarms.firstWhere((s) => s.superTabId == 'alpha').id;
      app.selectSwarm(tab);
      await PersonalSwarm.of(app).show(tab);
      await _settle();
      const mine = 'swarm-owner-$kPersonalSwarmOperation';
      expect(_shown(app, tab), mine);
      expect(backend.contributions('team-personal'), isEmpty);
      expect(backend.contributions(mine).map((c) => c['machineId']), ['m']);
    },
  );

  test('a Swarm owned and named Personal but not the server\'s is not used, '
      'even unread', () async {
    final backend = _Backend()
      ..add('alpha', 'Alpha')
      ..add('renamed', 'Personal');
    final app = _computer(backend, MemoryStore());
    await app.superTabs.refreshTabs();
    final tab = app.swarms.firstWhere((s) => s.superTabId == 'alpha').id;
    app.selectSwarm(tab);
    await PersonalSwarm.of(app).show(tab);
    await _settle();
    expect(backend.contributions('renamed'), isEmpty);
    expect(_shown(app, tab), 'swarm-owner-$kPersonalSwarmOperation');
  });

  test('this computer joins Personal as Add machine adds it: through Team '
      'accounts where the Swarm uses them', () async {
    final (app, backend) = await _twoTabs();
    await PersonalSwarm.of(app).show(app.activeSwarmId);
    await _settle();
    final id = PersonalSwarm.of(app).id!;
    expect(backend.contributions(id).single['teamAccountOnly'], isTrue);
  });

  test('an add that answers after Personal was let go adds nothing and '
      'says nothing', () async {
    final (app, backend) = await _twoTabs();
    final tab = app.activeSwarmId;
    backend.holdPrepare = Completer<void>();
    final picking = PersonalSwarm.of(app).show(tab);
    await _settle();
    final id = PersonalSwarm.of(app).id!;
    expect(_shown(app, tab), id);
    // The add goes out, and its answer is slow.
    final answer = backend.servers[id]!.holdCommands = Completer<void>();
    backend.holdPrepare!.complete();
    await _settle();
    expect(backend.contributions(id), hasLength(1));
    // The person moves the tab on before it answers.
    app.showSuperTabIn(tab, 'gamma', 'Gamma');
    answer.complete();
    await picking;
    await _settle();
    expect(PersonalSwarm.of(app).errorIn(tab), isNull);
    expect(_shown(app, tab), 'gamma');
  });

  test('a loss handled once: with Personal open in another tab, that tab is '
      'selected, and the tab that lost access is not bounced again', () async {
    final (app, _) = await _twoTabs();
    final betaTab = app.swarms.firstWhere((s) => s.superTabId == 'beta').id;
    await PersonalSwarm.of(app).show(betaTab);
    await _settle();
    final personal = PersonalSwarm.of(app).id!;
    expect(_shown(app, betaTab), personal);
    final alphaTab = app.swarms.firstWhere((s) => s.superTabId == 'alpha').id;
    app.selectSwarm(alphaTab);
    final alpha = await app.superTabs.open('alpha');
    await alpha.refresh();
    alpha.revokeAccess('You no longer have access to this Swarm.');
    await fallBackToPersonal(app, alpha);
    expect(app.activeSwarmId, betaTab);
    app.selectSwarm(alphaTab);
    await fallBackToPersonal(app, alpha);
    expect(app.activeSwarmId, alphaTab);
  });

  test('a loss right after launch waits for what this computer remembers of '
      'Personal before deciding', () async {
    final backend = _Backend()
      ..add('alpha', 'Alpha')
      ..add('mine', 'Personal');
    final store = MemoryStore()..values['super_tab.personal.owner'] = 'mine';
    final app = _computer(backend, store);
    await app.superTabs.setTabVisible('mine', false);
    await app.superTabs.refreshTabs();
    final tab = app.swarms.firstWhere((s) => s.superTabId == 'alpha').id;
    app.selectSwarm(tab);
    final alpha = await app.superTabs.open('alpha');
    await alpha.refresh();
    alpha.revokeAccess('You no longer have access to this Swarm.');
    await fallBackToPersonal(app, alpha);
    expect(_shown(app, tab), 'mine');
  });

  test('a Swarm taken away while shown moves its tab to Personal and leaves '
      'the menu; without Personal picked here the tab stays', () async {
    final (app, _) = await _twoTabs();
    final tab = app.activeSwarmId;
    final alpha = await app.superTabs.open('alpha');
    await alpha.refresh();
    alpha.revokeAccess('You no longer have access to this Swarm.');
    await fallBackToPersonal(app, alpha);
    expect(_shown(app, tab), 'alpha');
    expect(swarmChoices(app).map((c) => c.id), isNot(contains('alpha')));

    final (app2, _) = await _twoTabs();
    final tab2 = app2.activeSwarmId;
    await PersonalSwarm.of(app2).show(tab2);
    await _settle();
    final personal = PersonalSwarm.of(app2).id!;
    app2.showSuperTabIn(tab2, 'alpha', 'Alpha');
    await _settle();
    final shown = await app2.superTabs.open('alpha');
    await shown.refresh();
    shown.revokeAccess('You no longer have access to this Swarm.');
    await fallBackToPersonal(app2, shown);
    expect(_shown(app2, tab2), personal);
    expect(app2.activeSwarm.name, 'Personal');
    expect(swarmChoices(app2).map((c) => c.id), isNot(contains('alpha')));
  });

  test('a Personal creation that answers after the tab moved on, or after '
      'sign-out, changes nothing', () async {
    final (app, backend) = await _twoTabs();
    final tab = app.activeSwarmId;
    backend.holdCreate = Completer<void>();
    final picking = PersonalSwarm.of(app).show(tab);
    await _settle();
    app.showSuperTabIn(tab, 'gamma', 'Gamma');
    backend.holdCreate!.complete();
    await picking;
    await _settle();
    expect(_shown(app, tab), 'gamma');
    expect(backend.servers.values.expand((s) => s.posts), isEmpty);

    final (other, backend2) = await _twoTabs();
    final tab2 = other.activeSwarmId;
    backend2.holdCreate = Completer<void>();
    final late = PersonalSwarm.of(other).show(tab2);
    await _settle();
    other.currentUser = const CurrentUserProfile(
      id: 'mate',
      email: 'mate@example.com',
    );
    backend2.holdCreate!.complete();
    await late;
    await _settle();
    expect(_shown(other, tab2), 'alpha');
    expect(PersonalSwarm.of(other).errorIn(tab2), isNull);
  });

  for (final dropdown in [true, false]) {
    testWidgets('the Swarm view moves a tab whose Swarm is taken away to '
        'Personal${dropdown ? '' : ', but not without the dropdown'}', (
      tester,
    ) async {
      late AppNotifier app;
      late String tab, personal;
      late SuperTabController alpha;
      await tester.runAsync(() async {
        (app, _) = await _twoTabs();
        tab = app.activeSwarmId;
        await PersonalSwarm.of(app).show(tab);
        await _settle();
        personal = PersonalSwarm.of(app).id!;
        app.showSuperTabIn(tab, 'alpha', 'Alpha');
        await _settle();
        alpha = await app.superTabs.open('alpha');
        await alpha.refresh();
      });
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: Scaffold(
            body: SuperTabView(
              controller: alpha,
              app: app,
              onInvite: () {},
              onAddAgent: (_) {},
              onOpenTerminal: (_) {},
              onNewSwarm: dropdown ? () {} : null,
              machineName: (_) => 'Team Mac',
            ),
          ),
        ),
      );
      await tester.pump();
      alpha.revokeAccess('You no longer have access to this Swarm.');
      await tester.pump();
      // What this computer remembers of Personal was read in the real zone.
      await tester.runAsync(() => _settle());
      await tester.pump();
      expect(_shown(app, tab), dropdown ? personal : 'alpha');
      await _releaseAll(tester, app);
    });
  }

  group('a restart under an open Swarm (task #2647)', () {
    const dropped = SuperTabFailure(
      'BACKEND_UNAVAILABLE',
      'Could not reach the Harness backend.',
      statusCode: 502,
    );
    const refusals = [
      SuperTabFailure(
        'NOT_FOUND',
        'This Super Tab is unavailable.',
        statusCode: 404,
      ),
      SuperTabFailure(
        'FORBIDDEN',
        'You cannot read this Swarm.',
        statusCode: 403,
      ),
    ];

    /// Alpha shown in a tab, Personal picked here before, as on Dee's Mac:
    /// a Swarm taken away would move this tab to Personal.
    Future<(AppNotifier, _Backend, String, SuperTabController)> shown() async {
      final (app, backend) = await _twoTabs();
      final tab = app.activeSwarmId;
      await PersonalSwarm.of(app).show(tab);
      await _settle();
      app.showSuperTabIn(tab, 'alpha', 'Alpha');
      await _settle();
      final alpha = await app.superTabs.open('alpha');
      await alpha.refresh();
      return (app, backend, tab, alpha);
    }

    testWidgets('a Harness restart, then reads that drop and are refused while '
        'the list still has the Swarm (or cannot be read), keep it open in its '
        'tab under its own name, saying Reconnecting; it reads again once the '
        'backend is back', (tester) async {
      late AppNotifier app;
      late _Backend backend;
      late String tab;
      late SuperTabController alpha;
      await tester.runAsync(() async {
        (app, backend, tab, alpha) = await shown();
      });
      await tester.binding.setSurfaceSize(const Size(1200, 900));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: Scaffold(
            body: SuperTabView(
              controller: alpha,
              app: app,
              onInvite: () {},
              onAddAgent: (_) {},
              onOpenTerminal: (_) {},
              onNewSwarm: () {},
              machineName: (_) => 'Team Mac',
            ),
          ),
        ),
      );
      await tester.pump();
      expect(_rowText('Alpha'), findsOneWidget);

      Future<void> poll() async {
        await tester.runAsync(() async {
          await alpha.refresh();
          await _settle();
        });
        await tester.pump();
        await tester.runAsync(() => _settle());
        await tester.pump();
      }

      void stillAlpha(String when) {
        expect(alpha.accessRevoked, isFalse, reason: when);
        expect(_shown(app, tab), 'alpha', reason: when);
        expect(app.activeSwarm.name, 'Alpha', reason: when);
        expect(_rowText('Alpha'), findsOneWidget, reason: when);
        expect(_rowText('Swarm'), findsNothing, reason: when);
        expect(
          swarmChoices(app).map((c) => (c.id, c.name)),
          contains(('alpha', 'Alpha')),
          reason: when,
        );
      }

      // CLI v0.5.35 restarts this computer's Harness under the open Swarm.
      backend.daemonRestarting = true;
      await poll();
      stillAlpha('daemon restarting');
      expect(alpha.backendUnreachable, isTrue);
      expect(find.text('Reconnecting…'), findsOneWidget);
      backend.daemonRestarting = false;

      // Then the backend restarts: its reads drop...
      backend.stateReadFailure = dropped;
      await poll();
      stillAlpha('dropped');
      expect(alpha.backendUnreachable, isTrue);
      expect(find.text('Reconnecting…'), findsOneWidget);

      // The restarting backend refuses, and its list cannot be read yet.
      backend.listFailure = dropped;
      for (final refusal in refusals) {
        backend.stateReadFailure = refusal;
        await poll();
        stillAlpha('${refusal.code}, list unreadable');
        expect(alpha.backendUnreachable, isTrue);
      }
      // The list answers, still with Alpha, while its reads are refused.
      backend.listFailure = null;
      for (final refusal in refusals) {
        backend.stateReadFailure = refusal;
        await poll();
        stillAlpha('${refusal.code}, list has it');
        expect(alpha.backendUnreachable, isTrue);
      }
      // Quiet: one line, never the refusal's own words.
      expect(find.text('Reconnecting…'), findsOneWidget);
      for (final refusal in refusals) {
        expect(find.text(refusal.message), findsNothing);
      }
      expect(find.text('Conversation unavailable.'), findsNothing);

      backend.stateReadFailure = null;
      await poll();
      stillAlpha('back');
      expect(alpha.backendUnreachable, isFalse);
      expect(alpha.snapshot?.name, 'Alpha');
      await _releaseAll(tester, app);
    });

    test('a refusal once the list no longer has the Swarm still takes it '
        'away and moves the tab to Personal', () async {
      final (app, backend, tab, alpha) = await shown();
      final personal = PersonalSwarm.of(app).id!;
      backend.tabs.removeWhere((t) => t['id'] == 'alpha');
      backend.stateReadFailure = refusals.last;
      await alpha.refresh();
      await _settle();
      expect(alpha.accessRevoked, isTrue);
      await fallBackToPersonal(app, alpha);
      expect(_shown(app, tab), personal);
    });

    group('re-reads the list at most once a minute (task #2767)', () {
      late DateTime now;
      late AppNotifier app;
      late _Backend backend;
      late SuperTabController alpha;

      /// One poll of Alpha, its refusal's list check and all, then [later].
      Future<void> poll({Duration later = const Duration(seconds: 10)}) async {
        await alpha.refresh();
        await _settle();
        now = now.add(later);
      }

      Future<void> under(Future<void> Function() body) {
        now = DateTime.utc(2026, 11, 4, 5);
        return withClock(Clock(() => now), () async {
          (app, backend, _, alpha) = await shown();
          await body();
        });
      }

      test('refusals within a minute read the list once, the first of them '
          'failing; a refusal after the minute reads it again', () {
        return under(() async {
          backend.listFailure = dropped;
          backend.stateReadFailure = refusals.last;
          final before = backend.listReads;
          await poll();
          expect(backend.listReads - before, 1);
          backend.listFailure = null;
          for (final refusal in [...refusals, ...refusals]) {
            backend.stateReadFailure = refusal;
            await poll();
          }
          expect(
            backend.listReads - before,
            1,
            reason: 'five refusals in 50 seconds read the list once',
          );
          expect(alpha.accessRevoked, isFalse);
          now = now.add(const Duration(seconds: 10));
          await poll();
          expect(backend.listReads - before, 2);
          expect(alpha.accessRevoked, isFalse);
          expect(alpha.snapshot?.name, 'Alpha');
        });
      });

      test('a list read within the minute that leaves the Swarm out takes it '
          'away at the next refusal, reading the list no more', () {
        return under(() async {
          backend.stateReadFailure = refusals.first;
          await poll();
          expect(alpha.accessRevoked, isFalse);
          final reads = backend.listReads;
          backend.tabs.removeWhere((t) => t['id'] == 'alpha');
          // This computer's own discovery reads the list meanwhile.
          await app.superTabs.refreshTabs();
          await _settle();
          await poll();
          expect(alpha.accessRevoked, isTrue);
          expect(backend.listReads, reads + 1, reason: 'the discovery read');
        });
      });

      test('a list that answered before the refusal asked never takes the '
          'Swarm away', () {
        return under(() async {
          // The last list that answered, already without Alpha, is older
          // than the ask, whose own read fails; another read within the
          // minute is not made.
          backend.tabs.removeWhere((t) => t['id'] == 'alpha');
          await app.superTabs.refreshTabs();
          await _settle();
          now = now.add(const Duration(seconds: 1));
          backend.listFailure = dropped;
          backend.stateReadFailure = refusals.last;
          await poll();
          await poll();
          expect(alpha.accessRevoked, isFalse);
          expect(alpha.snapshot?.name, 'Alpha');
        });
      });

      test('each Swarm has its own minute', () {
        return under(() async {
          final beta = await app.superTabs.open('beta');
          await beta.refresh();
          await _settle();
          backend.stateReadFailure = refusals.last;
          final before = backend.listReads;
          await poll(later: Duration.zero);
          await beta.refresh();
          await _settle();
          expect(backend.listReads - before, 2);
          await poll(later: Duration.zero);
          await beta.refresh();
          await _settle();
          expect(backend.listReads - before, 2);
        });
      });
    });
  });

  test('a failure to add this computer says so in the tab Personal was '
      'picked in, and only there', () async {
    final (app, backend) = await _twoTabs();
    final alphaTab = app.activeSwarmId;
    final betaTab = app.swarms.firstWhere((s) => s.superTabId == 'beta').id;
    backend.prepareState = 'unknown';
    await PersonalSwarm.of(app).show(alphaTab);
    await _settle();
    expect(
      PersonalSwarm.of(app).errorIn(alphaTab),
      'Could not add this computer to Personal. '
      'Update Harness on this machine, then try again.',
    );
    expect(PersonalSwarm.of(app).errorIn(betaTab), isNull);
  });

  test('a failed creation says so only in the tab it was picked in', () async {
    final (app, backend) = await _twoTabs();
    final alphaTab = app.activeSwarmId;
    final betaTab = app.swarms.firstWhere((s) => s.superTabId == 'beta').id;
    backend.failCreate = true;
    await PersonalSwarm.of(app).show(alphaTab);
    await _settle();
    expect(
      PersonalSwarm.of(app).errorIn(alphaTab),
      'Swarm is busy. Try again.',
    );
    expect(PersonalSwarm.of(app).errorIn(betaTab), isNull);
  });

  test('a tab that moves on while Personal’s saved state is read shows no '
      'error', () async {
    final store = _SlowStore();
    final (app, backend) = await _twoTabs(store: store);
    final tab = app.activeSwarmId;
    const id = 'swarm-owner-$kPersonalSwarmOperation';
    store
      ..slowKey = 'super_tab.owner.$id'
      ..hold = Completer<void>();
    final picking = PersonalSwarm.of(app).show(tab);
    await _settle();
    expect(_shown(app, tab), id);
    // The person moves the tab on before Personal has opened.
    app.showSuperTabIn(tab, 'gamma', 'Gamma');
    store.hold!.complete();
    await picking;
    await _settle();
    expect(PersonalSwarm.of(app).errorIn(tab), isNull);
    expect(backend.contributions(id), isEmpty);
    expect(_shown(app, tab), 'gamma');
  });

  testWidgets('a failed creation says so under the bar, and picking Personal '
      'again creates it', (tester) async {
    late AppNotifier app;
    late _Backend backend;
    await tester.runAsync(() async {
      (app, backend) = await _twoTabs();
    });
    backend.failCreate = true;
    await _pumpBar(tester, app);
    await _openMenu(tester);
    await tester.tap(find.byKey(const ValueKey('swarm-switch-personal')));
    await tester.runAsync(() => _settle(tester));
    await tester.pump();
    expect(find.text('Swarm is busy. Try again.'), findsOneWidget);
    expect(_rowText('Alpha'), findsOneWidget);

    backend.failCreate = false;
    await _openMenu(tester);
    expect(find.text('Swarm is busy. Try again.'), findsNothing);
    await tester.tap(find.byKey(const ValueKey('swarm-switch-personal')));
    await tester.runAsync(() => _settle(tester));
    await tester.pump();
    await tester.pump();
    expect(backend.creates, hasLength(2));
    expect(_rowText('Personal'), findsOneWidget);
    await _releaseAll(tester, app);
  });

  group('Personal lists all of the person\'s own machines (Dee)', () {
    List<String?> added(_Backend backend, String id) => [
      for (final c in backend.contributions(id)) c['machineId'] as String?,
    ];

    Future<(AppNotifier, _Backend, SuperTabController)> personal({
      void Function(AppNotifier)? before,
    }) async {
      final (app, backend) = await _twoTabs();
      before?.call(app);
      await PersonalSwarm.of(app).show(app.activeSwarmId);
      await _settle();
      final c = await app.superTabs.open(PersonalSwarm.of(app).id!);
      await PersonalMachines.of(app).sync(c);
      await _settle();
      return (app, backend, c);
    }

    test('opened on one Mac it adds the person\'s other linked machines, and '
        'skips a Team machine, a teammate\'s and an unlinked one', () async {
      final (app, backend, c) = await personal(
        before: (app) {
          _ownMachine(app, 'rig');
          _ownMachine(app, 'lamp');
          _ownMachine(app, 'team', team: true);
          _ownMachine(app, 'theirs', shared: true);
          _ownMachine(app, 'unlinked', linked: false);
        },
      );
      expect(added(backend, c.tabId), unorderedEquals(['m', 'rig', 'lamp']));
      expect(
        backend.machineCalls.map((call) => call.$1),
        isNot(contains('team')),
      );
      expect(
        backend.machineCalls.map((call) => call.$1),
        isNot(contains('theirs')),
      );
      expect(PersonalMachines.of(app).waiting(c), isEmpty);
    });

    test(
      'one at a time: the next is not set up until the last is in',
      () async {
        final (app, backend) = await _twoTabs();
        await PersonalSwarm.of(app).show(app.activeSwarmId);
        await _settle();
        final c = await app.superTabs.open(PersonalSwarm.of(app).id!);
        _ownMachine(app, 'rig');
        _ownMachine(app, 'lamp');
        final hold = backend.holdPrepare = Completer<void>();
        final running = PersonalMachines.of(app).sync(c);
        await _settle();
        final prepared = backend.machineCalls.where(
          (call) => call.$2 == 'prepareContribution' && call.$1 != 'm',
        );
        expect(prepared, hasLength(1));
        hold.complete();
        backend.holdPrepare = null;
        await running;
        await _settle();
        expect(
          backend.machineCalls.where(
            (call) => call.$2 == 'prepareContribution' && call.$1 != 'm',
          ),
          hasLength(2),
        );
      },
    );

    test(
      'an offline machine is listed as Offline, and joins once it is online',
      () async {
        final (app, backend, c) = await personal(
          before: (app) => _ownMachine(app, 'lamp', online: false),
        );
        expect(added(backend, c.tabId), ['m']);
        final row = PersonalMachines.of(app).waiting(c).single;
        expect(row.machineId, 'lamp');
        expect(row.status, 'Offline');
        app.machineStates['lamp']!
          ..nodeOnline = true
          ..connectionStatus = ConnectionStatus.connected;
        await PersonalMachines.of(app).sync(c);
        await _settle();
        expect(added(backend, c.tabId), ['m', 'lamp']);
        expect(PersonalMachines.of(app).waiting(c), isEmpty);
      },
    );

    test(
      'adds nothing while anyone else is in it, and lists nothing',
      () async {
        final (app, backend, c) = await personal();
        final before = added(backend, c.tabId);
        (backend.servers[c.tabId]!.state['people'] as List).add({
          'id': 'peer',
          'email': 'peer@example.com',
          'role': 'collaborator',
        });
        await c.refresh();
        _ownMachine(app, 'rig');
        _ownMachine(app, 'lamp', online: false);
        await PersonalMachines.of(app).sync(c);
        await _settle();
        expect(added(backend, c.tabId), before);
        expect(PersonalMachines.of(app).waiting(c), isEmpty);
      },
    );

    test(
      'a failure says so on its row, waits, and does not hold the next back',
      () async {
        final (app, backend) = await _twoTabs();
        await PersonalSwarm.of(app).show(app.activeSwarmId);
        await _settle();
        final c = await app.superTabs.open(PersonalSwarm.of(app).id!);
        _ownMachine(app, 'rig');
        _ownMachine(app, 'lamp');
        backend.failPrepareOn = 'rig';
        await PersonalMachines.of(app).sync(c);
        await _settle();
        expect(added(backend, c.tabId), contains('lamp'));
        final row = PersonalMachines.of(app).waiting(c).single;
        expect(row.machineId, 'rig');
        expect(row.status, "Couldn't add");
        expect(row.reason, isNotEmpty);
        // Within its wait it is not asked again.
        final asked = backend.machineCalls
            .where((call) => call.$1 == 'rig')
            .length;
        await PersonalMachines.of(app).sync(c);
        await _settle();
        expect(
          backend.machineCalls.where((call) => call.$1 == 'rig'),
          hasLength(asked),
        );
      },
    );

    test('another account\'s list is never read under the last one: sign-out ends the sync', () async {
      final (app, backend) = await _twoTabs();
      await PersonalSwarm.of(app).show(app.activeSwarmId);
      await _settle();
      final c = await app.superTabs.open(PersonalSwarm.of(app).id!);
      _ownMachine(app, 'rig');
      final hold = backend.holdPrepare = Completer<void>();
      final before = added(backend, c.tabId);
      final running = PersonalMachines.of(app).sync(c);
      await _settle();
      app.currentUser = CurrentUserProfile(
        id: 'other',
        email: 'other@example.com',
      );
      hold.complete();
      backend.holdPrepare = null;
      await running;
      await _settle();
      expect(added(backend, c.tabId), before);
    });

    test('asks the server to add a machine only if it is missing, and lends it only through Team accounts, with Team accounts off too', () async {
      final (app, backend) = await _twoTabs();
      await PersonalSwarm.of(app).show(app.activeSwarmId);
      await _settle();
      final c = await app.superTabs.open(PersonalSwarm.of(app).id!);
      backend.servers[c.tabId]!.state['teamAccounts'] = false;
      await c.refresh();
      _ownMachine(app, 'rig');
      await PersonalMachines.of(app).sync(c);
      await _settle();
      final sent = backend
          .contributions(c.tabId)
          .firstWhere((m) => m['machineId'] == 'rig');
      expect(sent['ifMissing'], isTrue);
      expect(sent['teamAccountOnly'], isTrue);
    });

    test('this computer stays out too once its person took it out, and its add asks the server so', () async {
      final (app, backend) = await _twoTabs();
      await PersonalSwarm.of(app).show(app.activeSwarmId);
      await _settle();
      final id = PersonalSwarm.of(app).id!;
      final sent = backend.contributions(id).single;
      expect(sent['ifMissing'], isTrue);
      expect(sent['unlessRemoved'], isTrue);
      // Taken out, on any computer: the next show adds it no more.
      final server = backend.servers[id]!;
      server.state['machines'] = <Map<String, dynamic>>[];
      server.state['removedMachines'] = ['m'];
      final c = await app.superTabs.open(id);
      await c.refresh();
      await PersonalSwarm.of(app).show(app.activeSwarmId);
      await _settle();
      expect(backend.contributions(id), hasLength(1));
    });

    test('a machine its person took out stays out, on a computer that never saw it: the server says so', () async {
      final (app, backend, c) = await personal();
      backend.servers[c.tabId]!.state['removedMachines'] = ['rig'];
      await c.refresh();
      _ownMachine(app, 'rig');
      await PersonalMachines.of(app).sync(c);
      await _settle();
      expect(added(backend, c.tabId), isNot(contains('rig')));
      expect(PersonalMachines.of(app).waiting(c), isEmpty);
    });

    test('sends unlessRemoved, so a read that is behind still cannot bring a removed one back', () async {
      final (app, backend, c) = await personal();
      _ownMachine(app, 'rig');
      await PersonalMachines.of(app).sync(c);
      await _settle();
      expect(
        backend
            .contributions(c.tabId)
            .firstWhere((m) => m['machineId'] == 'rig')['unlessRemoved'],
        isTrue,
      );
    });

    test(
      'adds nothing while it shows a saved view: someone may have joined since',
      () async {
        final (app, backend, c) = await personal();
        c.showingSavedForTest = true;
        final before = added(backend, c.tabId);
        _ownMachine(app, 'rig');
        await PersonalMachines.of(app).sync(c);
        await _settle();
        expect(added(backend, c.tabId), before);
        expect(PersonalMachines.of(app).waiting(c), isEmpty);
      },
    );

    test('a Buddy-only machine, hidden from the Swarm\'s list, is added as an ordinary one', () async {
      final (_, backend, c) = await personal(
        before: (a) => _ownMachine(a, 'buddy-only'),
      );
      expect(added(backend, c.tabId), contains('buddy-only'));
    });

    group('their rows', () {
      Finder row(String id) =>
          find.byKey(ValueKey('super-personal-machine-$id'));
      Future<void> pump(
        WidgetTester tester,
        AppNotifier app,
        SuperTabController c,
      ) async {
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: SingleChildScrollView(
                child: SuperTabMachines(
                  controller: c,
                  app: app,
                  embedded: true,
                  onAddAgent: (_) {},
                ),
              ),
            ),
          ),
        );
        await tester.pump();
      }

      testWidgets(
        'an offline machine reads one word, and the row goes once it joined',
        (tester) async {
          late AppNotifier app;
          late SuperTabController c;
          await tester.runAsync(() async {
            final (a, _, opened) = await personal(
              before: (a) => _ownMachine(a, 'lamp', online: false),
            );
            app = a;
            c = opened;
          });
          await pump(tester, app, c);
          expect(
            find.descendant(
              of: row('lamp'),
              matching: find.text('Machine lamp'),
            ),
            findsOneWidget,
          );
          expect(
            find.descendant(of: row('lamp'), matching: find.text('Offline')),
            findsOneWidget,
          );
          await tester.runAsync(() async {
            app.machineStates['lamp']!
              ..nodeOnline = true
              ..connectionStatus = ConnectionStatus.connected;
            await PersonalMachines.of(app).sync(c);
            await _settle();
            await c.refresh();
          });
          await tester.pump();
          expect(row('lamp'), findsNothing);
        },
      );

      testWidgets('a failure reads one word, with its reason on hover', (
        tester,
      ) async {
        late AppNotifier app;
        late SuperTabController c;
        await tester.runAsync(() async {
          final (a, backend, opened) = await personal();
          app = a;
          c = opened;
          backend.failPrepareOn = 'rig';
          _ownMachine(a, 'rig');
          await PersonalMachines.of(a).sync(c);
          await _settle();
        });
        await pump(tester, app, c);
        expect(
          find.descendant(of: row('rig'), matching: find.text("Couldn't add")),
          findsOneWidget,
        );
        expect(
          find.descendant(
            of: row('rig'),
            matching: find.textContaining('Setup failed'),
          ),
          findsNothing,
        );
        expect(
          find.descendant(
            of: row('rig'),
            matching: find.byTooltip('Setup failed there.'),
          ),
          findsOneWidget,
        );
      });

      testWidgets('another Swarm lists none', (tester) async {
        late AppNotifier app;
        late SuperTabController other;
        await tester.runAsync(() async {
          final (a, _, _) = await personal(
            before: (a) => _ownMachine(a, 'lamp', online: false),
          );
          app = a;
          other = await a.superTabs.open('gamma');
          await other.refresh();
        });
        await pump(tester, app, other);
        expect(row('lamp'), findsNothing);
      });
    });
  });
}
