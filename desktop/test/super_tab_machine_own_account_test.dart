import 'dart:async';
import 'dart:io';

import 'package:flutter/gestures.dart' show kSecondaryMouseButton;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/machines.dart';

import 'support/capture.dart';
import 'support/super_tab_fixture.dart';

// Task #2813 (Scholes, 11-04): the Mac's owner lets teammates' work run in their own account on it, after one warning
// (backend `machine.ownAccountWork`, #2806). Only on the Mac its owner added, never on a Harness Team account's entry.
final shots = Platform.environment['HARNESS_SUPER_TAB_CAPTURE'];

const _allow = ValueKey('super-machine-own-account-allow');
const _item = ValueKey('super-machine-menu-own-account');

Map<String, dynamic> _machine(
  String id, {
  String contributor = 'owner',
  String? host,
  bool? allowed,
  String? ownAccountLine,
}) => {
  'machineId': id,
  'name': id == 'studio' ? "Gray's Mac" : id,
  'contributorId': contributor,
  'hostMachineId': ?host,
  'observation': {'receivedAt': DateTime.now().millisecondsSinceEpoch},
  if (allowed != null)
    'ownAccountChoice': {
      'allowed': allowed,
      'by': contributor,
      'at': '2026-11-04T09:00:00Z',
    },
  if (ownAccountLine != null)
    'teamWork': {'allowed': true, 'ownAccount': ownAccountLine},
};

