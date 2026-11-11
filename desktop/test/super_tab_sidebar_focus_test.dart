import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/widgets/desktop_chrome.dart';

import 'support/super_tab_fixture.dart';
import 'support/super_tab_left_pane.dart';

/// Audit finding 21 (Desktop 1.3.89, task #4445): after Tab the focused row wore the hover fill, and looked almost
/// like the selected one. Focus is a ring now; the fill stays the row's own.
void main() {
  Finder key(String k) => find.byKey(ValueKey(k));

  /// Kestrel and Orion, each with its own chat (Swarm v4); Orion the PM.
  void agents(ConversationServer server) {
    server.state['agents'] = [
      {...leftPaneAgent('kestrel', 'Kestrel'), 'chatId': 'agent-chat-kestrel'},
      {
        ...leftPaneAgent('orion', 'Orion'),
        'chatId': 'agent-chat-orion',
        'kind': 'pm',
      },
    ];
    (server.state['conversations'] as List<Map<String, dynamic>>).addAll([
      for (final id in ['kestrel', 'orion'])
        {
          ...conversationFixture('agent-chat-$id', id),
          'kind': 'agent-chat',
          'agentIds': [id],
        },
    ]);
  }

  Future<void> tabTo(WidgetTester tester, Finder row) async {
    for (var i = 0; i < 60; i++) {
      await tester.sendKeyEvent(LogicalKeyboardKey.tab);
      await tester.pump();
      final focused = FocusManager.instance.primaryFocus?.context;
      final inRow = find.descendant(
        of: row,
        matching: find.byElementPredicate((e) => e == focused),
      );
      if (focused != null && inRow.evaluate().isNotEmpty) {
        // Past any highlight's fade.
        await tester.pump(const Duration(milliseconds: 400));
        return;
      }
    }
    fail('Tab never reached the row');
  }

  /// A fill of [color] over the row, as an ink highlight draws one.
  PaintPattern fill(Color color) => paints
    ..something(
      (method, args) =>
          method == #drawRRect &&
          (args[1] as Paint).color.toARGB32() == color.toARGB32(),
    );

  /// The focus ring: a [width] rim of [DesktopChrome.focusRing] around the row.
  PaintPattern ring({double width = 2}) => paints
    ..something((method, args) {
      if (method != #drawDRRect) return false;
      final outer = args[0] as RRect, inner = args[1] as RRect;
      return (args[2] as Paint).color.toARGB32() ==
              DesktopChrome.focusRing.toARGB32() &&
          (outer.width - inner.width - 2 * width).abs() < .01;
    });

  for (final (row, label) in [
    ('super-agent-orion', 'an agent row'),
    ('super-project-lead', 'a project row'),
  ]) {
    testWidgets('Tab to $label that is not selected: a ring, and its fill '
        'unchanged', (tester) async {
      final c = await showLeftPane(tester, setup: agents);
      c.select('agent-chat-kestrel');
      await tester.pump();
      await tabTo(tester, key(row));
      final drawn = key(row);
      expect(drawn, isNot(fill(grid.SidebarInk.hover)));
      expect(drawn, ring());
      // The selected row keeps its fill and wears no ring.
      final selected = key('super-agent-kestrel');
      expect(
        tester
            .widget<Material>(
              find.descendant(of: selected, matching: find.byType(Material)),
            )
            .color,
        grid.SidebarInk.selected,
      );
      expect(selected, isNot(ring()));
      await tester.runAsync(c.flush);
    });
  }
}
