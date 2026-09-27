import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/phone/find_row.dart';
import 'package:harness_mobile/phone/terminal_page.dart';
import 'package:harness_mobile/phone/terminal_search.dart';

import '../integration_test/perf/claude_output.dart';
import '../integration_test/perf/fixture.dart';

/// The on-device benchmark's fixture (`integration_test/perf/`), checked on
/// every `flutter test` so it cannot drift from the app it measures — and the
/// one property of the idle screen that benchmark depends on.
void main() {
  /// iPhone 14: 390×844 points at 3×, with its safe-area insets.
  void phone(WidgetTester tester) {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3;
    tester.view.padding = const FakeViewPadding(top: 141, bottom: 102);
    addTearDown(tester.view.reset);
  }

  testWidgets('an idle terminal page draws nothing', (tester) async {
    phone(tester);
    final fixture = PerfFixture.create();
    final a = fixture.terminals['agent-a']!;
    await tester.pumpWidget(
      perfApp(FocusHost(fixture: fixture, initialAgentId: 'agent-a')),
    );
    await tester.pump(const Duration(milliseconds: 100));
    // The attach as the benchmark does it: the machine's size, the phone's
    // resize, and a keyframe back at the phone's grid.
    await a.keyframe(ClaudeOutput(cols: 80).keyframe(20), cols: 80, rows: 24);
    await tester.pump(const Duration(milliseconds: 100));
    await tester.pump(const Duration(milliseconds: 100));
    final (cols, rows) = a.lastResize!;
    await a.keyframe(
      ClaudeOutput(cols: cols).keyframe(2000),
      cols: cols,
      rows: rows,
    );
    await tester.pump(const Duration(milliseconds: 500));

    // Nothing streaming, keyboard down, mic at rest: every repeating
    // animation on the page (skeleton, header glint, mic arc/dots/bob, take
    // meter, cursor blink) is gated off, so no frame is asked for.
    for (var i = 0; i < 50; i++) {
      await tester.pump(const Duration(milliseconds: 100));
      expect(
        tester.binding.hasScheduledFrame,
        isFalse,
        reason: 'a frame was scheduled ${(i + 1) * 100} ms into idle',
      );
    }
    expect(tester.binding.transientCallbackCount, 0);
    expect(a.resizes, 1, reason: 'one resize, for the grid, then none');

    await tester.pumpWidget(const SizedBox.shrink());
    fixture.dispose();
  });

  testWidgets(
    'the redraw load holds the screen still; the append load grows it',
    (tester) async {
      final fixture = PerfFixture.create();
      final a = fixture.terminals['agent-a']!;
      final output = ClaudeOutput(cols: 40);
      await a.keyframe(output.keyframe(200), cols: 40, rows: 49);
      final buffer = a.session.terminal.buffer;
      final lines = buffer.lines.length;
      final cursor = buffer.cursorY;
      for (var tick = 1; tick <= 50; tick++) {
        await a.output(FixtureTerminal.encode(output.redrawBurst(tick)));
      }
      // Ink's in-place redraw: an 8-row region rewritten, nothing added.
      expect(buffer.lines.length, lines);
      expect(buffer.cursorY, cursor);
      for (var tick = 1; tick <= 20; tick++) {
        await a.output(FixtureTerminal.encode(output.appendBurst(tick)));
      }
      // Three long lines a burst, each wrapping several times at 40 columns.
      expect(buffer.lines.length, greaterThan(lines + 20 * 3 * 3));
      fixture.dispose();
    },
  );

  testWidgets('Find lists the other agent, and opening it switches the page', (
    tester,
  ) async {
    phone(tester);
    final fixture = PerfFixture.create();
    final host = GlobalKey<FocusHostState>();
    await tester.pumpWidget(
      perfApp(
        FocusHost(key: host, fixture: fixture, initialAgentId: 'agent-a'),
      ),
    );
    for (final id in ['agent-a', 'agent-b']) {
      await fixture.terminals[id]!.keyframe(
        ClaudeOutput(cols: 40).keyframe(100),
        cols: 40,
        rows: 49,
      );
    }
    await tester.pump(const Duration(milliseconds: 200));
    await tester.dragFrom(
      tester.getCenter(find.byType(TerminalPage).first) - const Offset(120, 0),
      const Offset(300, 0),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.byType(TerminalSearchOverlay), findsOneWidget);

    final row = find.byWidgetPredicate(
      (w) => w is FindRow && w.title == 'tighten rate limiter',
    );
    expect(row, findsOneWidget);
    await tester.tap(row);
    await tester.pump();
    expect(host.currentState!.agentId, 'agent-b');
    expect(
      find.byWidgetPredicate(
        (w) => w is TerminalPage && w.agentId == 'agent-b',
      ),
      findsOneWidget,
    );

    await tester.pump(const Duration(seconds: 1));
    await tester.pumpWidget(const SizedBox.shrink());
    fixture.dispose();
  });
}
