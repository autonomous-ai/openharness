import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_max_bar/dev/fixtures.dart';
import 'package:harness_max_bar/model/bar_model.dart';
import 'package:harness_max_bar/model/types.dart';
import 'package:harness_max_bar/ui/bar_frame.dart';
import 'package:harness_max_bar/ui/overview/cell.dart';
import 'package:harness_max_bar/ui/pages/overview_page.dart';
import 'package:harness_max_bar/ui/pet.dart';

import '../support/bar_test.dart';
import 'recording_model.dart';

Future<void> _show(WidgetTester tester, BarModel model) async {
  await tester.runAsync(preloadPets);
  await pumpOnBar(tester, OverviewPage(model: model));
  await settleImages(tester);
}

void main() {
  setUpAll(loadBarFaces);

  group('looks as the mockup', () {
    testWidgets('Orca: five cells, the bell with two unread', (tester) async {
      await _show(tester, mockupModel());
      await expectLater(find.byType(BarFrame), matchesGoldenFile('goldens/overview.png'));
    });

    testWidgets('Harness: three cells', (tester) async {
      await _show(tester, mockupModel(app: 'harness'));
      await expectLater(find.byType(BarFrame), matchesGoldenFile('goldens/overview_harness.png'));
    });
  });

  group('touch', () {
    testWidgets('a tap on a cell is a touch, then that agent', (tester) async {
      final m = RecordingModel(mockupModel());
      await _show(tester, m);
      await tester.tap(find.text('flaky-e2e'));
      expect(m.calls, ['touched', 'tapCell flaky-e2e']);
    });

    testWidgets('a tap anywhere in a cell counts, even on its rail or below its words', (tester) async {
      final m = RecordingModel(mockupModel());
      await _show(tester, m);
      // auth-refactor's cell is x 196..430 (five cells across 1172 px)
      await tester.tapAt(const Offset(300, 3));
      await tester.tapAt(const Offset(300, 310));
      expect(m.calls, ['touched', 'tapCell auth-refactor', 'touched', 'tapCell auth-refactor']);
    });

    testWidgets('a tap that slides a little is still a tap', (tester) async {
      final m = RecordingModel(mockupModel());
      await _show(tester, m);
      await tester.dragFrom(const Offset(780, 160), const Offset(-60, 10));
      expect(m.calls, ['touched', 'tapCell flaky-e2e']);
    });

    testWidgets('a swipe to the left shows the next page, to the right the previous', (tester) async {
      final m = RecordingModel(mockupModel());
      await _show(tester, m);
      await tester.dragFrom(const Offset(900, 160), const Offset(-200, 0));
      await tester.dragFrom(const Offset(500, 160), const Offset(200, 10));
      expect(m.calls, ['touched', 'swipeCells 1', 'touched', 'swipeCells -1']);
    });

    testWidgets('a drag more down than sideways is no swipe', (tester) async {
      final m = RecordingModel(mockupModel());
      await _show(tester, m);
      await tester.dragFrom(const Offset(780, 40), const Offset(-90, 200));
      expect(m.calls, ['touched', 'tapCell flaky-e2e']);
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
    testWidgets('each cell has its name and status word; the badge counts the unread', (tester) async {
      await _show(tester, mockupModel());
      for (final w in ['auth-refactor', 'Editing', 'landing-hero', 'Needs you', 'flaky-e2e', 'Done', 'rate-limiter',
          'Planning', 'docs-sweep', 'Resting', 'Orca', '2']) {
        expect(find.text(w), findsOneWidget, reason: w);
      }
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
      m
        ..connected = false
        ..changed();
      await pumpOnBar(tester, OverviewPage(model: m));
      expect(find.text('Not connected'), findsOneWidget);
    });
  });

  group('pages of cells', () {
    BarModel seven() {
      final m = mockupModel();
      m.agents.addAll([
        Agent(id: 'billing-export', name: 'billing-export', engine: 'muse', state: AgentState.working, verb: 'Reading'),
        Agent(id: 'release-notes', name: 'release-notes', engine: 'claude', state: AgentState.done),
      ]);
      return m;
    }

    testWidgets('one dot per page; the page with a waiting agent is yellow', (tester) async {
      final m = seven();
      await _show(tester, m);
      expect(find.byKey(const ValueKey('dot0')), findsOneWidget);
      expect(find.byKey(const ValueKey('dot1')), findsOneWidget);
      final dot0 = tester.widget<Container>(find.byKey(const ValueKey('dot0')));
      final dot1 = tester.widget<Container>(find.byKey(const ValueKey('dot1')));
      expect((dot0.decoration! as BoxDecoration).color, const Color(0xFFE5E510));
      expect((dot1.decoration! as BoxDecoration).color, const Color(0xFF585863));
      expect(tester.getSize(find.byKey(const ValueKey('dot0'))).width, 16);
    });

    testWidgets('the last page keeps a full page\'s cell width', (tester) async {
      final m = seven()..cellPage = 1;
      await _show(tester, m);
      expect(find.text('billing-export'), findsOneWidget);
      expect(find.text('auth-refactor'), findsNothing);
      expect(tester.getSize(find.byType(AgentCell).first).width, closeTo(1172 / 5, .01));
    });

    testWidgets('a single page has no dots', (tester) async {
      await _show(tester, mockupModel());
      expect(find.byKey(const ValueKey('dot0')), findsNothing);
    });
  });
}
