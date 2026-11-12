import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/new_harness.dart' show newHarnessOpensInBox;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/personal_projects.dart';
import 'package:harness/super_tabs/swarm_switcher.dart';
import 'package:harness/ws/ws_conn.dart';

import 'support/capture.dart';
import 'support/open_harness.dart';
import 'support/super_tab_fixture.dart';
import 'swarm_screen_test.dart' show mount;
import 'swarm_state_test.dart' show MemoryStore, createApp;

/// The backend as a person's computers meet it: their Swarm list, each Swarm's reads, and one Personal Swarm per account
/// whichever computer asks first (backend superTabs/store.ts `create`).
class _Backend {
  _Backend({this.marks = true});

  /// False as a backend before 2026-11-12 answers: no Swarm is marked a Personal one to its members.
  final bool marks;
  final servers = <String, ConversationServer>{};
  final names = <String, String>{};
  final creates = <Map<String, dynamic>>[];
  String? personal;
  bool failCreate = false;
  Completer<void>? holdCreate;

  /// Swarm [id], [owner]'s, with [guests] invited there; a person's name is the one they set ([names]). The reader's own
  /// Personal Swarm ([personal]), or another person's ([personalSwarm]), is marked one in its head.
  void add(
    String id,
    String name, {
    String owner = 'owner',
    List<String> guests = const [],
    Map<String, String> people = const {},
    bool personalSwarm = false,
  }) {
    servers[id] = ConversationServer()
      ..state['id'] = id
      ..state['name'] = name
      ..state['ownerId'] = owner
      ..state['personal'] = marks && (personalSwarm || id == personal)
      ..state['people'] = [
        for (final person in [owner, ...guests])
          {
            'id': person,
            'email': '$person@example.com',
            'role': person == owner ? 'owner' : 'collaborator',
            'name': ?people[person],
          },
      ];
    names[id] = name;
  }

  Future<Object?> request(
    String method,
    String path, {
    Map<String, dynamic>? body,
  }) async {
    final uri = Uri.parse(path);
    if (uri.path == '/api/super-tabs/list') {
      return {
        'tabs': [
          for (final MapEntry(key: id, value: name) in names.entries)
            {
              'id': id,
              'name': name,
              'ownerId': servers[id]!.state['ownerId'],
              // As the backend's list: `personal` only on the reader's own Personal Swarm, `personalSwarm` on every one.
              if (id == personal) 'personal': true,
              if (servers[id]!.state['personal'] == true) 'personalSwarm': true,
            },
        ],
        'next': null,
      };
    }
    if (method == 'POST' && uri.path == '/api/super-tabs') {
      creates.add(Map.of(body!));
      if (holdCreate case final hold?) await hold.future;
      if (failCreate) {
        throw const SuperTabFailure(
          'SERVICE_UNAVAILABLE',
          'Swarm is busy. Try again.',
          statusCode: 503,
        );
      }
      final id = personal ??= 'personal0123456789abcdef';
      if (!servers.containsKey(id)) add(id, body['name'] as String);
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
  _Connection(this.backend)
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
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

/// One of the person's computers, signed in, with nothing of a Swarm remembered on it.
AppNotifier _computer(
  _Backend backend, {
  bool entered = false,
  String account = 'owner',
}) {
  final app = createApp(
    store: MemoryStore(),
    connected: true,
    connectionForTest: (_) => _Connection(backend),
  );
  app.machineStates['m']!.localOnly = true;
  app.status = AppStatus.authenticated;
  app.currentUser = CurrentUserProfile(
    id: account,
    email: '$account@example.com',
  );
  if (entered) app.enterSuperTabs();
  addTearDown(app.dispose);
  return app;
}

/// Personal's row, before the server has named it (swarm_switcher.dart `kPersonalSwarmRow`).
const _personalRow = kPersonalSwarmOperation;

Finder _row(String id) => find.byKey(ValueKey('welcome-closed-super-tab-$id'));

/// [text] in the window's tab strip.
Finder _inTabs(String text) => find.descendant(
  of: find.byKey(const ValueKey('workspace-tab-bar')),
  matching: find.text(text),
);

/// [text] as the left pane's org name, the Swarm menu's row.
Finder _inPane(String text) => find.descendant(
  of: find.byKey(const ValueKey('super-swarm-switcher')),
  matching: find.text(text),
);

/// The Swarm menu's row for [id], reading [text].
Finder _menuRow(String id, String text) => find.descendant(
  of: find.byKey(ValueKey('swarm-switch-$id')),
  matching: find.text(text),
);

Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 20; i++) {
    await tester.pump(const Duration(milliseconds: 20));
  }
}

Future<void> _end(WidgetTester tester, AppNotifier app) async {
  await tester.pumpWidget(const SizedBox.shrink());
  app.superTabs.dispose();
  await tester.pump();
}

/// Set to a folder to write the pull request's pictures there.
final _shots = Platform.environment['PERSONAL_REACH_SHOTS'];

/// The Personal Swarm is reached on each of the person's computers without another Swarm open, first among the Swarms
/// (anh Dee, 2026-11-11), clicked through as a person does.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() => loadCaptureFonts(_shots));

