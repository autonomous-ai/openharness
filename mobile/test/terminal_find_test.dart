import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/terminal/terminal_binary.dart';
import 'package:harness_mobile/terminal/terminal_find.dart';
import 'package:harness_mobile/terminal/terminal_session.dart';
import 'package:harness_mobile/widgets/terminal_panel.dart';
import 'package:xterm/xterm.dart';

import 'terminal_panel_fixture.dart';

/// What [TerminalFindController] was asked, recorded in place of a panel.
class _Target implements TerminalFindTarget {
  final queries = <String>[];
  final steps = <int>[];

  @override
  void findQuery(String query) => queries.add(query);

  @override
  void findStep(int delta) => steps.add(delta);
}

/// Find in terminal, below the bar: what the bar and the panel say to each other, and what the
/// panel does with the terminal it shows — the desktop's ⌘F, on the phone.
void main() {
  group('the controller between the bar and the panel', () {
    test('the count, in the desktop bar’s words', () {
      final find = TerminalFindController();
      addTearDown(find.dispose);
      expect(find.status, '', reason: 'nothing asked, nothing said');

      find.setQuery('error');
      find.report(count: 0, selected: -1, searching: true, hasSnapshot: false);
      expect(find.status, '…');
      expect(find.missed, isFalse, reason: 'not known yet');

      find.report(count: 12, selected: 2, searching: false, hasSnapshot: true);
      expect(find.status, '3/12');

      find.report(count: 0, selected: -1, searching: false, hasSnapshot: true);
      expect(find.status, '0/0');
      expect(find.missed, isTrue);
    });

    test('words typed before the panel attached reach it as it does', () {
      final find = TerminalFindController();
      addTearDown(find.dispose);
      find.setQuery('error');

      final target = _Target();
      find.attach(target);
      find.setQuery('errors');
      find.next();
      find.previous();

      expect(target.queries, ['error', 'errors']);
      expect(target.steps, [1, -1]);
    });

    test('only the panel that attached can let go', () {
      final find = TerminalFindController();
      addTearDown(find.dispose);
      final old = _Target(), current = _Target();
      find.attach(old);
      // A remounted panel attaches before the old one is disposed.
      find.attach(current);
      find.detach(old);
      find.next();
      expect(current.steps, [1]);

      find.report(count: 3, selected: 0, searching: false, hasSnapshot: true);
      find.detach(current);
      find.next();
      expect(current.steps, [1], reason: 'nobody to step once let go');
      expect(find.count, 0, reason: 'nothing found by nobody');
    });

    test('says so only when something changed', () {
      final find = TerminalFindController();
      addTearDown(find.dispose);
      var heard = 0;
      find.addListener(() => heard++);
      find.report(count: 2, selected: 0, searching: false, hasSnapshot: true);
      find.report(count: 2, selected: 0, searching: false, hasSnapshot: true);
      find.setQuery('');
      expect(heard, 1);
    });
  });

  group('the panel', () {
    late AppNotifier notifier;
    setUp(() => notifier = panelNotifier());
    tearDown(() => notifier.dispose());

    TerminalSession session() {
      final made = controllingSession();
      addTearDown(made.dispose);
      return made;
    }

    Future<void> pumpPanel(
      WidgetTester tester,
      TerminalSession session, {
      TerminalFindController? find,
    }) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Align(
              alignment: Alignment.topLeft,
              child: SizedBox(
                width: 400,
                height: 320,
                child: TerminalPanel(
                  key: const ValueKey('pane'),
                  notifier: notifier,
                  session: session,
                  focused: false,
                  find: find,
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pump();
    }

    ScrollPosition scroll(WidgetTester tester) => tester
        .state<ScrollableState>(
          find.descendant(
            of: find.byType(TerminalView),
            matching: find.byType(Scrollable),
          ),
        )
        .position;

    TerminalController controller(WidgetTester tester) =>
        tester.widget<TerminalView>(find.byType(TerminalView)).controller!;

    double lineHeight(WidgetTester tester) => tester
        .state<TerminalViewState>(find.byType(TerminalView))
        .renderTerminal
        .lineHeight;

    /// Two hundred rows of history, `marker` on rows 3 and 150, read at the end.
    void history(TerminalSession session) {
      for (var i = 0; i < 200; i++) {
        session.terminal.write(
          i == 3 || i == 150 ? 'row $i marker\r\n' : 'row $i\r\n',
        );
      }
    }

    /// The search's scans, done — they yield to the event loop between slices.
    Future<void> scanned(WidgetTester tester) async {
      for (var i = 0; i < 6; i++) {
        await tester.pump(const Duration(milliseconds: 20));
      }
    }

    testWidgets('finds what the terminal shows, lights it, brings it into view '
        'and says how many', (tester) async {
      final pane = session();
      history(pane);
      final finding = TerminalFindController();
      addTearDown(finding.dispose);
      await pumpPanel(tester, pane);
      await tester.pump();
      final atEnd = scroll(tester).pixels;
      expect(atEnd, scroll(tester).maxScrollExtent);

      await pumpPanel(tester, pane, find: finding);
      finding.setQuery('marker');
      await scanned(tester);

      expect(finding.count, 2);
      expect(finding.status, '1/2');
      expect(controller(tester).highlights, hasLength(1));
      // Row 3, three rows clear of the top where the title lies over it.
      expect(scroll(tester).pixels, 0);

      finding.next();
      await scanned(tester);
      expect(finding.status, '2/2');
      final line = lineHeight(tester);
      final position = scroll(tester);
      expect(
        150 * line,
        inInclusiveRange(
          position.pixels,
          position.pixels + position.viewportDimension,
        ),
        reason: 'row 150 is on screen',
      );
      expect(controller(tester).highlights, hasLength(1));
    });

    testWidgets('nothing found says so and moves nothing', (tester) async {
      final pane = session();
      history(pane);
      final finding = TerminalFindController();
      addTearDown(finding.dispose);
      await pumpPanel(tester, pane, find: finding);
      await tester.pump();
      final before = scroll(tester).pixels;

      finding.setQuery('needle');
      await scanned(tester);

      expect(finding.status, '0/0');
      expect(finding.missed, isTrue);
      expect(controller(tester).highlights, isEmpty);
      expect(scroll(tester).pixels, before);
    });

    testWidgets(
      'closed, the light goes and the reader is back where they were',
      (tester) async {
        final pane = session();
        history(pane);
        final finding = TerminalFindController();
        addTearDown(finding.dispose);
        await pumpPanel(tester, pane, find: finding);
        await tester.pump();
        finding.setQuery('marker');
        await scanned(tester);
        expect(scroll(tester).pixels, 0);

        await pumpPanel(tester, pane);
        await tester.pump();

        expect(controller(tester).highlights, isEmpty);
        expect(scroll(tester).pixels, scroll(tester).maxScrollExtent);
        expect(finding.count, 0, reason: 'the panel let the bar go');
      },
    );

    // The keyboard Find's own field raises resizes the pane, and the machine answers every resize
    // with a keyframe that replaces the terminal: without carrying the search across, the first
    // letter typed would end the search it started.
    testWidgets('a keyframe replacing the terminal keeps the search and its '
        'words', (tester) async {
      final pane = session();
      final finding = TerminalFindController();
      addTearDown(finding.dispose);
      await pumpPanel(tester, pane, find: finding);
      await tester.pump();
      finding.setQuery('marker');
      await scanned(tester);
      expect(finding.count, 0);

      await pane.handleBinary(
        TerminalBinaryFrame(
          kind: TerminalBinaryKind.keyframe,
          streamId: 's',
          seq: 0,
          bytes: Uint8List.fromList(
            utf8.encode('first marker\r\nthen another marker\r\n'),
          ),
          compressed: false,
          cols: 40,
          rows: 12,
        ),
      );
      await tester.pump();
      await scanned(tester);

      expect(finding.query, 'marker');
      expect(finding.count, 2);
      expect(finding.status, '1/2');
      expect(controller(tester).highlights, hasLength(1));
      // The ack and the resize the keyframe asks for, sent before the test ends.
      await tester.pump(const Duration(seconds: 2));
    });
  });
}
