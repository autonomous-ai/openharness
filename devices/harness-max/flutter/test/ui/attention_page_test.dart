// Attention as the mockup draws it (goldens beside $S/v2-ref/attention-*.png) and what a tap on it does.
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_max_bar/dev/fixtures.dart';
import 'package:harness_max_bar/model/types.dart';
import 'package:harness_max_bar/ui/overlays/edge_light.dart';
import 'package:harness_max_bar/ui/overlays/toast_overlay.dart';
import 'package:harness_max_bar/ui/pages/attention_page.dart';
import 'package:harness_max_bar/ui/pet.dart';

import '../support/bar_test.dart';
import 'page_harness.dart';

/// The mockup's ring at the moment its reference shots were taken: the top run's right end at x 197.
const _shotAt = Duration(milliseconds: 216);

RecordingModel _attention(String agentId, AttnKind kind, {String app = 'orca'}) {
  final m = RecordingModel.mockup(app: app);
  m
    ..page = BarPage.attention
    ..attention = Attention(agentId: agentId, kind: kind, since: kFixtureNow);
  return m;
}

/// firmware-max asks to flash the bar, as the mockup's "firmware-max xin chạy lệnh".
RecordingModel _permission() {
  final m = _attention('firmware-max', AttnKind.ask, app: 'harness');
  final a = m.agentById('firmware-max')!
    ..state = AgentState.asking
    ..said = 'Wants to run: make flash PORT=usb';
  const prompt = 'Approve Bash command: make flash PORT=usb';
  m.asks[a.id] = Ask(
    agentId: a.id,
    requestId: 'req-fw',
    text: prompt,
    items: const [AskItem(key: 'run', q: prompt, options: ['Yes', 'No'])],
    permission: true,
    command: 'make flash PORT=usb',
    path: AskPath.plain,
    since: kFixtureNow,
  );
  return m;
}

/// docs-sweep's turn failed.
RecordingModel _failed() {
  final m = _attention('docs-sweep', AttnKind.failed);
  m.agentById('docs-sweep')!
    ..state = AgentState.failed
    ..said = 'The docs build stopped: 3 links point at pages that no longer exist.';
  return m;
}

Widget _glass(RecordingModel m) => Stack(fit: StackFit.expand, children: [
      AttentionPage(model: m),
      EdgeLight(model: m),
      ToastOverlay(model: m),
    ]);

Future<void> _show(WidgetTester tester, RecordingModel m) async {
  await pumpPage(tester, _glass(m));
  await tester.pump(_shotAt);
}

