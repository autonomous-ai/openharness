import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/view.dart';

import 'box_render_preview_test.dart' show loadPreviewFonts;
import 'support/super_tab_fixture.dart';

/// Set to a folder to write the PR's screenshots there.
final shots = Platform.environment['SUPER_TAB_MESSAGE_EDIT_SHOTS'];

/// Edit and delete your own message (task #2746): the More menu with Edit
/// message and Delete message, the in-place editor, an edited message and a
/// deleted one that keeps its thread, in both appearances.
void main() {
  setUpAll(() async {
    if (shots != null) await loadPreviewFonts();
  });

  for (final brightness in Brightness.values) {
    testWidgets('screenshots for review (${brightness.name})', (tester) async {
      final picture = GlobalKey();
      final server = ConversationServer()..threads = true;
      server
        ..append('Kicking off the release notes for 1.4.')
        ..append('Draft is in the doc, please have a look.')
        ..append('Looks good to me.')
        ..append('Shipping the notes at 15:00.');
      server.messages[2]
        ..['thread'] = 'message-1'
        ..['author'] = {'kind': 'person', 'id': 'huy', 'name': 'Huy'};
      server.messages[3]['author'] = {
        'kind': 'agent',
        'id': 'lead-agent',
        'name': 'Avocet',
      };
      server.editMessage('message-2', 'Draft is in the doc, have a look.');
      server.deleteMessage('message-1');
      final c = server.controller();
      addTearDown(c.dispose);
      await c.refresh();
      grid.AppTheme.brightness.value = brightness;
      addTearDown(() => grid.AppTheme.brightness.value = Brightness.light);
      await tester.binding.setSurfaceSize(const Size(900, 560));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: brightness),
          builder: (context, child) =>
              RepaintBoundary(key: picture, child: child),
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
      expect(find.text('This message was deleted.'), findsOneWidget);
      expect(find.text('(edited)'), findsOneWidget);

      Future<void> shot(String name) async {
        if (shots == null) return;
        await tester.runAsync(() async {
          final boundary =
              picture.currentContext!.findRenderObject()!
                  as RenderRepaintBoundary;
          final image = await boundary.toImage(pixelRatio: 1.5);
          final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
          await Directory(shots!).create(recursive: true);
          await File('$shots/message-edit-$name-${brightness.name}.png')
              .writeAsBytes(bytes!.buffer.asUint8List());
          image.dispose();
        });
      }

      await shot('rows');

      final row = find.byKey(const ValueKey('super-message-message-2'));
      final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
      await mouse.addPointer(location: Offset.zero);
      await mouse.moveTo(tester.getCenter(row));
      await tester.pumpAndSettle();
      await tester.tap(
        find.descendant(
          of: row,
          matching: find.byKey(const ValueKey('super-message-more-message-2')),
        ),
      );
      await tester.pumpAndSettle();
      await mouse.moveTo(tester.getCenter(find.text('Edit message')));
      await tester.pumpAndSettle();
      await shot('menu');

      await tester.tap(find.text('Edit message'));
      await tester.pumpAndSettle();
      await mouse.removePointer();
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('super-message-edit-message-2')),
        findsOneWidget,
      );
      await shot('editor');

      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      final mouse2 = await tester.createGesture(kind: PointerDeviceKind.mouse);
      await mouse2.addPointer(location: Offset.zero);
      await mouse2.moveTo(tester.getCenter(row));
      await tester.pumpAndSettle();
      await tester.tap(
        find.descendant(
          of: row,
          matching: find.byKey(const ValueKey('super-message-more-message-2')),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Delete message'));
      await tester.pumpAndSettle();
      await mouse2.removePointer();
      await tester.pumpAndSettle();
      expect(find.text('Delete message?'), findsOneWidget);
      await shot('confirm');
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
    });
  }
}
