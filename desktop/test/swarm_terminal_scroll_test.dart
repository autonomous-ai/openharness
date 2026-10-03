import 'dart:convert';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/pane_preset.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/widgets/pane_grid.dart';
import 'package:xterm/xterm.dart';

import 'swarm_state_test.dart' show createApp;
import 'swarm_screen_test.dart' show terminal;

void main() {
  for (final alt in [false, true]) {
    testWidgets('four panes scroll ${alt ? 'TUI' : 'history'} with wheel', (
      tester,
    ) async {
      final app = createApp();
      app.machineStates['m']!.nodeOnline = true;
      final inputs = List.generate(4, (_) => <TerminalBinaryFrame>[]);
      for (var i = 0; i < 4; i++) {
        final session = terminal('a$i', inputs[i]);
        session.terminal.write(
          List.generate(200, (n) => 'pane $i line $n\r\n').join(),
        );
        if (alt) session.terminal.write('\x1b[?1049h\x1b[?1000h\x1b[?1006h');
        app.adoptSessionForTest(session);
      }
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(1200, 800);
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        MaterialApp(home: PaneGrid(notifier: app, swarmMode: true)),
      );
      await tester.pump();
      for (final preset in PanePreset.forCount(4)) {
        app.setPreset(4, preset);
        await tester.pump();
        for (var i = 0; i < 4; i++) {
          final view = find.byWidgetPredicate(
            (w) =>
                w is TerminalView &&
                w.terminal == app.panes[i].session!.terminal,
          );
          await tester.ensureVisible(view);
          await tester.pump();
          final controller = tester
              .widget<TerminalView>(view)
              .scrollController!;
          if (!alt) controller.jumpTo(controller.position.maxScrollExtent);
          await tester.pump();
          inputs[i].clear();
          final before = controller.offset;
          final center = tester.getCenter(view);
          final pointer = TestPointer(2, PointerDeviceKind.mouse);
          await tester.sendEventToBinding(pointer.hover(center));
          await tester.sendEventToBinding(pointer.scroll(const Offset(0, -60)));
          await tester.pump(const Duration(milliseconds: 400));
          if (alt) {
            expect(
              inputs[i],
              isNotEmpty,
              reason: '${preset.id} pane $i must send scroll to TUI',
            );
            final render = tester.state<TerminalViewState>(view).renderTerminal;
            final cell = render.getCellOffset(render.globalToLocal(center));
            final reports = inputs[i]
                .map((frame) => utf8.decode(frame.bytes))
                .join();
            expect(
              reports,
              contains('\x1b[<64;${cell.x + 1};${cell.y + 1}M'),
              reason:
                  '${preset.id} pane $i must report pane-local mouse coordinates',
            );
          } else {
            expect(
              controller.offset,
              lessThan(before),
              reason: '${preset.id} pane $i must scroll history',
            );
          }
        }
      }
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    });
  }
}
