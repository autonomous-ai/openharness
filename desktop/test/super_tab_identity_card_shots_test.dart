import 'dart:io';
import 'dart:ui' as ui;

import 'package:clock/clock.dart';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/identity_card.dart';
import 'package:harness/super_tabs/message_row.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/zone_time.dart';

import 'box_render_preview_test.dart' show loadPreviewFonts;

/// Set to a folder to write the PR's screenshots there.
final shots = Platform.environment['SUPER_TAB_CARD_SHOTS'];

SuperTabMessage _message(String id, Map<String, Object> author, String text) =>
    SuperTabMessage.fromJson({
      'id': id,
      'conversationId': 'lead',
      'text': text,
      'sequence': 1,
      'createdAt': '2026-11-04T08:42:00.000Z',
      'author': author,
    });

final _huy = SuperTabPerson.fromJson({
  'id': 'huy',
  'email': 'phamngochuy.1989@gmail.com',
  'role': 'collaborator',
  'name': 'Huy Pham',
  'status': {'text': 'Out of office', 'emoji': '🌴'},
});

final _shrike = SuperTabAgent.fromJson({
  'id': 'shrike2',
  'name': 'Shrike2',
  'machineId': 'm',
  'harnessId': 'h',
  'contributorId': 'ken',
  'configuration': {'engine': 'claude', 'model': 'opus'},
});

/// A chat row with its card open below the name, as hovering shows it
/// (Huy, 11-04).
Widget _scene(Widget row, SuperTabIdentityFacts facts) => Stack(
  children: [
    Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [const SizedBox(height: 8), row],
    ),
    Positioned(
      left: SuperTabMessageRow.bodyInset,
      top: 8 + 16 + 8 + 22 + 6,
      child: SuperTabIdentityCard(facts: facts),
    ),
  ],
);

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
      final picture = GlobalKey();
      grid.AppTheme.brightness.value = brightness;
      addTearDown(() => grid.AppTheme.brightness.value = Brightness.light);
      await tester.binding.setSurfaceSize(const Size(720, 460));
      addTearDown(() => tester.binding.setSurfaceSize(null));

      Future<void> show(Widget scene) async {
        await tester.pumpWidget(
          MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: grid.buildAppTheme(brightness: brightness),
            home: RepaintBoundary(
              key: picture,
              child: Scaffold(body: scene),
            ),
          ),
        );
        await tester.pumpAndSettle();
      }

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

      await withClock(
        Clock.fixed(DateTime.utc(2026, 11, 4, 8, 42)),
        () => show(
          _scene(
            SuperTabMessageRow(
              message: _message('m1', {
                'kind': 'person',
                'id': 'huy',
                'name': 'phamngochuy.1989@gmail.com',
              }, 'Can the card show where the agent runs?'),
              author: 'Huy Pham',
              person: _huy,
              receipts: const [],
              onReturnToComposer: () {},
            ),
            SuperTabPersonFacts(
              'Huy Pham',
              status: _huy.status,
              timeZone: 'Asia/Ho_Chi_Minh',
            ),
          ),
        ),
      );
      await shot('person');

      await show(
        _scene(
          SuperTabMessageRow(
            message: _message('m2', {
              'kind': 'agent',
              'id': 'shrike2',
              'name': 'Shrike2',
            }, 'Yes: its machine, engine and model, and its task.'),
            author: 'Shrike2',
            agent: _shrike,
            machineName: 'MacbookPro.local',
            receipts: const [],
            onReturnToComposer: () {},
          ),
          const SuperTabAgentFacts(
            'Shrike2',
            engine: 'claude',
            model: 'Opus 5.5',
            machine: 'MacbookPro.local',
            deviceType: 'MacBook Pro',
            task:
                'Working on #2605 Chat: a card on hover over a name or avatar',
          ),
        ),
      );
      await shot('agent');
    }, skip: shots == null);
  }
}
