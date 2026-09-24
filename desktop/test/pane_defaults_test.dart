import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/widgets/pane_grid.dart';
import 'package:xterm/xterm.dart';

import 'support/real_fonts.dart';
import 'swarm_interactions_test.dart' show chord;
import 'swarm_resize_test.dart' show mountWide;
import 'swarm_screen_test.dart' show terminal;
import 'swarm_state_test.dart' show createApp, MemoryStore;

void main() {
  testWidgets(
    'New Pane reflows 2 to 3 to 4 to 5 panes, retaining terminals and focus',
    (tester) async {
      final captures =
          Platform.environment['HARNESS_PANE_DEFAULTS_CAPTURE_DIR'];
      if (captures != null) await tester.runAsync(loadRealFonts);
      final store = MemoryStore();
      final app = createApp(store: store);
      app.machineStates['m']!.nodeOnline = true;
      final frames = <TerminalBinaryFrame>[];
      final tab = app.activeSwarm;
      final first = app.adoptSessionForTest(terminal('a0', frames));
      app.adoptSessionForTest(terminal('a1', frames));
      app.newSwarm(name: 'Available harnesses');
      final available = [
        for (var i = 2; i < 5; i++)
          app.adoptSessionForTest(terminal('a$i', frames)),
      ];
      app.selectSwarm(tab.id);
      await mountWide(tester, app);
      final firstView = find.descendant(
        of: find.byKey(first.cellKey),
        matching: find.byType(TerminalView),
      );
      final retained = tester.element(firstView);
      const expected = {
        3: [
          Rect.fromLTRB(0, 0, 1 / 3, 1),
          Rect.fromLTRB(1 / 3, 0, 2 / 3, 1),
          Rect.fromLTRB(2 / 3, 0, 1, 1),
        ],
        4: [
          Rect.fromLTRB(0, 0, .5, .5),
          Rect.fromLTRB(.5, 0, 1, .5),
          Rect.fromLTRB(0, .5, .5, 1),
          Rect.fromLTRB(.5, .5, 1, 1),
        ],
        5: [
          Rect.fromLTRB(0, 0, 1 / 3, .5),
          Rect.fromLTRB(1 / 3, 0, 2 / 3, 1),
          Rect.fromLTRB(2 / 3, 0, 1, .5),
          Rect.fromLTRB(0, .5, 1 / 3, 1),
          Rect.fromLTRB(2 / 3, .5, 1, 1),
        ],
      };

      void checkShape(int count) {
        final grid = tester.getRect(find.byType(PaneGrid));
        for (var i = 0; i < count; i++) {
          final rect = tester.getRect(find.byKey(app.panes[i].cellKey));
          final want = expected[count]![i];
          expect((rect.left - grid.left) / grid.width, closeTo(want.left, .02));
          expect((rect.top - grid.top) / grid.height, closeTo(want.top, .02));
          expect(
            (rect.right - grid.left) / grid.width,
            closeTo(want.right, .02),
          );
          expect(
            (rect.bottom - grid.top) / grid.height,
            closeTo(want.bottom, .02),
          );
        }
      }

      for (var count = 3; count <= 5; count++) {
        await chord(tester, LogicalKeyboardKey.keyP, shift: true);
        await tester.enterText(
          find.byKey(const ValueKey('swarm-search-input')),
          'Agent ${count - 1}',
        );
        await tester.pump();
        await tester.sendKeyEvent(LogicalKeyboardKey.enter);
        await tester.pump(const Duration(milliseconds: 150));
        expect(app.activeSwarm, same(tab));
        expect(app.panes, hasLength(count));
        expect(app.panes.last, same(available[count - 3]));
        expect(app.focusedPaneId, app.panes.last.id);
        expect(tester.element(firstView), same(retained));
        checkShape(count);
        expect(tester.takeException(), isNull);
        if (captures != null) {
          await expectLater(
            find.byType(MaterialApp),
            matchesGoldenFile(Uri.file('$captures/$count-panes.png')),
          );
        }
        frames.clear();
        await tester.sendKeyEvent(LogicalKeyboardKey.arrowRight);
        await tester.pump(const Duration(milliseconds: 10));
        expect(frames.single.streamId, app.panes.last.session!.streamId);
      }

      // Closing panes returns to the matching default at each smaller count.
      for (final count in [4, 3]) {
        await app.closePane(app.panes.last.id);
        await tester.pump(const Duration(milliseconds: 150));
        checkShape(count);
        expect(tester.element(firstView), same(retained));
      }
      await app.flushPaneLayout();
      await tester.pumpWidget(const SizedBox());
      app.dispose();
      final restored = createApp(store: store);
      await restored.restorePaneLayoutForTest();
      expect(restored.panes.map((pane) => pane.agentId), ['a0', 'a1', 'a2']);
      expect(restored.presetFor(3)!.tilesFor(3), expected[3]);
      restored.dispose();
    },
  );
}
