import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/widgets/app_menu.dart';
import 'package:harness/super_tabs/message_row.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/focus_in.dart';
import 'support/swarm_v4_data.dart';

/// Every menu of the v4 chat closes on Escape, however it was opened, and its control has focus again, so the
/// keyboard goes on from there (anh Dee, 2026-11-09).
void main() {
  Finder key(String k) => find.byKey(ValueKey(k));

  Future<void> show(WidgetTester tester) async {
    await tester.binding.setSurfaceSize(const Size(1440, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final c = swarmV4Server().controller(
      account: 'owner',
      initial: {'tabId': 'tab', 'accountId': 'owner', 'selectedId': 'lead'},
    );
    addTearDown(c.dispose);
    await tester.runAsync(c.refresh);
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.light),
        home: Scaffold(
          body: SuperTabView(
            controller: c,
            onInvite: () {},
            onAddAgent: (_) {},
            onOpenTerminal: (_) {},
            machineName: (_) => 'Mac Studio',
            github: swarmV4GitHub(),
            board: true,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  Future<void> escape(WidgetTester tester) async {
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
  }

  testWidgets(
    'the project menu: a click opens it, Escape closes it, and the keyboard goes on from the name',
    (tester) async {
      await show(tester);
      // Twice running, as fast as a person opens and dismisses it.
      for (var i = 0; i < 2; i++) {
        await tester.tap(key('super-project-menu'));
        await tester.pumpAndSettle();
        expect(find.text('Project settings…'), findsOneWidget, reason: '$i');
        await escape(tester);
        expect(find.text('Project settings…'), findsNothing, reason: '$i');
        expect(focusIsIn(key('super-project-menu')), isTrue, reason: '$i');
      }
      // Enter on the name opens it again.
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(find.text('Project settings…'), findsOneWidget);
      await escape(tester);
      expect(find.text('Project settings…'), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('a message\'s More menu closes on Escape', (tester) async {
    await show(tester);
    await tester.tap(key('super-agent-second'));
    await tester.pumpAndSettle();
    final more = find
        .byWidgetPredicate(
          (w) =>
              w.key is ValueKey<String> &&
              (w.key! as ValueKey<String>).value.startsWith(
                'super-message-more-message-',
              ),
        )
        .first;
    // The mouse over the message shows its actions; More is one of them.
    final row = find.ancestor(
      of: more,
      matching: find.byType(SuperTabMessageRow),
    );
    final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
    await mouse.addPointer(location: Offset.zero);
    addTearDown(mouse.removePointer);
    await mouse.moveTo(tester.getCenter(row.first));
    await tester.pumpAndSettle();
    await tester.tap(more);
    await tester.pumpAndSettle();
    expect(find.byType(AppMenuItem), findsWidgets);
    await escape(tester);
    expect(find.byType(AppMenuItem), findsNothing);
    expect(focusIsIn(more), isTrue);
    expect(tester.takeException(), isNull);
  });
}
