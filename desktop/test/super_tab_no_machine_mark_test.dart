import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/humans_fixture.dart';
import 'support/super_tab_fixture.dart';
import 'support/super_tab_members.dart';

/// Scholes (11-04): the project lists 32 people and 21 machines, and nothing
/// showed who had not shared one. In the People list, a quiet mark after the
/// name of anyone with no machine in this Swarm. A machine that is only
/// offline still counts, and the mark goes once they add one (task #2699).
void main() {
  Future<SuperTabController> show(
    WidgetTester tester,
    ConversationServer server,
  ) async {
    await tester.binding.setSurfaceSize(const Size(1300, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final controller = server.controller(
      account: 'peer',
      initial: {'tabId': 'tab', 'accountId': 'peer', 'selectedId': 'lead'},
    );
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
    await openSuperTabMembers(tester);
    return controller;
  }

  Future<void> close(WidgetTester tester, SuperTabController controller) async {
    await tester.pumpWidget(const SizedBox());
    await controller.flush();
    controller.dispose();
  }

  Finder mark(String id) =>
      find.byKey(ValueKey('super-person-no-machine-$id'));

  testWidgets('marks a person with no machine, says why on hover', (
    tester,
  ) async {
    final controller = await show(tester, membersSwarm());
    expect(mark('peer'), findsOneWidget);
    expect(mark('tony'), findsOneWidget);
    // Inside their row, after the name.
    final row = find.byKey(const ValueKey('super-person-peer'));
    expect(find.descendant(of: row, matching: mark('peer')), findsOneWidget);
    expect(
      find.descendant(
        of: row,
        matching: find.byTooltip('No machine shared yet'),
      ),
      findsOneWidget,
    );
    expect(
      find.descendant(
        of: row,
        matching: find.bySemanticsLabel('No machine shared yet'),
      ),
      findsOneWidget,
    );
    await close(tester, controller);
  });

  testWidgets('a machine that is only offline still counts', (tester) async {
    // Ken's Mac Studio has sent no reading: offline, but in the Swarm.
    final server = membersSwarm();
    final studio = (server.state['machines'] as List).single as Map;
    expect(studio['observation'], isNull);
    final controller = await show(tester, server);
    expect(find.byKey(const ValueKey('super-person-owner')), findsOneWidget);
    expect(mark('owner'), findsNothing);
    await close(tester, controller);
  });

  testWidgets('the mark goes once they add a machine', (tester) async {
    final controller = await show(tester, membersSwarm());
    expect(mark('peer'), findsOneWidget);
    await controller.command({
      'type': 'machine.contribute',
      'machineId': 'dee-mac',
      'name': 'Dee’s Mac',
      'cwd': '/work',
      'scope': 'swarm',
      'engines': ['claude'],
      'maxAgents': 2,
    });
    await tester.pumpAndSettle();
    expect(mark('peer'), findsNothing);
    expect(mark('tony'), findsOneWidget);
    await close(tester, controller);
  });
}