  testWidgets('on a computer that never opened a Swarm, New Swarm offers '
      'Personal first, and a click opens it in that tab', (tester) async {
    final backend = _Backend();
    final app = _computer(backend);
    // New Swarm, as Alt+S and the New Tab page's button make it.
    app.newSwarm(newTabPage: true);
    app.markSuperTabDraft(app.activeSwarmId);
    final draft = app.activeSwarmId;
    await mount(tester, app);
    await captureWindow(tester, _shots, 'new-swarm-page');
    expect(_row(_personalRow), findsOneWidget);
    expect(
      find.descendant(of: _row(_personalRow), matching: find.text('Personal')),
      findsOneWidget,
    );

    await tester.tap(_row(_personalRow));
    await _settle(tester);
    // Asked once, by the request every computer of theirs sends, and shown in the tab it was asked from.
    expect(backend.creates, hasLength(1));
    expect(backend.creates.single['operationId'], kPersonalSwarmOperation);
    expect(app.activeSwarmId, draft);
    expect(app.activeSwarm.superTabId, backend.personal);
    expect(app.activeSwarm.name, 'Personal');
    expect(app.swarms.where((s) => s.isSuperTab), hasLength(1));
    await _end(tester, app);
  });

  testWidgets('on their second computer Personal is first on the New Tab page '
      'and in the command palette, once, and opens the one they have', (
    tester,
  ) async {
    final backend = _Backend()
      ..add('0123456789abcdef01234567', 'Pilot')
      ..personal = 'personal0123456789abcdef';
    backend.add(backend.personal!, 'Personal');
    final app = _computer(backend, entered: true);
    // Both closed on this computer.
    await app.superTabs.setTabVisible('0123456789abcdef01234567', false);
    await app.superTabs.setTabVisible(backend.personal!, false);
    await app.superTabs.refreshTabs();
    app.newSwarm(newTabPage: true);
    await mount(tester, app);
    await _settle(tester);
    await captureWindow(tester, _shots, 'new-tab-page');

    final rows = find.descendant(
      of: find.byKey(const ValueKey('welcome-closed-super-tabs')),
      matching: find.byType(TextButton),
    );
    expect(rows, findsNWidgets(2));
    expect(
      tester.widget<TextButton>(rows.first).key,
      const ValueKey('welcome-closed-super-tab-$_personalRow'),
    );
    expect(_row(backend.personal!), findsNothing);
    expect(_row('0123456789abcdef01234567'), findsOneWidget);

    await openHarnessPicker(tester);
    await tester.enterText(
      find.byKey(const ValueKey('swarm-search-input')),
      '>Personal',
    );
    await tester.pumpAndSettle();
    await captureWindow(tester, _shots, 'command-palette');
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await _settle(tester);
    // The server answered the Swarm it made before: none is made twice.
    expect(app.activeSwarm.superTabId, backend.personal);
    expect(backend.servers, hasLength(2));
    expect(
      app.swarms.where((s) => s.superTabId == backend.personal),
      hasLength(1),
    );
    await _end(tester, app);
  });

  // PSQA, 2026-11-12: a computer that had not picked Personal took it for any Swarm once someone was invited there, as it
  // guessed Personal by its name and its people: the switcher listed it twice, and Your Team had no panes there.
  testWidgets('on a computer that has not picked Personal yet, their Personal '
      'with someone they invited is still Personal: listed once, with their '
      'panes', (tester) async {
    final backend = _Backend()..personal = 'personal0123456789abcdef';
    backend.add(backend.personal!, 'Personal');
    (backend.servers[backend.personal]!.state['people'] as List).add({
      'id': 'kim',
      'email': 'kim@example.com',
      'role': 'collaborator',
    });
    final app = _computer(backend, entered: true);
    await app.superTabs.refreshTabs();
    final c = await app.superTabs.open(backend.personal!);
    await c.refresh();
    expect(c.snapshot!.people, hasLength(2));
    await mount(tester, app);
    await _settle(tester);
    expect(PersonalSwarm.of(app).id, backend.personal);
    // Its Your Team holds their panes and its Projects their repos, as on the computer that picked it.
    expect(PersonalProjects.of(app).eligible(c), isTrue);
    expect(
      swarmChoices(app).where((choice) => choice.id == backend.personal),
      isEmpty,
    );
    expect(
      swarmsToOpen(app, personal: true).where((s) => s.name == 'Personal'),
      hasLength(1),
    );
    await _end(tester, app);
  });