void main() {
  setUpAll(() async {
    await loadBarFaces();
    await preloadPets();
  });

  group('goldens', () {
    testWidgets('a Harness question: its options and Say it', (tester) async {
      await _show(tester, _attention('harness-cli', AttnKind.ask, app: 'harness'));
      await expectGlass(tester, 'goldens/attention_question.png');
    });

    testWidgets('a permission prompt: the command in mono, Allow and Deny', (tester) async {
      await _show(tester, _permission());
      await expectGlass(tester, 'goldens/attention_permission.png');
    });

    testWidgets('a question of another app: where to answer it', (tester) async {
      await _show(tester, _attention('landing-hero', AttnKind.ask));
      await expectGlass(tester, 'goldens/attention_outside_app.png');
    });

    testWidgets('a finished turn: its words in the recap ink, a green light', (tester) async {
      await _show(tester, _attention('flaky-e2e', AttnKind.done));
      await expectGlass(tester, 'goldens/attention_done.png');
    });

    testWidgets('a failed turn: a red light', (tester) async {
      await _show(tester, _failed());
      await expectGlass(tester, 'goldens/attention_failed.png');
    });
  });

  group('a question the bar answers', () {
    testWidgets('an option chooses it', (tester) async {
      final m = _attention('harness-cli', AttnKind.ask, app: 'harness');
      await _show(tester, m);
      await tester.tap(find.text('Keep 3'));
      expect(m.calls, ['choose 1']);
    });

    testWidgets('Say it opens the mic', (tester) async {
      final m = _attention('harness-cli', AttnKind.ask, app: 'harness');
      await _show(tester, m);
      await tester.tap(find.text('Say it'));
      expect(m.calls, ['sayIt']);
    });

    testWidgets('a finger just above a button still takes it', (tester) async {
      final m = _attention('harness-cli', AttnKind.ask, app: 'harness');
      await _show(tester, m);
      final top = tester.getRect(find.ancestor(of: find.text('Bump to 4'), matching: find.byType(KeyedSubtree)).first);
      await tester.tapAt(Offset(top.center.dx, top.top - 14));
      await tester.tapAt(Offset(top.left - 5, top.center.dy));
      expect(m.calls, ['choose 0', 'choose 0']);
    });

    testWidgets('a tap away from the buttons brings the agent up on the computer', (tester) async {
      final m = _attention('harness-cli', AttnKind.ask, app: 'harness');
      await _show(tester, m);
      await tester.tapAt(const Offset(150, 160)); // the pet
      await tester.tapAt(const Offset(1300, 290)); // the empty right
      expect(m.calls, ['away', 'away']);
    });

    testWidgets('no Say it for an agent without voice', (tester) async {
      final m = _attention('harness-cli', AttnKind.ask, app: 'harness');
      m.agentById('harness-cli')!.caps = const Caps(voice: false);
      await _show(tester, m);
      expect(find.text('Say it'), findsNothing);
      expect(find.text('Bump to 4'), findsOneWidget);
    });

    testWidgets('while the answer goes it says so and nothing can be pressed', (tester) async {
      final m = _attention('harness-cli', AttnKind.ask, app: 'harness');
      m.asks['harness-cli']!
        ..phase = AskPhase.sending
        ..choices = [1 << 1];
      await _show(tester, m);
      expect(find.text('Sending…'), findsOneWidget);
      await tester.tap(find.text('Keep 3'));
      await tester.tap(find.text('Say it'));
      expect(m.calls, isEmpty);
    });

    testWidgets('a sent answer shows the daemon\'s receipt', (tester) async {
      final m = _attention('harness-cli', AttnKind.ask, app: 'harness');
      m.asks['harness-cli']!
        ..phase = AskPhase.sent
        ..note = 'Taken by harness-cli';
      await _show(tester, m);
      expect(find.text('Sent'), findsOneWidget);
      expect(find.text('Taken by harness-cli'), findsOneWidget);
    });

    testWidgets('a failed answer says why in place of the buttons', (tester) async {
      final m = _attention('harness-cli', AttnKind.ask, app: 'harness');
      m.asks['harness-cli']!
        ..phase = AskPhase.failed
        ..note = 'The question moved on';
      await _show(tester, m);
      expect(find.text('The question moved on'), findsOneWidget);
      expect(find.text('Bump to 4'), findsNothing);
      expect(find.text('asks'), findsOneWidget);
    });

    testWidgets('a request of several questions shows the one on the card and where it is', (tester) async {
      final m = _attention('harness-cli', AttnKind.ask, app: 'harness');
      m.asks['harness-cli']!
        ..items = const [
          AskItem(key: 'a', q: 'Bump the protocol?', options: ['Bump', 'Keep']),
          AskItem(key: 'b', q: 'Ship it today?', options: ['Today', 'Monday']),
        ]
        ..step = 1;
      await _show(tester, m);
      expect(find.text('Ship it today?'), findsOneWidget);
      expect(find.text('2 / 2'), findsOneWidget);
      await tester.tap(find.text('Monday'));
      expect(m.calls, ['choose 1']);
    });
  });

  group('a permission prompt', () {
    testWidgets('Allow and Deny, never Say it', (tester) async {
      final m = _permission();
      await _show(tester, m);
      expect(find.text('wants to run'), findsOneWidget);
      expect(find.text('make flash PORT=usb'), findsOneWidget);
      expect(find.text('Say it'), findsNothing);
      await tester.tap(find.text('Allow'));
      await tester.tap(find.text('Deny'));
      expect(m.calls, ['allow', 'deny']);
    });

    testWidgets('without a command of its own, the words after the prompt\'s colon', (tester) async {
      final m = _permission();
      m.asks['firmware-max']!.command = '';
      await _show(tester, m);
      expect(find.text('make flash PORT=usb'), findsOneWidget);
    });
  });

  group('a question the bar cannot answer', () {
    testWidgets('says where to answer it, and a tap anywhere brings it up', (tester) async {
      final m = _attention('landing-hero', AttnKind.ask);
      await _show(tester, m);
      expect(find.text('Answer it in Orca'), findsOneWidget);
      expect(find.text('Gradient'), findsNothing);
      await tester.tap(find.text('Answer it in Orca'));
      await tester.tap(find.textContaining('Both hero versions'));
      expect(m.calls, ['away', 'away']);
    });
  });

  group('a finished or failed turn', () {
    testWidgets('done: its words, a tap brings it up', (tester) async {
      final m = _attention('flaky-e2e', AttnKind.done);
      await _show(tester, m);
      expect(find.text('is done'), findsOneWidget);
      expect(find.textContaining('Found it'), findsOneWidget);
      await tester.tapAt(const Offset(700, 160));
      expect(m.calls, ['away']);
    });

    testWidgets('failed: the word says so', (tester) async {
      await _show(tester, _failed());
      expect(find.text('failed'), findsOneWidget);
      expect(find.textContaining('docs build stopped'), findsOneWidget);
    });
  });

  testWidgets('nothing on the glass when Attention is down', (tester) async {
    final m = RecordingModel.mockup()..attention = null;
    await _show(tester, m);
    expect(find.descendant(of: find.byType(AttentionPage), matching: find.byType(Text)), findsNothing);
  });
}
