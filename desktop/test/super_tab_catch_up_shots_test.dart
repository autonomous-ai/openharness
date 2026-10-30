import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/view.dart';

import 'box_render_preview_test.dart' show loadPreviewFonts;
import 'support/super_tab_fixture.dart';

/// Set to a folder to write the PR's screenshots there.
final shots = Platform.environment['SUPER_TAB_CATCH_UP_SHOTS'];

const _updates = [
  'Reading the offline queue before the reconnect.',
  'The reconnect keeps every queued edit in order.',
  'Two devices editing at once settle on the newest edit.',
  'Pushed the branch; the checks are running.',
];

Map<String, dynamic> _item(int sequence, String author, String text) => {
  'messageId': 'message-$sequence',
  'sequence': sequence,
  'author': author,
  'text': text,
};

/// The chat opened after a while away: the New messages line with the
/// catch-up card under it, at normal and enlarged text.
void main() {
  setUpAll(() async {
    if (shots != null) await loadPreviewFonts();
  });

  for (final (brightness, scale) in [
    (Brightness.light, 1.0),
    (Brightness.dark, 1.0),
    (Brightness.dark, 1.8),
  ]) {
    final name = '${brightness.name}${scale > 1 ? '-large-text' : ''}';
    testWidgets('screenshots for review ($name)', (tester) async {
      final picture = GlobalKey();
      final server = ConversationServer();
      for (var i = 1; i <= 80; i++) {
        server.append('${_updates[i % _updates.length]} ($i)');
        server.messages.last['author'] = {
          'kind': 'agent',
          'id': 'lead-agent',
          'name': 'Lead',
        };
      }
      server.markReadElsewhere('lead', 30);
      server.catchUps['lead'] = {
        'after': 30,
        'through': 80,
        'unread': 50,
        'more': false,
        'decisions': 1,
        'needsYou': {
          'total': 2,
          'items': [
            _item(
              52,
              'River',
              'Dee, the reconnect can keep the newest edit or ask the person. Which one should ship first?',
            ),
            _item(61, 'River', 'Dee, can you try the phone build tonight?'),
          ],
        },
        'blocked': {
          'total': 1,
          'items': [
            _item(74, 'Iris', 'Stuck: No iPhone simulator on this Mac.'),
          ],
        },
        'landed': {
          'total': 4,
          'items': [
            _item(44, 'River', 'Offline queue keeps edits in order'),
            _item(58, 'River', 'Done: Merged #2201.'),
          ],
        },
      };
      final c = server.controller();
      addTearDown(c.dispose);
      await c.refresh();
      grid.AppTheme.brightness.value = brightness;
      addTearDown(() => grid.AppTheme.brightness.value = Brightness.light);
      tester.view.physicalSize = const Size(1200, 860);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: brightness),
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context)
                .copyWith(textScaler: TextScaler.linear(scale)),
            child: RepaintBoundary(key: picture, child: child),
          ),
          home: Scaffold(
            body: SuperTabView(
              controller: c,
              onInvite: () {},
              onAddAgent: (_) {},
              onOpenTerminal: (_) {},
              machineName: (_) => 'Mac Studio',
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('super-catch-up')), findsOne);
      expect(tester.takeException(), isNull);
      if (shots == null) return;
      await tester.runAsync(() async {
        final boundary =
            picture.currentContext!.findRenderObject()!
                as RenderRepaintBoundary;
        final image = await boundary.toImage(pixelRatio: 1.5);
        final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
        await Directory(shots!).create(recursive: true);
        await File('$shots/catch-up-$name.png')
            .writeAsBytes(bytes!.buffer.asUint8List());
        image.dispose();
      });
    });
  }
}
