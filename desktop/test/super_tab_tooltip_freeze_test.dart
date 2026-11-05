import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/view.dart';

import 'super_tab_roster_test.dart' show RosterFixture;
import 'support/humans_fixture.dart';

/// Scholes, 11-02: the mouse froze on the Swarm screen after a hovered row's
/// tooltip opened in the frame the row left the list ("Cannot hit test a render
/// box that has never been laid out"). The theme's hover wait is 500 ms, so a
/// test passes this to run the tooltip's timer without drawing a frame.
const _pastHoverWait = Duration(milliseconds: 600);

void main() {
  testWidgets('a roster row leaving as its tooltip opens keeps clicks alive', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(420, 400));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final fixture = RosterFixture();
    addTearDown(fixture.app.dispose);
    addTearDown(fixture.controller.dispose);
    await fixture.initialize();
    fixture.server.state['agents'] = [
      for (var i = 0; i < 60; i++)
        {
          'id': 'agent-$i',
          'projectId': 'lead',
          'name': 'Lead',
          'displayName': 'Agent $i',
          'machineId': 'm',
          'harnessId': 'a$i',
          'contributorId': 'owner',
          'configuration': {'engine': 'codex'},
        },
    ];
    await fixture.controller.refresh();
    await fixture.show(tester);

    final list = tester.state<ScrollableState>(find.byType(Scrollable).first);
    list.position.jumpTo(list.position.maxScrollExtent);
    await tester.pumpAndSettle();

    final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
    addTearDown(mouse.removePointer);
    await mouse.addPointer(location: const Offset(100, 380));
    await tester.pump();
    await tester.binding.delayed(_pastHoverWait);
    list.position.jumpTo(list.position.pixels - 1500);
    await tester.pump();
    expect(tester.takeException(), isNull);

    await mouse.moveTo(const Offset(100, 100));
    expect(tester.takeException(), isNull);
    await tester.pump(const Duration(seconds: 1));
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'clicking around the Swarm screen and toggling Buddies logs no error',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(1300, 500));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final server = modelsSwarm();
      final controller = server.controller(
        account: 'peer',
        initial: {'tabId': 'tab', 'accountId': 'peer', 'selectedId': 'lead'},
      );
      addTearDown(controller.dispose);
      await controller.refresh();
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.light),
          home: Scaffold(
            body: SuperTabView(
              controller: controller,
              onInvite: () {},
              onAddAgent: (_) {},
              onOpenTerminal: (_) {},
              machineName: (_) => 'Mac Studio',
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
      addTearDown(mouse.removePointer);
      await mouse.addPointer(location: Offset.zero);

      Future<void> click(Finder target) async {
        await mouse.moveTo(tester.getCenter(target));
        await tester.pump();
        await tester.binding.delayed(_pastHoverWait);
        await mouse.down(tester.getCenter(target));
        await mouse.up();
        await tester.pump();
        await tester.pump(const Duration(seconds: 1));
        expect(tester.takeException(), isNull);
      }

      for (var round = 0; round < 3; round++) {
        await click(find.byTooltip('Collapse Buddies'));
        expect(controller.buddiesGroupOpen, isFalse);
        await click(find.byTooltip('Expand Buddies'));
        expect(controller.buddiesGroupOpen, isTrue);
        // Hover a Buddy's row, then close Buddies as its tooltip opens: the
        // row leaves the list. (Projects no longer folds, task #2996.)
        await mouse.moveTo(
          tester.getCenter(find.byKey(const ValueKey('super-buddy-lead'))),
        );
        await tester.pump();
        await tester.binding.delayed(_pastHoverWait);
        controller.toggleBuddiesGroup();
        await tester.pump();
        expect(tester.takeException(), isNull);
        // And open it again while the place it left is hovered.
        await tester.binding.delayed(_pastHoverWait);
        controller.toggleBuddiesGroup();
        await tester.pump();
        expect(tester.takeException(), isNull);
        await mouse.moveTo(const Offset(100, 60));
        expect(tester.takeException(), isNull);
        await tester.pump(const Duration(seconds: 1));
        expect(tester.takeException(), isNull);
      }
    },
  );
}
