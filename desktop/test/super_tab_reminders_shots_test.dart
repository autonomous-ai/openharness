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
final shots = Platform.environment['SUPER_TAB_REMIND_SHOTS'];

/// The More menu with Mark unread and Remind me, a chat marked unread, and
/// a due reminder in Activity's Needs you, as the PR shows them, in both appearances.
void main() {
  setUpAll(() async {
    if (shots != null) await loadPreviewFonts();
  });

  for (final brightness in Brightness.values) {
    testWidgets('screenshots for review (${brightness.name})', (tester) async {
      final picture = GlobalKey();
      final server = ConversationServer()
        ..append('Planning the reminders for Huy.')
        ..append('Draft PR is up with the plan.')
        ..append('Should a reminder clear when it is opened?')
        ..append('Yes: opening it is the answer.');
      server.messages[2]['author'] = {
        'kind': 'agent',
        'id': 'lead-agent',
        'name': 'Avocet',
      };
      server.messages[3]['author'] = {
        'kind': 'person',
        'id': 'huy',
        'name': 'Huy',
      };
      server.followedThreads = {'unread': [], 'read': [], 'more': false};
      server.markReadElsewhere('lead', 4);
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

      Future<void> shot(String name) async {
        if (shots == null) return;
        await tester.runAsync(() async {
          final boundary =
              picture.currentContext!.findRenderObject()!
                  as RenderRepaintBoundary;
          final image = await boundary.toImage(pixelRatio: 1.5);
          final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
          await Directory(shots!).create(recursive: true);
          await File('$shots/remind-$name-${brightness.name}.png')
              .writeAsBytes(bytes!.buffer.asUint8List());
          image.dispose();
        });
      }

      final row = find.byKey(const ValueKey('super-message-message-3'));
      final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
      await mouse.addPointer(location: Offset.zero);
      await mouse.moveTo(tester.getCenter(row));
      await tester.pumpAndSettle();
      await tester.tap(
        find.descendant(
          of: row,
          matching: find.byKey(const ValueKey('super-message-more-message-3')),
        ),
      );
      await tester.pumpAndSettle();
      // Pointed at, as a person opens it.
      await mouse.moveTo(tester.getCenter(find.text('Remind me')));
      await tester.pumpAndSettle();
      expect(find.text('Tomorrow at 09:00'), findsOneWidget);
      await shot('menu');

      await tester.tap(find.text('In 20 minutes'));
      await tester.pumpAndSettle();
      await tester.pump(const Duration(seconds: 3));
      await mouse.moveTo(tester.getCenter(row));
      await tester.pumpAndSettle();
      await tester.tap(
        find.descendant(
          of: row,
          matching: find.byKey(const ValueKey('super-message-more-message-3')),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Mark unread'));
      await tester.pumpAndSettle();
      await mouse.removePointer();
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('super-new-messages-line')),
        findsOneWidget,
      );
      await shot('unread');

      await tester.pump(const Duration(minutes: 21));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Activity').first);
      await tester.pumpAndSettle();
      expect(
        find.byKey(
          const ValueKey('super-activity-row-reminder:reminder-message-3'),
        ),
        findsOneWidget,
      );
      await shot('activity');
    });
  }
}
