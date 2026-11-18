import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_max_bar/dev/fixtures.dart';
import 'package:harness_max_bar/model/bar_model.dart';
import 'package:harness_max_bar/model/types.dart';
import 'package:harness_max_bar/ui/bar_frame.dart';
import 'package:harness_max_bar/ui/overview/open_agent.dart';
import 'package:harness_max_bar/ui/overview/touch.dart';
import 'package:harness_max_bar/ui/pet.dart';

import '../support/bar_test.dart';
import 'recording_model.dart';

/// The mockup's fixture with [id] open; [talk] as the mic stands, the recording [secs] old. A recording that listens or
/// sends is [id]'s own: the model opens it as a cell's tap does, which is how `talkingTo` is set.
BarModel agentModel(String id,
    {TalkPhase talk = TalkPhase.off, int secs = 0, bool heard = false, double quiet = 0}) {
  final m = mockupModel();
  if (talk == TalkPhase.listening || talk == TalkPhase.sending) {
    m.tapCell(id);
    m.talkStarted = kFixtureNow.subtract(Duration(seconds: secs));
    if (heard) m.levels.addAll([.2, .6, .9, .8]);
  } else {
    m
      ..page = BarPage.agent
      ..selectedId = id;
  }
  m
    ..talk = talk
    ..heard = heard
    ..quiet = quiet;
  return m;
}

/// A RecordingModel that keeps whose recording it is (RecordingModel copies the model's fields, not the recording's
/// agent, which the model alone sets).
class _Recording extends RecordingModel {
  _Recording(super.from) : _to = from.talkingTo;
  final String? _to;

  @override
  String? get talkingTo => _to;
}

/// [model]'s open agent (or [agent]) at the glass's left, in a SwipeArea as the row lays it.
Future<void> _show(WidgetTester tester, BarModel model, {Agent? agent}) async {
  await tester.runAsync(preloadPets);
  await pumpOnBar(
    tester,
    Align(
      alignment: Alignment.centerLeft,
      child: SizedBox(
        width: kOpenW,
        child: SwipeArea(onSwipe: (_) {}, child: OpenAgent(model: model, agent: agent ?? model.selected!)),
      ),
    ),
  );
  // the band has turned (.3 s), and the Listening dot is at the top of its .8 s pulse
  await tester.pump(const Duration(milliseconds: 800));
}

