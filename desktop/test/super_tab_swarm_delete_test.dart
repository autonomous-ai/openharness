import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/project_sidebar.dart';
import 'package:harness/super_tabs/swarm_delete.dart';
import 'package:harness/super_tabs/swarm_switcher.dart';
import 'package:harness/ws/ws_conn.dart';

import 'support/capture.dart';
import 'support/super_tab_fixture.dart';
import 'swarm_state_test.dart' show MemoryStore, createApp;

/// The backend as deleting a Swarm meets it (backend superTabs/deletion.ts):
/// the account's list, each Swarm's reads and commands, `swarm.delete` by its
/// owner with its exact name, then every read answering as for a missing
/// Swarm, the owner's Recently deleted list, and `swarm.restore`.
class _Backend {
  final tabs = <Map<String, dynamic>>[];
  final servers = <String, ConversationServer>{};
  final deleted = <String, int>{};
  final commands = <(String, String, Map)>[];
  String account = 'owner';
  int now = DateTime.now().millisecondsSinceEpoch;

  /// While set, the deleted list answers only once it completes.
  Completer<void>? holdDeletedList;

  /// The deleted list fails this many more times.
  int failDeletedList = 0;

  /// While set, swarm.delete is refused with it.
  SuperTabFailure? refuseDelete;
  Completer<void>? holdDelete;

  ConversationServer add(
    String id,
    String name, {
    String owner = 'owner',
    List<String> members = const ['owner'],
    int agents = 0,
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
    for (var i = 0; i < agents; i++) {
      (server.state['agents'] as List).add({
        'id': 'agent-$id-$i',
        'name': 'Agent $i',
        'machineId': 'm',
        'harnessId': 'h-$id-$i',
        'contributorId': owner,
        'projectId': 'lead',
        'configuration': {'engine': 'codex'},
      });
    }
    servers[id] = server;
    tabs.add({'id': id, 'name': name, 'ownerId': owner, 'members': members});
    return server;
  }

  static const missing = SuperTabFailure(
    'NOT_FOUND',
    'This is not available to you. It may have been removed, or your access changed.',
    statusCode: 404,
  );

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
            if ((tab['members'] as List).contains(account) &&
                !deleted.containsKey(tab['id']))
              {'id': tab['id'], 'name': tab['name'], 'ownerId': tab['ownerId']},
        ],
        'next': null,
      };
    }
    if (uri.path == '/api/super-tabs/deleted') {
      if (holdDeletedList case final hold?) await hold.future;
      if (failDeletedList > 0) {
        failDeletedList--;
        throw const SuperTabFailure(
          'SERVICE_UNAVAILABLE',
          'Busy.',
          statusCode: 503,
        );
      }
      return {
        'tabs': [
          for (final MapEntry(key: id, value: at) in deleted.entries)
            if (tabs.firstWhere((t) => t['id'] == id)['ownerId'] == account)
              {
                'id': id,
                'name': tabs.firstWhere((t) => t['id'] == id)['name'],
                'deletedAt': at,
                'purgeAt': at + const Duration(days: 7).inMilliseconds,
              },
        ],
      };
    }
    final swarm = RegExp(r'^/api/super-tabs/([^/]+)/').firstMatch(uri.path);
    final id = swarm?.group(1);
    final server = servers[id];
    if (server == null) throw missing;
    final tab = tabs.firstWhere((t) => t['id'] == id);
    final command = method == 'POST' && uri.path.endsWith('/commands')
        ? body!['command'] as Map
        : null;
    if (command != null) commands.add((account, id!, command));
    if (command?['type'] == 'swarm.restore') {
      if (!deleted.containsKey(id) || tab['ownerId'] != account) throw missing;
      deleted.remove(id);
      return {
        'result': {'restored': true},
        'revision': 1,
      };
    }
    // A deleted Swarm reads, and takes commands, as one that does not exist.
    if (deleted.containsKey(id) ||
        !(tab['members'] as List).contains(account)) {
      throw missing;
    }
    if (command?['type'] == 'swarm.delete') {
      if (holdDelete case final hold?) await hold.future;
      if (refuseDelete case final refusal?) throw refusal;
      if (tab['ownerId'] != account) throw missing;
      if (command!['name'] != tab['name']) {
        throw const SuperTabFailure(
          'NAME_MISMATCH',
          'Type the Swarm\'s name exactly to delete it.',
          statusCode: 400,
        );
      }
      deleted[id!] = now;
      return {
        'result': {'purgeAt': now + const Duration(days: 7).inMilliseconds},
        'revision': 1,
      };
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
    if (type != 'super_tabs' || payload['action'] != 'backend') return {};
    return {
      'value': await backend.request(
        payload['method'] as String,
        payload['path'] as String,
        body: payload['body'] as Map<String, dynamic>?,
      ),
    };
  }
}

