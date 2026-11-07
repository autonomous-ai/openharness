import 'dart:io';

import 'package:flutter/gestures.dart' show kSecondaryMouseButton;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/machines.dart';

import 'support/capture.dart';
import 'support/super_tab_fixture.dart';

// Task #4289: Swarm v3 has no Team accounts (#4120). Every agent runs on its own person's computer, as them, so a
// machine's menu offers no choice of where teammates' work runs, and its row says nothing of it.
final shots = Platform.environment['HARNESS_SUPER_TAB_CAPTURE'];

Map<String, dynamic> _machine(
  String id, {
  bool? ownAccountChoice,
  Map<String, dynamic>? teamWork,
}) => {
  'machineId': id,
  'name': "Gray's Mac",
  'contributorId': 'owner',
  'observation': {'receivedAt': DateTime.now().millisecondsSinceEpoch},
  if (ownAccountChoice != null)
    'ownAccountChoice': {
      'allowed': ownAccountChoice,
      'by': 'owner',
      'at': '2026-11-04T09:00:00Z',
    },
  'teamWork': ?teamWork,
};

const _people = [
  {'id': 'owner', 'email': 'gray@example.com', 'role': 'owner', 'name': 'Gray'},
  {
    'id': 'scholes',
    'email': 'scholes@example.com',
    'role': 'member',
    'name': 'Scholes',
  },
];

Future<dynamic> _mount(
  WidgetTester tester,
  ConversationServer server, {
  Brightness brightness = Brightness.light,
}) async {
  // The design tokens follow the app's brightness, which main.dart sets from the theme.
  final previous = grid.AppTheme.brightness.value;
  grid.AppTheme.brightness.value = brightness;
  addTearDown(() => grid.AppTheme.brightness.value = previous);
  server.state['people'] = _people;
  final c = server.controller();
  await c.refresh();
  await tester.pumpWidget(
    MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: grid.buildAppTheme(brightness: brightness),
      home: Scaffold(
        body: SuperTabMachines(controller: c, onAddAgent: (_) {}),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return c;
}

Future<void> _rightClick(WidgetTester tester, String id) async {
  await tester.tap(
    find.byKey(ValueKey('super-machine-$id')),
    buttons: kSecondaryMouseButton,
  );
  await tester.pumpAndSettle();
}

Future<void> _done(WidgetTester tester, dynamic c) async {
  await tester.pumpWidget(const SizedBox());
  await c.flush();
  c.dispose();
}

void main() {
  setUpAll(() => loadCaptureFonts(shots));

  testWidgets(
    "the owner's menu on their Mac is Details and Remove from Swarm, whatever it chose before",
    (tester) async {
      for (final choice in [null, false, true]) {
        final server = ConversationServer();
        server.state['machines'] = [
          _machine('studio', ownAccountChoice: choice),
        ];
        final c = await _mount(tester, server);
        await _rightClick(tester, 'studio');
        expect(find.text('Details'), findsOneWidget, reason: '$choice');
        expect(find.text('Remove from Swarm'), findsOneWidget);
        expect(
          find.byKey(const ValueKey('super-machine-menu-own-account')),
          findsNothing,
          reason: '$choice',
        );
        expect(find.textContaining("teammates' work"), findsNothing);
        expect(find.textContaining('Team account'), findsNothing);
        await tester.sendKeyEvent(LogicalKeyboardKey.escape);
        await tester.pumpAndSettle();
        await _done(tester, c);
      }
    },
  );

  testWidgets("a row says nothing of where teammates' work runs", (
    tester,
  ) async {
    final server = ConversationServer();
    server.state['machines'] = [
      // An older Swarm's note that its owner let teammates' work run in their own account.
      _machine(
        'studio',
        ownAccountChoice: true,
        teamWork: {
          'allowed': true,
          'ownAccount':
              "Gray's Mac runs teammates' work in Gray's own account.",
        },
      ),
    ];
    final c = await _mount(tester, server);
    expect(find.byKey(const ValueKey('super-machine-studio')), findsOneWidget);
    expect(find.textContaining("teammates' work"), findsNothing);
    expect(find.textContaining('own account'), findsNothing);
    await _done(tester, c);
  });

  testWidgets('screenshots of the menu, light and dark', (tester) async {
    await tester.binding.setSurfaceSize(const Size(900, 560));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    for (final (brightness, name) in [
      (Brightness.light, 'light'),
      (Brightness.dark, 'dark'),
    ]) {
      final server = ConversationServer();
      server.state['machines'] = [_machine('studio', ownAccountChoice: true)];
      final c = await _mount(tester, server, brightness: brightness);
      await _rightClick(tester, 'studio');
      await captureWindow(tester, shots, 'machine-menu-$name');
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      await _done(tester, c);
    }
  }, skip: shots == null);
}
