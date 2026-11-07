import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_icons.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;

import 'support/super_tab_fixture.dart';
import 'support/super_tab_left_pane.dart';

/// The left pane's smaller polish and finding 20's "No projects yet" (Desktop 1.3.89 audit, task #4445).
void main() {
  Finder key(String k) => find.byKey(ValueKey(k));
  Finder inRow(String agent, Finder matching) =>
      find.descendant(of: key('super-agent-$agent'), matching: matching);

  /// Kestrel, whose chat is [kestrelChat] (none while null), and Orion, the PM of web-project.
  void Function(ConversationServer) agents({String? kestrelChat = 'offline'}) =>
      (server) {
        server.state['agents'] = [
          leftPaneAgent('kestrel', 'Kestrel'),
          leftPaneAgent('orion', 'Orion'),
        ];
        final groups = (server.state['conversations'] as List)
            .cast<Map<String, dynamic>>();
        groups.firstWhere((g) => g['id'] == 'lead')['leadId'] = 'orion';
        if (kestrelChat != null) {
          groups.firstWhere((g) => g['id'] == kestrelChat)['assignment'] = {
            'id': 'a1',
            'agentId': 'kestrel',
            'status': 'working',
          };
        }
      };

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

  testWidgets('a PM\'s project reads after a separator, muted', (tester) async {
    await showLeftPane(tester, setup: agents());
    final note = inRow('orion', find.text('· web-project'));
    expect(note, findsOneWidget);
    expect(
      tester.widget<Text>(note).style?.color,
      grid.SidebarInk.muted(tester.element(key('super-agent-orion'))),
    );
  });

  testWidgets('the crown is at least 12 px on a 20 px avatar', (tester) async {
    await showLeftPane(tester, setup: agents());
    final badge = find
        .ancestor(
          of: inRow('orion', find.byIcon(AppIcons.crown)),
          matching: find.byType(Container),
        )
        .first;
    expect(tester.getSize(badge).width, greaterThanOrEqualTo(12));
  });

  testWidgets('an agent with no chat yet shows no hover fill and no click '
      'cursor, and still says why', (tester) async {
    await showLeftPane(tester, setup: agents(kestrelChat: null));
    final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
    addTearDown(mouse.removePointer);
    await mouse.addPointer(
      location: tester.getCenter(key('super-agent-kestrel')),
    );
    await tester.pump(const Duration(milliseconds: 400));
    expect(
      RendererBinding.instance.mouseTracker.debugDeviceActiveCursor(1),
      SystemMouseCursors.basic,
    );
    expect(
      key('super-agent-kestrel'),
      isNot(
        paints..something(
          (method, args) =>
              method == #drawRRect &&
              (args[1] as Paint).color.toARGB32() ==
                  grid.SidebarInk.hover.toARGB32(),
        ),
      ),
    );
    expect(find.byTooltip('Kestrel · no chat yet'), findsOneWidget);
  });

  testWidgets('open Projects with none says so', (tester) async {
    await showLeftPane(
      tester,
      setup: (server) {
        server.state['projects'] = <dynamic>[];
        server.state['agents'] = <dynamic>[];
      },
    );
    expect(find.byTooltip('Collapse Projects'), findsOneWidget);
    final empty = find.text('No projects yet.');
    expect(empty, findsOneWidget);
    expect(tester.widget<Text>(empty).style?.color, grid.SidebarInk.inkMuted);
  });
}