AppNotifier _computer(_Backend backend, {String account = 'owner'}) {
  final app = createApp(
    store: MemoryStore(),
    connected: true,
    connectionForTest: (machineId) => _Connection(backend, machineId),
  );
  app.machineStates['m']!.localOnly = true;
  app.status = AppStatus.authenticated;
  app.currentUser = CurrentUserProfile(
    id: account,
    email: '$account@example.com',
  );
  app.enterSuperTabs();
  addTearDown(app.dispose);
  return app;
}

Future<void> _settle() async {
  for (var i = 0; i < 30; i++) {
    await Future<void>.delayed(Duration.zero);
  }
}

/// Alpha (owner, a member and two agents) shown in a tab, and Beta.
Future<(AppNotifier, _Backend)> _swarms({String account = 'owner'}) async {
  final backend = _Backend()
    ..account = account
    ..add('alpha', 'Alpha', members: ['owner', 'member'], agents: 2)
    ..add('beta', 'Beta', members: ['owner', 'member']);
  final app = _computer(backend, account: account);
  await app.superTabs.refreshTabs();
  app.selectSwarm(app.swarms.firstWhere((s) => s.superTabId == 'alpha').id);
  return (app, backend);
}

Future<SuperTabController> _pump(
  WidgetTester tester,
  AppNotifier app, {
  Brightness brightness = Brightness.dark,
}) async {
  await tester.binding.setSurfaceSize(const Size(900, 900));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  late SuperTabController shown;
  await tester.runAsync(() async {
    shown = await app.superTabs.open(app.activeSwarm.superTabId!);
    await shown.refresh();
  });
  await tester.pumpWidget(
    MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: grid.buildAppTheme(brightness: brightness),
      home: Scaffold(
        body: Align(
          alignment: Alignment.topLeft,
          child: SizedBox(
            width: 300,
            child: ListenableBuilder(
              listenable: app,
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
                        onNewSwarm: () {},
                      ),
                    ),
                  },
            ),
          ),
        ),
      ),
    ),
  );
  await tester.pump();
  await tester.pump();
  return shown;
}

Future<void> _releaseAll(WidgetTester tester, AppNotifier app) async {
  await tester.pumpWidget(const SizedBox());
  for (final c in app.superTabs.loadedControllers.toList()) {
    app.superTabs.release(c.tabId);
  }
  await tester.runAsync(_settle);
}

Future<void> _openMenu(WidgetTester tester) async {
  await tester.tap(find.byKey(const ValueKey('super-swarm-switcher')));
  await tester.runAsync(_settle);
  await tester.pump();
  await tester.pump();
}

const _deleteItem = ValueKey('swarm-switch-delete');
const _confirm = ValueKey('swarm-delete-confirm');
const _nameField = ValueKey('swarm-delete-name');

/// Through the fake transport, then the frames it changed.
Future<void> _run(WidgetTester tester) async {
  await tester.runAsync(_settle);
  await tester.pump();
  await tester.pump();
}