  // anh Dee, 2026-11-12: someone invited to a person's Personal Swarm saw it as "Personal", right beside their own.
  testWidgets('a guest sees the Personal Swarm they were invited to as its '
      "owner's Swarm in the tab, the left pane, the Swarm menu, Recent Swarms "
      'and the command palette; their own is Personal and a team Swarm keeps '
      'its name', (tester) async {
    const own = 'kimpersonal0123456789abc';
    const dees = 'deepersonal0123456789abc';
    const pilot = '0123456789abcdef01234567';
    // A team Swarm Dee named Personal: not a Personal Swarm, so it keeps its name.
    const team = 'deeteam0123456789abcdef0';
    final backend = _Backend()..personal = own;
    backend
      ..add(own, 'Personal', owner: 'kim')
      ..add(
        dees,
        'Personal',
        owner: 'dee',
        guests: ['kim'],
        people: {'dee': 'Dee'},
        personalSwarm: true,
      )
      ..add(pilot, 'Pilot', owner: 'dee', guests: ['kim'])
      ..add(team, 'Personal', owner: 'dee', guests: ['kim']);
    final app = _computer(backend, entered: true, account: 'kim');
    await app.superTabs.setTabVisible(pilot, false);
    await app.superTabs.setTabVisible(team, false);
    await app.superTabs.refreshTabs();
    app.selectSwarm(app.swarms.firstWhere((s) => s.superTabId == dees).id);
    await mount(tester, app);
    await _settle(tester);

    expect(_inPane("Dee's Swarm"), findsOneWidget);
    expect(_inTabs("Dee's Swarm"), findsOneWidget);
    expect(_inTabs('Personal'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('super-swarm-switcher')));
    await _settle(tester);
    expect(_menuRow('personal', 'Personal'), findsOneWidget);
    expect(_menuRow(dees, "Dee's Swarm"), findsOneWidget);
    expect(_menuRow(pilot, 'Pilot'), findsOneWidget);
    expect(_menuRow(team, 'Personal'), findsOneWidget);

    // Pilot in this tab: Dee's goes to Recent Swarms, named the same.
    await tester.tap(find.byKey(const ValueKey('swarm-switch-$pilot')));
    await _settle(tester);
    expect(_inPane('Pilot'), findsOneWidget);
    app.newSwarm(newTabPage: true);
    await _settle(tester);
    expect(
      find.descendant(of: _row(dees), matching: find.text("Dee's Swarm")),
      findsOneWidget,
    );
    expect(
      find.descendant(of: _row(_personalRow), matching: find.text('Personal')),
      findsOneWidget,
    );
    expect(
      find.descendant(of: _row(team), matching: find.text('Personal')),
      findsOneWidget,
    );

    await openHarnessPicker(tester);
    await tester.enterText(
      find.byKey(const ValueKey('swarm-search-input')),
      ">Dee's",
    );
    await tester.pumpAndSettle();
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await _settle(tester);
    expect(app.activeSwarm.superTabId, dees);
    expect(_inTabs("Dee's Swarm"), findsOneWidget);
    // Display only: the Swarm is still named Personal.
    expect(app.superTabName(dees), 'Personal');
    await _end(tester, app);
  });

  testWidgets('its owner still sees their Personal Swarm, with a guest in it, '
      'as Personal, and a team Swarm by its name', (tester) async {
    const dees = 'deepersonal0123456789abc';
    const pilot = '0123456789abcdef01234567';
    final backend = _Backend()..personal = dees;
    backend
      ..add(
        dees,
        'Personal',
        owner: 'dee',
        guests: ['kim'],
        people: {'dee': 'Dee', 'kim': 'Kim'},
      )
      ..add(pilot, 'Pilot', owner: 'dee', guests: ['kim']);
    final app = _computer(backend, entered: true, account: 'dee');
    await app.superTabs.refreshTabs();
    app.selectSwarm(app.swarms.firstWhere((s) => s.superTabId == dees).id);
    await mount(tester, app);
    await _settle(tester);

    expect(_inPane('Personal'), findsOneWidget);
    expect(_inTabs('Personal'), findsOneWidget);
    expect(_inTabs('Pilot'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('super-swarm-switcher')));
    await _settle(tester);
    expect(_menuRow('personal', 'Personal'), findsOneWidget);
    expect(_menuRow(pilot, 'Pilot'), findsOneWidget);
    expect(find.byKey(const ValueKey('swarm-switch-$dees')), findsNothing);
    expect(find.textContaining("'s Swarm"), findsNothing);
    await _end(tester, app);
  });

