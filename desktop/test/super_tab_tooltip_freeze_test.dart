import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'super_tab_roster_test.dart' show RosterFixture;

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
}
