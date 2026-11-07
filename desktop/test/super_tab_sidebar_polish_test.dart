import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/super_tab_fixture.dart';
import 'support/super_tab_left_pane.dart';

/// The left pane's smaller polish (Desktop 1.3.89 audit, task #4445). A Lead's project and Projects' counts are the
/// quiet rows' details (super_tab_v3_left_test.dart, task #4466).
void main() {
  Finder key(String k) => find.byKey(ValueKey(k));

  testWidgets('a long Swarm name says all of itself on hover', (tester) async {
    const name = 'Autonomous Robotics Collective of Saigon';
    await showLeftPane(
      tester,
      width: 180,
      setup: (server) => server.state['name'] = name,
    );
    expect(
      find.descendant(
        of: key('super-swarm-switcher'),
        matching: find.text(name),
      ),
      findsOneWidget,
    );
    expect(find.byTooltip(name), findsOneWidget);
  });
}
