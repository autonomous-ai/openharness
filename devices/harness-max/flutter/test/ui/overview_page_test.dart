import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_max_bar/dev/fixtures.dart';
import 'package:harness_max_bar/model/bar_model.dart';
import 'package:harness_max_bar/model/types.dart';
import 'package:harness_max_bar/ui/bar_frame.dart';
import 'package:harness_max_bar/ui/overview/cell.dart';
import 'package:harness_max_bar/ui/overview/open_agent.dart';
import 'package:harness_max_bar/ui/pages/overview_page.dart';
import 'package:harness_max_bar/ui/pet.dart';
import 'package:harness_max_bar/ui/tokens.dart';

import '../support/bar_test.dart';
import 'recording_model.dart';

Future<void> _show(WidgetTester tester, BarModel model) async {
  await tester.runAsync(preloadPets);
  await pumpOnBar(tester, OverviewPage(model: model));
  await settleImages(tester);
}

/// The Orca fixture with [id] open, as a cell's tap leaves it (the mic off).
BarModel _opened(String id) => mockupModel()
  ..page = BarPage.agent
  ..selectedId = id;

/// Lets a fling, a snap or the row's own motion run out (the page's clock never stops, so no pumpAndSettle).
Future<void> _rest(WidgetTester tester) async {
  for (var i = 0; i < 12; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
}

double _scrolled(WidgetTester tester) => tester.state<ScrollableState>(find.byType(Scrollable)).position.pixels;

double _width(WidgetTester tester, String id) => tester.getSize(find.byKey(ValueKey(id))).width;

double _dot(WidgetTester tester, int i) => tester.widget<AnimatedOpacity>(find.byKey(ValueKey('dot$i'))).opacity;

void main() {
  setUpAll(loadBarFaces);

  group('looks as the mockup', () {
    testWidgets('Orca: the first three of five cells, the right edge faded, the dots, the bell with two unread',
        (tester) async {
      await _show(tester, mockupModel());
      await expectLater(find.byType(BarFrame), matchesGoldenFile('goldens/overview.png'));
    });

    testWidgets('Harness: three cells fill the row, no dots', (tester) async {
      await _show(tester, mockupModel(app: 'harness'));
      await expectLater(find.byType(BarFrame), matchesGoldenFile('goldens/overview_harness.png'));
    });

    testWidgets('Orca with rate-limiter open: a sliver either side of it', (tester) async {
      await _show(tester, _opened('rate-limiter'));
      await expectLater(find.byType(BarFrame), matchesGoldenFile('goldens/overview_open.png'));
    });
  });

  group('touch', () {
    testWidgets('a tap on a cell is a touch, then that agent', (tester) async {
      final m = RecordingModel(mockupModel());
      await _show(tester, m);
      await tester.tap(find.text('rate-limiter'));
      expect(m.calls, ['touched', 'tapCell rate-limiter']);
    });

    testWidgets('a tap anywhere in a cell counts, even on its rail or below its words', (tester) async {
      final m = RecordingModel(mockupModel());
      await _show(tester, m);
      // landing-hero's cell, the first (it waits on the person), is x 196..587 (a third of the 1172 px row)
      await tester.tapAt(const Offset(300, 3));
      await tester.tapAt(const Offset(300, 310));
      expect(m.calls, ['touched', 'tapCell landing-hero', 'touched', 'tapCell landing-hero']);
    });

    testWidgets('a sideways drag scrolls the row, taps nothing, and comes to rest on a cell\'s edge', (tester) async {
      final m = RecordingModel(mockupModel());
      await _show(tester, m);
      // past half a cell (the row takes the drag from where it beat the touch slop): the next cell's edge
      await tester.dragFrom(const Offset(900, 160), const Offset(-260, 0));
      await _rest(tester);
      expect(m.calls, isEmpty);
      expect(_scrolled(tester), closeTo(kCellW, .01));
      expect(tester.getTopLeft(find.byKey(const ValueKey('auth-refactor'))).dx, closeTo(196, .01));
    });

    testWidgets('a tap on a sliver beside the open agent is a touch, then that agent', (tester) async {
      final m = RecordingModel(_opened('rate-limiter'));
      await _show(tester, m);
      // one sliver before the open agent: auth-refactor at x 196..332, flaky-e2e at x 1232..1368
      await tester.tapAt(const Offset(264, 160));
      await tester.tapAt(const Offset(1300, 160));
      expect(m.calls, ['touched', 'tapSliver auth-refactor', 'touched', 'tapSliver flaky-e2e']);
    });

    testWidgets('the open agent takes its own taps: its X closes it, and no cell opens under it', (tester) async {
      final m = RecordingModel(_opened('rate-limiter'));
      await _show(tester, m);
      await tester.tapAt(const Offset(700, 160));
      await tester.tap(find.byKey(const ValueKey('close')));
      expect(m.calls.where((c) => c.startsWith('tapCell') || c.startsWith('tapSliver')), isEmpty);
      expect(m.calls, contains('closeAgent'));
    });

    testWidgets('a finger sliding on the open agent does not move the row under it', (tester) async {
      final m = RecordingModel(_opened('rate-limiter'));
      await _show(tester, m);
      await tester.dragFrom(const Offset(700, 160), const Offset(-200, 0));
      await _rest(tester);
      expect(_scrolled(tester), closeTo(kSliverW, .01));
    });

    testWidgets('the app column opens Apps when there is another app', (tester) async {
      final m = RecordingModel(mockupModel());
      await _show(tester, m);
      await tester.tapAt(const Offset(100, 300));
      expect(m.calls, ['touched', 'openApps']);
    });

    testWidgets('with no other app, the app column has no grid and does nothing', (tester) async {
      final from = mockupModel();
      from.apps.removeWhere((a) => a.id != 'orca');
      final m = RecordingModel(from);
      await _show(tester, m);
      await tester.tapAt(const Offset(100, 160));
      expect(m.calls, isEmpty);
    });

    testWidgets('the bell column opens Inbox, top to bottom', (tester) async {
      final m = RecordingModel(mockupModel());
      await _show(tester, m);
      await tester.tapAt(const Offset(1424, 160));
      await tester.tapAt(const Offset(1372, 6));
      await tester.tapAt(const Offset(1475, 315));
      expect(m.calls, ['touched', 'openInbox', 'touched', 'openInbox', 'touched', 'openInbox']);
    });
  });

  group('words', () {
    testWidgets('each cell has its name, its task and its state chip; the app has its count; the badge the unread',
        (tester) async {
      await _show(tester, mockupModel());
      for (final w in [
        'auth-refactor', 'session.ts', 'Editing', //
        'landing-hero', 'Both hero versions build. Keep the dark gradient, or switch to the product photo?',
        'Needs you', 'flaky-e2e', 'Done', 'rate-limiter', '4 steps, starting with the middleware', 'Planning',
        'docs-sweep', 'Resting', 'Orca', '5 agents', '2',
      ]) {
        expect(find.text(w), findsOneWidget, reason: w);
      }
    });

    testWidgets('an agent with no task yet says so, faint', (tester) async {
      await _show(tester, mockupModel());
      expect(tester.widget<Text>(find.text('No task yet')).style!.color, Ink.faint);
    });

    testWidgets('one agent is "1 agent"', (tester) async {
      final m = mockupModel()..agents.removeRange(1, 5);
      await _show(tester, m);
      expect(find.text('1 agent'), findsOneWidget);
    });

    testWidgets('no unread notice: no badge', (tester) async {
      final m = mockupModel();
      for (final n in m.inbox) {
        n.unread = false;
      }
      await _show(tester, m);
      expect(find.byKey(const ValueKey('badge')), findsNothing);
    });

    testWidgets('no agents: says so, or that no computer is on the cable', (tester) async {
      final m = mockupModel()..agents.clear();
      await _show(tester, m);
      expect(find.text('No agents yet'), findsOneWidget);
      expect(find.text('0 agents'), findsNothing);
      m
        ..connected = false
        ..changed();
      await tester.pump();
      expect(find.text('Not connected'), findsOneWidget);
    });
  });

  group('order', () {
    double x(WidgetTester tester, String id) => tester.getTopLeft(find.byKey(ValueKey(id))).dx;

    testWidgets('who needs the person first: waiting, at work, failed, done, resting', (tester) async {
      final m = mockupModel();
      m.agentById('flaky-e2e')!.state = AgentState.failed;
      m.agentById('auth-refactor')!.state = AgentState.done;
      await _show(tester, m);
      final ids = ['landing-hero', 'rate-limiter', 'flaky-e2e', 'auth-refactor', 'docs-sweep'];
      for (var i = 1; i < ids.length; i++) {
        expect(x(tester, ids[i]), closeTo(x(tester, ids[i - 1]) + kCellW, .01), reason: ids[i]);
      }
      expect(x(tester, 'landing-hero'), closeTo(196, .01));
    });

    testWidgets('an agent that comes to wait on the person moves up among the waiting, in the ring\'s order',
        (tester) async {
      final m = mockupModel();
      await _show(tester, m);
      expect(x(tester, 'docs-sweep'), closeTo(196 + 4 * kCellW, .01));
      m
        ..agentById('docs-sweep')!.state = AgentState.asking
        ..changed();
      await tester.pump();
      expect(x(tester, 'landing-hero'), closeTo(196, .01));
      expect(x(tester, 'docs-sweep'), closeTo(196 + kCellW, .01));
      expect(x(tester, 'auth-refactor'), closeTo(196 + 2 * kCellW, .01));
    });
  });

  group('dots', () {
    testWidgets('one per agent in its state\'s colour; the three cells on the glass lit', (tester) async {
      await _show(tester, mockupModel());
      expect([for (var i = 0; i < 5; i++) _dot(tester, i)], [1, 1, 1, .28, .28]);
      // the first agent waits on the person
      final waiting = tester.widget<Container>(
          find.descendant(of: find.byKey(const ValueKey('dot0')), matching: find.byType(Container)));
      expect((waiting.decoration! as BoxDecoration).color, Ink.ask);
    });

    testWidgets('scrolled to the end, the last three are lit and the left edge fades', (tester) async {
      await _show(tester, mockupModel());
      await tester.dragFrom(const Offset(1300, 160), const Offset(-1000, 0));
      await _rest(tester);
      expect(_scrolled(tester), closeTo(2 * kCellW, .01));
      expect([for (var i = 0; i < 5; i++) _dot(tester, i)], [.28, .28, 1, 1, 1]);
      expect(tester.widget<AnimatedOpacity>(find.byKey(const ValueKey('fade-left'))).opacity, 1);
      expect(tester.widget<AnimatedOpacity>(find.byKey(const ValueKey('fade-right'))).opacity, 0);
    });

    testWidgets('three agents: no dots, no faded edge', (tester) async {
      await _show(tester, mockupModel(app: 'harness'));
      expect(find.byKey(const ValueKey('dot0')), findsNothing);
      expect(tester.widget<AnimatedOpacity>(find.byKey(const ValueKey('fade-left'))).opacity, 0);
      expect(tester.widget<AnimatedOpacity>(find.byKey(const ValueKey('fade-right'))).opacity, 0);
    });
  });

  group('open', () {
    testWidgets('built open: the agent across the row, every other a sliver, one sliver before it', (tester) async {
      await _show(tester, _opened('rate-limiter'));
      expect(_width(tester, 'rate-limiter'), kOpenW);
      for (final id in ['landing-hero', 'auth-refactor', 'flaky-e2e', 'docs-sweep']) {
        expect(_width(tester, id), kSliverW, reason: id);
      }
      expect(_scrolled(tester), kSliverW);
      expect(find.byType(OpenAgent), findsOneWidget);
    });

    testWidgets('built open on the last agent: the row as far as it goes', (tester) async {
      await _show(tester, _opened('docs-sweep'));
      // 900 + 4 slivers less the row's 1172
      expect(_scrolled(tester), 272);
    });

    testWidgets('opening widens the cell as the row scrolls with it; closing narrows it, then scrolls back',
        (tester) async {
      final m = mockupModel();
      await _show(tester, m);
      m
        ..page = BarPage.agent
        ..selectedId = 'rate-limiter'
        ..changed();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));
      final w = _width(tester, 'rate-limiter');
      expect(w, greaterThan(kCellW));
      expect(w, lessThan(kOpenW));
      expect(_scrolled(tester), greaterThan(0));
      expect(_scrolled(tester), lessThan(kSliverW));
      await tester.pump(const Duration(milliseconds: 400));
      expect(_width(tester, 'rate-limiter'), kOpenW);
      expect(_width(tester, 'auth-refactor'), kSliverW);
      expect(_scrolled(tester), kSliverW);

      m
        ..page = BarPage.overview
        ..changed();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 430));
      expect(_width(tester, 'rate-limiter'), kCellW);
      // the widths first, the row where it was; then it comes back with rate-limiter in the middle
      expect(_scrolled(tester), kSliverW);
      await _rest(tester);
      expect(_scrolled(tester), closeTo(kCellW, .01));
      expect([for (var i = 0; i < 5; i++) _dot(tester, i)], [.28, 1, 1, 1, .28]);
    });

    testWidgets('a sliver\'s face moves to its middle and its words go; the open agent\'s face gives way',
        (tester) async {
      await _show(tester, _opened('rate-limiter'));
      final name = find.text('auth-refactor');
      expect(tester.widget<AnimatedOpacity>(find.ancestor(of: name, matching: find.byType(AnimatedOpacity)).first).opacity,
          0);
      // the sliver is x 196..332
      expect(tester.getCenter(name).dx, closeTo(264, .01));
      // rate-limiter's name twice: its face's (first, faded for the open agent) and the open agent's
      expect(find.text('rate-limiter'), findsNWidgets(2));
      final face = find.ancestor(of: find.text('rate-limiter').first, matching: find.byType(AnimatedOpacity));
      expect(tester.widgetList<AnimatedOpacity>(face).map((o) => o.opacity), contains(0));
    });
  });

  test('a sliver\'s colour matrix: none at rest, brightness .42 and opacity .42 when dimmed', () {
    expect(dimMatrix(0),
        [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0].map((v) => closeTo(v, 1e-9)).toList());
    final m = dimMatrix(1);
    // white stays grey (saturation keeps a grey grey) at .42; alpha .42
    for (final row in [0, 1, 2]) {
      expect(m[row * 5] + m[row * 5 + 1] + m[row * 5 + 2], closeTo(.42, 1e-9));
    }
    expect(m[18], closeTo(.42, 1e-9));
  });
}
