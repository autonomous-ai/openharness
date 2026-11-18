import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_max_bar/dev/fixtures.dart';
import 'package:harness_max_bar/model/types.dart';
import 'package:harness_max_bar/ui/bar_screen.dart';
import 'package:harness_max_bar/ui/pages/agent_page.dart';
import 'package:harness_max_bar/ui/pages/inbox_page.dart';
import 'package:harness_max_bar/ui/pages/overview_page.dart';
import 'package:harness_max_bar/ui/pet.dart';

import '../support/bar_test.dart';
import 'recording_model.dart';

double opacityOf(WidgetTester tester, Type page) => tester
    .widget<FadeTransition>(find.ancestor(of: find.byType(page), matching: find.byType(FadeTransition)).first)
    .opacity
    .value;

void main() {
  setUpAll(loadBarFaces);

  testWidgets('shows the model\'s page', (tester) async {
    await tester.runAsync(preloadPets);
    final m = mockupModel();
    await pumpOnBar(tester, BarScreen(model: m));
    expect(find.byType(OverviewPage), findsOneWidget);
    m
      ..page = BarPage.agent
      ..selectedId = 'flaky-e2e'
      ..changed();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.byType(AgentPage), findsOneWidget);
    expect(find.byType(OverviewPage), findsNothing);
  });

  testWidgets('a new page fades in over the old as the old fades out, eased, in .3 s', (tester) async {
    await tester.runAsync(preloadPets);
    final m = mockupModel();
    await pumpOnBar(tester, BarScreen(model: m));
    expect(opacityOf(tester, OverviewPage), 1);
    m
      ..page = BarPage.inbox
      ..changed();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 150));
    // CSS `ease` halfway through is .8024
    expect(opacityOf(tester, InboxPage), closeTo(.8024, .01));
    expect(opacityOf(tester, OverviewPage), closeTo(1 - .8024, .01));
    await tester.pump(const Duration(milliseconds: 150));
    // the old page is dropped on the first frame past its fade
    await tester.pump(const Duration(milliseconds: 16));
    expect(find.byType(OverviewPage), findsNothing);
    expect(opacityOf(tester, InboxPage), 1);
  });

  testWidgets('the page going out takes no touch', (tester) async {
    await tester.runAsync(preloadPets);
    final m = RecordingModel(mockupModel());
    await pumpOnBar(tester, BarScreen(model: m));
    m
      ..page = BarPage.inbox
      ..changed();
    await tester.pump(const Duration(milliseconds: 50));
    // the Overview's bell under the finger, fading out: the tap is Inbox's (its card there), never openInbox
    await tester.tapAt(const Offset(1424, 160));
    expect(m.calls, isNot(contains('openInbox')));
  });

  testWidgets('on the agent page, a turn that ends fades its page from Working to reading; the band stays up',
      (tester) async {
    await tester.runAsync(preloadPets);
    final m = mockupModel()
      ..page = BarPage.agent
      ..selectedId = 'auth-refactor'
      ..talk = TalkPhase.listening
      ..talkStarted = kFixtureNow;
    await pumpOnBar(tester, BarScreen(model: m));
    await tester.pump(const Duration(milliseconds: 400));
    final band = find.text('Listening');
    final bandTop = tester.getTopLeft(band);
    m.selected!
      ..state = AgentState.done
      ..said = 'Token refresh retries once.';
    m.changed();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.text('session.ts'), findsOneWidget);
    expect(find.text('Token refresh retries once.'), findsOneWidget);
    expect(tester.getTopLeft(band), bandTop);
    await tester.pump(const Duration(milliseconds: 250));
    expect(find.text('session.ts'), findsNothing);
  });

  testWidgets('any touch on any page starts the idle clock again, a drag on Inbox too', (tester) async {
    await tester.runAsync(preloadPets);
    final m = RecordingModel(mockupModel()..page = BarPage.inbox);
    await pumpOnBar(tester, BarScreen(model: m));
    await tester.dragFrom(const Offset(900, 160), const Offset(-200, 0));
    await tester.pump(const Duration(milliseconds: 400));
    expect(m.calls, contains('touched'));
  });
}
