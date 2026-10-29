import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/view.dart';

import 'box_render_preview_test.dart' show loadPreviewFonts;
import 'support/super_tab_fixture.dart';

/// Set to a folder to write the PR's screenshots there.
final shots = Platform.environment['SUPER_TAB_PERSON_MENTION_SHOTS'];
final _picture = GlobalKey();

Future<void> shot(WidgetTester tester, String name) async {
  await tester.runAsync(() async {
    final boundary =
        _picture.currentContext!.findRenderObject()! as RenderRepaintBoundary;
    final image = await boundary.toImage();
    final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
    await Directory(shots!).create(recursive: true);
    await File('$shots/$name.png').writeAsBytes(bytes!.buffer.asUint8List());
    image.dispose();
  });
}

void main() {
  setUpAll(() async {
    if (shots != null) await loadPreviewFonts();
  });
  final composer = find.byKey(const ValueKey('super-message-composer'));
  final picker = find.byKey(const ValueKey('super-composer-completions'));

  ConversationServer swarm() {
    final server = ConversationServer();
    server.state['people'] = [
      {'id': 'owner', 'email': 'river@autonomous.ai', 'role': 'owner'},
      {'id': 'ken', 'email': 'ken15@autonomous.ai', 'role': 'collaborator'},
      {'id': 'dee', 'email': 'dee@autonomous.ai', 'role': 'collaborator'},
    ];
    server.state['agents'] = [
      {
        'id': 'kestrel',
        'name': 'Builder',
        'displayName': 'Kestrel',
        'machineId': 'host',
        'harnessId': 'session',
        'contributorId': 'owner',
        'configuration': {'engine': 'codex'},
      },
    ];
    for (final group in server.state['conversations'] as List) {
      (group as Map)['agentIds'] = ['kestrel'];
    }
    return server;
  }

  Future<SuperTabController> show(
    WidgetTester tester,
    ConversationServer server, {
    Brightness brightness = Brightness.dark,
  }) async {
    final c = server.controller();
    await c.refresh();
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: brightness),
        builder: (context, child) =>
            RepaintBoundary(key: _picture, child: child),
        home: Scaffold(
          body: SuperTabView(
            controller: c,
            onInvite: () {},
            onAddAgent: (_) {},
            onOpenTerminal: (_) {},
            machineName: (_) => 'Team Mac',
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    addTearDown(c.dispose);
    return c;
  }

  List<String> choices(WidgetTester tester) => [
    for (final tile in tester.widgetList<ListTile>(
      find.descendant(of: picker, matching: find.byType(ListTile)),
    ))
      (tile.title as Text).data!,
  ];

  testWidgets('@ offers people first, then agents, filtered as typed', (
    tester,
  ) async {
    await show(tester, swarm());
    await tester.tap(composer);
    await tester.enterText(composer, 'Please check @ke');
    await tester.pumpAndSettle();
    expect(choices(tester), ['ken15', 'Kestrel']);
    expect(
      find.descendant(of: picker, matching: find.text('person')),
      findsOneWidget,
    );
    expect(
      find.descendant(of: picker, matching: find.text('agent')),
      findsOneWidget,
    );
    // Never the reader, never by address.
    await tester.enterText(composer, 'Please check @');
    await tester.pumpAndSettle();
    expect(choices(tester), ['ken15', 'dee', 'Kestrel']);
    expect(
      find.descendant(of: picker, matching: find.textContaining('@')),
      findsNothing,
    );
  });

  testWidgets('a chosen person is sent as a tag, not as a recipient', (
    tester,
  ) async {
    final server = swarm();
    final c = await show(tester, server);
    await tester.tap(composer);
    await tester.enterText(composer, 'Please check @ke');
    await tester.pumpAndSettle();
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    expect(
      tester.widget<TextField>(composer).controller!.text,
      'Please check @ken15 ',
    );
    expect(c.mentions(c.selectedId), {'ken': '@ken15'});
    await tester.enterText(composer, 'Please check @ken15 and @Kes');
    await tester.pumpAndSettle();
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    final command = server.posts.last['command'] as Map;
    expect(command['type'], 'message.send');
    expect(command['mentions'], ['ken']);
    expect(command['recipientIds'], ['kestrel']);
    // The read marker's save settles.
    await tester.pump(const Duration(seconds: 1));
  });

  testWidgets('a private chat offers only the people who read it', (
    tester,
  ) async {
    final server = swarm();
    ((server.state['conversations'] as List)[0] as Map)['audience'] = {
      'people': [
        {'id': 'owner', 'generation': 'fixture'},
        {'id': 'dee', 'generation': 'fixture'},
      ],
    };
    await show(tester, server);
    await tester.tap(composer);
    await tester.enterText(composer, '@');
    await tester.pumpAndSettle();
    expect(choices(tester), ['dee', 'Kestrel']);
  });

  for (final brightness in Brightness.values) {
    testWidgets('screenshots for review, ${brightness.name}', (tester) async {
      await tester.binding.setSurfaceSize(const Size(900, 640));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      grid.AppTheme.brightness.value = brightness;
      addTearDown(() => grid.AppTheme.brightness.value = Brightness.light);
      final server = swarm()
        ..tag('message-1', text: '@river can you try it?', leadId: 'dee');
      server.mentions.last['leadName'] = 'dee';
      await show(tester, server, brightness: brightness);
      await tester.tap(composer);
      await tester.enterText(composer, 'Please check @');
      await tester.pumpAndSettle();
      await shot(tester, 'picker-all-${brightness.name}');
      await tester.enterText(composer, 'Please check @ke');
      await tester.pumpAndSettle();
      await shot(tester, 'picker-ke-${brightness.name}');
      await tester.enterText(composer, '');
      await tester.tap(find.byKey(const ValueKey('super-notifications')));
      await tester.pumpAndSettle();
      await shot(tester, 'notification-${brightness.name}');
    }, skip: shots == null);
  }
}
