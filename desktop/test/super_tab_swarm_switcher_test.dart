import 'dart:async';

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/project_sidebar.dart';
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

  /// Machines answer preparing with this state ('ready' sets them up).
  String prepareState = 'ready';

  /// The Swarm an account's personal-swarm request already made, by account.
  final personalOf = <String, String>{};

  /// The account the next request is from.
  String account = 'owner';

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
                    onAddAgent: (_) {},
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
        tester.getTopLeft(find.byKey(const ValueKey('super-new-project'))).dy,
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
}