List<Map<String, dynamic>> _ownAccountCommands(ConversationServer server) => [
  for (final p in server.posts)
    if ((p['command'] as Map?)?['type'] == 'machine.ownAccountWork')
      Map<String, dynamic>.from(p['command'] as Map),
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

/// Whether [text]'s line is cut short where it is laid out: ellipsized, or narrower than the text needs.
bool _cut(WidgetTester tester, String text) {
  final paragraph = tester.renderObject<RenderParagraph>(find.text(text));
  final whole = TextPainter(
    text: paragraph.text,
    textDirection: TextDirection.ltr,
    textScaler: paragraph.textScaler,
  )..layout();
  return paragraph.didExceedMaxLines ||
      paragraph.size.width < whole.width - 0.5;
}

Future<void> _done(WidgetTester tester, dynamic c) async {
  await tester.pumpWidget(const SizedBox());
  await c.flush();
  c.dispose();
}

void main() {
  setUpAll(() => loadCaptureFonts(shots));

  group("teammates' work in the owner's own account", () {
    testWidgets('only the Mac its owner added offers it', (tester) async {
      final server = ConversationServer();
      server.state['machines'] = [
        _machine('studio'),
        _machine('pro', contributor: 'scholes'),
        // A Harness Team account's own entry, shown on its own row while its Mac is not in this Swarm.
        _machine('studio-team', host: 'gray-mac'),
      ];
      final c = await _mount(tester, server);
      await _rightClick(tester, 'studio');
      expect(
        find.text("Let teammates' work run in my account"),
        findsOneWidget,
      );
      expect(
        _cut(tester, "Let teammates' work run in my account"),
        isFalse,
        reason: 'the item reads whole, not cut short',
      );
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      for (final other in ['pro', 'studio-team']) {
        await _rightClick(tester, other);
        expect(find.text('Details'), findsOneWidget, reason: other);
        expect(find.byKey(_item), findsNothing, reason: other);
        await tester.sendKeyEvent(LogicalKeyboardKey.escape);
        await tester.pumpAndSettle();
      }
      await _done(tester, c);
    });

    testWidgets('it warns once, and Cancel, the default, sends nothing', (
      tester,
    ) async {
      final server = ConversationServer();
      server.state['machines'] = [_machine('studio')];
      final c = await _mount(tester, server);
      await _rightClick(tester, 'studio');
      await tester.tap(find.byKey(_item));
      await tester.pumpAndSettle();
      expect(
        find.text("Let teammates' work run in your account?"),
        findsOneWidget,
      );
      expect(
        find.text(
          "Teammates' agents in this Swarm will run as you on Gray's Mac. They can read your files, your keychain "
          'and your signed-in apps. Agents already running are not moved. Your other Swarms keep their own choice.',
        ),
        findsOneWidget,
      );
      final cancel = find.widgetWithText(TextButton, 'Cancel');
      expect(tester.widget<TextButton>(cancel).autofocus, isTrue);
      await tester.tap(cancel);
      await tester.pumpAndSettle();
      expect(find.byKey(_allow), findsNothing);
      expect(_ownAccountCommands(server), isEmpty);
      await _done(tester, c);
    });

    testWidgets('Let them run sends the choice once', (tester) async {
      final server = ConversationServer();
      server.state['machines'] = [_machine('studio')];
      final c = await _mount(tester, server);
      await _rightClick(tester, 'studio');
      await tester.tap(find.byKey(_item));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(_allow));
      await tester.pumpAndSettle();
      expect(_ownAccountCommands(server), [
        {
          'type': 'machine.ownAccountWork',
          'machineId': 'studio',
          'allowed': true,
        },
      ]);
      expect(find.byKey(_allow), findsNothing);
      await _done(tester, c);
    });

    testWidgets(
      'once on, it reads Team account only and switches back with no question',
      (tester) async {
        final server = ConversationServer();
        server.state['machines'] = [_machine('studio', allowed: true)];
        final c = await _mount(tester, server);
        await _rightClick(tester, 'studio');
        expect(
          find.text("Run teammates' work only in the Team account"),
          findsOneWidget,
        );
        expect(
          find.text("Let teammates' work run in my account"),
          findsNothing,
        );
        expect(
          _cut(tester, "Run teammates' work only in the Team account"),
          isFalse,
          reason: 'the item reads whole, not cut short',
        );
        await tester.tap(find.byKey(_item));
        await tester.pumpAndSettle();
        expect(
          find.text("Let teammates' work run in your account?"),
          findsNothing,
        );
        expect(_ownAccountCommands(server), [
          {
            'type': 'machine.ownAccountWork',
            'machineId': 'studio',
            'allowed': false,
          },
        ]);
        await _done(tester, c);
      },
    );

    testWidgets('a refusal says its reason in one line', (tester) async {
      final server = ConversationServer()
        ..refuse = {
          'code': 'OWNER_REQUIRED',
          'message':
              "Only the machine's owner can change where teammates' work runs.",
        }
        ..refuseStatus = 403;
      server.state['machines'] = [_machine('studio')];
      final c = await _mount(tester, server);
      await _rightClick(tester, 'studio');
      await tester.tap(find.byKey(_item));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(_allow));
      await tester.pumpAndSettle();
      final reason = find.byKey(
        const ValueKey('super-machine-own-account-reason'),
      );
      expect(reason, findsOneWidget);
      expect(
        tester.widget<Text>(reason).data,
        "Only the machine's owner can change where teammates' work runs.",
      );
      expect(tester.widget<Text>(reason).maxLines, 1);
      // The warning stays up with its reason; nothing changed.
      expect(find.byKey(_allow), findsOneWidget);
      await tester.tap(find.widgetWithText(TextButton, 'Cancel'));
      await tester.pumpAndSettle();
      await _done(tester, c);
    });

    testWidgets('a refused switch back says its reason in one line', (
      tester,
    ) async {
      final server = ConversationServer()
        ..refuse = {
          'code': 'MACHINE_REMOVED',
          'message': 'This machine was removed from the Swarm.',
        }
        ..refuseStatus = 404;
      server.state['machines'] = [_machine('studio', allowed: true)];
      final c = await _mount(tester, server);
      await _rightClick(tester, 'studio');
      await tester.tap(find.byKey(_item));
      await tester.pumpAndSettle();
      final bar = find.byKey(
        const ValueKey('super-machine-own-account-refused'),
      );
      expect(bar, findsOneWidget);
      expect(
        find.descendant(
          of: bar,
          matching: find.text('This machine was removed from the Swarm.'),
        ),
        findsOneWidget,
      );
      await _done(tester, c);
    });

    // Review of #2983 (Avocet4): while another action is still being sent, the controller sends nothing; switching back
    // must say so, never leave the owner thinking it is off.
    testWidgets('switching back while another action is sending says so', (
      tester,
    ) async {
      final server = ConversationServer();
      server.state['machines'] = [_machine('studio', allowed: true)];
      final c = await _mount(tester, server);
      final hold = Completer<void>();
      server.holdCommands = hold;
      final other = c.command({
        'type': 'machine.pause',
        'machineId': 'studio',
        'paused': true,
      });
      await tester.pump();
      await _rightClick(tester, 'studio');
      await tester.tap(find.byKey(_item));
      await tester.pumpAndSettle();
      expect(_ownAccountCommands(server), isEmpty);
      final bar = find.byKey(
        const ValueKey('super-machine-own-account-refused'),
      );
      expect(bar, findsOneWidget);
      expect(
        find.descendant(
          of: bar,
          matching: find.text(
            'Another action is still being sent. Try again in a moment.',
          ),
        ),
        findsOneWidget,
      );
      hold.complete();
      await other;
      await tester.pumpAndSettle();
      await _done(tester, c);
    });

    // Review of #2983 (Avocet4): a reply that never came says "Retry"; the warning offers it.
    testWidgets('a lost reply offers Retry in the warning, which confirms it', (
      tester,
    ) async {
      final server = ConversationServer()..loseReply = true;
      server.state['machines'] = [_machine('studio')];
      final c = await _mount(tester, server);
      await _rightClick(tester, 'studio');
      await tester.tap(find.byKey(_item));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(_allow));
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('super-machine-own-account-reason')),
        findsOneWidget,
      );
      final retry = find.byKey(_allow);
      expect(
        find.descendant(of: retry, matching: find.text('Retry')),
        findsOneWidget,
      );
      expect(tester.widget<FilledButton>(retry).onPressed, isNotNull);
      await tester.tap(retry);
      await tester.pumpAndSettle();
      expect(find.byKey(_allow), findsNothing);
      expect(c.hasPendingAction, isFalse);
      // The lost send and its Retry are the same command, sent again under its operation id.
      expect(_ownAccountCommands(server), isNotEmpty);
      expect(
        _ownAccountCommands(server),
        everyElement({
          'type': 'machine.ownAccountWork',
          'machineId': 'studio',
          'allowed': true,
        }),
      );
      await _done(tester, c);
    });

    testWidgets("the row says it runs in the owner's own account", (
      tester,
    ) async {
      final server = ConversationServer();
      server.state['people'] = [
        {
          'id': 'owner',
          'email': 'gray@example.com',
          'role': 'owner',
          'name': 'Gray',
        },
        {
          'id': 'scholes',
          'email': 'scholes@example.com',
          'role': 'member',
          'name': 'Scholes',
        },
      ];
      server.state['machines'] = [
        _machine(
          'studio',
          allowed: true,
          ownAccountLine:
              "Gray's Mac runs teammates' work in Gray's own account.",
        ),
      ];
      final c = await _mount(tester, server);
      expect(
        find.textContaining("runs teammates' work in Gray's own account"),
        findsOneWidget,
      );
      await _done(tester, c);
    });

    testWidgets('screenshots for Scholes', (tester) async {
      await tester.binding.setSurfaceSize(const Size(900, 560));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      for (final (brightness, name) in [
        (Brightness.light, 'light'),
        (Brightness.dark, 'dark'),
      ]) {
        final server = ConversationServer();
        server.state['machines'] = [_machine('studio')];
        final c = await _mount(tester, server, brightness: brightness);
        await _rightClick(tester, 'studio');
        await captureWindow(tester, shots, 'own-account-menu-$name');
        await tester.tap(find.byKey(_item));
        await tester.pumpAndSettle();
        await captureWindow(tester, shots, 'own-account-confirm-$name');
        await tester.tap(find.widgetWithText(TextButton, 'Cancel'));
        await tester.pumpAndSettle();
        await _done(tester, c);
        final on = ConversationServer();
        on.state['machines'] = [_machine('studio', allowed: true)];
        final d = await _mount(tester, on, brightness: brightness);
        await _rightClick(tester, 'studio');
        await captureWindow(tester, shots, 'own-account-menu-on-$name');
        await tester.sendKeyEvent(LogicalKeyboardKey.escape);
        await tester.pumpAndSettle();
        await _done(tester, d);
      }
    }, skip: shots == null);
  });
}
