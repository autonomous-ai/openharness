import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/terminal/terminal_session.dart';
import 'package:harness/widgets/terminal_panel.dart';
import 'package:xterm/xterm.dart';

import 'swarm_state_test.dart' show createApp;

/// The band over a pane that lost its stream: what it says, that ⏎ takes the
/// stream back, and that a stray keystroke is answered rather than dropped.
void main() {
  late AppNotifier app;
  late TerminalSession session;
  late List<String> sent;
  late List<TerminalBinaryFrame> input;

  /// A second tile of the same app, adopted but (unless a test mounts it)
  /// not on screen: what a gesture on `session`'s tile does to the REST.
  late TerminalSession other;
  late List<String> sentOther;

  setUp(() {
    app = createApp();
    app.stateOf('m')!
      ..nodeOnline = true
      ..terminalCapabilityAvailable = true;
    sent = [];
    input = [];
    session =
        TerminalSession(
            machineId: 'm',
            agentId: 'a0',
            agentName: 'Session a0',
            engineId: 'codex',
            send: (type, _) async {
              sent.add(type);
              return true;
            },
            sendBinary: (frame) async {
              if (frame.kind == TerminalBinaryKind.input) input.add(frame);
              return true;
            },
          )
          ..status = TerminalSessionStatus.controlling
          ..streamId = 'stream-a0';
    app.adoptSessionForTest(session);
    sentOther = [];
    other =
        TerminalSession(
            machineId: 'm',
            agentId: 'a1',
            agentName: 'Session a1',
            engineId: 'codex',
            send: (type, _) async {
              sentOther.add(type);
              return true;
            },
            sendBinary: (_) async => true,
          )
          ..status = TerminalSessionStatus.controlling
          ..streamId = 'stream-a1';
    app.adoptSessionForTest(other);
    // The tile under test is the focused one; the other is just present.
    app.focusPane(app.paneOfAgent('m', 'a0')!.id);
  });

  // The app owns the adopted session and disposes it with itself. Done inside
  // the test body: a reopen arms the session's handshake timers, and the
  // binding checks for pending timers before tearDown runs.
  var finished = false;
  Future<void> finish(WidgetTester tester) async {
    // A tap into a live terminal arms xterm's double-tap recognizer; let it
    // lapse before the binding checks for stray timers.
    await tester.pump(const Duration(milliseconds: 400));
    await tester.pumpWidget(const SizedBox());
    app.dispose();
    finished = true;
  }

  tearDown(() {
    if (!finished) app.dispose();
    finished = false;
  });

  Future<void> pump(
    WidgetTester tester, {
    bool readOnly = false,
    TerminalNotice? notice,
    bool composerVisible = false,
    bool compactHeader = false,
    bool focused = true,
    bool visible = true,
    int focusRequest = 0,
    bool focusByUser = true,
    double width = 900,
    Widget? beside,
  }) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Column(
            children: [
              ?beside,
              Center(
                child: SizedBox(
                  width: width,
                  height: 400,
                  child: TerminalPanel(
                    notifier: app,
                    session: session,
                    focused: focused,
                    visible: visible,
                    focusRequest: focusRequest,
                    focusByUser: focusByUser,
                    readOnly: readOnly,
                    notice: notice,
                    composerVisible: composerVisible,
                    compactHeader: compactHeader,
                    onToggleComposer: () {},
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
    await tester.pump();
    await tester.pump();
  }

  /// Mounting measures the grid and sends a resize; only the opens matter here.
  List<String> opens() => sent.where((t) => t == 'terminal_open').toList();
  List<String> opensOther() =>
      sentOther.where((t) => t == 'terminal_open').toList();

  void takeOverOther() {
    other.handleFrame('terminal_closed', {
      'streamId': 'stream-a1',
      'code': 'TERMINAL_TAKEN_OVER',
      'reason': 'Another client connected to this terminal.',
    });
  }

  void takeOver() {
    session.handleFrame('terminal_closed', {
      'streamId': 'stream-a0',
      'code': 'TERMINAL_TAKEN_OVER',
      'reason': 'Another client connected to this terminal.',
    });
  }

  final banner = find.widgetWithText(FilledButton, 'Take control');
  final takenOverTitle = find.text('Another app took control of this terminal');

  /// The daemon named the taker; `machineId` is another machine in the fleet
  /// when [inFleet], so the app can show that machine's current name instead.
  void takeOverBy({bool inFleet = false}) {
    if (inFleet) {
      const studio = Machine(
        machineId: 'ab12ab12ab12ab12',
        authMode: MachineAuthMode.remote,
        name: 'Studio',
      );
      app.machineStates['ab12ab12ab12ab12'] = MachineState(studio);
    }
    session.handleFrame('terminal_closed', {
      'streamId': 'stream-a0',
      'code': 'TERMINAL_TAKEN_OVER',
      'reason': 'another client connected',
      'takenBy': {
        'kind': 'desktop',
        'name': 'Mac mini',
        'machineId': 'ab12ab12ab12ab12',
      },
    });
  }

  final hint = find.textContaining('press ⏎');

  testWidgets('the banner names who took control when the daemon said', (
    tester,
  ) async {
    await pump(tester);
    takeOverBy();
    await tester.pump();
    expect(find.text('Mac mini took control of this terminal'), findsOneWidget);
    expect(takenOverTitle, findsNothing);
    expect(banner, findsOneWidget);
    // The chip's tooltip says the same.
    expect(
      find.byWidgetPredicate(
        (w) => w is Tooltip && (w.message ?? '').contains('Mac mini controls'),
      ),
      findsOneWidget,
    );
    await finish(tester);
  });

  testWidgets('a taker in the fleet is named as the fleet names it', (
    tester,
  ) async {
    await pump(tester);
    takeOverBy(inFleet: true);
    await tester.pump();
    expect(find.text('Studio took control of this terminal'), findsOneWidget);
    expect(find.textContaining('Mac mini'), findsNothing);
    await finish(tester);
  });

  testWidgets('the banner appears over a taken-over pane and only there', (
    tester,
  ) async {
    // Swarm mode hands every pane a compact header; the band must not read
    // that as permission to drop the one line that says what to press.
    await pump(tester, compactHeader: true);
    expect(takenOverTitle, findsNothing);
    expect(banner, findsNothing);

    takeOver();
    await tester.pump();
    expect(session.status, TerminalSessionStatus.takenOver);
    expect(takenOverTitle, findsOneWidget);
    expect(banner, findsOneWidget);
    expect(hint, findsOneWidget);
    expect(
      find.descendant(of: banner, matching: find.byIcon(Icons.keyboard_return)),
      findsOneWidget,
      reason: 'the key is drawn on the button itself',
    );

    // A shared read-only view has nothing to take.
    await pump(tester, readOnly: true);
    expect(takenOverTitle, findsNothing);

    // A pane-level notice (offline, unlinked) already explains itself.
    await pump(
      tester,
      notice: (
        label: 'Offline',
        icon: Icons.cloud_off,
        detail: 'Test host is offline.',
        actionLabel: null,
        onAction: null,
      ),
    );
    expect(takenOverTitle, findsNothing);
    await finish(tester);
  });

  testWidgets('⏎ in the terminal takes control back, once', (tester) async {
    await pump(tester);
    takeOver();
    await tester.pump();
    expect(opens(), isEmpty);

    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    expect(opens(), ['terminal_open']);
    expect(input, isEmpty);
    expect(session.status, TerminalSessionStatus.opening);
    // The band stays through the handshake, saying so, without a button.
    expect(find.text('Taking control…'), findsOneWidget);
    expect(banner, findsNothing);

    // A held or repeated ⏎ does not send a second open.
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    expect(opens(), ['terminal_open']);

    session
      ..status = TerminalSessionStatus.controlling
      ..streamId = 'stream-a0-2'
      ..notifyListeners();
    await tester.pump();
    expect(find.text('Taking control…'), findsNothing);
    expect(takenOverTitle, findsNothing);
    await finish(tester);
  });

  testWidgets('a keystroke into a taken-over pane is answered, not dropped', (
    tester,
  ) async {
    await pump(tester);
    takeOver();
    await tester.pump();
    final nudge = find.text('Keys are ignored — press ⏎ to take control.');
    expect(nudge, findsNothing);

    await tester.sendKeyEvent(LogicalKeyboardKey.keyA);
    await tester.pump();
    expect(input, isEmpty);
    expect(opens(), isEmpty);
    expect(nudge, findsOneWidget);

    // The message steps back once the person stops typing.
    await tester.pump(const Duration(seconds: 3));
    expect(nudge, findsNothing);

    // ⌘ chords are the app's, not an attempt to type.
    await tester.sendKeyDownEvent(LogicalKeyboardKey.metaLeft);
    await tester.sendKeyEvent(LogicalKeyboardKey.keyC);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.metaLeft);
    await tester.pump();
    expect(nudge, findsNothing);
    expect(opens(), isEmpty);
    await finish(tester);
  });

  testWidgets('the button takes control too', (tester) async {
    await pump(tester);
    takeOver();
    await tester.pump();
    await tester.tap(banner);
    await tester.pump();
    expect(opens(), ['terminal_open']);
    expect(find.text('Taking control…'), findsOneWidget);
    await finish(tester);
  });

  testWidgets('a closed stream keeps the header chip alone, no band', (
    tester,
  ) async {
    // closed/error are usually a beat long — the app reattaches them itself —
    // so a band there would flash; they keep the old Reconnect chip and ⏎
    // goes to the read-only terminal as before.
    await pump(tester);
    session.handleFrame('terminal_closed', {
      'streamId': 'stream-a0',
      'reason': 'Session exited.',
    });
    await tester.pump();
    expect(session.status, TerminalSessionStatus.closed);
    expect(find.widgetWithText(TextButton, 'Reconnect'), findsOneWidget);
    expect(find.byType(FilledButton), findsNothing);
    expect(takenOverTitle, findsNothing);

    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    expect(opens(), isEmpty);
    await finish(tester);
  });

  testWidgets('a shared read-only view ignores ⏎', (tester) async {
    await pump(tester, readOnly: true);
    takeOver();
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    expect(opens(), isEmpty);
    await finish(tester);
  });

  testWidgets('with the composer showing, the terminal still takes ⏎', (
    tester,
  ) async {
    // The composer is disabled while the pane has no stream and refuses focus;
    // the keyboard has to land on the terminal for ⏎ to mean anything.
    await pump(tester, composerVisible: true);
    takeOver();
    await tester.pump();
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    expect(opens(), ['terminal_open']);
    await finish(tester);
  });

  testWidgets('losing the stream pulls an idle keyboard into the tile', (
    tester,
  ) async {
    // Nothing in the window held the keyboard (it had fallen back to the
    // route's scope). The band promises ⏎, so the focused tile takes it.
    await pump(tester);
    FocusManager.instance.primaryFocus?.unfocus();
    await tester.pump();
    expect(FocusManager.instance.primaryFocus, isA<FocusScopeNode>());

    takeOver();
    await tester.pump();
    await tester.pump();
    expect(hint, findsOneWidget);
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    expect(opens(), ['terminal_open']);
    await finish(tester);
  });

  testWidgets('losing the stream never steals the keyboard from a field', (
    tester,
  ) async {
    // Mid-word in the command dock, a rename box, anything: that stays put.
    final elsewhere = FocusNode();
    addTearDown(elsewhere.dispose);
    await pump(tester, beside: TextField(focusNode: elsewhere));
    elsewhere.requestFocus();
    await tester.pump();
    expect(elsewhere.hasFocus, isTrue);

    takeOver();
    await tester.pump();
    await tester.pump();
    expect(elsewhere.hasFocus, isTrue);
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    expect(opens(), isEmpty);
    await finish(tester);
  });

  // ── Coming back to the pane takes the stream back ─────────────────────────
  //
  // A person returning to a taken-over tile — by mouse, by key, by switching to
  // its tab, by bringing the window forward — gets it back without being asked.
  // The one thing these must never do is fire on the takeover itself: both
  // apps see that, and two panes retaking on each other's notifications would
  // trade the stream forever. The first test below pins that.

  testWidgets('losing the stream on its own never retakes it', (tester) async {
    // The focused, visible tile has the keyboard pulled into it on takeover;
    // that pull is the app's doing, not the person's, and must not retake —
    // neither this tile nor any other the same client took.
    await pump(tester);
    takeOver();
    takeOverOther();
    for (var i = 0; i < 4; i++) {
      await tester.pump();
    }
    expect(session.status, TerminalSessionStatus.takenOver);
    expect(other.status, TerminalSessionStatus.takenOver);
    expect(opens(), isEmpty);
    expect(opensOther(), isEmpty);
    await finish(tester);
  });

  // ── One gesture brings the whole app back ─────────────────────────────────

  testWidgets('a click into a pane that is fine retakes the others', (
    tester,
  ) async {
    await pump(tester);
    takeOverOther();
    await tester.pump();
    expect(takenOverTitle, findsNothing, reason: 'this tile is not taken');

    await tester.tapAt(tester.getCenter(find.byType(TerminalView)));
    await tester.pump();
    expect(opensOther(), ['terminal_open']);
    expect(opens(), isEmpty, reason: 'nothing to reopen on the tile clicked');
    await finish(tester);
  });

  testWidgets('⏎ on one taken tile retakes every taken tile', (tester) async {
    await pump(tester);
    takeOver();
    takeOverOther();
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    expect(opens(), ['terminal_open']);
    expect(opensOther(), ['terminal_open']);
    expect(find.text('Taking control…'), findsOneWidget);
    await finish(tester);
  });

  testWidgets('the window coming back leaves the others alone too', (
    tester,
  ) async {
    // Same rule as this tile's own: the window arriving is not a gesture on
    // any pane. A click in this one still brings every other back with it.
    await pump(tester);
    takeOverOther();
    await tester.pump();
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    await tester.pump();
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pump();
    expect(opensOther(), isEmpty);

    await tester.tap(find.byType(TerminalView));
    await tester.pump();
    expect(opensOther(), ['terminal_open']);
    await finish(tester);
  });

  testWidgets('a tile the daemon would refuse is left with its band', (
    tester,
  ) async {
    // The other tile's machine is offline: nothing can be reopened there.
    app.stateOf('m')!.nodeOnline = false;
    await pump(tester);
    takeOverOther();
    await tester.pump();
    await tester.tapAt(tester.getCenter(find.byType(TerminalView)));
    await tester.pump();
    expect(opensOther(), isEmpty);
    expect(other.status, TerminalSessionStatus.takenOver);
    await finish(tester);
  });

  testWidgets('a tile retaken by another tile\'s gesture keeps its band up', (
    tester,
  ) async {
    // Both tiles on screen; the other's band should say "Taking control…"
    // through the handshake, exactly as its own ⏎ would, not vanish early.
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Row(
            children: [
              Expanded(
                child: TerminalPanel(
                  notifier: app,
                  session: session,
                  focused: true,
                ),
              ),
              Expanded(
                child: TerminalPanel(
                  notifier: app,
                  session: other,
                  focused: false,
                ),
              ),
            ],
          ),
        ),
      ),
    );
    await tester.pump();
    takeOverOther();
    await tester.pump();
    expect(takenOverTitle, findsOneWidget);

    await tester.tapAt(tester.getCenter(find.byType(TerminalView).first));
    await tester.pump();
    expect(opensOther(), ['terminal_open']);
    expect(find.text('Taking control…'), findsOneWidget);
    expect(takenOverTitle, findsNothing);

    other
      ..status = TerminalSessionStatus.controlling
      ..streamId = 'stream-a1-2'
      ..notifyListeners();
    await tester.pump();
    expect(find.text('Taking control…'), findsNothing);
    await finish(tester);
  });

  testWidgets('a click into the pane takes control back, once', (tester) async {
    final elsewhere = FocusNode();
    addTearDown(elsewhere.dispose);
    await pump(tester, beside: TextField(focusNode: elsewhere));
    takeOver();
    await tester.pump();
    elsewhere.requestFocus();
    await tester.pump();

    await tester.tapAt(tester.getCenter(find.byType(TerminalView)));
    await tester.pump();
    expect(opens(), ['terminal_open']);
    expect(session.status, TerminalSessionStatus.opening);
    // A second press while the handshake is under way sends nothing more.
    await tester.tapAt(tester.getCenter(find.byType(TerminalView)));
    await tester.pump();
    expect(opens(), ['terminal_open']);
    await finish(tester);
  });

  testWidgets('a click on the band itself takes control back', (tester) async {
    await pump(tester);
    takeOver();
    await tester.pump();
    await tester.tap(takenOverTitle);
    await tester.pump();
    expect(opens(), ['terminal_open']);
    await finish(tester);
  });

  testWidgets('a click into a shared read-only view takes nothing', (
    tester,
  ) async {
    // A shared view's session is itself read only (`shared_harness_panel`):
    // neither its own band path nor the app-wide retake has anything there.
    final sentShared = <String>[];
    final shared =
        TerminalSession(
            machineId: 'm',
            agentId: 'a2',
            agentName: 'Shared a2',
            engineId: 'codex',
            readOnly: true,
            send: (type, _) async {
              sentShared.add(type);
              return true;
            },
            sendBinary: (_) async => true,
          )
          ..status = TerminalSessionStatus.controlling
          ..streamId = 'stream-a2';
    app.adoptSessionForTest(shared);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: TerminalPanel(
            notifier: app,
            session: shared,
            focused: true,
            readOnly: true,
          ),
        ),
      ),
    );
    await tester.pump();
    shared.handleFrame('terminal_closed', {
      'streamId': 'stream-a2',
      'code': 'TERMINAL_TAKEN_OVER',
    });
    await tester.pump();
    await tester.tapAt(tester.getCenter(find.byType(TerminalView)));
    await tester.pump();
    expect(sentShared.where((t) => t == 'terminal_open'), isEmpty);
    expect(takenOverTitle, findsNothing);
    await finish(tester);
  });

  testWidgets('a click into a noticed pane takes nothing', (tester) async {
    // Offline: the pane carries a notice instead of the band, and the daemon
    // would refuse an open, so the app-wide retake skips it as well.
    app.stateOf('m')!.nodeOnline = false;
    await pump(
      tester,
      notice: (
        label: 'Offline',
        icon: Icons.cloud_off,
        detail: 'Test host is offline.',
        actionLabel: null,
        onAction: null,
      ),
    );
    takeOver();
    await tester.pump();
    await tester.tapAt(tester.getCenter(find.byType(TerminalView)));
    await tester.pump();
    expect(opens(), isEmpty);
    expect(takenOverTitle, findsNothing);
    await finish(tester);
  });

  testWidgets('focusing the tile by key takes control back', (tester) async {
    // ⌘1–9 / ⌘] / an attention jump: the grid flips `focused` on this tile.
    await pump(tester, focused: false);
    takeOver();
    await tester.pump();
    expect(opens(), isEmpty);
    await pump(tester, focused: true);
    expect(opens(), ['terminal_open']);
    await finish(tester);
  });

  testWidgets('re-focusing an already focused tile takes control back', (
    tester,
  ) async {
    // ⌘1 on the tile that is already focused bumps `focusRequest` instead.
    await pump(tester);
    takeOver();
    await tester.pump();
    expect(opens(), isEmpty);
    await pump(tester, focusRequest: 1);
    expect(opens(), ['terminal_open']);
    await finish(tester);
  });

  testWidgets(
    'a tile shown again takes control back only if it is the focused one',
    (tester) async {
      await pump(tester, visible: false);
      takeOver();
      await tester.pump();
      expect(opens(), isEmpty);
      await pump(tester, visible: true);
      expect(opens(), ['terminal_open']);
      await finish(tester);
    },
  );

  testWidgets('a focus from the device takes nothing back', (tester) async {
    // The dial turning onto this tile, or a question shown there for it, bumps
    // `focusRequest` exactly as ⌘1 does — with `focusByUser` false. The
    // keyboard still lands here; the stream stays with whoever holds it, and
    // so does every other tile's (owner, 2026-09-22: a question re-shown on
    // the dial took the whole desk back, 1.5s round, until the cable came out).
    await pump(tester);
    takeOver();
    takeOverOther();
    await tester.pump();
    await pump(tester, focusRequest: 1, focusByUser: false);
    expect(opens(), isEmpty);
    expect(opensOther(), isEmpty);

    // Flipping `focused` on from the device is the same non-event.
    await pump(tester, focused: false, focusRequest: 1, focusByUser: false);
    await pump(tester, focused: true, focusRequest: 1, focusByUser: false);
    expect(opens(), isEmpty);

    // A person's ⌘1 after it takes back as ever.
    await pump(tester, focusRequest: 2);
    expect(opens(), ['terminal_open']);
    expect(opensOther(), ['terminal_open']);
    await finish(tester);
  });

  testWidgets('the keyboard still lands on a tile the device focused', (
    tester,
  ) async {
    // Focus-only is not band-only: the band's ⏎ is live at once, and pressing
    // it is the person taking back.
    await pump(tester);
    takeOver();
    await tester.pump();
    await pump(tester, focusRequest: 1, focusByUser: false);
    expect(opens(), isEmpty);
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    expect(opens(), ['terminal_open']);
    await finish(tester);
  });

  testWidgets('a tab the device switched to is nobody arriving', (
    tester,
  ) async {
    await pump(tester, visible: false);
    takeOver();
    await tester.pump();
    await pump(tester, visible: true, focusByUser: false);
    expect(opens(), isEmpty);
    await finish(tester);
  });

  testWidgets('a tile shown again unfocused stays as it is', (tester) async {
    await pump(tester, visible: false, focused: false);
    takeOver();
    await tester.pump();
    await pump(tester, visible: true, focused: false);
    expect(opens(), isEmpty);
    await finish(tester);
  });

  testWidgets('the window coming forward takes nothing back', (tester) async {
    // It used to: the focused tile retook on every `inactive → resumed`. The
    // window comes forward for things nobody did to a pane — ⌘-Tab, a
    // notification, a screen waking — and each one pulled the terminal off the
    // phone the person was typing into (owner, 2026-09-22). The band stays;
    // ⏎ or a click takes back.
    await pump(tester);
    takeOver();
    await tester.pump();
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    await tester.pump();
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pump();
    expect(opens(), isEmpty);
    expect(hint, findsOneWidget, reason: 'the band is still offering ⏎');

    // And the gesture the band promises still works.
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    expect(opens(), ['terminal_open']);
    await finish(tester);
  });

  testWidgets('a narrow tile stacks the button under the title', (
    tester,
  ) async {
    await pump(tester, width: 240);
    takeOver();
    await tester.pump();
    expect(takenOverTitle, findsOneWidget);
    expect(banner, findsOneWidget);
    expect(hint, findsOneWidget, reason: 'the hint stays, on one line');
    expect(tester.takeException(), isNull);
    final title = tester.getRect(takenOverTitle);
    final button = tester.getRect(banner);
    expect(button.top, greaterThanOrEqualTo(title.bottom));
    await finish(tester);
  });
}
