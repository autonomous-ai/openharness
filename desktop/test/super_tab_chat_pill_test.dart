import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/fake_voice_recorder.dart';
import 'support/super_tab_fixture.dart';

/// Task #4529 (anh Dee's mockup, 11-07): the composer is a rounded pill
/// holding the text, and beside it the mic while there is nothing to send;
/// send takes the mic's place once there is. The paperclip stays at the
/// pill's start, so a file can still be picked.
void main() {
  Finder key(String value) => find.byKey(ValueKey(value));

  Future<SuperTabController> show(
    WidgetTester tester,
    Brightness brightness,
  ) async {
    final c = ConversationServer.chat().controller();
    addTearDown(c.dispose);
    await c.refresh();
    grid.AppTheme.brightness.value = brightness;
    addTearDown(() => grid.AppTheme.brightness.value = Brightness.light);
    await tester.binding.setSurfaceSize(const Size(1280, 720));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: brightness),
        home: Scaffold(
          body: SuperTabView(
            controller: c,
            onAddAgent: (_) {},
            onOpenTerminal: (_) {},
            machineName: (_) => 'Mac Studio',
            voiceRecorder: FakeVoiceRecorder.new,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    return c;
  }

  for (final brightness in Brightness.values) {
    testWidgets('a pill of text, the mic or send beside it '
        '(${brightness.name})', (tester) async {
      final c = await show(tester, brightness);
      const surface = 'super-message-composer-surface';
      final box = tester.widget<DecoratedBox>(key(surface)).decoration;
      expect(
        (box as BoxDecoration).borderRadius,
        BorderRadius.circular(grid.AppDesktop.composerRadius),
      );
      expect(grid.AppDesktop.composerRadius, 20);
      final pill = tester.getRect(key(surface));
      final field = tester.getRect(key('super-message-composer'));
      final mic = tester.getRect(key('super-composer-mic'));
      final attach = tester.getRect(
        find.descendant(of: key(surface), matching: key('new-harness-attach')),
      );
      expect(attach.right, lessThanOrEqualTo(field.left));
      // The text inside the pill, the mic outside it on the same line.
      expect(pill.contains(field.center), isTrue);
      expect(mic.left, greaterThanOrEqualTo(pill.right));
      expect(mic.center.dy, closeTo(pill.center.dy, 2));
      expect(find.byTooltip('Send message'), findsNothing);

      await tester.enterText(key('super-message-composer'), 'Ship it');
      await tester.pump();
      expect(find.byTooltip('Send message'), findsOneWidget);
      expect(key('super-composer-mic'), findsNothing);

      await tester.enterText(key('super-message-composer'), '');
      await tester.pump();
      expect(key('super-composer-mic'), findsOneWidget);
      expect(find.byTooltip('Send message'), findsNothing);
      // The draft's save waits on a timer: let it run.
      await tester.pumpWidget(const SizedBox());
      await c.flush();
    });
  }
}
