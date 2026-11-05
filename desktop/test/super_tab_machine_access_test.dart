// Task #3047 (phase 1, docs/design/2026-11-05-machine-access.md section 6): what each machine can reach, per macOS
// account. Every member who sees a machine reads its Access on the expanded row; its owner keeps the list in Configure
// (backend `machine.access`). Memory store and a fake sign-in only: nothing here touches the real CLI.
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/detail_dialog.dart';
import 'package:harness/super_tabs/machines.dart';

import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;
import 'super_tab_machines_test.dart' show openMachineDetails;
import 'support/capture.dart';
import 'support/super_tab_fixture.dart';

/// Set to a folder to write the PR's screenshots there.
final shots = Platform.environment['HARNESS_SUPER_TAB_CAPTURE'];

const _gray = {
  'id': 'gray',
  'email': 'gray@example.com',
  'role': 'member',
  'name': 'Gray',
};
const _dee = {
  'id': 'dee',
  'email': 'dee@example.com',
  'role': 'member',
  'name': 'Dee',
};

Map<String, dynamic> _entry(
  String id,
  String name, {
  String account = 'own',
  String state = 'ok',
  bool teammates = false,
  bool production = false,
  String? note,
  String? saidBy,
}) => {
  'id': id,
  'name': name,
  'account': account,
  'state': state,
  if (teammates) 'teammates': true,
  if (production) 'production': true,
  'note': ?note,
  'addedBy': saidBy ?? 'owner',
  'addedAt': '2026-11-05T09:00:00Z',
  'saidBy': ?saidBy,
};

/// The owner's list in the mockup: three own entries (one with a note, one Dee said), and two in the Team account.
final _ownerList = [
  _entry('a1', 'Fusion 360'),
  _entry('a2', 'ArgoCD', note: 'connection info in ~/.argocd/config'),
  _entry('a3', 'Slack (dee@)', state: 'unconfirmed', saidBy: 'dee'),
  _entry('a4', 'Lamp', account: 'team'),
  _entry('a5', "Tony's iPhone", account: 'team'),
];

/// The Mac [id] owned by [contributor], with [access] on its own entry, as the Swarm sends it.
Map<String, dynamic> _mac(
  String id, {
  String contributor = 'owner',
  String? name,
  List<Map<String, dynamic>>? access,
}) => {
  'machineId': id,
  'name': ?name,
  'contributorId': contributor,
  'maxAgents': 4,
  'observation': {'receivedAt': DateTime.now().millisecondsSinceEpoch},
  'access': ?access,
};

/// [mac]'s Harness Team account: its own pool, which never carries a list of its own.
Map<String, dynamic> _team(String mac, {String contributor = 'owner'}) => {
  'machineId': '$mac-team',
  'name': '$mac (Team)',
  'contributorId': contributor,
  'hostMachineId': mac,
  'maxAgents': 4,
  'observation': {'receivedAt': DateTime.now().millisecondsSinceEpoch},
};

List<Map<String, dynamic>> _accessCommands(ConversationServer server) => [
  for (final p in server.posts)
    if ((p['command'] as Map?)?['type'] == 'machine.access')
      Map<String, dynamic>.from(p['command'] as Map),
];

void _theme(Brightness brightness) {
  // The design tokens follow the app's brightness, which main.dart sets from the theme.
  final previous = grid.AppTheme.brightness.value;
  grid.AppTheme.brightness.value = brightness;
  addTearDown(() => grid.AppTheme.brightness.value = previous);
}

