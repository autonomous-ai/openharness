import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/auth/auth_session.dart';
import 'package:harness_mobile/core/config.dart';
import 'package:harness_mobile/measurement/product_measurement.dart';
import 'package:harness_mobile/phone/machines_tab.dart';
import 'package:harness_mobile/phone/terminal_page.dart';
import 'package:harness_mobile/phone/terminal_search.dart';
import 'package:harness_mobile/phone/voice_input_controller.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/terminal/terminal_session.dart';
import 'package:xterm/xterm.dart';

import 'voice_fakes.dart';

/// Focus is Snapchat's camera: a swipe right on the terminal pulls Find in from
/// the left edge, a tap on the agent's name opens it too, and a swipe left
/// opens Computers. A new harness is Find's `New Harness` now.
void main() {
  late AppNotifier notifier;
  late TerminalSession session;
  late VoiceInputController voice;
  late ValueNotifier<String> language;
  late List<Map<String, dynamic>> resizes;
  late _Openings usage;

  setUp(() {
    usage = _Openings();
    notifier = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
      productMeasurement: usage,
    );
    resizes = [];
    session = TerminalSession(
      machineId: 'm',
      agentId: 'a',
      agentName: 'Agent',
      engineId: 'claude',
      send: (type, payload) async {
        if (type == 'terminal_resize') resizes.add(payload);
        return true;
      },
      sendBinary: (_) async => true,
    );
    session.status = TerminalSessionStatus.controlling;
    session.streamId = 's';
    for (var line = 0; line < 400; line++) {
      session.terminal.write('output line $line\r\n');
    }
    notifier.adoptSessionForTest(session);
    language = ValueNotifier('en');
    voice = VoiceInputController(
      transcriber: FakeTranscriber().call,
      recorder: FakeVoiceRecorder(),
      language: language,
    );
  });

  tearDown(() {
    voice.dispose();
    language.dispose();
    // Disposes the session too: it was adopted as a pane.
    notifier.dispose();
  });

  Future<List<Route<dynamic>>> pumpFocus(WidgetTester tester) async {
    final pushed = <Route<dynamic>>[];
    await tester.pumpWidget(
      MaterialApp(
        navigatorObservers: [_Pushes(pushed)],
        home: TerminalPage(
          notifier: notifier,
          machineId: 'm',
          agentId: 'a',
          voice: voice,
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 100));
    pushed.clear();
    return pushed;
  }

  testWidgets('a swipe right on the terminal pulls Find in', (tester) async {
    await pumpFocus(tester);
    expect(find.byType(TerminalSearchOverlay), findsNothing);

    await tester.drag(find.byType(TerminalView), const Offset(400, 0));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    expect(find.byType(TerminalSearchOverlay), findsOneWidget);
    expect(usage.opened, [(PhoneScreen.find, ScreenOpening.swipe)]);
  });

  testWidgets('a short swipe right lets Find go back', (tester) async {
    await pumpFocus(tester);

    await tester.timedDrag(
      find.byType(TerminalView),
      const Offset(40, 0),
      const Duration(milliseconds: 800),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    expect(find.byType(TerminalSearchOverlay), findsNothing);
    expect(usage.opened, isEmpty, reason: 'Find went back: nothing opened');
  });

  testWidgets('a tap on the agent\'s name opens Find', (tester) async {
    await pumpFocus(tester);

    await tester.dragFrom(
      tester.getCenter(find.byType(TerminalPage).first) - const Offset(120, 0),
      const Offset(300, 0),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    expect(find.byType(TerminalSearchOverlay), findsOneWidget);
  });

  testWidgets('a swipe left on Find sends it back', (tester) async {
    await pumpFocus(tester);
    await tester.dragFrom(
      tester.getCenter(find.byType(TerminalPage).first) - const Offset(120, 0),
      const Offset(300, 0),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    await tester.fling(
      find.byType(TerminalSearchOverlay),
      const Offset(-300, 0),
      1500,
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    expect(find.byType(TerminalSearchOverlay), findsNothing);
  });

  testWidgets('a swipe left on the terminal opens Computers', (tester) async {
    final pushed = await pumpFocus(tester);

    await tester.drag(find.byType(TerminalView), const Offset(-200, 0));

    expect(pushed, hasLength(1));
    expect(usage.opened, [(PhoneScreen.computers, ScreenOpening.swipe)]);
    expect(find.byType(TerminalSearchOverlay), findsNothing);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.byType(MachinesTab), findsOneWidget);
  });

  group('VoiceOver', () {
    // VoiceOver keeps one-finger swipes for itself, and xterm draws no semantics: the terminal
    // node is the only way it reaches the agent's words, Find and Computers.
    SemanticsNode terminalNode(WidgetTester tester) =>
        tester.getSemantics(find.bySemanticsLabel(RegExp(r', terminal$')));

    testWidgets('reads the agent\'s name and its last lines', (tester) async {
      final handle = tester.ensureSemantics();
      await pumpFocus(tester);
      final node = terminalNode(tester);
      expect(node.label, 'a, terminal');
      expect(node.value, endsWith('output line 399'));
      expect(node.value.split('\n'), hasLength(6));
      handle.dispose();
    });

    testWidgets('Find is an action, and it opens Find', (tester) async {
      final handle = tester.ensureSemantics();
      await pumpFocus(tester);
      final node = terminalNode(tester);
      final find_ = node.getSemanticsData().customSemanticsActionIds!.map(
        CustomSemanticsAction.getAction,
      );
      expect(find_.map((a) => a!.label), containsAll(['Find', 'Computers']));
      node.owner!.performAction(
        node.id,
        SemanticsAction.customAction,
        CustomSemanticsAction.getIdentifier(
          const CustomSemanticsAction(label: 'Find'),
        ),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      expect(find.byType(TerminalSearchOverlay), findsOneWidget);
      expect(usage.opened, isEmpty, reason: 'only a swipe is counted');
      handle.dispose();
    });

    testWidgets('Computers is an action, and it opens Computers', (
      tester,
    ) async {
      final handle = tester.ensureSemantics();
      final pushed = await pumpFocus(tester);
      final node = terminalNode(tester);
      node.owner!.performAction(
        node.id,
        SemanticsAction.customAction,
        CustomSemanticsAction.getIdentifier(
          const CustomSemanticsAction(label: 'Computers'),
        ),
      );
      expect(pushed, hasLength(1));
      expect(usage.opened, isEmpty, reason: 'only a swipe is counted');
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      expect(find.byType(MachinesTab), findsOneWidget);
      handle.dispose();
    });
  });
}

class _Pushes extends NavigatorObserver {
  _Pushes(this.pushed);

  final List<Route<dynamic>> pushed;

  @override
  void didPush(Route<dynamic> route, Route<dynamic>? previousRoute) =>
      pushed.add(route);
}

/// Which side page opened and how, recorded in place of being counted.
class _Openings extends ProductMeasurement {
  _Openings()
    : super(surface: 'phone', automatic: false, sendSetup: (_) async => {});

  final opened = <(PhoneScreen, ScreenOpening)>[];

  @override
  void screenOpened(PhoneScreen screen, ScreenOpening how) =>
      opened.add((screen, how));
}
