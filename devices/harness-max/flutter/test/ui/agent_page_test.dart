import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_max_bar/dev/fixtures.dart';
import 'package:harness_max_bar/model/bar_model.dart';
import 'package:harness_max_bar/model/types.dart';
import 'package:harness_max_bar/ui/agent/mic_closed.dart';
import 'package:harness_max_bar/ui/bar_frame.dart';
import 'package:harness_max_bar/ui/pages/agent_page.dart';
import 'package:harness_max_bar/ui/pet.dart';

import '../support/bar_test.dart';
import 'recording_model.dart';

/// The mockup's fixture on the agent page for [id]; [talk] as the mic stands, the recording [secs] old.
BarModel agentModel(String id, {TalkPhase talk = TalkPhase.off, int secs = 0, bool heard = false}) {
  final m = mockupModel()
    ..page = BarPage.agent
    ..selectedId = id
    ..talk = talk
    ..heard = heard;
  if (talk == TalkPhase.listening || talk == TalkPhase.sending) {
    m.talkStarted = kFixtureNow.subtract(Duration(seconds: secs));
    if (heard) m.levels.addAll([.2, .6, .9, .8]);
  }
  return m;
}

Future<void> _show(WidgetTester tester, BarModel model) async {
  await tester.runAsync(preloadPets);
  await pumpOnBar(tester, AgentPage(model: model));
  await settleImages(tester);
  // the band has risen (.35 s), a note has faded in (.3 s), and the Listening dot is at the top of its .8 s pulse
  await tester.pump(const Duration(milliseconds: 800));
}

