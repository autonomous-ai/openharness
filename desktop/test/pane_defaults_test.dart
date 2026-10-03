import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/pane_arrangement.dart';
import 'package:harness/state/pane_preset.dart';
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
    'closing split panes resets defaults in visible order and retains terminals',
    (tester) async {
      final store = MemoryStore();
      final app = createApp(store: store, connected: true);
      final frames = <TerminalBinaryFrame>[];
      final panes = [
        for (var i = 0; i < 5; i++)
          app.adoptSessionForTest(terminal('a$i', frames)),
      ];
      final tab = app.activeSwarm;
      // A downward split puts a1 before a2 in the list, but a2 is beside a0.
      tab.savePaneSizes(
        '5:manual',
        PaneArrangement(const [
          Rect.fromLTRB(0, 0, .5, .25),
          Rect.fromLTRB(0, .25, .5, .5),
          Rect.fromLTRB(.5, 0, 1, .5),
          Rect.fromLTRB(0, .5, .5, 1),
          Rect.fromLTRB(.5, .5, 1, 1),
        ]),
      );
      // Old choices for the smaller counts must not reappear on close.
      for (final count in [2, 3, 4]) {
        tab.presets[count] = PanePreset.rows;
        final saved = PaneArrangement(PanePreset.rows.tilesFor(count));
        tab.savePaneSizes('$count:manual', saved);
        tab.savePaneSizes('$count:rows:0:rows', saved);
      }
      app.togglePinPane(panes[4].id);
      app.focusPane(panes[2].id);
      await mountWide(tester, app);
      final retained = {
        for (final pane in panes)
          pane: tester.element(
            find.descendant(
              of: find.byKey(pane.cellKey),
              matching: find.byType(TerminalView),
            ),
          ),
      };
      final sessions = {for (final pane in panes) pane: pane.session};
      const shapes = [
        [
          Rect.fromLTRB(0, 0, .5, .5),
          Rect.fromLTRB(.5, 0, 1, .5),
          Rect.fromLTRB(0, .5, .5, 1),
          Rect.fromLTRB(.5, .5, 1, 1),
        ],
        [
          Rect.fromLTRB(0, 0, 1 / 3, 1),
          Rect.fromLTRB(1 / 3, 0, 2 / 3, 1),
          Rect.fromLTRB(2 / 3, 0, 1, 1),
        ],
        [Rect.fromLTRB(0, 0, .5, 1), Rect.fromLTRB(.5, 0, 1, 1)],
        [Rect.fromLTRB(0, 0, 1, 1)],
      ];
      const orders = [
        [0, 2, 1, 4],
        [0, 1, 4],
        [0, 4],
        [0],
      ];
      const closing = [3, 2, 1, 4];
      const focused = [2, 1, 4, 0];
      for (var step = 0; step < closing.length; step++) {
        await app.closePane(panes[closing[step]].id);
        await tester.pump(const Duration(milliseconds: 150));
        expect(app.panes, [for (final i in orders[step]) panes[i]]);
        expect(app.focusedPaneId, panes[focused[step]].id);
        expect(
          app.presetFor(app.panes.length),
          PanePreset.defaultFor(app.panes.length),
        );
        expect(tab.manualLayout, isNull);
        final grid = tester.getRect(find.byType(PaneGrid));
        for (var i = 0; i < app.panes.length; i++) {
          final pane = app.panes[i];
          final rect = tester.getRect(find.byKey(pane.cellKey));
          final want = shapes[step][i];
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
          expect(pane.session, same(sessions[pane]));
          expect(
            tester.element(
              find.descendant(
                of: find.byKey(pane.cellKey),
                matching: find.byType(TerminalView),
              ),
            ),
            same(retained[pane]),
          );
        }
        if (step < 3) expect(app.pinnedSlotFor(panes[4]), app.panes.length - 1);
        frames.clear();
        await tester.sendKeyEvent(LogicalKeyboardKey.arrowRight);
        await tester.pump(const Duration(milliseconds: 10));
        expect(frames.single.streamId, app.focusedPane!.session!.streamId);
        expect(tester.takeException(), isNull);
        await app.flushPaneLayout();
        final restored = createApp(store: store);
        await restored.restorePaneLayoutForTest();
        expect(restored.panes.map((pane) => pane.agentId), [
          for (final i in orders[step]) 'a$i',
        ]);
        expect(restored.activeSwarm.manualLayout, isNull);
        expect(
          restored.presetFor(app.panes.length),
          PanePreset.defaultFor(app.panes.length),
        );
        restored.dispose();
      }
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );

  testWidgets(
    'New Pane reflows 2 to 3 to 4 to 5 panes, retaining terminals and focus',
    (tester) async {
      final captures =
          Platform.environment['HARNESS_PANE_DEFAULTS_CAPTURE_DIR'];
      if (captures != null) await tester.runAsync(loadRealFonts);
      final store = MemoryStore();
      final app = createApp(store: store, connected: true);
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