  testWidgets('against a backend that marks no Personal Swarm to its guests, '
      'another person\'s keeps its own name', (tester) async {
    const own = 'kimpersonal0123456789abc';
    const dees = 'deepersonal0123456789abc';
    final backend = _Backend(marks: false)..personal = own;
    backend
      ..add(own, 'Personal', owner: 'kim')
      ..add(
        dees,
        'Personal',
        owner: 'dee',
        guests: ['kim'],
        people: {'dee': 'Dee'},
      );
    final app = _computer(backend, entered: true, account: 'kim');
    await app.superTabs.refreshTabs();
    app.selectSwarm(app.swarms.firstWhere((s) => s.superTabId == dees).id);
    await mount(tester, app);
    await _settle(tester);
    expect(_inPane('Personal'), findsOneWidget);
    expect(find.textContaining("'s Swarm"), findsNothing);
    await _end(tester, app);
  });

  // PSQA, 2026-11-12: the Swarms' names sat 30 points left of the recent harnesses' names above them.
  testWidgets('on the New Tab page as the app draws it, Recent Swarms\' names '
      'start where the recent harnesses\' names do, and a click opens one', (
    tester,
  ) async {
    final box = newHarnessOpensInBox;
    newHarnessOpensInBox = true;
    addTearDown(() => newHarnessOpensInBox = box);
    final backend = _Backend()..add('0123456789abcdef01234567', 'Pilot');
    final app = _computer(backend, entered: true);
    app.machineStates['m']!.agents = [
      Agent(
        id: 'recent',
        name: 'Polish the desktop composer',
        engine: 'claude',
        terminalAvailable: true,
        lastOpenedAt: DateTime.now().subtract(const Duration(minutes: 5)),
        lastActivityAt: DateTime.now().subtract(const Duration(minutes: 5)),
      ),
    ];
    await app.superTabs.setTabVisible('0123456789abcdef01234567', false);
    await app.superTabs.refreshTabs();
    app.newSwarm(newTabPage: true);
    await mount(tester, app);
    await _settle(tester);
    await captureWindow(tester, _shots, 'new-tab-page-recents');

    final harness = tester
        .getTopLeft(
          find.descendant(
            of: find.byKey(const ValueKey('welcome-sessions')),
            matching: find.text('Polish the desktop composer'),
          ),
        )
        .dx;
    for (final name in ['Personal', 'Pilot']) {
      expect(
        tester
            .getTopLeft(
              find.descendant(
                of: find.byKey(const ValueKey('welcome-closed-super-tabs')),
                matching: find.text(name),
              ),
            )
            .dx,
        moreOrLessEquals(harness, epsilon: .5),
        reason: name,
      );
    }
    await tester.tap(_row('0123456789abcdef01234567'));
    await _settle(tester);
    expect(app.activeSwarm.superTabId, '0123456789abcdef01234567');
    await _end(tester, app);
  });

  testWidgets('a person who moves to another tab while Personal is being made '
      'stays there', (tester) async {
    final backend = _Backend()..holdCreate = Completer<void>();
    final app = _computer(backend);
    final first = app.activeSwarmId;
    app.newSwarm(newTabPage: true);
    app.markSuperTabDraft(app.activeSwarmId);
    await mount(tester, app);
    await tester.tap(_row(_personalRow));
    await tester.pump();
    app.selectSwarm(first);
    backend.holdCreate!.complete();
    await _settle(tester);
    expect(app.activeSwarmId, first);
    expect(app.swarms.where((s) => s.superTabId != null), isEmpty);
    await _end(tester, app);
  });

  testWidgets('a Personal Swarm the server cannot make says why and leaves '
      'the page as it was', (tester) async {
    final backend = _Backend()..failCreate = true;
    final app = _computer(backend);
    app.newSwarm(newTabPage: true);
    app.markSuperTabDraft(app.activeSwarmId);
    await mount(tester, app);
    await tester.tap(_row(_personalRow));
    await _settle(tester);
    expect(find.text('Swarm is busy. Try again.'), findsOneWidget);
    expect(app.activeSwarm.superTabId, isNull);
    expect(_row(_personalRow), findsOneWidget);
    await _end(tester, app);
  });
}
