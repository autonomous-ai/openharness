import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/auth/auth_session.dart';
import 'package:harness_mobile/core/config.dart';
import 'package:harness_mobile/phone/tty_controls.dart';
import 'package:harness_mobile/phone/phone_search_results.dart';
import 'package:harness_mobile/phone/terminal_action_column.dart';
import 'package:harness_mobile/phone/terminal_title.dart';
import 'package:harness_mobile/phone/terminal_key_bar.dart';
import 'package:harness_mobile/phone/terminal_page.dart';
import 'package:harness_mobile/phone/voice_input_controller.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/terminal/terminal_session.dart';
import 'package:xterm/xterm.dart';

import 'voice_fakes.dart';

/// Scrolling folds the header away — and that must never reach the far machine.
///
/// The header used to shrink out of the page's column and hand its height to
/// the terminal, so every fold changed the row count: a resize of the agent's
/// shell, a keyframe back, and the whole TUI redrawn, on every change of scroll
/// direction. It slides over the terminal now, which keeps one height.
void main() {
  late AppNotifier notifier;
  late TerminalSession session;
  late VoiceInputController voice;
  late ValueNotifier<String> language;
  late List<Map<String, dynamic>> resizes;

  setUp(() {
    notifier = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
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

  testWidgets('folding the header leaves the terminal its size', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        home: TerminalPage(
          notifier: notifier,
          machineId: 'm',
          agentId: 'a',
          voice: voice,
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 100));
    final before = tester.getSize(find.byType(TerminalView));
    resizes.clear();
    // The title over the terminal's top rows, where a tap lands on it.
    expect(find.byType(TerminalTitle).hitTestable(), findsOneWidget);

    // Back into the scrollback, then forward again: the forward push is what
    // sends the header away.
    await tester.drag(find.byType(TerminalView), const Offset(0, 160));
    await tester.pump(const Duration(milliseconds: 50));
    await tester.drag(find.byType(TerminalView), const Offset(0, -80));
    // The slide's ticker starts on the frame after the push, then runs out.
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));

    // Folded: the header is no longer where a tap would land on it.
    expect(find.byType(TerminalTitle).hitTestable(), findsNothing);
    expect(tester.getSize(find.byType(TerminalView)), before);
    // The slide is over; a resize owed to it would be on its way by now.
    await tester.pump(const Duration(seconds: 1));
    expect(resizes, isEmpty);
  });

  testWidgets('the keyboard search raises leaves the terminal its size', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        home: TerminalPage(
          notifier: notifier,
          machineId: 'm',
          agentId: 'a',
          voice: voice,
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 100));
    resizes.clear();

    await tester.dragFrom(
      tester.getCenter(find.byType(TerminalPage).first) - const Offset(120, 0),
      const Offset(300, 0),
    );
    await tester.pump();
    // The search field's keyboard slides up, and the page shrinks above it.
    tester.view.viewInsets = const FakeViewPadding(bottom: 900);
    addTearDown(tester.view.resetViewInsets);
    await tester.pump();
    await tester.pump(const Duration(seconds: 1));

    // The terminal is faded behind the search screen: resizing the agent's shell
    // for a keyboard that is typing a query redraws its whole TUI for nothing,
    // and again when the search closes.
    expect(resizes, isEmpty);
  });

  testWidgets('the terminal under search holds still through open and close', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        home: TerminalPage(
          notifier: notifier,
          machineId: 'm',
          agentId: 'a',
          voice: voice,
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 100));
    final size = tester.getSize(find.byType(TerminalView));
    resizes.clear();
    // The terminal as it was — its height, no key bar, its floating column.
    void expectUntouched() {
      expect(tester.getSize(find.byType(TerminalView)), size);
      expect(find.byType(TerminalKeyBar), findsNothing);
      expect(find.byType(TerminalActionColumn), findsOneWidget);
    }

    await tester.dragFrom(
      tester.getCenter(find.byType(TerminalPage).first) - const Offset(120, 0),
      const Offset(300, 0),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    // Find opens on the recent agents; a tap on its field is what starts a
    // search and brings the keyboard.
    await tester.tap(
      find.descendant(
        of: find.byType(TtyField),
        matching: find.byType(TextField),
      ),
    );
    await tester.pump();
    addTearDown(tester.view.resetViewInsets);
    for (final inset in const [300.0, 600.0, 900.0]) {
      tester.view.viewInsets = FakeViewPadding(bottom: inset);
      await tester.pump(const Duration(milliseconds: 16));
      expectUntouched();
    }
    await tester.pump(const Duration(seconds: 1));
    expectUntouched();
    // The search itself still sits above its keyboard.
    expect(
      tester.getBottomLeft(find.byType(PhoneSearchResults)).dy,
      lessThanOrEqualTo(size.height),
    );

    // Closed the way iOS does it: the keyboard's view goes at once, but the
    // inset it reports falls over ~0.5s — past the end of search's fade. Every
    // frame, through the fade AND after it, shows the terminal search opened
    // over; releasing it with the fade let the falling inset raise its key bar.
    //
    // Find is flung shut to the left, the way it came in — the one close that
    // leaves with the keyboard still up. From the list: the prompt keeps a
    // sideways drag for moving its caret.
    await tester.flingFrom(
      tester.getCenter(find.byType(PhoneSearchResults)),
      const Offset(-300, 0),
      2000,
    );
    await tester.pump();
    for (var ms = 0; ms <= 700; ms += 16) {
      tester.view.viewInsets = FakeViewPadding(
        bottom: ms >= 500 ? 0 : 900 * (1 - ms / 500),
      );
      await tester.pump(const Duration(milliseconds: 16));
      expectUntouched();
    }
    await tester.pump(const Duration(seconds: 1));
    expect(find.byType(PhoneSearchResults), findsNothing);
    expect(find.byType(TtyField), findsNothing);
    expectUntouched();
    expect(resizes, isEmpty);
  });

  testWidgets('the first keyboard up resizes the terminal once, when it lands', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        home: TerminalPage(
          notifier: notifier,
          machineId: 'm',
          agentId: 'a',
          voice: voice,
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 100));
    resizes.clear();

    // The keyboard's slide, frame by frame — with REAL time between the frames,
    // as a phone has: the session sends a resize straight away once the last
    // one is 50ms of wall clock old, and fake time never gets it there.
    for (final inset in const [300.0, 600.0, 900.0]) {
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 60)),
      );
      tester.view.viewInsets = FakeViewPadding(bottom: inset);
      await tester.pump(const Duration(milliseconds: 16));
    }
    await tester.pump(const Duration(seconds: 1));

    // One SIGWINCH at the final height — not a first one at whatever height the
    // slide's opening frame happened to have.
    expect(resizes, hasLength(1));

    // Down again and settled inside the test, so no resize is left in flight
    // when the view is reset for the next one.
    tester.view.resetViewInsets();
    await tester.pump();
    await tester.pump(const Duration(seconds: 1));
    // The settle's end lays the terminal out on the frame above; its resize
    // coalesces for one more beat.
    await tester.pump(const Duration(milliseconds: 100));
  });
}