Future<void> _openDialog(WidgetTester tester) async {
  await _openMenu(tester);
  await tester.tap(find.byKey(_deleteItem));
  await tester.pump();
  await tester.pump();
}

bool _confirmEnabled(WidgetTester tester) =>
    tester.widget<FilledButton>(find.byKey(_confirm)).onPressed != null;

final _shots = Platform.environment['SWARM_DELETE_SHOTS'];

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() => loadCaptureFonts(_shots));

  testWidgets('the dropdown offers Delete to the owner of the shown Swarm '
      'alone: not to a member, and never for Personal', (tester) async {
    late AppNotifier app;
    await tester.runAsync(() async => (app, _) = await _swarms());
    await _pump(tester, app);
    await _openMenu(tester);
    expect(find.byKey(_deleteItem), findsOneWidget);
    expect(find.text('Delete “Alpha”…'), findsOneWidget);
    await _releaseAll(tester, app);

    late AppNotifier member;
    await tester.runAsync(
      () async => (member, _) = await _swarms(account: 'member'),
    );
    await _pump(tester, member);
    await _openMenu(tester);
    expect(find.byKey(const ValueKey('swarm-switch-alpha')), findsOneWidget);
    expect(find.byKey(_deleteItem), findsNothing);
    await _releaseAll(tester, member);
  });

  testWidgets('the dialog names who loses access and deletes only once the '
      'exact name is typed; Cancel sends nothing', (tester) async {
    late AppNotifier app;
    late _Backend backend;
    await tester.runAsync(() async => (app, backend) = await _swarms());
    await _pump(tester, app);
    await _openDialog(tester);
    expect(find.text('Delete “Alpha”?'), findsOneWidget);
    expect(
      find.text('Everyone loses access at once: 2 people, 2 agents.'),
      findsOneWidget,
    );
    expect(_confirmEnabled(tester), isFalse);
    for (final wrong in ['alpha', 'Alph', 'Alpha!']) {
      await tester.enterText(find.byKey(_nameField), wrong);
      await tester.pump();
      expect(_confirmEnabled(tester), isFalse, reason: wrong);
    }
    await tester.enterText(find.byKey(_nameField), ' Alpha ');
    await tester.pump();
    expect(_confirmEnabled(tester), isTrue);
    await tester.tap(find.byKey(const ValueKey('swarm-delete-cancel')));
    await tester.pump();
    await tester.pump();
    expect(find.byKey(const ValueKey('swarm-delete-dialog')), findsNothing);
    expect(
      backend.commands.where((c) => c.$3['type'] == 'swarm.delete'),
      isEmpty,
    );
    expect(backend.deleted, isEmpty);
    await _releaseAll(tester, app);
  });

  testWidgets('deleting takes the Swarm out of the dropdown at once and lists '
      'it under Restore; restoring brings it back into this tab', (
    tester,
  ) async {
    late AppNotifier app;
    late _Backend backend;
    await tester.runAsync(() async => (app, backend) = await _swarms());
    final shown = await _pump(tester, app);
    await _openDialog(tester);
    await tester.enterText(find.byKey(_nameField), 'Alpha');
    await tester.pump();
    await tester.tap(find.byKey(_confirm));
    await _run(tester);
    await _run(tester);

    expect(
      [
        for (final (who, id, command) in backend.commands)
          if (command['type'] == 'swarm.delete') (who, id, command['name']),
      ],
      [('owner', 'alpha', 'Alpha')],
    );
    expect(find.byKey(const ValueKey('swarm-delete-dialog')), findsNothing);
    // Gone from this computer at once: its view lets go of it, the dropdown
    // no longer lists it, and nothing of it stays readable here.
    expect(shown.accessRevoked, isTrue);
    expect(shown.snapshot, isNull);
    expect(swarmChoices(app).map((c) => c.id), isNot(contains('alpha')));
    expect(app.superTabs.ownerOf('alpha'), isNull);

    await _openMenu(tester);
    expect(find.byKey(const ValueKey('swarm-switch-alpha')), findsNothing);
    expect(find.text('Restore “Alpha”'), findsOneWidget);
    expect(find.text('Deleted · 7 days left'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('swarm-switch-restore-alpha')));
    await _run(tester);
    await _run(tester);
    final (who, id, command) = backend.commands.last;
    expect((who, id, command['type']), ('owner', 'alpha', 'swarm.restore'));
    expect(backend.deleted, isEmpty);
    expect(swarmChoices(app).map((c) => c.id), contains('alpha'));
    expect(app.activeSwarm.superTabId, 'alpha');
    expect(DeletedSwarms.of(app).items, isEmpty);
    await _releaseAll(tester, app);
  });

  testWidgets('a member\'s computer loses the deleted Swarm on its next read, '
      'with its chat and agents cleared', (tester) async {
    late AppNotifier member;
    late _Backend backend;
    late SuperTabController alpha;
    await tester.runAsync(() async {
      (member, backend) = await _swarms(account: 'member');
      alpha = await member.superTabs.open('alpha');
      await alpha.refresh();
      expect(alpha.snapshot?.agents, hasLength(2));
      backend.deleted['alpha'] = backend.now;
      await alpha.refresh();
      await member.superTabs.refreshTabs();
    });
    expect(alpha.accessRevoked, isTrue);
    expect(alpha.snapshot, isNull);
    expect(swarmChoices(member).map((c) => c.id), isNot(contains('alpha')));
    // And a member is never offered its restore.
    await tester.runAsync(() => DeletedSwarms.of(member).read());
    expect(DeletedSwarms.of(member).items, isEmpty);
    member.superTabs.release('alpha');
    await tester.runAsync(_settle);
  });

  testWidgets('a refusal keeps the dialog open with its reason, and deletes '
      'nothing', (tester) async {
    late AppNotifier app;
    late _Backend backend;
    await tester.runAsync(() async => (app, backend) = await _swarms());
    backend.refuseDelete = const SuperTabFailure(
      'STARTS_PENDING',
      'An agent is starting in this Swarm. Try again in a moment.',
      statusCode: 409,
    );
    final shown = await _pump(tester, app);
    await _openDialog(tester);
    await tester.enterText(find.byKey(_nameField), 'Alpha');
    await tester.pump();
    await tester.tap(find.byKey(_confirm));
    await _run(tester);
    expect(find.byKey(const ValueKey('swarm-delete-dialog')), findsOneWidget);
    expect(find.byKey(const ValueKey('swarm-delete-error')), findsOneWidget);
    expect(shown.accessRevoked, isFalse);
    expect(swarmChoices(app).map((c) => c.id), contains('alpha'));
    await tester.tap(find.byKey(const ValueKey('swarm-delete-cancel')));
    await tester.pump();
    await _releaseAll(tester, app);
  });

  testWidgets('access lost while the dialog is open closes what it showed; a '
      'late answer changes nothing', (tester) async {
    late AppNotifier app;
    await tester.runAsync(() async => (app, _) = await _swarms());
    final shown = await _pump(tester, app);
    await _openDialog(tester);
    expect(find.text('Delete “Alpha”?'), findsOneWidget);
    shown.revokeAccess('You no longer have access to this Swarm.');
    await tester.pump();
    await tester.pump();
    // The dialog no longer names the Swarm, its people or its agents.
    expect(find.text('Delete “Alpha”?'), findsNothing);
    expect(find.textContaining('2 people'), findsNothing);
    expect(find.byKey(_nameField), findsNothing);
    expect(find.text('This action is no longer available.'), findsOneWidget);
    await _releaseAll(tester, app);
  });

  test('a Recently deleted read that answers for another account, or after a '
      'newer read, changes nothing; a failed first read recovers', () async {
    final (app, backend) = await _swarms();
    backend.deleted['beta'] = backend.now;
    final list = DeletedSwarms.of(app);

    // Asked as the owner, answered once another account is signed in.
    backend.holdDeletedList = Completer();
    final stale = list.read();
    app.currentUser = const CurrentUserProfile(
      id: 'member',
      email: 'member@example.com',
    );
    backend.holdDeletedList!.complete();
    backend.holdDeletedList = null;
    await stale;
    expect(list.items, isEmpty);

    app.currentUser = const CurrentUserProfile(
      id: 'owner',
      email: 'owner@example.com',
    );
    backend.failDeletedList = 1;
    await list.read();
    expect(list.items, isEmpty);
    await list.read();
    expect(list.items.map((s) => s.id), ['beta']);

    // Signed out: no account's list is shown, and none is read.
    app.currentUser = null;
    expect(list.items, isEmpty);
  });

  test('a restore the server refuses says why on its row and reads the list '
      'again', () async {
    final (app, backend) = await _swarms();
    backend.deleted['beta'] = backend.now;
    final list = DeletedSwarms.of(app);
    await list.read();
    // Purged meanwhile: the server answers as for a missing Swarm.
    backend.deleted.clear();
    backend.servers.remove('beta');
    expect(await list.restore('beta'), isFalse);
    expect(list.restoreError, (
      id: 'beta',
      message: 'This Swarm can no longer be restored.',
    ));
    await _settle();
    expect(list.items, isEmpty);
  });

  test('parses the deleted list, leaving out rows it cannot read, and says '
      'how long is left', () {
    final rows = parseDeletedSwarms({
      'tabs': [
        {'id': 'a', 'name': 'A', 'purgeAt': 1000},
        {'id': 'b', 'name': 2, 'purgeAt': 1000},
        {'id': 'c', 'name': 'C'},
        'nonsense',
      ],
    });
    expect(rows.map((r) => r.id), ['a']);
    expect(parseDeletedSwarms({'tabs': 'x'}), isEmpty);
    final now = DateTime(2026, 10, 31);
    expect(
      restoreTimeLeft(now.add(const Duration(days: 7)), now),
      '7 days left',
    );
    expect(
      restoreTimeLeft(now.add(const Duration(hours: 30)), now),
      '1 day left',
    );
    expect(
      restoreTimeLeft(now.add(const Duration(hours: 3)), now),
      'Less than a day left',
    );
  });

  for (final brightness in Brightness.values) {
    testWidgets('pictures of Delete Swarm in ${brightness.name}', (
      tester,
    ) async {
      if (_shots == null) return;
      final previous = grid.AppTheme.brightness.value;
      grid.AppTheme.brightness.value = brightness;
      addTearDown(() => grid.AppTheme.brightness.value = previous);
      tester.view.devicePixelRatio = 2;
      tester.view.physicalSize = const Size(1800, 1300);
      addTearDown(tester.view.reset);
      late AppNotifier app;
      late _Backend backend;
      await tester.runAsync(() async {
        (app, backend) = await _swarms();
        backend.add('old', 'test-1');
        backend.deleted['old'] =
            backend.now - const Duration(days: 1).inMilliseconds;
        await app.superTabs.refreshTabs();
      });
      await _pump(tester, app, brightness: brightness);
      await _openMenu(tester);
      await captureWindow(
        tester,
        _shots,
        'swarm-delete-menu-${brightness.name}',
      );
      await tester.tap(find.byKey(_deleteItem));
      await tester.pump();
      await tester.pump();
      await tester.enterText(find.byKey(_nameField), 'Alp');
      await tester.pump();
      await captureWindow(
        tester,
        _shots,
        'swarm-delete-dialog-${brightness.name}',
      );
      await tester.tap(find.byKey(const ValueKey('swarm-delete-cancel')));
      await tester.pump();
      await _releaseAll(tester, app);
    }, variant: TargetPlatformVariant.only(TargetPlatform.macOS));
  }
}
