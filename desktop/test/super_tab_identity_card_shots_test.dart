import 'dart:io';
import 'dart:ui' as ui;

import 'package:clock/clock.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/identity.dart';
import 'package:harness/super_tabs/identity_card.dart';
import 'package:harness/super_tabs/view.dart';
import 'package:harness/super_tabs/zone_time.dart';

import 'box_render_preview_test.dart' show loadPreviewFonts;
import 'support/super_tab_fixture.dart';

/// Set to a folder to write the PR's screenshots there.
final shots = Platform.environment['SUPER_TAB_CARD_SHOTS'];

final _now = DateTime.utc(2026, 11, 4, 8, 42);

/// The chat as Huy sees it (11-04): his message and an agent's, the agent
/// working on this task on 0xken15's MacBook Pro.
ConversationServer _server() {
  final server = ConversationServer();
  final state = server.state;
  (state['people'] as List).add({
    'id': 'huy',
    'email': 'phamngochuy.1989@gmail.com',
    'role': 'collaborator',
    'name': 'Huy Pham',
    'status': {'text': 'Out of office', 'emoji': '🌴'},
    'timeZone': 'Asia/Ho_Chi_Minh',
  });
  (state['agents'] as List).add({
    'id': 'shrike2',
    'name': 'Shrike2',
    'machineId': 'm',
    'harnessId': 'h',
    'contributorId': 'owner',
    'configuration': {'engine': 'claude', 'model': 'claude-opus-5-5'},
  });
  state['machines'] = [
    {
      'machineId': 'm',
      'name': 'MacbookPro.local',
      'observation': {
        'resources': {'deviceType': 'MacBook Pro'},
      },
    },
  ];
  ((state['conversations'] as List)[1] as Map)
    ..['title'] = 'Chat: a card on hover over a name or avatar'
    ..['number'] = 2605
    ..['agentIds'] = ['shrike2']
    ..['assignment'] = {'id': 'w1', 'agentId': 'shrike2', 'status': 'working'};
  void say(String text, Map<String, Object> author, int minutesAgo) {
    server.append(text);
    server.messages.last
      ..['author'] = author
      ..['createdAt'] = _now
          .subtract(Duration(minutes: minutesAgo))
          .toIso8601String();
  }

  say('Can the card show where the agent runs?', {
    'kind': 'person',
    'id': 'huy',
    'name': 'phamngochuy.1989@gmail.com',
  }, 9);
  say('Yes: its machine, engine and model, and its task.', {
    'kind': 'agent',
    'id': 'shrike2',
    'name': 'Shrike2',
  }, 2);
  return server;
}

void main() {
  setUpAll(() async {
    if (shots == null) return;
    await superTabLoadZones();
    await loadPreviewFonts();
    // The status emoji, drawn as a Mac draws it: the system face lacks it
    // and the theme falls back through Helvetica Neue.
    const emoji = '/System/Library/Fonts/Apple Color Emoji.ttc';
    if (File(emoji).existsSync()) {
      final bytes = File(emoji).readAsBytesSync();
      await (FontLoader(
        'Helvetica Neue',
      )..addFont(Future.value(ByteData.view(bytes.buffer)))).load();
    }
  });

  for (final brightness in Brightness.values) {
    testWidgets('identity card screenshots (${brightness.name})', (
      tester,
    ) async {
      await withClock(Clock.fixed(_now), () async {
        final picture = GlobalKey();
        grid.AppTheme.brightness.value = brightness;
        addTearDown(() => grid.AppTheme.brightness.value = Brightness.light);
        await tester.binding.setSurfaceSize(const Size(1100, 620));
        addTearDown(() => tester.binding.setSurfaceSize(null));
        final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
        await mouse.addPointer(location: Offset.zero);
        addTearDown(mouse.removePointer);

        Future<void> shot(String name) => tester.runAsync(() async {
          final boundary =
              picture.currentContext!.findRenderObject()!
                  as RenderRepaintBoundary;
          final image = await boundary.toImage(pixelRatio: 2);
          final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
          await Directory(shots!).create(recursive: true);
          await File('$shots/card-$name-${brightness.name}.png')
              .writeAsBytes(bytes!.buffer.asUint8List());
          image.dispose();
        });

        final server = _server();
        final c = server.controller();
        addTearDown(c.dispose);
        await c.refresh();
        await tester.pumpWidget(
          MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: grid.buildAppTheme(brightness: brightness),
            builder: (context, child) =>
                RepaintBoundary(key: picture, child: child),
            home: Scaffold(
              body: SuperTabView(
                controller: c,
                onInvite: () {},
                onAddAgent: (_) {},
                onOpenTerminal: (_) {},
                machineName: (_) => 'MacbookPro.local',
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();

        Finder inRow(int index, Finder matching) => find.descendant(
          of: find.byKey(
            ValueKey('super-message-${server.messages[index]['id']}'),
          ),
          matching: matching,
        );

        Future<void> hover(Finder target, String name) async {
          await mouse.moveTo(tester.getCenter(target));
          await tester.pump(SuperTabHoverCard.openDelay);
          await tester.pumpAndSettle();
          await shot(name);
          await mouse.moveTo(Offset.zero);
          await tester.pump(SuperTabHoverCard.closeDelay);
          await tester.pumpAndSettle();
        }

        await hover(inRow(0, find.text('Huy Pham')), 'person');
        await hover(inRow(1, find.byType(SuperTabAvatar)), 'agent');
        await tester.pumpWidget(const SizedBox());
        await c.flush();
      });
    }, skip: shots == null);
  }
}
