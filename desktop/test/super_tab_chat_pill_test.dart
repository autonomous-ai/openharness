import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/view.dart';

import 'support/fake_voice_recorder.dart';
import 'support/super_tab_fixture.dart';

/// Task #4529 (anh Dee's mockup, 11-07): the composer is one rounded pill:
/// the paperclip, the text, and the mic while there is nothing to send; send
/// takes the mic's place once there is.
void main() {
  Finder key(String value) => find.byKey(ValueKey(value));

  Future<void> show(WidgetTester tester, Brightness brightness) async {
    final c = ConversationServer().controller();
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
            onInvite: () {},
            onAddAgent: (_) {},
            onOpenTerminal: (_) {},
            machineName: (_) => 'Mac Studio',
            voiceRecorder: FakeVoiceRecorder.new,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    addTearDown(() async {
      await tester.pumpWidget(const SizedBox());
      await c.flush();
    });
  }

  for (final brightness in Brightness.values) {
    testWidgets('one pill row: paperclip, text, then the mic or send '
        '(${brightness.name})', (tester) async {
      await show(tester, brightness);
      const surface = 'super-message-composer-surface';
      final box = tester.widget<DecoratedBox>(key(surface)).decoration;
      expect(
        (box as BoxDecoration).borderRadius,
        BorderRadius.circular(grid.AppDesktop.composerRadius),
      );
      expect(grid.AppDesktop.composerRadius, 20);
      final field = tester.getRect(key('super-message-composer'));
      final attach = tester.getRect(
        find.descendant(of: key(surface), matching: key('new-harness-attach')),
      );
      final mic = tester.getRect(key('super-composer-mic'));
      // One row: the paperclip and the mic beside the text, not under it.
      expect(attach.right, lessThanOrEqualTo(field.left));
      expect(mic.left, greaterThanOrEqualTo(field.right));
      expect(attach.center.dy, closeTo(field.center.dy, 2));
      expect(mic.center.dy, closeTo(field.center.dy, 2));
      expect(find.byTooltip('Send message'), findsNothing);

      await tester.enterText(key('super-message-composer'), 'Ship it');
      await tester.pump();
      expect(find.byTooltip('Send message'), findsOneWidget);
      expect(key('super-composer-mic'), findsNothing);

      await tester.enterText(key('super-message-composer'), '');
      await tester.pump();
      expect(key('super-composer-mic'), findsOneWidget);
      expect(find.byTooltip('Send message'), findsNothing);
    });
  }
}