/// The Machines list on [server], read as [account], its machines expanded.
Future<dynamic> _mountRows(
  WidgetTester tester,
  ConversationServer server, {
  String account = 'owner',
  Brightness brightness = Brightness.light,
  GlobalKey? picture,
}) async {
  _theme(brightness);
  final c = server.controller(account: account);
  await c.refresh();
  for (final m in server.state['machines'] as List) {
    if ((m as Map)['hostMachineId'] == null) {
      c.toggleMachineExpanded(m['machineId'] as String);
    }
  }
  await tester.pumpWidget(
    MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: grid.buildAppTheme(brightness: brightness),
      home: Scaffold(
        body: RepaintBoundary(
          key: picture,
          child: SuperTabMachines(controller: c, onAddAgent: (_) {}),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return c;
}

/// The owner's Configure for machine `m`, this computer, as the machine's details open it.
Future<dynamic> _openConfigure(
  WidgetTester tester,
  SuperTabLaunchFixture f, {
  Brightness brightness = Brightness.light,
  String row = 'm',
}) async {
  _theme(brightness);
  final c = await f.app.superTabs.open(tabId);
  await c.refresh();
  await tester.pumpWidget(
    MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: grid.buildAppTheme(brightness: brightness),
      home: Scaffold(
        body: SuperTabMachines(
          controller: c,
          app: f.app,
          onAddAgent: (_) {},
          readLocal: (_) async => null,
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  await openMachineDetails(tester, find.byKey(ValueKey('super-machine-$row')));
  await tester.tap(find.widgetWithText(TextButton, 'Configure'));
  await tester.pumpAndSettle();
  return c;
}

SuperTabLaunchFixture _fixture(List<Map<String, dynamic>> machines) {
  final f = SuperTabLaunchFixture();
  f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
  f.connection.server.state['people'] = [
    {'id': 'owner', 'email': 'owner@example.com', 'role': 'owner'},
    _dee,
  ];
  f.connection.server.state['machines'] = machines;
  return f;
}

Future<void> _doneRows(WidgetTester tester, dynamic c) async {
  await tester.pumpWidget(const SizedBox());
  await c.flush();
  c.dispose();
}

Future<void> _doneConfigure(
  WidgetTester tester,
  SuperTabLaunchFixture f,
  dynamic c,
) async {
  await tester.pumpWidget(const SizedBox());
  await c.flush();
  f.app.superTabs.dispose();
  await tester.pump();
}

final _configure = find.byType(SuperTabDetailDialog);
Finder _inConfigure(Finder matching) =>
    find.descendant(of: _configure, matching: matching);

void main() {
  setUpAll(() => loadCaptureFonts(shots));

  setUp(() {
    // Room for the Configure dialog's whole Access section.
    final view =
        TestWidgetsFlutterBinding.instance.platformDispatcher.views.first;
    view.physicalSize = const Size(1000, 1100);
    view.devicePixelRatio = 1;
  });
  tearDown(() {
    final view =
        TestWidgetsFlutterBinding.instance.platformDispatcher.views.first;
    view.resetPhysicalSize();
    view.resetDevicePixelRatio();
  });

  group('the expanded row', () {
    testWidgets(
      "says what it can reach by account, to every member who sees it, its owner's account by name",
      (tester) async {
        final server = ConversationServer();
        server.state['people'] = [
          {'id': 'owner', 'email': 'owner@example.com', 'role': 'owner'},
          _gray,
          _dee,
        ];
        server.state['machines'] = [
          _mac(
            'studio',
            contributor: 'gray',
            name: "Gray's Mac",
            access: [
              _entry('a1', 'Fusion 360'),
              _entry('a2', 'Email (dee@)', state: 'unconfirmed', saidBy: 'dee'),
              _entry('a3', 'Lamp', account: 'team'),
              _entry('a4', 'Flutter', account: 'team'),
            ],
          ),
          _team('studio', contributor: 'gray'),
          _mac(
            'kiln',
            contributor: 'gray',
            name: 'Mac Studio',
            access: [_entry('b1', 'Prod DB read-only', production: true)],
          ),
        ];
        // Another member reads it: the owner of the Swarm, not of the machine.
        final c = await _mountRows(tester, server);
        final studio = find.byKey(
          const ValueKey('super-machine-access-studio'),
        );
        expect(studio, findsOneWidget);
        expect(
          find.descendant(
            of: studio,
            matching: find.text(
              "Gray's account: Fusion 360 · Email (dee@) waiting for Gray",
              findRichText: true,
            ),
          ),
          findsOneWidget,
        );
        expect(
          find.descendant(
            of: studio,
            matching: find.text(
              'Team account: Lamp · Flutter',
              findRichText: true,
            ),
          ),
          findsOneWidget,
        );
        expect(
          find.descendant(
            of: find.byKey(const ValueKey('super-machine-access-kiln')),
            matching: find.text(
              "Gray's account: Prod DB read-only (production)",
              findRichText: true,
            ),
          ),
          findsOneWidget,
        );
        // Last, under the readings: after Subscriptions.
        expect(
          tester.getTopLeft(studio).dy,
          greaterThan(
            tester
                .getTopLeft(
                  find
                      .descendant(
                        of: find.byKey(
                          const ValueKey('super-machine-readings-studio'),
                        ),
                        matching: find.text(
                          'Subscriptions',
                          findRichText: true,
                        ),
                      )
                      .first,
                )
                .dy,
          ),
        );
        expect(tester.takeException(), isNull);
        await _doneRows(tester, c);
      },
    );

    testWidgets(
      'an entry not working says so; a machine with nothing listed has no Access',
      (tester) async {
        final server = ConversationServer();
        server.state['people'] = [
          {'id': 'owner', 'email': 'owner@example.com', 'role': 'owner'},
          _gray,
        ];
        server.state['machines'] = [
          _mac(
            'studio',
            contributor: 'gray',
            access: [
              // Phase 2's state, from a newer server: shown, never dropped.
              _entry('a1', 'Email (dee@)', state: 'notWorking'),
            ],
          ),
          _mac('pro', contributor: 'gray'),
        ];
        final c = await _mountRows(tester, server);
        expect(
          find.text(
            "Gray's account: Email (dee@) not working",
            findRichText: true,
          ),
          findsOneWidget,
        );
        expect(
          find.byKey(const ValueKey('super-machine-access-pro')),
          findsNothing,
        );
        await _doneRows(tester, c);
      },
    );
  });

  group("the owner's Configure", () {
    testWidgets(
      'lists what it can reach by account, a note under its entry, and who said one not yet confirmed',
      (tester) async {
        final f = _fixture([_mac('m', access: _ownerList), _team('m')]);
        final c = await _openConfigure(tester, f);
        final section = find.byKey(const ValueKey('machine-access-section'));
        expect(section, findsOneWidget);
        expect(_inConfigure(find.text('Access')), findsOneWidget);
        double top(String text) =>
            tester.getTopLeft(_inConfigure(find.text(text)).first).dy;
        expect(top('Your account'), lessThan(top('Fusion 360')));
        expect(top('Fusion 360'), lessThan(top('ArgoCD')));
        expect(
          top('ArgoCD'),
          lessThan(top('Note: connection info in ~/.argocd/config')),
        );
        expect(
          top('Note: connection info in ~/.argocd/config'),
          lessThan(top('Slack (dee@)')),
        );
        expect(top('Slack (dee@)'), lessThan(top('Team account')));
        expect(top('Team account'), lessThan(top('Lamp')));
        expect(top('Lamp'), lessThan(top("Tony's iPhone")));
        expect(top("Tony's iPhone"), lessThan(top('Add access…')));
        expect(
          _inConfigure(find.text('waiting for you: Dee said it')),
          findsOneWidget,
        );
        // Each own-account entry it confirmed can be shared; a Team-account entry runs teammates' work anyway.
        for (final id in ['a1', 'a2']) {
          expect(
            find.byKey(ValueKey('machine-access-teammates-$id')),
            findsOneWidget,
            reason: id,
          );
        }
        for (final id in ['a3', 'a4', 'a5']) {
          expect(
            find.byKey(ValueKey('machine-access-teammates-$id')),
            findsNothing,
            reason: id,
          );
        }
        expect(_inConfigure(find.text('Teammates may use')), findsNWidgets(2));
        expect(tester.takeException(), isNull);
        await _doneConfigure(tester, f, c);
      },
    );

    testWidgets('a Mac without a Team account lists only Your account', (
      tester,
    ) async {
      final f = _fixture([
        _mac('m', access: [_entry('a1', 'Fusion 360')]),
      ]);
      final c = await _openConfigure(tester, f);
      expect(_inConfigure(find.text('Your account')), findsOneWidget);
      expect(_inConfigure(find.text('Team account')), findsNothing);
      await _doneConfigure(tester, f, c);
    });

    testWidgets(
      'Add access… sends the name, where, Production system and the note',
      (tester) async {
        final f = _fixture([_mac('m'), _team('m')]);
        final c = await _openConfigure(tester, f);
        await tester.tap(_inConfigure(find.text('Add access…')));
        await tester.pumpAndSettle();
        expect(find.text('Add access'), findsOneWidget);
        expect(
          find.text('Like: Email (dee@), Prod DB read-only'),
          findsOneWidget,
        );
        expect(find.text('Your account'), findsWidgets);
        await tester.enterText(
          find.byKey(const ValueKey('machine-access-name')),
          'Prod DB read-only',
        );
        await tester.tap(
          find.byKey(const ValueKey('machine-access-where-team')),
        );
        await tester.tap(
          find.byKey(const ValueKey('machine-access-production')),
        );
        await tester.enterText(
          find.byKey(const ValueKey('machine-access-note')),
          'profile prod-ro in ~/.pgpass',
        );
        await tester.pump();
        await tester.tap(find.byKey(const ValueKey('machine-access-add')));
        await tester.pumpAndSettle();
        expect(_accessCommands(f.connection.server), [
          {
            'type': 'machine.access',
            'machineId': 'm',
            'action': 'add',
            'name': 'Prod DB read-only',
            'account': 'team',
            'production': true,
            'note': 'profile prod-ro in ~/.pgpass',
          },
        ]);
        // Added: the Add dialog closes, Configure stays.
        expect(find.text('Add access'), findsNothing);
        expect(_configure, findsOneWidget);
        await _doneConfigure(tester, f, c);
      },
    );

    testWidgets(
      'on a Mac without a Team account, Add offers only Your account and sends no empty fields',
      (tester) async {
        final f = _fixture([_mac('m')]);
        final c = await _openConfigure(tester, f);
        await tester.tap(_inConfigure(find.text('Add access…')));
        await tester.pumpAndSettle();
        expect(
          find.byKey(const ValueKey('machine-access-where-team')),
          findsNothing,
        );
        // Nothing to add until it has a name.
        final add = find.byKey(const ValueKey('machine-access-add'));
        expect(tester.widget<FilledButton>(add).onPressed, isNull);
        await tester.enterText(
          find.byKey(const ValueKey('machine-access-name')),
          '  Fusion 360 ',
        );
        await tester.pump();
        await tester.tap(add);
        await tester.pumpAndSettle();
        expect(_accessCommands(f.connection.server), [
          {
            'type': 'machine.access',
            'machineId': 'm',
            'action': 'add',
            'name': 'Fusion 360',
            'account': 'own',
          },
        ]);
        await _doneConfigure(tester, f, c);
      },
    );

    testWidgets("a refused add says the server's reason and stays open", (
      tester,
    ) async {
      final f = _fixture([_mac('m')]);
      f.connection.server
        ..refuse = {
          'code': 'ACCESS_SECRET',
          'message': 'That looks like a password or key. Write where it lives instead, such as a file or profile name.',
        }
        ..refuseStatus = 400;
      final c = await _openConfigure(tester, f);
      await tester.tap(_inConfigure(find.text('Add access…')));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const ValueKey('machine-access-name')),
        'ghp_abc123',
      );
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('machine-access-add')));
      await tester.pumpAndSettle();
      expect(find.text('Add access'), findsOneWidget);
      expect(
        find.text(
          'That looks like a password or key. Write where it lives instead, such as a file or profile name.',
        ),
        findsOneWidget,
      );
      await tester.tap(find.widgetWithText(TextButton, 'Cancel'));
      await tester.pumpAndSettle();
      await _doneConfigure(tester, f, c);
    });

    testWidgets(
      'Teammates may use asks first, naming the entry; Cancel sends nothing, Let them use it sends teammates',
      (tester) async {
        final f = _fixture([_mac('m', access: _ownerList), _team('m')]);
        final c = await _openConfigure(tester, f);
        final box = find.byKey(const ValueKey('machine-access-teammates-a1'));
        await tester.tap(box);
        await tester.pumpAndSettle();
        expect(
          find.text("Let teammates' work run in your account?"),
          findsOneWidget,
        );
        expect(
          find.textContaining(
            "Teammates' tasks in this Swarm that need Fusion 360",
          ),
          findsOneWidget,
        );
        final cancel = find.widgetWithText(TextButton, 'Cancel').last;
        expect(tester.widget<TextButton>(cancel).autofocus, isTrue);
        await tester.tap(cancel);
        await tester.pumpAndSettle();
        expect(_accessCommands(f.connection.server), isEmpty);
        expect(tester.widget<Checkbox>(box).value, isFalse);

        await tester.tap(box);
        await tester.pumpAndSettle();
        await tester.tap(
          find.byKey(const ValueKey('machine-access-teammates-allow')),
        );
        await tester.pumpAndSettle();
        expect(_accessCommands(f.connection.server), [
          {
            'type': 'machine.access',
            'machineId': 'm',
            'action': 'change',
            'entryId': 'a1',
            'teammates': true,
          },
        ]);
        expect(
          find.text("Let teammates' work run in your account?"),
          findsNothing,
        );
        await _doneConfigure(tester, f, c);
      },
    );

    testWidgets('turning Teammates may use off sends at once', (tester) async {
      final f = _fixture([
        _mac('m', access: [_entry('a1', 'Fusion 360', teammates: true)]),
      ]);
      final c = await _openConfigure(tester, f);
      final box = find.byKey(const ValueKey('machine-access-teammates-a1'));
      expect(tester.widget<Checkbox>(box).value, isTrue);
      await tester.tap(box);
      await tester.pumpAndSettle();
      expect(
        find.text("Let teammates' work run in your account?"),
        findsNothing,
      );
      expect(_accessCommands(f.connection.server), [
        {
          'type': 'machine.access',
          'machineId': 'm',
          'action': 'change',
          'entryId': 'a1',
          'teammates': false,
        },
      ]);
      await _doneConfigure(tester, f, c);
    });

    testWidgets('Confirm and Not right answer an entry someone else said', (
      tester,
    ) async {
      final f = _fixture([_mac('m', access: _ownerList), _team('m')]);
      final c = await _openConfigure(tester, f);
      await tester.tap(find.byKey(const ValueKey('machine-access-confirm-a3')));
      await tester.pumpAndSettle();
      await tester.tap(
        find.byKey(const ValueKey('machine-access-not-right-a3')),
      );
      await tester.pumpAndSettle();
      expect(_accessCommands(f.connection.server), [
        {
          'type': 'machine.access',
          'machineId': 'm',
          'action': 'confirm',
          'entryId': 'a3',
        },
        {
          'type': 'machine.access',
          'machineId': 'm',
          'action': 'remove',
          'entryId': 'a3',
        },
      ]);
      await _doneConfigure(tester, f, c);
    });

    testWidgets("Remove sends remove, and a refusal says the server's reason", (
      tester,
    ) async {
      final f = _fixture([_mac('m', access: _ownerList), _team('m')]);
      final c = await _openConfigure(tester, f);
      await tester.tap(find.byKey(const ValueKey('machine-access-remove-a4')));
      await tester.pumpAndSettle();
      expect(_accessCommands(f.connection.server), [
        {
          'type': 'machine.access',
          'machineId': 'm',
          'action': 'remove',
          'entryId': 'a4',
        },
      ]);
      f.connection.server
        ..refuse = {
          'code': 'MACHINE_REMOVED',
          'message': 'This machine is being removed from the Swarm.',
        }
        ..refuseStatus = 400;
      await tester.tap(find.byKey(const ValueKey('machine-access-remove-a1')));
      await tester.pumpAndSettle();
      expect(
        find.descendant(
          of: find.byKey(const ValueKey('machine-access-error')),
          matching: find.text('This machine is being removed from the Swarm.'),
        ),
        findsOneWidget,
      );
      await _doneConfigure(tester, f, c);
    });
  });

  group('anyone else', () {
    testWidgets(
      "a teammate's machine has no Configure, and its details no Access to change",
      (tester) async {
        final f = _fixture([_mac('m', contributor: 'dee', access: _ownerList)]);
        final c = await f.app.superTabs.open(tabId);
        await c.refresh();
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: SuperTabMachines(
                controller: c,
                app: f.app,
                onAddAgent: (_) {},
                readLocal: (_) async => null,
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        await openMachineDetails(
          tester,
          find.byKey(const ValueKey('super-machine-m')),
        );
        expect(find.widgetWithText(TextButton, 'Configure'), findsNothing);
        expect(
          find.byKey(const ValueKey('machine-access-section')),
          findsNothing,
        );
        expect(find.text('Add access…'), findsNothing);
        expect(find.byType(Checkbox), findsNothing);
        await _doneConfigure(tester, f, c);
      },
    );

    testWidgets(
      "a Harness Team account's own row has no Access in its Configure: its list is on its Mac",
      (tester) async {
        // Its Mac is not in this Swarm, so the Team account shows on its own row.
        final f = _fixture([
          {..._team('elsewhere'), 'machineId': 'm'},
        ]);
        final c = await _openConfigure(tester, f);
        expect(_configure, findsOneWidget);
        expect(
          find.byKey(const ValueKey('machine-access-section')),
          findsNothing,
        );
        await _doneConfigure(tester, f, c);
      },
    );
  });

  testWidgets('screenshots', (tester) async {
    for (final (brightness, name) in [
      (Brightness.light, 'light'),
      (Brightness.dark, 'dark'),
    ]) {
      final server = ConversationServer();
      server.state['people'] = [
        {'id': 'owner', 'email': 'owner@example.com', 'role': 'owner'},
        _gray,
        _dee,
      ];
      server.state['machines'] = [
        _mac(
          'studio',
          contributor: 'gray',
          name: "Gray's Mac",
          access: [
            _entry('a1', 'Fusion 360'),
            _entry('a2', 'Email (dee@)', state: 'unconfirmed', saidBy: 'dee'),
            _entry('a3', 'Lamp', account: 'team'),
            _entry('a4', 'Flutter', account: 'team'),
            _entry('a5', "Tony's iPhone", account: 'team'),
          ],
        ),
        _team('studio', contributor: 'gray'),
        _mac(
          'kiln',
          contributor: 'gray',
          name: 'Mac Studio',
          access: [_entry('b1', 'Prod DB read-only', production: true)],
        ),
      ];
      final c = await _mountRows(tester, server, brightness: brightness);
      await captureWindow(tester, shots, 'machine-access-row-$name');
      await _doneRows(tester, c);

      final f = _fixture([
        _mac(
          'm',
          access: [
            ..._ownerList.take(3),
            _entry('a6', 'Prod DB read-only', production: true),
            ..._ownerList.skip(3),
          ],
        ),
        _team('m'),
      ]);
      final d = await _openConfigure(tester, f, brightness: brightness);
      await captureWindow(tester, shots, 'machine-access-configure-$name');
      await tester.tap(_inConfigure(find.text('Add access…')));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const ValueKey('machine-access-name')),
        'Fusion 360',
      );
      await tester.pump();
      await captureWindow(tester, shots, 'machine-access-add-$name');
      await tester.tap(find.widgetWithText(TextButton, 'Cancel').last);
      await tester.pumpAndSettle();
      await tester.tap(
        find.byKey(const ValueKey('machine-access-teammates-a1')),
      );
      await tester.pumpAndSettle();
      await captureWindow(tester, shots, 'machine-access-share-$name');
      await tester.tap(find.widgetWithText(TextButton, 'Cancel').last);
      await tester.pumpAndSettle();
      await _doneConfigure(tester, f, d);
    }
  }, skip: shots == null);
}