void main() {
  setUpAll(loadBarFaces);

  group('looks as the mockup', () {
    testWidgets('listening, nothing said yet: docs-sweep resting', (tester) async {
      await _show(tester, agentModel('docs-sweep', talk: TalkPhase.listening, secs: 1));
      await expectLater(find.byType(BarFrame), matchesGoldenFile('goldens/agent_listening.png'));
    });

    testWidgets('talking to flaky-e2e, its summary over the band', (tester) async {
      await _show(tester, agentModel('flaky-e2e', talk: TalkPhase.listening, secs: 2, heard: true));
      await expectLater(find.byType(BarFrame), matchesGoldenFile('goldens/agent_talking.png'));
    });

    testWidgets('the mic closed: docs-sweep to read, "Tap to talk"', (tester) async {
      await _show(tester, agentModel('docs-sweep', talk: TalkPhase.closed));
      await expectLater(find.byType(BarFrame), matchesGoldenFile('goldens/agent_mic_closed.png'));
    });

    testWidgets('talking to auth-refactor at work', (tester) async {
      await _show(tester, agentModel('auth-refactor', talk: TalkPhase.listening, secs: 2, heard: true));
      await expectLater(find.byType(BarFrame), matchesGoldenFile('goldens/working_talking.png'));
    });

    testWidgets('auth-refactor at work, the mic off', (tester) async {
      await _show(tester, agentModel('auth-refactor'));
      await expectLater(find.byType(BarFrame), matchesGoldenFile('goldens/working.png'));
    });

    testWidgets('flaky-e2e done, the mic off', (tester) async {
      await _show(tester, agentModel('flaky-e2e'));
      await expectLater(find.byType(BarFrame), matchesGoldenFile('goldens/agent_reading.png'));
    });
  });

  group('touch', () {
    testWidgets('Back is a touch, then back', (tester) async {
      final m = RecordingModel(agentModel('flaky-e2e'));
      await _show(tester, m);
      await tester.tapAt(const Offset(30, 26));
      await tester.tapAt(const Offset(250, 48));
      expect(m.calls, ['touched', 'back', 'touched', 'back']);
    });

    testWidgets('a segment shows its agent, anywhere in its height', (tester) async {
      final m = RecordingModel(agentModel('flaky-e2e'));
      await _show(tester, m);
      await tester.tap(find.text('rate-limiter'));
      await tester.tapAt(const Offset(1470, 2));
      expect(m.calls, ['touched', 'tapSegment rate-limiter', 'touched', 'tapSegment docs-sweep']);
    });

    testWidgets('a tap on the page is the body: talk, or send what is said', (tester) async {
      final m = RecordingModel(agentModel('flaky-e2e', talk: TalkPhase.listening, secs: 2, heard: true));
      await _show(tester, m);
      await tester.tapAt(const Offset(700, 130));
      await tester.tapAt(const Offset(130, 200));
      await tester.tap(find.text('Tap to send'));
      expect(m.calls, ['touched', 'tapBody', 'touched', 'tapBody', 'touched', 'tapBody']);
    });

    testWidgets('X cancels, and so does a touch that lands a little left of it', (tester) async {
      final m = RecordingModel(agentModel('flaky-e2e', talk: TalkPhase.listening, secs: 2));
      await _show(tester, m);
      await tester.tapAt(const Offset(1428, 261));
      await tester.tapAt(const Offset(1390, 300));
      expect(m.calls, ['touched', 'cancelTalk', 'touched', 'cancelTalk']);
    });

    testWidgets('a swipe walks the ring: left is the next agent, right the one before', (tester) async {
      final m = RecordingModel(agentModel('flaky-e2e'));
      await _show(tester, m);
      await tester.dragFrom(const Offset(900, 160), const Offset(-150, 0));
      await tester.dragFrom(const Offset(700, 30), const Offset(150, 20));
      expect(m.calls, ['touched', 'swipeAgent 1', 'touched', 'swipeAgent -1']);
    });

    testWidgets('sending, there is no X: a tap there is the body', (tester) async {
      final m = RecordingModel(agentModel('flaky-e2e', talk: TalkPhase.sending, secs: 3, heard: true));
      await _show(tester, m);
      expect(find.text('Sending'), findsOneWidget);
      expect(find.text('Tap to send'), findsNothing);
      await tester.tapAt(const Offset(1428, 261));
      expect(m.calls, ['touched', 'tapBody']);
    });
  });

  group('words', () {
    testWidgets('done: its status, how long ago, its summary, "Tap to talk"', (tester) async {
      await _show(tester, agentModel('flaky-e2e'));
      expect(find.text('Done'), findsOneWidget);
      expect(find.text('2 min ago'), findsOneWidget);
      expect(find.textContaining('Found it: the checkout test'), findsOneWidget);
      expect(find.text('Tap to talk'), findsOneWidget);
      expect(find.text('Claude Code'), findsOneWidget);
    });

    testWidgets('nothing said: a resting phrase picked by its place in the ring', (tester) async {
      await _show(tester, agentModel('docs-sweep'));
      expect(find.text('Resting'), findsOneWidget);
      expect(find.text('1 h ago'), findsOneWidget);
      expect(find.text("What's next?"), findsOneWidget);
    });

    testWidgets('an agent the bar cannot record for says where to talk to it', (tester) async {
      final m = agentModel('flaky-e2e');
      m.selected!.caps = const Caps(voice: false);
      await _show(tester, m);
      expect(find.text('Talk to it in Orca'), findsOneWidget);
      expect(find.text('Tap to talk'), findsNothing);
    });

    testWidgets('at work: the spinner word, the activity, the last three steps, the turn clock', (tester) async {
      final m = agentModel('auth-refactor');
      final a = m.selected!;
      m.agents[0] = Agent(
          id: a.id,
          name: a.name,
          engine: a.engine,
          caps: a.caps,
          state: a.state,
          verb: a.verb,
          activity: a.activity,
          steps: [...a.steps, const TurnStep('Running tests', 'auth suite')],
          since: a.since,
          turnStarted: a.turnStarted);
      await _show(tester, m);
      expect(find.text('session.ts'), findsOneWidget);
      expect(find.text('Thinking'), findsNothing);
      for (final s in ['Reading', 'Editing', 'Running tests']) {
        expect(find.text(s), findsOneWidget, reason: s);
      }
      expect(find.text('4:12'), findsOneWidget);
    });

    testWidgets('at work, talking: the steps go, the clock stays', (tester) async {
      await _show(tester, agentModel('auth-refactor', talk: TalkPhase.listening, secs: 2, heard: true));
      expect(find.text('Reading'), findsNothing);
      expect(find.text('4:12'), findsOneWidget);
      expect(find.text('0:02'), findsOneWidget);
      expect(find.text('Claude Code'), findsNothing);
    });

    testWidgets('the clocks run', (tester) async {
      var now = kFixtureNow;
      final from = agentModel('auth-refactor', talk: TalkPhase.listening, secs: 2, heard: true);
      final m = BarModel(clock: () => now)
        ..page = from.page
        ..selectedId = from.selectedId
        ..talk = from.talk
        ..talkStarted = from.talkStarted
        ..heard = true;
      m.agents.addAll(from.agents);
      await _show(tester, m);
      now = now.add(const Duration(seconds: 61));
      await tester.pump(const Duration(milliseconds: 300));
      expect(find.text('5:13'), findsOneWidget);
      expect(find.text('1:03'), findsOneWidget);
    });

    testWidgets('listening: "Say it…" until speech is heard; after it, the quiet runs to the send', (tester) async {
      final m = agentModel('flaky-e2e', talk: TalkPhase.listening, secs: 1);
      await _show(tester, m);
      expect(find.text('Say it…'), findsOneWidget);
      expect(find.text('Listening'), findsOneWidget);
      m
        ..heard = true
        ..quiet = .5;
      await pumpOnBar(tester, AgentPage(model: m));
      expect(find.text('Say it…'), findsNothing);
      expect(find.text('Sending soon · tap to send now'), findsOneWidget);
    });

    testWidgets('the mic closed: the note shows, then goes after 2.2 s', (tester) async {
      await _show(tester, agentModel('docs-sweep', talk: TalkPhase.closed));
      expect(find.text(kMicClosed), findsOneWidget);
      expect(find.text('Tap to talk'), findsOneWidget);
      final note = find.ancestor(of: find.text(kMicClosed), matching: find.byType(Opacity)).first;
      expect(tester.widget<Opacity>(note).opacity, 1);
      await tester.pump(const Duration(milliseconds: 2200));
      await tester.pump(const Duration(milliseconds: 300));
      expect(tester.widget<Opacity>(note).opacity, 0);
    });

    testWidgets('the mic closed and the model\'s toast says so: the page does not say it twice', (tester) async {
      final m = agentModel('docs-sweep', talk: TalkPhase.closed)
        ..toast = Toast(kMicClosed, until: kFixtureNow.add(const Duration(seconds: 5)));
      await _show(tester, m);
      expect(find.text(kMicClosed), findsNothing);
    });
  });
}