void main() {
  setUpAll(loadBarFaces);

  group('looks as the mockup', () {
    testWidgets('flaky-e2e listening, speech heard, 2 s in', (tester) async {
      await _show(tester, agentModel('flaky-e2e', talk: TalkPhase.listening, secs: 2, heard: true));
      await expectLater(find.byType(BarFrame), matchesGoldenFile('goldens/open_listening.png'));
    });

    testWidgets('docs-sweep with the mic closed', (tester) async {
      await _show(tester, agentModel('docs-sweep', talk: TalkPhase.closed));
      await expectLater(find.byType(BarFrame), matchesGoldenFile('goldens/open_mic_closed.png'));
    });

    testWidgets('auth-refactor at work, the mic off', (tester) async {
      await _show(tester, agentModel('auth-refactor'));
      await expectLater(find.byType(BarFrame), matchesGoldenFile('goldens/open_working.png'));
    });

    testWidgets('docs-sweep listening, nothing said yet', (tester) async {
      await _show(tester, agentModel('docs-sweep', talk: TalkPhase.listening, secs: 1));
      await expectLater(find.byType(BarFrame), matchesGoldenFile('goldens/open_say_it.png'));
    });
  });

  group('touch', () {
    testWidgets('X is a touch, then the agent closes, the button and the box around it', (tester) async {
      final m = _Recording(agentModel('flaky-e2e', talk: TalkPhase.listening, secs: 2, heard: true));
      await _show(tester, m);
      await tester.tap(find.byKey(const ValueKey('close')));
      // a touch just off the round button, left of it and under it
      await tester.tapAt(const Offset(kOpenW - 88, 80));
      expect(m.calls, ['touched', 'closeAgent', 'touched', 'closeAgent']);
    });

    testWidgets('the pet, the words and the band are the body: send now, or talk', (tester) async {
      final m = _Recording(agentModel('flaky-e2e', talk: TalkPhase.listening, secs: 2, heard: true));
      await _show(tester, m);
      await tester.tapAt(const Offset(120, 100));
      await tester.tap(find.textContaining('Found it: the checkout test'));
      await tester.tap(find.text('Tap to send'));
      await tester.tap(find.text('Listening'));
      expect(m.calls, ['touched', 'tapBody', 'touched', 'tapBody', 'touched', 'tapBody', 'touched', 'tapBody']);
    });

    testWidgets('the quiet band is the body too', (tester) async {
      final m = _Recording(agentModel('docs-sweep', talk: TalkPhase.closed));
      await _show(tester, m);
      await tester.tap(find.text('Mic closed · tap to talk'));
      expect(m.calls, ['touched', 'tapBody']);
    });
  });

  group('words', () {
    testWidgets('listening: "Listening", the clock, "Say it…" until speech, "Tap to send"', (tester) async {
      await _show(tester, agentModel('docs-sweep', talk: TalkPhase.listening, secs: 65));
      expect(find.text('Listening'), findsOneWidget);
      expect(find.text('1:05'), findsOneWidget);
      expect(find.text('Say it…'), findsOneWidget);
      expect(find.text('Tap to send'), findsOneWidget);
      expect(find.text('Tap to talk'), findsNothing);
    });

    testWidgets('speech heard: "Say it…" goes; "Tap to send" until the quiet runs', (tester) async {
      await _show(tester, agentModel('flaky-e2e', talk: TalkPhase.listening, secs: 2, heard: true));
      expect(find.text('Say it…'), findsNothing);
      expect(find.text('Tap to send'), findsOneWidget);
    });

    testWidgets('speech then quiet: "Sending soon · tap to send now"', (tester) async {
      await _show(tester, agentModel('flaky-e2e', talk: TalkPhase.listening, secs: 3, heard: true, quiet: .5));
      expect(find.text('Sending soon · tap to send now'), findsOneWidget);
      expect(find.text('Tap to send'), findsNothing);
    });

    testWidgets('sending: "Sending", nothing to tap for', (tester) async {
      await _show(tester, agentModel('flaky-e2e', talk: TalkPhase.sending, secs: 3, heard: true));
      expect(find.text('Sending'), findsOneWidget);
      expect(find.text('Listening'), findsNothing);
      expect(find.text('Tap to send'), findsNothing);
      expect(find.text('Sending soon · tap to send now'), findsNothing);
    });

    testWidgets('the mic closed: "Mic closed · tap to talk"', (tester) async {
      await _show(tester, agentModel('docs-sweep', talk: TalkPhase.closed));
      expect(find.text('Mic closed · tap to talk'), findsOneWidget);
      expect(find.text('Listening'), findsNothing);
    });

    testWidgets('the mic off: "Tap to talk"', (tester) async {
      await _show(tester, agentModel('flaky-e2e'));
      expect(find.text('Tap to talk'), findsOneWidget);
      expect(find.text('Listening'), findsNothing);
    });

    testWidgets('an agent the bar cannot record for says where to talk to it', (tester) async {
      final m = agentModel('flaky-e2e');
      m.selected!.caps = const Caps(voice: false);
      await _show(tester, m);
      expect(find.text('Talk to it in Orca'), findsOneWidget);
      expect(find.text('Tap to talk'), findsNothing);
    });

    testWidgets('with no app known, on the computer', (tester) async {
      final m = agentModel('flaky-e2e')..shownApp = '';
      m.selected!
        ..caps = const Caps(voice: false)
        ..host = '';
      await _show(tester, m);
      expect(find.text('Talk to it on the computer'), findsOneWidget);
    });

    testWidgets('the recording is another agent\'s: this one\'s band is quiet', (tester) async {
      final m = agentModel('flaky-e2e', talk: TalkPhase.listening, secs: 2, heard: true);
      await _show(tester, m, agent: m.agentById('auth-refactor'));
      expect(find.text('Tap to talk'), findsOneWidget);
      expect(find.text('Listening'), findsNothing);
      expect(find.text('Tap to send'), findsNothing);
      expect(find.byWidgetPredicate((w) => w is PetView && w.scene == 'listen'), findsNothing);
    });

    testWidgets('the name, the state chip and the task', (tester) async {
      await _show(tester, agentModel('auth-refactor'));
      expect(find.text('auth-refactor'), findsOneWidget);
      expect(find.text('Editing'), findsOneWidget);
      expect(find.text('session.ts'), findsOneWidget);
    });

    testWidgets('no task yet', (tester) async {
      await _show(tester, agentModel('docs-sweep'));
      expect(find.text('Resting'), findsOneWidget);
      expect(find.text('No task yet'), findsOneWidget);
    });
  });

  group('pet', () {
    testWidgets('puts its headphones on while the mic is its own', (tester) async {
      await _show(tester, agentModel('flaky-e2e', talk: TalkPhase.listening, secs: 2));
      expect(tester.widget<PetView>(find.byType(PetView)).scene, 'listen');
    });

    testWidgets('and while its words are sent', (tester) async {
      await _show(tester, agentModel('flaky-e2e', talk: TalkPhase.sending, secs: 2, heard: true));
      expect(tester.widget<PetView>(find.byType(PetView)).scene, 'listen');
    });

    testWidgets('plays its own scene with the mic closed', (tester) async {
      final m = agentModel('auth-refactor', talk: TalkPhase.closed);
      await _show(tester, m);
      expect(tester.widget<PetView>(find.byType(PetView)).scene, petSceneFor(m.selected!));
      expect(tester.widget<PetView>(find.byType(PetView)).scene, 'work');
    });
  });
}
