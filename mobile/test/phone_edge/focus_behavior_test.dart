import 'dart:async';
import 'dart:convert';

import 'package:file_selector/file_selector.dart' show XFile;
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/demo/sample_mode.dart';
import 'package:harness_mobile/phone/machines_tab.dart';
import 'package:harness_mobile/phone/phone_search_catalog.dart'
    show phoneAgentId;
import 'package:harness_mobile/phone/phone_shell_scope.dart';
import 'package:harness_mobile/phone/terminal_file_send.dart';
import 'package:harness_mobile/phone/terminal_find_bar.dart';
import 'package:harness_mobile/phone/terminal_page.dart';
import 'package:harness_mobile/widgets/terminal_panel.dart';
import 'package:harness_mobile/phone/terminal_search.dart';
import 'package:harness_mobile/phone/settings_page.dart';
import 'package:harness_mobile/phone/voice_input_controller.dart';
import 'package:harness_mobile/phone/voice_mic_button.dart';
import 'package:harness_mobile/phone/voice_mic_face.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/state/pending_question.dart';
import 'package:harness_mobile/terminal/terminal_binary.dart';
import 'package:harness_mobile/terminal/terminal_font_store.dart';
import 'package:harness_mobile/terminal/terminal_session.dart';
import 'package:harness_mobile/ws/ws_conn.dart';
import 'package:xterm/xterm.dart';

import '../voice_fakes.dart';
import 'edge_fixture.dart';

/// Focus as somebody uses it: a keyboard raised mid-take, a machine that goes away under the
/// agent on screen, taps that come twice, the menu's every row, a question answered by key, by
/// line and by voice.
void main() {
  setUp(() {
    // Whether the keyboard is up is kept once for the whole screen, not per page — so it outlives
    // a test that raised one. A pager clears it as it opens (`AgentSwipeHost`); so does each test.
    resetKeyboardSession();
    // The sheet's own haptics and the clipboard are platform calls a test has no platform for.
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, (call) async {
          if (call.method == 'Clipboard.getData') return _clipboard;
          // ⚠️ Answered as well as `getData`, because the menu's Paste asks this
          // FIRST — it is how iOS is spared a second "Allow Paste" prompt (see
          // `phone/terminal_paste.dart`). Unanswered it reads as false, and the
          // paste walked straight past the text to look for an image.
          if (call.method == 'Clipboard.hasStrings') {
            final text = _clipboard?['text'];
            // ⚠️ Typed `<String, dynamic>`, not left to inference. Flutter reads
            // this reply as `Map<String, dynamic>?`, and a `Map<String, bool>`
            // fails that cast with a TypeError — which, thrown inside an
            // unawaited paste, is swallowed whole: no paste, no message, no
            // failure, just a Paste row that silently does nothing.
            return <String, dynamic>{
              'value': text is String && text.isNotEmpty,
            };
          }
          return null;
        });
    // ⚠️ **Answered too, or Paste never finishes.** With no text on the
    // clipboard the paste goes looking for an IMAGE, over this channel — and an
    // unmocked channel in a widget test never replies at all. The await simply
    // hangs: no paste, no message, no error, and a test that reads as "the row
    // did nothing" when the row is in fact still waiting. Null is "no image".
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
          const MethodChannel('harness/clipboard_image'),
          (call) async => null,
        );
  });

  tearDown(() {
    _clipboard = null;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, null);
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
          const MethodChannel('harness/clipboard_image'),
          null,
        );
  });

  testWidgets('a keyboard raised while the mic records puts the take away', (
    tester,
  ) async {
    final focus = await _Focus.open(tester);

    await tester.tap(find.byType(VoiceMicCore));
    await frames(tester);
    expect(focus.voice.status, VoiceInputStatus.listening);

    // The keyboard comes up while the take is still recording.
    raiseKeyboard(tester);
    await frames(tester);

    expect(focus.voice.status, VoiceInputStatus.idle);
    expect(focus.recorder.cancels, 1, reason: 'the microphone is let go');
    expect(
      find.byType(VoiceMicButton),
      findsNothing,
      reason: 'the mic hides under the key bar rather than floating over it',
    );
    expect(find.byKey(const ValueKey('terminal-key-esc')), findsOneWidget);

    // And the ▾ key puts the keyboard away again, bringing the mic back.
    await tester.tap(find.byKey(const ValueKey('terminal-key-Hide keyboard')));
    lowerKeyboard(tester);
    await frames(tester);
    expect(find.byType(VoiceMicButton), findsOneWidget);
    await focus.close();
  });

  testWidgets('a keyboard asked for again while ⌄ still slides it down is '
      "the page's", (tester) async {
    final focus = await _Focus.open(tester);
    bool focused() =>
        tester.widget<TerminalPanel>(find.byType(TerminalPanel)).focused;

    await focus.tapPrompt();
    raiseKeyboard(tester);
    await frames(tester);
    expect(focused(), isTrue);

    await tester.tap(find.byKey(const ValueKey('terminal-key-Hide keyboard')));
    // Halfway down when the prompt is tapped again: the inset turns back without reaching zero.
    tester.view.viewInsets = const FakeViewPadding(bottom: 300);
    await tester.pump(const Duration(milliseconds: 16));
    await focus.tapPrompt();
    raiseKeyboard(tester);
    await frames(tester);

    expect(focused(), isTrue, reason: 'the keyboard up is read as up');
    await focus.close();
  });

  testWidgets('the machine goes offline under the agent on screen, and back', (
    tester,
  ) async {
    final focus = await _Focus.open(tester);
    expect(_micLive(tester), isTrue);

    await focus.app.handleMachineEventForTest('m', {
      'type': 'node_status',
      'payload': {'online': false},
    });
    await frames(tester);

    // The page stays on the agent: the name, the terminal it had — and a mic that cannot send.
    expect(tester.takeException(), isNull);
    expect(find.text('a'), findsOneWidget);
    expect(find.byType(TerminalView), findsOneWidget);
    expect(focus.session.acceptsInput, isFalse);
    expect(_micLive(tester), isFalse);

    // A tap on the dead terminal asks for it back rather than raising a keyboard over nothing.
    await focus.tapPrompt();
    await frames(tester);

    await focus.app.handleMachineEventForTest('m', {
      'type': 'node_status',
      'payload': {'online': true},
    });
    await frames(tester);
    expect(tester.takeException(), isNull);
    await focus.close();
  });

  testWidgets(
    'a tap on a stream that died reopens it rather than raising a keyboard over nothing',
    (tester) async {
      final focus = await _Focus.open(tester);
      focus.fill();
      await frames(tester);
      await focus.session.handleFrame('terminal_closed', {
        'streamId': focus.session.streamId,
        'code': 'TERMINAL_CLOSED',
        'reason': 'the daemon restarted',
      });
      await frames(tester);
      expect(focus.session.status, TerminalSessionStatus.closed);
      final opensBefore = focus.opens;

      await focus.tapPrompt();
      await frames(tester);

      // Before: the keyboard came up, its keys dimmed, and every letter typed went nowhere.
      expect(
        find.byKey(const ValueKey('terminal-key-esc')),
        findsNothing,
        reason: 'no keyboard over a stream that cannot take a keystroke',
      );
      expect(focus.opens, greaterThan(opensBefore), reason: 'reopened');
      await focus.close();
    },
  );

  testWidgets(
    'the socket drops and redials: the page waits rather than leaving',
    (tester) async {
      final focus = await _Focus.open(tester);
      focus.app.connectionStatusForTest('m', ConnectionStatus.reconnecting);
      await frames(tester);
      expect(find.byType(TerminalPage), findsOneWidget);
      focus.app.connectionStatusForTest('m', ConnectionStatus.connected);
      await frames(tester);
      expect(find.byType(TerminalPage), findsOneWidget);
      await focus.close();
    },
  );

  testWidgets('a double tap on the title opens one menu, not two', (
    tester,
  ) async {
    final focus = await _Focus.open(tester);
    final routes = focus.pushed.length;

    await tester.tap(find.byKey(const ValueKey('terminal-title')));
    await tester.pump(const Duration(milliseconds: 60));
    await tester.tap(
      find.byKey(const ValueKey('terminal-title')),
      warnIfMissed: false,
    );
    await frames(tester);

    expect(
      focus.pushed.length - routes,
      lessThanOrEqualTo(1),
      reason: 'the second tap lands on the open menu, not on a second one',
    );
    await focus.close();
  });

  testWidgets('back and forth between Focus, Find and Computers, quickly', (
    tester,
  ) async {
    final focus = await _Focus.open(tester);
    final centre = tester.getCenter(find.byType(TerminalPage));
    for (var round = 0; round < 3; round++) {
      // Right: Find.
      await tester.dragFrom(
        centre - const Offset(120, 0),
        const Offset(300, 0),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.byType(TerminalSearchOverlay), findsOneWidget);
      // Left on Find: back to the terminal, before the open has even finished.
      await tester.fling(
        find.byType(TerminalSearchOverlay),
        const Offset(-300, 0),
        1500,
      );
      await frames(tester);
      expect(find.byType(TerminalSearchOverlay), findsNothing);
      // Left on the terminal: Computers. A new harness is Find's `New Harness` now.
      await tester.dragFrom(
        centre + const Offset(120, 0),
        const Offset(-300, 0),
      );
      await frames(tester);
      expect(find.byType(MachinesTab), findsOneWidget);
      // Right on Computers: back.
      await tester.dragFrom(
        tester.getCenter(find.byType(MachinesTab)),
        const Offset(300, 0),
      );
      await frames(tester, count: 6);
      expect(find.byType(MachinesTab), findsNothing);
    }
    expect(tester.takeException(), isNull);
    expect(find.byType(TerminalView), findsOneWidget);
    await focus.close();
  });

  group('the title', () {
    testWidgets('held, with no other harness: says so above the mic', (
      tester,
    ) async {
      final focus = await _Focus.open(tester);
      await tester.longPress(find.byKey(const ValueKey('terminal-title')));
      await tester.pump();
      expect(find.text('no other harness yet'), findsOneWidget);
      await tester.pump(const Duration(seconds: 3));
      expect(find.text('no other harness yet'), findsNothing);
      await focus.close();
    });

    testWidgets('held: back to the harness used before this one', (
      tester,
    ) async {
      final focus = await _Focus.open(
        tester,
        agents: [edgeAgent('a'), edgeAgent('b'), edgeAgent('c')],
      );
      focus.app.searchHistory.remember(phoneAgentId('m', 'c'));
      await tester.longPress(find.byKey(const ValueKey('terminal-title')));
      await tester.pump();
      expect(focus.opened, [('m', 'c')]);

      // With no visits on this phone, the account's last-used order decides.
      final other = await _Focus.open(
        tester,
        agents: [edgeAgent('a'), edgeAgent('b', minutesAgo: 1)],
      );
      await tester.longPress(find.byKey(const ValueKey('terminal-title')));
      await tester.pump();
      expect(other.opened, [('m', 'b')]);
      await other.close();
    });

    testWidgets(
      'another harness starts asking while this one is on screen: the title says so',
      (tester) async {
        final focus = await _Focus.open(
          tester,
          agents: [
            edgeAgent('a'),
            edgeAgent('b', name: 'api-fix'),
            edgeAgent('c', name: 'docs'),
          ],
        );
        expect(find.textContaining('asking'), findsNothing);

        await focus.question('b');
        await frames(tester);
        expect(find.text('api-fix asking'), findsOneWidget);

        // Two asking are counted, not named.
        await focus.question('c');
        await frames(tester);
        expect(find.text('2 asking'), findsOneWidget);

        // Answered elsewhere: the word goes.
        await focus.answered('b');
        await focus.answered('c');
        await frames(tester);
        expect(find.textContaining('asking'), findsNothing);
        await focus.close();
      },
    );

    testWidgets('another harness asking: its name opens Find', (tester) async {
      final focus = await _Focus.open(
        tester,
        agents: [
          edgeAgent('a'),
          edgeAgent('b', name: 'api-fix'),
        ],
      );
      await focus.question('b');
      await frames(tester);
      await tester.tap(find.text('api-fix asking'));
      await frames(tester);
      expect(find.byType(TerminalSearchOverlay), findsOneWidget);
      await focus.close();
    });
  });

  // The desktop's ⌘F: the phone could not search what a harness had said at all — a long build's
  // one error line was found by scrolling and reading.
  group('find in terminal', () {
    Finder bar() => find.byKey(const ValueKey('terminal-find-bar'));
    Finder field() =>
        find.descendant(of: bar(), matching: find.byType(TextField));
    String status(WidgetTester tester) =>
        (tester.widget<Text>(
                  find.descendant(
                    of: find.byKey(const ValueKey('terminal-find-status')),
                    matching: find.byType(Text),
                  ),
                ).data ??
                '')
            .trim();

    /// The page, its terminal holding [lines], and Find opened from the `⋯` menu.
    Future<_Focus> openFind(
      WidgetTester tester, {
      String lines = 'row 1 marker\r\nrow 2\r\nrow 3 marker\r\n',
    }) async {
      final focus = await _Focus.open(tester);
      focus.session.terminal.write(lines);
      await tester.tap(find.byKey(const ValueKey('terminal-title')));
      await frames(tester);
      await tester.tap(find.text('Find in terminal'));
      await frames(tester);
      return focus;
    }

    Future<void> search(WidgetTester tester, String query) async {
      await tester.enterText(field(), query);
      await frames(tester);
    }

    testWidgets('opens from the menu with its field focused, counts and steps, '
        'and nothing typed reaches the shell', (tester) async {
      final focus = await openFind(tester);

      expect(bar(), findsOneWidget);
      expect(
        tester.binding.focusManager.primaryFocus?.context
            ?.findAncestorWidgetOfExactType<TextField>(),
        isNotNull,
        reason: 'the field has the keyboard',
      );
      await search(tester, 'marker');
      expect(status(tester), '1/2');

      await tester.tap(find.byKey(const ValueKey('terminal-find-next')));
      await frames(tester);
      expect(status(tester), '2/2');
      await tester.tap(find.byKey(const ValueKey('terminal-find-previous')));
      await frames(tester);
      expect(status(tester), '1/2');

      expect(focus.typed, isEmpty, reason: 'the query is the bar’s');
      await focus.close();
    });

    testWidgets('nothing found reads 0/0, and ↑ ↓ take no tap', (tester) async {
      final focus = await openFind(tester);
      await search(tester, 'needle');

      expect(status(tester), '0/0');
      final next = tester.widget<IconButton>(
        find.byKey(const ValueKey('terminal-find-next')),
      );
      expect(next.onPressed, isNull);
      await focus.close();
    });

    // ⚠️ Every keyboard raised or lowered ends in a keyframe that replaces the terminal — Find's
    // own field's keyboard among them. Read as the terminal's, that keyboard handed the input
    // connection back to the panel, and the rest of the query went to the shell.
    testWidgets('a keyframe while typing keeps the search, and the query out of '
        'the shell', (tester) async {
      final focus = await openFind(tester);
      await search(tester, 'mar');
      // The field's keyboard, up — the one the terminal must not take for its own.
      raiseKeyboard(tester);
      await frames(tester);
      // What the machine sends after the resize the field's keyboard caused: a new screen.
      await focus.session.handleBinary(
        TerminalBinaryFrame(
          kind: TerminalBinaryKind.keyframe,
          streamId: focus.session.streamId!,
          seq: 1000,
          bytes: Uint8List.fromList(
            utf8.encode('one marker\r\nanother marker\r\n'),
          ),
          compressed: false,
          cols: focus.session.terminal.viewWidth,
          rows: focus.session.terminal.viewHeight,
        ),
      );
      await tester.pump(const Duration(milliseconds: 250));
      await frames(tester);
      expect(
        tester.binding.focusManager.primaryFocus?.context
            ?.findAncestorWidgetOfExactType<TerminalFindBar>(),
        isNotNull,
        reason: 'the keyboard is still the field’s after the terminal was replaced',
      );

      await search(tester, 'marker');
      // Both found on the new screen; which one is lit follows the match carried across.
      expect(status(tester), matches(RegExp(r'^[12]/2$')));
      expect(focus.typed, isEmpty);
      await focus.close();
    });

    testWidgets('× and Back put it away, and the page stays', (tester) async {
      final focus = await openFind(tester);
      await tester.tap(find.byKey(const ValueKey('terminal-find-close')));
      await frames(tester);
      expect(bar(), findsNothing);

      await tester.tap(find.byKey(const ValueKey('terminal-title')));
      await frames(tester);
      await tester.tap(find.text('Find in terminal'));
      await frames(tester);
      expect(bar(), findsOneWidget);

      await tester.binding.handlePopRoute();
      await frames(tester);
      expect(bar(), findsNothing, reason: 'Back closes Find first');
      expect(find.byType(TerminalPage), findsOneWidget);
      await focus.close();
    });

    // The keyboard-inset rule (`phone_shell.dart`): a bar on the keyboard sits exactly on it, never
    // a second keyboard's height higher.
    testWidgets('the bar sits on the keyboard, not two keyboards up', (
      tester,
    ) async {
      final focus = await openFind(tester);
      raiseKeyboard(tester);
      await frames(tester);

      final screen = tester.view.physicalSize.height / tester.view.devicePixelRatio;
      final keyboard = tester.view.viewInsets.bottom / tester.view.devicePixelRatio;
      expect(tester.getBottomLeft(bar()).dy, moreOrLessEquals(screen - keyboard, epsilon: 1));

      lowerKeyboard(tester);
      await frames(tester);
      expect(
        tester.getBottomLeft(bar()).dy,
        greaterThan(screen - keyboard),
        reason: 'back at the foot once the keyboard has gone',
      );
      await focus.close();
    });
  });

  group('the menu', () {
    Future<_Focus> openMenu(
      WidgetTester tester, {
      bool working = false,
      bool raw = false,
      String engine = 'claude',
      EdgeConn? connection,
    }) async {
      final focus = await _Focus.open(
        tester,
        agents: [
          edgeAgent(
            'a',
            engine: engine,
            project: longProject,
            branch: longBranch,
          ),
        ],
        connection: connection,
      );
      if (working) focus.app.stateOf('m')!.processingAgentIds.add('a');
      focus.app.stateOf('m')!.terminalPasteRawAvailable = raw;
      await tester.tap(find.byKey(const ValueKey('terminal-title')));
      await frames(tester);
      return focus;
    }

    testWidgets('Paste: the clipboard\'s text goes to the prompt', (
      tester,
    ) async {
      final focus = await openMenu(tester);
      _clipboard = {'text': 'git status'};
      await tester.tap(find.text('Paste from clipboard'));
      await frames(tester);
      expect(focus.typed.join(), contains('git status'));
      await focus.close();
    });

    testWidgets('Paste with nothing on the clipboard says so', (tester) async {
      final focus = await openMenu(tester);
      _clipboard = null;
      await tester.tap(find.text('Paste from clipboard'));
      await frames(tester);
      // No text AND no image: the sheet's Paste looks for both before it gives
      // up, so the sentence names the clipboard rather than the text on it.
      expect(
        find.text('There is nothing on the clipboard to paste.'),
        findsOneWidget,
      );
      await focus.close();
    });

    testWidgets('Paste where the computer takes a raw paste', (tester) async {
      final focus = await openMenu(tester, raw: true);
      _clipboard = {'text': 'ls -la'};
      await tester.tap(find.text('Paste from clipboard'));
      await frames(tester);
      expect(tester.takeException(), isNull);
      await focus.close();
    });

    testWidgets('Interrupt, while it works, sends esc', (tester) async {
      final focus = await openMenu(tester, working: true);
      await tester.tap(find.text('Interrupt'));
      await frames(tester);
      expect(focus.typed, contains('\x1b'));
      await focus.close();
    });

    // Offered whenever the agent works — the one row wanted most when something must stop — and on
    // a terminal the computer took its Esc used to be dropped without a word.
    testWidgets('Interrupt on a terminal the computer took takes it back, '
        'then sends esc', (tester) async {
      final focus = await openMenu(tester, working: true);
      await focus.takenByComputer();
      await frames(tester);
      final before = focus.opens;

      await tester.tap(find.text('Interrupt'));
      await frames(tester);
      expect(focus.opens, greaterThan(before));
      expect(focus.typed, isNot(contains('\x1b')));
      // Nothing seemed to happen: the sheet opened again, Interrupt pressed again in the wait.
      await tester.tap(find.byKey(const ValueKey('terminal-title')));
      await frames(tester);
      await tester.tap(find.text('Interrupt'));
      await frames(tester);

      await focus.answerOpen();
      await tester.pump(const Duration(milliseconds: 250));
      await frames(tester);
      expect(focus.session.acceptsInput, isTrue);
      // One Esc: a second, on Claude Code's empty prompt, opens its rewind.
      expect(focus.typed.where((key) => key == '\x1b'), hasLength(1));
      await focus.close();
    });

    testWidgets('Interrupt pressed twice on a terminal the phone holds sends '
        'esc twice, as before', (tester) async {
      final focus = await openMenu(tester, working: true);
      await tester.tap(find.text('Interrupt'));
      await frames(tester);
      await tester.tap(find.byKey(const ValueKey('terminal-title')));
      await frames(tester);
      await tester.tap(find.text('Interrupt'));
      await frames(tester);
      expect(focus.typed.where((key) => key == '\x1b'), hasLength(2));
      await focus.close();
    });

    testWidgets('Restart that the machine refuses says why', (tester) async {
      final focus = await openMenu(tester);
      await tester.tap(find.text('Restart'));
      await frames(tester);
      expect(focus.conn.requests, contains('agent_restart'));
      await focus.close();
    });

    /// A machine that forks what it is asked to, as `f`, echoing the receipt — or, with [failure],
    /// records the fork as refused for that reason.
    EdgeConn forking({Map<String, dynamic>? failure}) => EdgeConn(
      const {},
      (type, payload) => type != 'agent_fork'
          ? null
          : failure != null
          ? {
              'creationId': payload['creationId'],
              'state': 'failed',
              'failure': failure,
            }
          : {
              'creationId': payload['creationId'],
              'state': 'created',
              'level': 'native',
              'agent': {
                'id': 'f',
                'name': payload['name'] ?? 'f',
                'engine': 'claude',
                'terminal': {'available': true},
              },
            },
    )..handshaken = true;

    testWidgets('Clone opens another of this one, in the same folder, and the '
        'source stays as it was', (tester) async {
      final conn = EdgeConn(const {}, startsAgents)..handshaken = true;
      final focus = await openMenu(tester, connection: conn);
      await tapInView(tester, find.text('Clone'));
      for (var i = 0; i < 40 && focus.opened.isEmpty; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }

      final [sent] = conn.payloads['agent_create']!;
      expect(sent['engine'], 'claude');
      expect(sent['cwd'], '/code/$longProject');
      expect(sent['name'], 'a - clone');
      expect(focus.opened, [('m', 'new-agent')]);
      expect(conn.requests, isNot(contains('agent_close')));
      await focus.close();
    });

    testWidgets('Clone, while it is out, says so and cannot be pressed '
        'again', (tester) async {
      final reply = Completer<Map<String, dynamic>>();
      final conn = _HeldCreateConn(reply.future)..handshaken = true;
      final focus = await openMenu(tester, connection: conn);
      await tapInView(tester, find.text('Clone'));
      await frames(tester);

      await tester.tap(find.byKey(const ValueKey('terminal-title')));
      await frames(tester);
      expect(find.text('cloning…'), findsOneWidget);
      await tapInView(tester, find.text('Clone'));
      await frames(tester);
      expect(conn.payloads['agent_create'], hasLength(1));

      reply.complete({'error': 'BUSY'});
      await frames(tester);
      await focus.close();
    });

    testWidgets('Fork is offered where the machine can fork, and not on a '
        'terminal', (tester) async {
      var focus = await openMenu(tester);
      expect(find.text('Fork'), findsOneWidget);
      await focus.close();

      focus = await openMenu(tester, engine: 'terminal');
      expect(find.text('Fork'), findsNothing);
      await focus.close();
    });

    testWidgets('Fork: the desktop’s form, named after the source, then the '
        'fork opens and the source is left as it was', (tester) async {
      final conn = forking();
      final focus = await openMenu(tester, connection: conn);
      await tapInView(tester, find.text('Fork'));
      await frames(tester);

      expect(find.text('Fork Harness'), findsOneWidget);
      expect(
        find.text('Continues the conversation in the same project folder.'),
        findsOneWidget,
      );
      expect(
        tester
            .widget<TextField>(find.byKey(const Key('fork-name')))
            .controller!
            .text,
        'a - fork',
      );
      await tester.enterText(
        find.byKey(const Key('fork-task')),
        'Try the other approach',
      );
      await tester.tap(find.byKey(const Key('fork-confirm')));
      for (var i = 0; i < 40 && focus.opened.isEmpty; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }

      final [sent] = conn.payloads['agent_fork']!;
      expect(sent['agentId'], 'a');
      expect(sent['name'], 'a - fork');
      expect(sent['prompt'], 'Try the other approach');
      expect(focus.opened, [('m', 'f')]);
      await frames(tester);
      expect(find.text('Fork Harness'), findsNothing, reason: 'the form went');
      expect(
        conn.requests,
        isNot(contains('agent_close')),
        reason: 'the source is not touched',
      );
      await focus.close();
    });

    testWidgets('Fork the machine refuses says why in the form, and opens '
        'nothing', (tester) async {
      final conn = forking(
        failure: {
          'code': 'AGENT_BUSY',
          'detail': 'a is in the middle of a turn.',
        },
      );
      final focus = await openMenu(tester, connection: conn);
      await tapInView(tester, find.text('Fork'));
      await frames(tester);
      await tester.tap(find.byKey(const Key('fork-confirm')));
      await frames(tester);

      expect(find.text('a is in the middle of a turn.'), findsOneWidget);
      expect(find.text('Fork'), findsOneWidget, reason: 'can be sent again');
      expect(focus.opened, isEmpty);
      await focus.close();
    });

    testWidgets('Fork with no name is not sent', (tester) async {
      final conn = forking();
      final focus = await openMenu(tester, connection: conn);
      await tapInView(tester, find.text('Fork'));
      await frames(tester);
      await tester.enterText(find.byKey(const Key('fork-name')), '  ');
      await tester.tap(find.byKey(const Key('fork-confirm')));
      await frames(tester);

      expect(find.text('Name cannot be empty'), findsOneWidget);
      expect(conn.payloads['agent_fork'], isNull);
      await focus.close();
    });

    // The form's own fields raise the keyboard, and on a small phone it takes most of the screen:
    // the form scrolls inside what is left rather than overflowing, and Fork stays in reach.
    testWidgets('Fork’s form under the keyboard on a small phone still reaches '
        'Fork', (tester) async {
      final conn = forking();
      final focus = await openMenu(tester, connection: conn);
      setPhone(tester, smallPhone);
      await frames(tester);
      await tapInView(tester, find.text('Fork'));
      await frames(tester);
      raiseKeyboard(tester);
      await frames(tester);
      expect(tester.takeException(), isNull, reason: 'no overflow');

      final confirm = find.byKey(const Key('fork-confirm'));
      await tester.ensureVisible(confirm);
      await tester.pump();
      final bottom = tester.getRect(confirm).bottom;
      expect(
        bottom,
        lessThanOrEqualTo(smallPhone.size.height - smallPhone.keyboard),
        reason: 'above the keyboard',
      );
      await tester.tap(confirm);
      for (var i = 0; i < 40 && focus.opened.isEmpty; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }
      expect(focus.opened, [('m', 'f')]);
      lowerKeyboard(tester);
      await frames(tester);
      await focus.close();
    });

    testWidgets('Fork closed while it is on its way carries on, says so when '
        'it lands, and offers the fork', (tester) async {
      final reply = Completer<Map<String, dynamic>>();
      final forkConn = _HeldForkConn(reply.future)..handshaken = true;
      final focus = await openMenu(tester, connection: forkConn);
      await tapInView(tester, find.text('Fork'));
      await frames(tester);
      await tester.tap(find.byKey(const Key('fork-confirm')));
      await frames(tester);
      expect(
        find.text('Forking continues if you close this dialog.'),
        findsOneWidget,
      );
      await tester.tap(find.byKey(const Key('fork-cancel')));
      await frames(tester);
      expect(find.text('Fork Harness'), findsNothing);

      // The menu says so while it is out, and goes when the answer lands under it.
      await tester.tap(find.byKey(const ValueKey('terminal-title')));
      await frames(tester);
      expect(find.text('forking…'), findsOneWidget);

      reply.complete({
        'creationId': forkConn.receipt,
        'state': 'created',
        'agent': {
          'id': 'f',
          'name': 'a - fork',
          'engine': 'claude',
          'terminal': {'available': true},
        },
      });
      await frames(tester);
      expect(find.text('forking…'), findsNothing, reason: 'the menu went');
      expect(find.text('Fork created.'), findsOneWidget);
      expect(
        focus.opened,
        isEmpty,
        reason: 'offered, not opened over the page',
      );
      await tester.tap(find.text('Open'));
      await frames(tester);
      expect(focus.opened, [('m', 'f')]);
      await focus.close();
    });

    /// A harness its machine can save and stop — what Change agent needs of one.
    Agent switchable() => Agent(
      id: 'a',
      name: 'a',
      engine: 'claude',
      sessionId: 'session-a',
      project: const AgentProject(name: 'web', cwd: '/code/web'),
      terminalAvailable: true,
      createdAt: DateTime.utc(2026, 10, 16, 1),
      closeSupported: true,
    );

    /// The switch's own requests, in the order the machine got them.
    List<String> switchSteps(EdgeConn conn) => [
      for (final type in conn.requests)
        if (const {
          'agent_handoff_prepare',
          'agent_recent',
          'agent_close',
          'agent_create',
        }.contains(type))
          type,
    ];

    /// Change agent ▸ [label], picked by searching for it: the list is longer than a screen.
    Future<void> switchTo(WidgetTester tester, String label) async {
      await tester.tap(find.text('Change agent'));
      await frames(tester);
      await tester.enterText(find.byType(TextField).last, label);
      await frames(tester);
      await tester.tap(find.text(label, findRichText: true).last);
      await frames(tester);
    }

    /// A machine that reviews then deletes what it is asked to — or, with [review], answers the
    /// review only when that does.
    EdgeConn purging({Future<Map<String, dynamic>>? review}) =>
        _PurgeConn(review ?? Future.value({'reviewId': 'review-1'}))
          ..handshaken = true;

    testWidgets('while it works: Stop after it finishes queues the stop, and '
        'the menu then offers to keep it running', (tester) async {
      final conn = EdgeConn(const {}, (type, payload) {
        if (type != 'agent_close') return null;
        return payload['mode'] == 'cancel'
            ? {'cancelled': true}
            : {'deferred': true};
      })..handshaken = true;
      final focus = await _Focus.open(
        tester,
        agents: [switchable()],
        connection: conn,
      );
      focus.app.stateOf('m')!.processingAgentIds.add('a');
      await tester.tap(find.byKey(const ValueKey('terminal-title')));
      await frames(tester);

      await tapInView(tester, find.text('Stop after it finishes'));
      await frames(tester);
      expect(conn.payloads['agent_close']!.single['mode'], 'after_task');
      expect(find.text('Stops after it finishes.'), findsOneWidget);

      await tester.tap(find.byKey(const ValueKey('terminal-title')));
      await frames(tester);
      expect(find.text('Stop after it finishes'), findsNothing);
      await tapInView(
        tester,
        find.text('Stops after finishing · Keep running'),
      );
      await frames(tester);
      expect(conn.payloads['agent_close']!.last['mode'], 'cancel');
      // Behind the first answer's snackbar, which has its few seconds first.
      await tester.pump(const Duration(seconds: 5));
      await frames(tester);
      expect(find.text('Keeps running.'), findsOneWidget);
      await focus.close();
    });

    testWidgets('idle, or a shell, has no stop to queue — Stop is the '
        'answer', (tester) async {
      var focus = await _Focus.open(tester, agents: [switchable()]);
      await tester.tap(find.byKey(const ValueKey('terminal-title')));
      await frames(tester);
      expect(find.text('Stop after it finishes'), findsNothing);
      expect(find.text('Stop this harness'), findsOneWidget);
      await focus.close();

      focus = await openMenu(tester, working: true);
      expect(
        find.text('Stop after it finishes'),
        findsNothing,
        reason: 'its machine cannot close it',
      );
      await focus.close();
    });

    testWidgets('Delete is offered beside Stop, and not on a terminal', (
      tester,
    ) async {
      var focus = await openMenu(tester);
      expect(find.text('Stop this harness'), findsOneWidget);
      expect(find.text('Delete this harness'), findsOneWidget);
      await focus.close();

      focus = await openMenu(tester, engine: 'terminal');
      expect(find.text('Stop this harness'), findsOneWidget);
      expect(find.text('Delete this harness'), findsNothing);
      await focus.close();
    });

    testWidgets('Delete, confirmed, reviews then deletes the harness this page '
        'shows, conversation and all', (tester) async {
      final conn = purging();
      final focus = await _Focus.open(
        tester,
        agents: [switchable()],
        connection: conn,
      );
      await tester.tap(find.byKey(const ValueKey('terminal-title')));
      await frames(tester);
      await tapInView(tester, find.text('Delete this harness'));
      await frames(tester);
      expect(find.text('Delete a?'), findsOneWidget);
      await tester.tap(find.widgetWithText(FilledButton, 'Delete'));
      await frames(tester);

      expect(
        [for (final p in conn.payloads['agent_purge']!) p['mode']],
        ['inspect', 'delete'],
      );
      expect(conn.payloads['agent_purge']!.last, {
        'agentId': 'a',
        'sessionId': 'session-a',
        'createdAt': DateTime.utc(2026, 10, 16, 1).millisecondsSinceEpoch,
        'mode': 'delete',
        'reviewId': 'review-1',
      });
      expect(conn.requests, isNot(contains('agent_delete')));
      expect(focus.app.stateOf('m')!.agents, isEmpty);
      await focus.close();
    });

    testWidgets('Delete, while it is out, says so and cannot be pressed '
        'again', (tester) async {
      final review = Completer<Map<String, dynamic>>();
      final conn = purging(review: review.future);
      final focus = await _Focus.open(
        tester,
        agents: [switchable()],
        connection: conn,
      );
      await tester.tap(find.byKey(const ValueKey('terminal-title')));
      await frames(tester);
      await tapInView(tester, find.text('Delete this harness'));
      await frames(tester);
      await tester.tap(find.widgetWithText(FilledButton, 'Delete'));
      await frames(tester);

      await tester.tap(find.byKey(const ValueKey('terminal-title')));
      await frames(tester);
      expect(find.text('Delete this harness'), findsNothing);
      await tapInView(tester, find.text('Deleting…'));
      await frames(tester);
      expect(find.text('Delete a?'), findsNothing, reason: 'took no tap');

      await tester.tapAt(const Offset(200, 40));
      await frames(tester);
      review.complete({'error': 'OWNER_REQUIRED'});
      await frames(tester);
      expect(find.text('Delete failed: OWNER_REQUIRED'), findsOneWidget);
      expect(conn.payloads['agent_purge'], hasLength(1));
      await focus.close();
    });

    testWidgets('Change agent is named by the agent it is on, and offered to '
        'an agent only', (tester) async {
      var focus = await openMenu(tester);
      final row = find
          .ancestor(of: find.text('Change agent'), matching: find.byType(Row))
          .first;
      expect(
        find.descendant(of: row, matching: find.text('Claude')),
        findsOneWidget,
      );
      await focus.close();

      focus = await openMenu(tester, engine: 'terminal');
      expect(find.text('Change agent'), findsNothing);
      await focus.close();
    });

    testWidgets('Change agent: the desktop picker’s rows, then the agent picked '
        'opens in place of this one', (tester) async {
      final conn = EdgeConn({
        'agent_handoff_prepare': {
          'agentId': 'a',
          'file': null,
          'gitRepo': true,
          'cwd': '/code/web',
          'degraded': <String>[],
        },
        'agent_close': {'closed': true},
      }, startsAgents)..handshaken = true;
      final focus = await _Focus.open(
        tester,
        agents: [switchable()],
        connection: conn,
      );
      await tester.tap(find.byKey(const ValueKey('terminal-title')));
      await frames(tester);
      await tester.tap(find.text('Change agent'));
      await frames(tester);

      expect(find.text('Current agent'), findsOneWidget);
      expect(
        find.text('Continue this project with recent context'),
        findsWidgets,
      );
      expect(find.text('New conversation in the same project'), findsWidgets);
      await tester.enterText(find.byType(TextField).last, 'Codex');
      await frames(tester);
      await tester.tap(find.text('Codex', findRichText: true).last);
      for (var i = 0; i < 120 && focus.opened.isEmpty; i++) {
        await tester.pump(const Duration(milliseconds: 250));
      }

      expect(switchSteps(conn), [
        'agent_handoff_prepare',
        'agent_close',
        'agent_create',
      ]);
      expect(conn.payloads['agent_create']!.single['engine'], 'codex');
      expect(focus.opened, [('m', 'new-agent')]);
      // Nothing to hand over: the desktop's line for a switch without history.
      expect(
        find.text(
          'Switched to Codex without history: no earlier conversation from '
          'Claude was found to hand off.',
        ),
        findsOneWidget,
      );
      await focus.close();
    });

    testWidgets('Change agent that cannot go on says why, and opens nothing', (
      tester,
    ) async {
      // A machine older than `agent_close`: the old agent could not be saved and stopped safely.
      final focus = await openMenu(tester);
      await switchTo(tester, 'Codex');
      await frames(tester);

      expect(
        find.text(
          'Update the Harness CLI on this machine to close saved sessions safely.',
        ),
        findsOneWidget,
      );
      expect(switchSteps(focus.conn), isEmpty);
      expect(focus.opened, isEmpty);
      await focus.close();
    });

    testWidgets('Change agent, while it runs, says so and cannot be pressed '
        'again', (tester) async {
      final handoff = Completer<Map<String, dynamic>>();
      final conn = _SwitchConn(() => handoff.future)..handshaken = true;
      final focus = await _Focus.open(
        tester,
        agents: [switchable()],
        connection: conn,
      );
      await tester.tap(find.byKey(const ValueKey('terminal-title')));
      await frames(tester);
      await switchTo(tester, 'Codex');
      expect(conn.handoffs, 1);

      await tester.tap(find.byKey(const ValueKey('terminal-title')));
      await frames(tester);
      expect(find.text('switching…'), findsOneWidget);
      await tester.tap(find.text('Change agent'));
      await frames(tester);
      expect(
        find.text('Current agent'),
        findsNothing,
        reason: 'the row took no tap, so no second chooser opened',
      );
      expect(conn.handoffs, 1);

      await tester.tapAt(const Offset(200, 40));
      await frames(tester);
      handoff.complete({'error': 'BUSY'});
      await frames(tester);
      await focus.close();
    });

    // The first switch tried on a phone waited half a minute on the computer: its two-second line
    // had gone, the menu opened to check said `switching…` long after, and the answer was in a
    // snackbar under that menu.
    testWidgets('Change agent says it is switching for as long as it is, and '
        'when it ends under an open menu the menu goes and the answer shows', (
      tester,
    ) async {
      final handoff = Completer<Map<String, dynamic>>();
      final conn = _SwitchConn(() => handoff.future)..handshaken = true;
      final focus = await _Focus.open(
        tester,
        agents: [switchable()],
        connection: conn,
      );
      await tester.tap(find.byKey(const ValueKey('terminal-title')));
      await frames(tester);
      await switchTo(tester, 'Codex');

      // Past the two seconds a flash lasts.
      await tester.pump(const Duration(seconds: 3));
      expect(find.text('switching to Codex…'), findsOneWidget);

      await tester.tap(find.byKey(const ValueKey('terminal-title')));
      await frames(tester);
      expect(find.text('switching…'), findsOneWidget);

      handoff.completeError(
        const WsRequestFailure(responseType: 'result', code: 'BUSY'),
      );
      await frames(tester);

      expect(find.text('Rename'), findsNothing, reason: 'the menu went');
      expect(
        find.text('Preparing the handoff took too long. Try switching again.'),
        findsOneWidget,
      );
      expect(find.text('switching to Codex…'), findsNothing);
      expect(switchSteps(conn), ['agent_handoff_prepare']);
      await focus.close();
    });

    /// The menu again, over the terminal, as a second look at it opens it.
    Future<void> reopen(WidgetTester tester) async {
      await tester.tap(find.byKey(const ValueKey('terminal-title')));
      await frames(tester);
    }

    /// The menu put away by a tap above it, on the veil.
    Future<void> putAway(WidgetTester tester) async {
      await tester.tapAt(const Offset(200, 40));
      await frames(tester);
    }

    // ⚠️ A second press is a second restart: the machine runs it once the first is done, and the
    // engine that just came back is replaced again.
    testWidgets('Restart, while it runs, says so and cannot be pressed again', (
      tester,
    ) async {
      final reply = Completer<Map<String, dynamic>>();
      final conn = _RestartConn(() => reply.future);
      final focus = await openMenu(tester, connection: conn);
      await tester.tap(find.text('Restart'));
      await frames(tester);
      expect(conn.restarts, 1);

      // Nothing seemed to happen: the menu opened again, Restart pressed again.
      await reopen(tester);
      expect(find.text('restarting…'), findsOneWidget);
      await tester.tap(find.text('Restart'));
      await frames(tester);
      expect(conn.restarts, 1);
      expect(
        find.text('restarting…'),
        findsOneWidget,
        reason: 'the row took no tap, so the menu is still up',
      );

      await putAway(tester);
      reply.complete({'resumed': true});
      await frames(tester);
      await reopen(tester);
      expect(find.text('restarting…'), findsNothing);
      await tester.tap(find.text('Restart'));
      await frames(tester);
      expect(
        conn.restarts,
        2,
        reason: 'once it is over, it can be asked again',
      );
      await focus.close();
    });

    testWidgets('Restart that came back on a new conversation says so', (
      tester,
    ) async {
      final focus = await openMenu(
        tester,
        connection: EdgeConn(const {
          'agent_restart': {'resumed': false},
        }),
      );
      await tester.tap(find.text('Restart'));
      await frames(tester);
      expect(find.text('Restarted with a new conversation.'), findsOneWidget);
      await focus.close();
    });

    testWidgets('Restart that came back where it was says nothing', (
      tester,
    ) async {
      final focus = await openMenu(
        tester,
        connection: EdgeConn(const {
          'agent_restart': {'resumed': true},
        }),
      );
      await tester.tap(find.text('Restart'));
      await frames(tester);
      expect(find.byType(SnackBar), findsNothing);
      await focus.close();
    });

    testWidgets('Restart from a machine too old to say how it came back says '
        'nothing', (tester) async {
      final focus = await openMenu(tester);
      await tester.tap(find.text('Restart'));
      await frames(tester);
      expect(focus.conn.requests, contains('agent_restart'));
      expect(find.byType(SnackBar), findsNothing);
      await focus.close();
    });

    // A terminal always restarts as a fresh shell, which is what its Restart promised.
    testWidgets('Restart of a terminal, a fresh shell, says nothing', (
      tester,
    ) async {
      final focus = await openMenu(
        tester,
        engine: 'terminal',
        connection: EdgeConn(const {
          'agent_restart': {'resumed': false},
        }),
      );
      await tester.tap(find.text('Restart'));
      await frames(tester);
      expect(focus.conn.requests, contains('agent_restart'));
      expect(find.byType(SnackBar), findsNothing);
      await focus.close();
    });

    testWidgets('Restart the machine refuses says why in a sentence, not as '
        'the socket\'s error', (tester) async {
      final conn = _RestartConn(
        () async => throw const WsRequestFailure(
          responseType: 'agent_restart_result',
          code: 'AGENT_BUSY',
        ),
      );
      final focus = await openMenu(tester, connection: conn);
      await tester.tap(find.text('Restart'));
      await frames(tester);
      expect(
        find.text(
          'Another operation is changing this harness. Wait for it to finish, then retry.',
        ),
        findsOneWidget,
      );
      expect(find.textContaining('agent_restart_result'), findsNothing);
      await putAway(tester);
      await reopen(tester);
      expect(find.text('restarting…'), findsNothing);
      await focus.close();
    });

    // The machine may be restarting it still: "failed" would send the person to press Restart
    // again, over a restart that is about to finish.
    testWidgets('Restart whose reply never came does not say it failed', (
      tester,
    ) async {
      final conn = _RestartConn(
        () async => throw const WsRequestTimeout('agent_restart'),
      );
      final focus = await openMenu(tester, connection: conn);
      await tester.tap(find.text('Restart'));
      await frames(tester);
      expect(
        find.text(
          'Could not confirm the restart. Check the terminal before restarting again.',
        ),
        findsOneWidget,
      );
      expect(find.textContaining('failed'), findsNothing);
      expect(find.textContaining('timed out'), findsNothing);

      await putAway(tester);
      await reopen(tester);
      expect(find.text('restarting…'), findsNothing);
      await tester.tap(find.text('Restart'));
      await frames(tester);
      expect(
        conn.restarts,
        2,
        reason: 'not held for good by a reply that never came',
      );
      await focus.close();
    });

    // A row that opens a screen of its own says so by opening it: no trailing `…`. The ellipsis is
    // kept for a row saying something is on its way (`forking…`, `Deleting…`).
    testWidgets('no row ends in an ellipsis', (tester) async {
      final focus = await openMenu(tester);
      for (final label in const [
        'Fork',
        'Rename',
        'Stop this harness',
        'Delete this harness',
      ]) {
        expect(find.text(label), findsOneWidget);
      }
      expect(
        find.descendant(
          of: find.byType(BottomSheet),
          matching: find.byWidgetPredicate(
            (widget) =>
                widget is Text &&
                (widget.data ?? widget.textSpan?.toPlainText() ?? '')
                    .contains('…'),
          ),
        ),
        findsNothing,
      );
      await focus.close();
    });

    testWidgets('Rename, Stop and Settings open their own screens', (
      tester,
    ) async {
      final focus = await openMenu(tester);
      // Switched off everywhere for now (`kModelSheetEnabled`): no row that looks like a choice.
      expect(find.text('Model'), findsNothing);
      await tester.tap(find.text('Rename'));
      await frames(tester);
      expect(find.byType(TextField), findsOneWidget);
      await tester.tap(find.text('Cancel'));
      await frames(tester);

      await tester.tap(find.byKey(const ValueKey('terminal-title')));
      await frames(tester);
      await tapInView(tester, find.text('Stop this harness'));
      await frames(tester);
      expect(find.text('Cancel'), findsOneWidget);
      await tester.tap(find.text('Cancel'));
      await frames(tester);

      await tester.tap(find.byKey(const ValueKey('terminal-title')));
      await frames(tester);
      await tapInView(tester, find.text('Settings'));
      await frames(tester);
      expect(find.byType(SettingsPage), findsOneWidget);
      await focus.close();
    });
  });

  // ⌘V on an iPad's keyboard, Ctrl+V on an Android one: the menu's own Paste, not the desktop's —
  // which ended in a ⌃V that pasted the far machine's clipboard rather than this phone's.
  group('a hardware keyboard\'s paste', () {
    final phones = TargetPlatformVariant({
      TargetPlatform.iOS,
      TargetPlatform.android,
    });

    /// The page, typing into its terminal.
    Future<_Focus> typing(WidgetTester tester) async {
      final focus = await _Focus.open(tester);
      await focus.tapPrompt();
      await tester.pump();
      raiseKeyboard(tester);
      await frames(tester);
      return focus;
    }

    Future<void> pasteChord(WidgetTester tester) async {
      final ios = defaultTargetPlatform == TargetPlatform.iOS;
      final platform = ios ? 'ios' : 'android';
      final modifier = ios
          ? LogicalKeyboardKey.metaLeft
          : LogicalKeyboardKey.controlLeft;
      await tester.sendKeyDownEvent(modifier, platform: platform);
      await tester.sendKeyEvent(LogicalKeyboardKey.keyV, platform: platform);
      await tester.sendKeyUpEvent(modifier, platform: platform);
      await frames(tester);
    }

    testWidgets('pastes the clipboard\'s text as the menu\'s Paste does', (
      tester,
    ) async {
      final focus = await typing(tester);
      _clipboard = {'text': 'git status'};
      await pasteChord(tester);
      expect(focus.typed.join(), contains('git status'));
      await focus.close();
    }, variant: phones);

    testWidgets('with nothing on the clipboard says so, and sends no ⌃V', (
      tester,
    ) async {
      final focus = await typing(tester);
      _clipboard = null;
      await pasteChord(tester);
      expect(focus.typed.join(), isNot(contains('\x16')));
      expect(
        find.text('There is nothing on the clipboard to paste.'),
        findsOneWidget,
      );
      await focus.close();
    }, variant: phones);
  });

  group('a question', () {
    Future<_Focus> asked(WidgetTester tester) async {
      final focus = await _Focus.open(tester);
      focus.session.terminal.write(permissionDialog);
      await frames(tester);
      return focus;
    }

    // No keys beside the mic since the owner's call (2026-09-29): each answer is a band over its
    // own lines, pressed by a tap there (the next test) — and, to a screen reader, a button named
    // for the answer.
    testWidgets('each answer is a button to VoiceOver, and presses its own '
        'number', (tester) async {
      final semantics = tester.ensureSemantics();
      final focus = await asked(tester);
      tester.semantics.tap(find.semantics.byLabel(RegExp('^Answer 1 ')));
      tester.semantics.tap(find.semantics.byLabel(RegExp('^Answer 3 ')));
      await frames(tester);
      expect(focus.typed, containsAllInOrder(['1', '3']));
      await focus.close();
      semantics.dispose();
    });

    testWidgets('a tap on an answer\'s own line presses it', (tester) async {
      final focus = await asked(tester);
      await focus.tapRow("don't ask again");
      await frames(tester);
      expect(focus.typed, contains('2'));
      await focus.close();
    });

    // The answers stay drawn on a terminal the computer took, and a tap there used to buzz and
    // press a digit the session then dropped. A tapped answer is a claim, as a spoken one is.
    testWidgets('an answer tapped on a terminal the computer took takes it '
        'back, then presses it, once', (tester) async {
      final focus = await asked(tester);
      await focus.takenByComputer();
      await frames(tester);
      expect(focus.session.acceptsInput, isFalse);
      final before = focus.opens;

      await focus.tapRow("don't ask again");
      await frames(tester);
      // Asked for again, and nothing pressed into a terminal that would drop it.
      expect(focus.opens, greaterThan(before));
      expect(focus.typed, isNot(contains('2')));
      // A second tap while it comes back adds no second answer.
      await focus.tapRow("don't ask again");
      await frames(tester);

      // Still asking: the screen it comes back with is the same question.
      await focus.answerOpen(screen: permissionDialog);
      await tester.pump(const Duration(milliseconds: 250));
      await frames(tester);
      expect(focus.session.acceptsInput, isTrue);
      expect(focus.typed.where((key) => key == '2'), hasLength(1));
      await focus.close();
    });

    testWidgets('a terminal that does not come back: the tapped answer says it '
        'was not sent', (tester) async {
      final focus = await asked(tester);
      await focus.takenByComputer();
      await frames(tester);

      await focus.tapRow("don't ask again");
      await frames(tester);
      // No answer to the open: the take gives up after six seconds, and says so.
      await tester.pump(const Duration(seconds: 6));
      await tester.pump(const Duration(milliseconds: 200));
      expect(find.text('✗ not sent'), findsOneWidget);
      expect(focus.typed, isNot(contains('2')));
      await focus.close();
    });

    testWidgets('a question answered on the computer while the phone takes '
        'the terminal back: nothing is pressed', (tester) async {
      final focus = await asked(tester);
      await focus.takenByComputer();
      await frames(tester);

      await focus.tapRow("don't ask again");
      await frames(tester);
      // Answered there meanwhile: the screen the terminal comes back with is the agent's prompt.
      // The watcher still holds the dialog for one more read, so only the screen itself can say.
      await focus.answerOpen(screen: '\x1b[2J\x1b[Hprompt> ');
      await tester.pump(const Duration(milliseconds: 250));
      await frames(tester);
      expect(focus.session.acceptsInput, isTrue);
      // A digit now would have been typed into the agent's prompt.
      expect(focus.typed, isNot(contains('2')));
      await focus.close();
    });

    testWidgets('a question with no words to spare: a voice that matches '
        'nothing is not sent', (tester) async {
      final focus = await _Focus.open(tester);
      focus.session.terminal.write(
        '\r\n ─────────────────────────────\r\n'
        ' Which database?\r\n'
        ' ❯ 1. Postgres\r\n'
        '   2. SQLite\r\n'
        '\r\n'
        ' Enter to select · Esc to cancel',
      );
      await frames(tester);
      focus.stt.replies.add('the fast one');
      await tester.tap(find.byType(VoiceMicCore));
      await frames(tester);
      await tester.tap(find.byType(VoiceMicCore));
      await frames(tester, count: 2);
      expect(find.text('✗ no match — tap an answer'), findsOneWidget);
      expect(focus.typed, isNot(contains('1')));
      // The words are kept: once the question has been answered on screen, a tap on the mic
      // sends them to the agent.
      expect(focus.voice.transcript, 'the fast one');
      await focus.close();
    });

    testWidgets('multi-select: answered on screen, with the keyboard\'s keys', (
      tester,
    ) async {
      final focus = await _Focus.open(tester);
      focus.session.terminal.write(
        '\r\n ─────────────────────────────\r\n'
        ' Which checks should run?\r\n'
        ' ❯ 1. [ ] Lint\r\n'
        '   2. [ ] Tests\r\n'
        '   3. [ ] Build\r\n'
        '\r\n'
        ' Enter to select · Esc to cancel',
      );
      await frames(tester);
      // No keys beside the mic for a dialog that takes several answers; the keyboard comes up for
      // it instead, with Enter on its strip.
      expect(find.bySemanticsLabel(RegExp('^Answer ')), findsNothing);
      expect(find.byKey(const ValueKey('terminal-key-Enter')), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('terminal-key-Enter')));
      await frames(tester);
      expect(focus.typed, contains('\r'));
      await focus.close();
    });
  });

  // openharness#1272: Claude Code's MCP elicitation has no digits and no `Enter to …`, and its
  // cursor parks under the footer — so the page neither read it nor raised the keyboard for it,
  // and nothing on the phone could answer it.
  group('an MCP server asking', () {
    String elicitation({String buttons = '  ❯ Accept    Decline'}) =>
        '\r\n──────────────────────────────\r\n'
        '  MCP server “db” requests your input\r\n'
        '\r\n'
        '  This SQL drops a table…\r\n'
        '\r\n'
        '$buttons\r\n'
        '\r\n'
        '  Esc to cancel · ↑/↓ to navigate';

    Future<_Focus> asked(WidgetTester tester, {String? buttons}) async {
      final focus = await _Focus.open(tester);
      focus.session.terminal.write(
        buttons == null ? elicitation() : elicitation(buttons: buttons),
      );
      await frames(tester);
      return focus;
    }

    testWidgets('Accept and Decline are each a button, and Accept with the '
        'caret on it is Enter', (tester) async {
      final semantics = tester.ensureSemantics();
      final focus = await asked(tester);
      expect(find.text('tap an answer · or say it'), findsOneWidget);
      expect(find.semantics.byLabel('Answer 2 Decline'), findsOne);
      tester.semantics.tap(find.semantics.byLabel('Answer 1 Accept'));
      await frames(tester);
      expect(focus.typed, ['\r']);
      await focus.close();
      semantics.dispose();
    });

    testWidgets('a tap on Decline moves the caret over, and presses Enter only '
        'once the pane shows it there', (tester) async {
      final focus = await asked(tester);
      await focus.tapText('Decline');
      await frames(tester);
      expect(focus.typed, hasLength(1));
      expect(focus.typed.single, anyOf('\x1b[C', '\x1bOC'));

      // Claude Code redraws the row with the caret on Decline.
      focus.session.terminal.write(
        '\x1b[2J\x1b[H${elicitation(buttons: '    Accept  ❯ Decline')}',
      );
      await tester.pump(const Duration(milliseconds: 200));
      await tester.pump(const Duration(milliseconds: 400));
      await frames(tester);
      expect(focus.typed.last, '\r');
      expect(focus.typed.where((key) => key == '\r'), hasLength(1));
      await focus.close();
    });

    testWidgets('"no" said to the mic declines it', (tester) async {
      final focus = await asked(tester);
      focus.stt.replies.add('No.');
      await tester.tap(find.byType(VoiceMicCore));
      await frames(tester);
      await tester.tap(find.byType(VoiceMicCore));
      await frames(tester);
      expect(focus.typed, hasLength(1));
      expect(focus.typed.single, anyOf('\x1b[C', '\x1bOC'));
      await focus.close();
    });

    testWidgets('a form: the keyboard comes up for its fields, Enter on its '
        'strip', (tester) async {
      final focus = await asked(tester, buttons: '    Accept    Decline');
      expect(find.bySemanticsLabel(RegExp('^Answer ')), findsNothing);
      expect(find.byKey(const ValueKey('terminal-key-Enter')), findsOneWidget);
      await focus.close();
    });
  });

  testWidgets('a dialog the page cannot read: a tap anywhere on it raises the '
      'keyboard', (tester) async {
    final focus = await _Focus.open(tester);
    focus.session.terminal.write(
      '\r\n──────────────────────────────\r\n'
      '  Pick a colour\r\n'
      '\r\n'
      '  ❯ Red    Blue\r\n'
      '\r\n'
      '  Esc to cancel · ←/→ to choose',
    );
    await frames(tester);
    expect(find.byKey(const ValueKey('terminal-key-esc')), findsNothing);
    await focus.tapRow('Red');
    await frames(tester);
    expect(find.byKey(const ValueKey('terminal-key-esc')), findsOneWidget);
    await focus.close();
  });

  testWidgets('↵ breaks the prompt\'s line without sending the turn', (
    tester,
  ) async {
    final focus = await _Focus.open(tester);
    focus.fill();
    await frames(tester);
    await focus.tapPrompt();
    await tester.pump();
    raiseKeyboard(tester);
    await frames(tester);
    focus.typed.clear();
    await tester.tap(find.byKey(const ValueKey('terminal-key-Newline')));
    await frames(tester);
    // What a hardware ⌥⏎ sends — never the bare Return that submits.
    expect(focus.typed, ['\x1b\r']);
    await focus.close();
  });

  group('the app going away and coming back', () {
    testWidgets('the keyboard it left with is the keyboard it comes back to', (
      tester,
    ) async {
      final focus = await _Focus.open(tester);
      focus.fill();
      await frames(tester);
      await focus.tapPrompt();
      await tester.pump();
      raiseKeyboard(tester);
      await frames(tester);
      expect(find.byKey(const ValueKey('terminal-key-esc')), findsOneWidget);

      final binding = tester.binding;
      binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      // Android takes the keyboard on the way out.
      lowerKeyboard(tester);
      await frames(tester);
      binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await frames(tester);

      expect(
        find.byKey(const ValueKey('terminal-key-esc')),
        findsOneWidget,
        reason: 'asked for again on the way back',
      );
      await focus.close();
    });
  });

  group('a picture', () {
    testWidgets('where the computer takes one: the library, cancelled, '
        'and a camera the phone refused', (tester) async {
      final calls = <String>[];
      Object? answer;
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(
            const MethodChannel('plugins.flutter.io/image_picker'),
            (call) async {
              calls.add('${call.method} ${call.arguments['source']}');
              if (answer case final PlatformException error) throw error;
              return answer;
            },
          );
      addTearDown(
        () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
            .setMockMethodCallHandler(
              const MethodChannel('plugins.flutter.io/image_picker'),
              null,
            ),
      );
      final focus = await _Focus.open(tester);
      focus.app.stateOf('m')!.terminalImagePasteAvailable = true;
      focus.fill();
      await frames(tester);
      await focus.tapPrompt();
      await tester.pump();
      raiseKeyboard(tester);
      await frames(tester);

      // Cancelled: nothing said about it.
      await tester.tap(find.byKey(const ValueKey('terminal-key-Send image')));
      await frames(tester);
      await tester.tap(find.text('Choose from library'));
      await frames(tester);
      expect(calls, hasLength(1));
      expect(find.byType(SnackBar), findsNothing);

      // The camera refused: the one failure somebody can do something about.
      answer = PlatformException(code: 'camera_access_denied');
      await tester.tap(find.byKey(const ValueKey('terminal-key-Send image')));
      await frames(tester);
      await tester.tap(find.text('Take a photo'));
      await frames(tester);
      expect(
        find.text('Allow camera access in Settings to send a photo.'),
        findsOneWidget,
      );
      await focus.close();
    });
  });

  group('a file', () {
    testWidgets('where the computer takes one: behind the same key, and out '
        'as an upload under its name', (tester) async {
      final restore = pickTerminalFile;
      addTearDown(() => pickTerminalFile = restore);
      var picks = 0;
      pickTerminalFile = () async {
        picks++;
        // Named by its path, as a picked file is on a phone.
        return XFile.fromData(
          Uint8List.fromList(utf8.encode('log line')),
          path: '/picked/server.log',
        );
      };
      final focus = await _Focus.open(tester);
      focus.app.stateOf('m')!
        ..terminalImagePasteAvailable = true
        ..terminalPasteFileAvailable = true;
      focus.fill();
      await frames(tester);
      await focus.tapPrompt();
      await tester.pump();
      raiseKeyboard(tester);
      await frames(tester);

      await tester.tap(
        find.byKey(const ValueKey('terminal-key-Send image or file')),
      );
      await frames(tester);
      await tester.tap(find.text('Choose a file'));
      await frames(tester);

      expect(picks, 1);
      final begin = focus.sent
          .where((frame) => frame.$1 == 'terminal_chunked_upload_begin')
          .single
          .$2;
      expect(begin['uploadKind'], 'file');
      expect(begin['filename'], 'server.log');
      await focus.close();
    });

    testWidgets('where it does not, the key offers pictures only', (
      tester,
    ) async {
      final focus = await _Focus.open(tester);
      focus.app.stateOf('m')!.terminalImagePasteAvailable = true;
      focus.fill();
      await frames(tester);
      await focus.tapPrompt();
      await tester.pump();
      raiseKeyboard(tester);
      await frames(tester);

      await tester.tap(find.byKey(const ValueKey('terminal-key-Send image')));
      await frames(tester);
      expect(find.text('Choose a file'), findsNothing);
      await focus.close();
    });
  });

  group('the sample', () {
    testWidgets('its end card: set up a computer, or keep playing', (
      tester,
    ) async {
      setPhone(tester, largePhone);
      final app = edgeApp(agents: [edgeAgent('sample-new-1')]);
      await liveTerminal(app, 'sample-new-1');
      final sample = FakeSample(app);
      await tester.pumpWidget(
        phoneApp(
          SampleMode(
            session: sample,
            child: TerminalPage(
              notifier: app,
              machineId: 'm',
              agentId: 'sample-new-1',
              voice: edgeVoice().voice,
            ),
          ),
        ),
      );
      await frames(tester);
      expect(find.text('✓ yours is running'), findsOneWidget);
      await tester.pump(const Duration(seconds: 9));
      await frames(tester);
      await tester.tap(find.text('Set up my computer'));
      expect(sample.left, ['set-up']);
      await tester.tap(find.text('Keep playing'));
      await frames(tester);
      expect(find.text('That’s Harness.'), findsNothing);

      // And its menu has the way out.
      await tester.tap(find.byKey(const ValueKey('terminal-title')));
      await frames(tester);
      await tester.tap(find.text('Leave the sample'));
      expect(sample.left, ['set-up', null]);
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 3));
      app.dispose();
      await tester.pump(const Duration(seconds: 30));
    });

    testWidgets('its guide line steps along with what has been done', (
      tester,
    ) async {
      setPhone(tester, largePhone);
      final app = edgeApp(
        agents: [
          edgeAgent('a'),
          edgeAgent('b', name: 'b'),
        ],
      );
      await liveTerminal(app, 'a');
      final sample = FakeSample(app);
      await tester.pumpWidget(
        phoneApp(
          SampleMode(
            session: sample,
            child: TerminalPage(
              notifier: app,
              machineId: 'm',
              agentId: 'a',
              voice: edgeVoice().voice,
            ),
          ),
        ),
      );
      await frames(tester);
      expect(find.text('← start one of your own'), findsOneWidget);
      await app.handleMachineEventForTest('m', {
        'type': 'commander_question',
        'payload': {
          'agentId': 'b',
          'requestId': 'q',
          'questions': [
            {
              'q': 'Go?',
              'options': ['Yes', 'No'],
            },
          ],
        },
      });
      await frames(tester);
      expect(find.text('b needs you →'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 3));
      app.dispose();
      await tester.pump(const Duration(seconds: 30));
    });
  });

  group('the agent going away', () {
    testWidgets('gone from the list it opened from: the way to another', (
      tester,
    ) async {
      setPhone(tester, largePhone);
      final app = edgeApp(agents: [edgeAgent('a', name: 'fix-login')]);
      app.stateOf('m')!.agentsFromCache = true;
      final pushed = <Route<dynamic>>[];
      await tester.pumpWidget(
        phoneApp(
          Builder(
            builder: (context) => TextButton(
              onPressed: () => Navigator.of(context).push(
                MaterialPageRoute<void>(
                  builder: (_) => TerminalPage(
                    notifier: app,
                    machineId: 'm',
                    agentId: 'a',
                    voice: edgeVoice().voice,
                  ),
                ),
              ),
              child: const Text('home'),
            ),
          ),
          observers: [_Pushes(pushed)],
        ),
      );
      await tester.tap(find.text('home'));
      await frames(tester);
      // The machine's own list lands, without it.
      app.stateOf('m')!
        ..agentsFromCache = false
        ..agents = [edgeAgent('other')];
      await app.syncAgentsForTest('m');
      await frames(tester);
      expect(find.text('fix-login is gone'), findsOneWidget);

      await tester.tap(find.text('Open another harness'));
      await frames(tester, count: 10);
      expect(find.byType(TerminalPage), findsNothing);
      expect(find.text('home'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 3));
      app.dispose();
      await tester.pump(const Duration(seconds: 30));
    });

    testWidgets('its pane closed while it is read: the page leaves', (
      tester,
    ) async {
      setPhone(tester, largePhone);
      final app = edgeApp();
      await liveTerminal(app, 'a');
      await tester.pumpWidget(
        phoneApp(
          Builder(
            builder: (context) => TextButton(
              onPressed: () => Navigator.of(context).push(
                MaterialPageRoute<void>(
                  builder: (_) => TerminalPage(
                    notifier: app,
                    machineId: 'm',
                    agentId: 'a',
                    voice: edgeVoice().voice,
                  ),
                ),
              ),
              child: const Text('home'),
            ),
          ),
        ),
      );
      await tester.tap(find.text('home'));
      await frames(tester);
      expect(find.byType(TerminalPage), findsOneWidget);

      await app.closePane(app.panes.single.id);
      await frames(tester, count: 10);
      expect(find.byType(TerminalPage), findsNothing);
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 3));
      app.dispose();
      await tester.pump(const Duration(seconds: 30));
    });
  });

  group('attaching', () {
    testWidgets('with animations off, the skeleton is drawn still', (
      tester,
    ) async {
      setPhone(tester, largePhone);
      final app = edgeApp();
      await tester.pumpWidget(
        phoneApp(
          MediaQuery(
            data: const MediaQueryData(disableAnimations: true),
            child: TerminalPage(
              notifier: app,
              machineId: 'm',
              agentId: 'a',
              voice: edgeVoice().voice,
            ),
          ),
        ),
      );
      await frames(tester);
      expect(find.bySemanticsLabel('Attaching to the harness'), findsOneWidget);
      // Nothing moves, so the tree settles — which a breathing skeleton never lets it do.
      await tester.pumpAndSettle();
      // ⚠️ And it is THERE: jumped to where the sweep would end. Before, a skeleton built with
      // animations already off never ran its sweep and never jumped it either — the reveal sat at
      // zero and the page waited on bare ground, which is the one thing the skeleton is for.
      expect(_skeletonReveal(tester), greaterThan(0.5));
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 3));
      app.dispose();
      await tester.pump(const Duration(seconds: 30));
    });

    testWidgets('parked beside the page on screen, then brought back', (
      tester,
    ) async {
      setPhone(tester, largePhone);
      final app = edgeApp();
      final voice = edgeVoice().voice;
      Widget page({required bool ticking}) => phoneApp(
        TickerMode(
          enabled: ticking,
          child: TerminalPage(
            notifier: app,
            machineId: 'm',
            agentId: 'a',
            voice: voice,
          ),
        ),
      );
      await tester.pumpWidget(page(ticking: true));
      await tester.pump(const Duration(milliseconds: 300));
      await tester.pumpWidget(page(ticking: false));
      await tester.pump();
      expect(_skeletonReveal(tester), greaterThan(0.5));
      await tester.pumpWidget(page(ticking: true));
      await tester.pump(const Duration(milliseconds: 300));
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 3));
      app.dispose();
      await tester.pump(const Duration(seconds: 30));
    });
  });

  // Back from a network switch or a redial, the terminal being read stays on screen under a light
  // blur and a spinner — never the attaching skeleton, which made it vanish and come back. The
  // skeleton is for a terminal with nothing on it yet (owner, 2026-10-15).
  group('brought back', () {
    Finder reconnecting() =>
        find.bySemanticsLabel('Reconnecting to the harness');
    Finder attaching() => find.bySemanticsLabel('Attaching to the harness');

    /// The terminal's socket dropping as the app sees it go: the machine dialling again, and the
    /// terminal on screen marked lost and waiting to be reopened.
    void socketDropped(_Focus focus) {
      final machine = focus.app.stateOf('m')!;
      machine.connectionStatus = ConnectionStatus.reconnecting;
      machine.pendingOfflineAgentId = 'a';
      focus.session.transportLost('Connection lost. Reconnecting…');
    }

    testWidgets('lost with its socket: the screen stays under a blur and a '
        'spinner until the new screen lands', (tester) async {
      final focus = await _Focus.open(tester);
      socketDropped(focus);
      await tester.pump();
      // A beat first: a quick return leaves the screen exactly as it was.
      expect(reconnecting(), findsNothing);

      await tester.pump(const Duration(milliseconds: 350));
      expect(reconnecting(), findsOneWidget);
      expect(attaching(), findsNothing);
      final overlay = find.byKey(const ValueKey('terminal-reconnecting'));
      expect(
        find.descendant(of: overlay, matching: find.byType(BackdropFilter)),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: overlay,
          matching: find.byType(CircularProgressIndicator),
        ),
        findsOneWidget,
      );
      // The screen is still the one that was read.
      expect(focus.session.hasScreen, isTrue);

      // Socket back, terminal reopened, the new screen lands: the spinner goes.
      focus.app.stateOf('m')!
        ..connectionStatus = ConnectionStatus.connected
        ..pendingOfflineAgentId = null;
      await focus.session.reopen();
      await focus.answerOpen(screen: 'what is now');
      await frames(tester);
      expect(reconnecting(), findsNothing);
      expect(attaching(), findsNothing);
      await focus.close();
    });

    testWidgets('no gap between the socket coming back and the reopen: the '
        'spinner stays, and does not start its beat over', (tester) async {
      final focus = await _Focus.open(tester);
      socketDropped(focus);
      // One frame to put the overlay up, then its beat.
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 350));
      expect(reconnecting(), findsOneWidget);

      // The socket is back while the terminal waits its turn (the app re-reads the list first).
      focus.app.stateOf('m')!.connectionStatus = ConnectionStatus.connected;
      focus.app.notifyListeners();
      await tester.pump();
      expect(reconnecting(), findsOneWidget);

      // Its turn: reopened, the old screen still on show under the same spinner.
      focus.app.stateOf('m')!.pendingOfflineAgentId = null;
      await focus.session.reopen();
      await tester.pump();
      expect(reconnecting(), findsOneWidget);
      expect(attaching(), findsNothing);

      await focus.answerOpen(screen: 'what is now');
      await frames(tester);
      expect(reconnecting(), findsNothing);
      await focus.close();
    });

    testWidgets('a quick reopen leaves the screen as it was: no spinner, no '
        'skeleton', (tester) async {
      final focus = await _Focus.open(tester);

      await focus.session.reopen(force: true);
      await tester.pump(const Duration(milliseconds: 100));
      expect(focus.session.showsEarlierScreen, isTrue);
      expect(reconnecting(), findsNothing);
      expect(attaching(), findsNothing);

      await focus.answerOpen(screen: 'what is now');
      await tester.pump(const Duration(milliseconds: 400));
      expect(reconnecting(), findsNothing);
      expect(attaching(), findsNothing);
      await focus.close();
    });

    testWidgets('lost and not waiting to be reopened: the screen, plainly, for '
        'a tap to reopen', (tester) async {
      final focus = await _Focus.open(tester);
      // The socket is up and nothing is queued to reopen this terminal.
      focus.session.transportLost('Connection lost. Reconnecting…');
      await frames(tester);

      expect(reconnecting(), findsNothing);
      expect(attaching(), findsNothing);
      await focus.close();
    });

    testWidgets('a terminal with nothing on it yet still waits behind the '
        'skeleton', (tester) async {
      setPhone(tester, largePhone);
      final app = edgeApp();
      await tester.pumpWidget(
        phoneApp(
          TerminalPage(
            notifier: app,
            machineId: 'm',
            agentId: 'a',
            voice: edgeVoice().voice,
          ),
        ),
      );
      await tester.pump(const Duration(milliseconds: 400));

      expect(attaching(), findsOneWidget);
      expect(reconnecting(), findsNothing);
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 3));
      app.dispose();
      await tester.pump(const Duration(seconds: 30));
    });

    testWidgets('its machine away: says why, and no spinner promises anything', (
      tester,
    ) async {
      setPhone(tester, largePhone);
      final app = edgeApp(online: false);
      final session = await liveTerminal(app, 'a');
      await tester.pumpWidget(
        phoneApp(
          TerminalPage(
            notifier: app,
            machineId: 'm',
            agentId: 'a',
            voice: edgeVoice().voice,
          ),
        ),
      );
      await session.reopen(force: true);
      // One frame to rebuild on the reopen, then longer than the spinner's beat.
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));

      expect(reconnecting(), findsNothing);
      expect(find.textContaining('is offline'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 3));
      app.dispose();
      await tester.pump(const Duration(seconds: 30));
    });

    testWidgets('with animations off, the spinner stands still', (tester) async {
      setPhone(tester, largePhone);
      final app = edgeApp();
      final session = await liveTerminal(app, 'a');
      await tester.pumpWidget(
        phoneApp(
          MediaQuery(
            data: const MediaQueryData(disableAnimations: true),
            child: TerminalPage(
              notifier: app,
              machineId: 'm',
              agentId: 'a',
              voice: edgeVoice().voice,
            ),
          ),
        ),
      );
      await session.reopen(force: true);
      // One frame to rebuild on the reopen, then longer than the spinner's beat.
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));

      expect(reconnecting(), findsOneWidget);
      final spinner = tester.widget<CircularProgressIndicator>(
        find.byType(CircularProgressIndicator),
      );
      expect(spinner.value, isNotNull, reason: 'a still ring, not a spinning one');
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 3));
      app.dispose();
      await tester.pump(const Duration(seconds: 30));
    });
  });

  group('more of what a thumb does', () {
    testWidgets('a restart the machine refuses says why', (tester) async {
      final focus = await _Focus.open(
        tester,
        answers: const {
          'agent_restart': {
            'error': 'TERMINAL_GONE',
            'detail': 'That harness has already exited.',
          },
        },
      );
      await tester.tap(find.byKey(const ValueKey('terminal-title')));
      await frames(tester);
      await tester.tap(find.text('Restart'));
      await frames(tester);
      expect(find.text('That harness has already exited.'), findsOneWidget);
      await focus.close();
    });

    testWidgets('a tap on the prompt mid-take types what was heard, and the '
        'keyboard picks up from there', (tester) async {
      final focus = await _Focus.open(tester);
      focus.fill();
      await frames(tester);
      focus.stt.replies.add('run the tests');
      await tester.tap(find.byType(VoiceMicCore));
      await frames(tester);
      expect(focus.voice.status, VoiceInputStatus.listening);
      await focus.tapPrompt();
      await frames(tester);
      expect(focus.typed.join(), contains('run the tests'));
      expect(focus.voice.status, VoiceInputStatus.idle);
      await focus.close();
    });

    testWidgets('a voice answer to a multi-select question is not sent', (
      tester,
    ) async {
      final focus = await _Focus.open(tester);
      focus.session.terminal.write(
        '\r\n ─────────────────────────────\r\n'
        ' Which checks should run?\r\n'
        ' ❯ 1. [ ] Lint\r\n'
        '   2. [ ] Tests\r\n'
        '\r\n'
        ' Enter to select · Esc to cancel',
      );
      await frames(tester);
      // The keyboard came up for the dialog; down again, the mic is back.
      await tester.tap(
        find.byKey(const ValueKey('terminal-key-Hide keyboard')),
      );
      await frames(tester);
      focus.stt.replies.add('lint');
      await tester.tap(find.byType(VoiceMicCore));
      await frames(tester);
      await tester.tap(find.byType(VoiceMicCore));
      await frames(tester, count: 2);
      expect(find.text('✗ answer on screen'), findsOneWidget);
      expect(focus.typed, isNot(contains('1')));
      // Two seconds on, the take's own line takes over.
      await tester.pump(const Duration(seconds: 2));
      await frames(tester);
      expect(find.text('✗ answer on screen'), findsNothing);
      await focus.close();
    });

    testWidgets('a scroll on a terminal another app holds takes it back', (
      tester,
    ) async {
      final focus = await _Focus.open(tester);
      focus.fill();
      await frames(tester);
      await focus.session.handleFrame('terminal_closed', {
        'streamId': focus.session.streamId,
        'code': 'TERMINAL_TAKEN_OVER',
        'reason': 'another client connected',
        'takenBy': {'machineId': 'm', 'label': 'MacBook'},
      });
      await frames(tester);
      expect(focus.session.status, TerminalSessionStatus.takenOver);
      final before = focus.opens;
      await tester.drag(
        find.byType(TerminalPage),
        const Offset(0, 300),
        warnIfMissed: false,
      );
      await frames(tester);
      expect(focus.opens, greaterThan(before));
      await focus.close();
    });

    testWidgets('a drag toward Find that is cancelled lets Find go', (
      tester,
    ) async {
      final focus = await _Focus.open(tester);
      final centre = tester.getCenter(find.byType(TerminalPage));
      final gesture = await tester.startGesture(centre - const Offset(120, 0));
      await gesture.moveBy(const Offset(40, 0));
      await gesture.moveBy(const Offset(60, 0));
      await tester.pump();
      expect(find.byType(TerminalSearchOverlay), findsOneWidget);
      await gesture.cancel();
      await frames(tester);
      expect(find.byType(TerminalSearchOverlay), findsNothing);
      await focus.close();
    });

    testWidgets('closed twice in a row, Find goes down once', (tester) async {
      final focus = await _Focus.open(tester);
      await tester.tap(find.byKey(const ValueKey('terminal-title')));
      await frames(tester);
      await tester.binding.handlePopRoute();
      await frames(tester);
      final centre = tester.getCenter(find.byType(TerminalPage));
      await tester.dragFrom(
        centre - const Offset(120, 0),
        const Offset(300, 0),
      );
      await frames(tester);
      expect(find.byType(TerminalSearchOverlay), findsOneWidget);
      // Back, and a tap on the dimming while the first close is still running.
      await tester.binding.handlePopRoute();
      await tester.pump(const Duration(milliseconds: 50));
      await tester.binding.handlePopRoute();
      await frames(tester);
      expect(find.byType(TerminalSearchOverlay), findsNothing);
      await focus.close();
    });
  });

  group('reading back', () {
    // The owner took the `[42/1380]` tag out: "we don't need the scrolling indicator".
    testWidgets('scrolled up, no position tag is drawn over the history', (
      tester,
    ) async {
      final focus = await _Focus.open(tester);
      focus.fill();
      await frames(tester);
      await tester.drag(
        find.byType(TerminalPage),
        const Offset(0, 500),
        warnIfMissed: false,
      );
      await frames(tester);
      expect(
        find.bySemanticsLabel(RegExp('lines above the end')),
        findsNothing,
      );
      await focus.close();
    });
  });

  group('a question, answered by voice', () {
    Future<_Focus> asked(WidgetTester tester) async {
      final focus = await _Focus.open(tester);
      focus.session.terminal.write(permissionDialog);
      await frames(tester);
      return focus;
    }

    testWidgets('"yes" said to the mic answers it', (tester) async {
      final focus = await asked(tester);
      focus.stt.replies.add('Yes.');
      await tester.tap(find.byType(VoiceMicCore));
      await frames(tester);
      await tester.tap(find.byType(VoiceMicCore));
      await frames(tester);
      expect(focus.typed, contains('1'));
      await focus.close();
    });

    testWidgets('"no, …" presses no, and the rest follows once it closes', (
      tester,
    ) async {
      final focus = await asked(tester);
      focus.stt.replies.add('No, build it with the flag instead');
      await tester.tap(find.byType(VoiceMicCore));
      await frames(tester);
      await tester.tap(find.byType(VoiceMicCore));
      await frames(tester);
      expect(focus.typed, contains('3'));
      // The question closes; the rest goes to the agent's prompt.
      focus.session.terminal.write('\x1b[2J\x1b[Hprompt> ');
      await tester.pump(const Duration(seconds: 1));
      await frames(tester);
      await focus.close();
    });
  });

  // The keys a pane's chrome offers and a phone cannot press, read off this
  // page's own buffer and drawn on its key strip — and taken off it again the
  // moment the pane cannot type.
  group('the pane\'s own keys on the strip', () {
    const queued = '\r\n  ? 1 question\r\n    shift+← to answer';
    const cycle = '\r\n  ⏵⏵ auto mode on (shift+tab to cycle)';
    final esc = find.byKey(const ValueKey('terminal-key-esc'));

    Future<_Focus> offered(
      WidgetTester tester, {
      String engine = 'codex',
      String screen = queued,
    }) async {
      final focus = await _Focus.open(
        tester,
        agents: [edgeAgent('a', engine: engine)],
      );
      raiseKeyboard(tester);
      await frames(tester);
      focus.session.terminal.write(screen);
      await frames(tester);
      return focus;
    }

    testWidgets('a Codex agent\'s queued question: its key on the strip, and '
        'the key answers it', (tester) async {
      final focus = await offered(tester);
      expect(esc, findsOneWidget);
      expect(find.text('answer'), findsOneWidget);
      expect(
        tester.getTopRight(find.text('answer')).dx,
        lessThan(tester.getTopLeft(esc).dx),
        reason: 'it leads the strip',
      );

      await tester.tap(find.text('answer'));
      await frames(tester);
      expect(focus.typed, contains('\x1b[1;2D'));
      await focus.close();
    });

    testWidgets('Claude Code\'s cycle: on the strip, past its own keys', (
      tester,
    ) async {
      final focus = await offered(tester, engine: 'claude', screen: cycle);
      expect(find.text('cycle'), findsOneWidget);
      expect(
        tester.getTopLeft(find.text('cycle')).dx,
        greaterThan(tester.getTopRight(esc).dx),
      );
      await focus.close();
    });

    testWidgets('taken by the computer: the pane\'s keys leave the strip', (
      tester,
    ) async {
      final focus = await offered(tester);
      expect(find.text('answer'), findsOneWidget);

      await focus.takenByComputer();
      await frames(tester);
      expect(focus.session.acceptsInput, isFalse);
      expect(find.text('answer'), findsNothing);
      await focus.close();
    });

    testWidgets('a stream that died: the pane\'s keys leave the strip', (
      tester,
    ) async {
      final focus = await offered(tester);
      expect(find.text('answer'), findsOneWidget);

      await focus.session.handleFrame('terminal_closed', {
        'streamId': focus.session.streamId,
        'code': 'TERMINAL_CLOSED',
        'reason': 'the daemon restarted',
      });
      await frames(tester);
      expect(focus.session.status, TerminalSessionStatus.closed);
      expect(find.text('answer'), findsNothing);
      await focus.close();
    });

    testWidgets('the agent is gone: no key of its pane is left', (
      tester,
    ) async {
      final focus = await offered(tester);
      expect(find.text('answer'), findsOneWidget);

      focus.app.stateOf('m')!
        ..agentsFromCache = false
        ..agents = [edgeAgent('other')];
      await focus.app.syncAgentsForTest('m');
      await frames(tester);
      expect(find.text('a is gone'), findsOneWidget);
      expect(find.text('answer'), findsNothing);
      await focus.close();
    });

    testWidgets('the hint goes once the pane stops offering it', (
      tester,
    ) async {
      final focus = await offered(tester);
      expect(find.text('answer'), findsOneWidget);

      // Answered: Codex redraws its bottom pane without the queue.
      focus.session.terminal.write('\x1b[2J\x1b[H› ');
      await frames(tester, count: 8);
      expect(find.text('answer'), findsNothing);
      expect(esc, findsOneWidget, reason: 'the strip itself stays');
      await focus.close();
    });
  });
}

/// The clipboard's contents as `Clipboard.getData` reports them.
Map<String, dynamic>? _clipboard;

/// How far the attaching skeleton's sweep has come, 0 (nothing drawn) to its stop short of 1 —
/// read off its painter, which is private to the page.
double _skeletonReveal(WidgetTester tester) {
  final painters = [
    for (final paint in tester.widgetList<CustomPaint>(
      find.byType(CustomPaint),
    ))
      if (paint.painter.runtimeType.toString() == '_SkeletonPainter')
        paint.painter,
  ];
  expect(painters, hasLength(1));
  final dynamic painter = painters.single;
  return (painter.reveal as Animation<double>).value;
}

/// Whether the mic can be pressed.
bool _micLive(WidgetTester tester) =>
    tester.widget<VoiceMicButton>(find.byType(VoiceMicButton)).onPressed !=
    null;

/// One Focus page, on a live agent, pushed over a home route inside a shell that records what it
/// is asked to open.
class _Focus {
  _Focus._(
    this._widgetTester,
    this.app,
    this.conn,
    this.session,
    this.voice,
    this.recorder,
    this.stt,
    this.opened,
    this.pushed,
    this.typed,
    this.sent,
  );

  final WidgetTester _widgetTester;
  final AppNotifier app;
  final EdgeConn conn;
  final TerminalSession session;
  final VoiceInputController voice;
  final FakeVoiceRecorder recorder;
  final FakeTranscriber stt;
  final List<(String, String)> opened;
  final List<Route<dynamic>> pushed;

  /// Everything the page typed into the terminal — keys, answers, pastes.
  final List<String> typed;

  /// Every frame the session sent — a reopen among them.
  final List<(String, Map<String, dynamic>)> sent;

  /// [connection], when given, is the machine instead of one answering from [answers].
  static Future<_Focus> open(
    WidgetTester tester, {
    List<Agent>? agents,
    Map<String, Map<String, dynamic>> answers = const {},
    EdgeConn? connection,
  }) async {
    setPhone(tester, largePhone);
    final conn = connection ?? EdgeConn(answers);
    final app = edgeApp(conn: conn, agents: agents ?? [edgeAgent('a')]);
    final sent = <(String, Map<String, dynamic>)>[];
    final session = await liveTerminal(app, 'a', sent: sent);
    final typed = <String>[];
    _record(session.terminal, typed);
    final voice = edgeVoice();
    final opened = <(String, String)>[];
    final pushed = <Route<dynamic>>[];
    await tester.pumpWidget(
      PhoneShellScope(
        onMachineLinked: (_) {},
        onOpenAgent: (machineId, agentId) => opened.add((machineId, agentId)),
        child: phoneApp(
          TerminalPage(
            notifier: app,
            machineId: 'm',
            agentId: 'a',
            voice: voice.voice,
          ),
          observers: [_Pushes(pushed)],
        ),
      ),
    );
    await frames(tester);
    return _Focus._(
      tester,
      app,
      conn,
      session,
      voice.voice,
      voice.recorder,
      voice.stt,
      opened,
      pushed,
      typed,
      sent,
    );
  }

  void ask(String agentId) =>
      app.stateOf('m')!.blockedAgents[agentId] = PendingQuestion(
        machineId: 'm',
        agentId: agentId,
        requestId: 'q-$agentId',
        answerKey: '1',
        prompt: 'Run the migration?',
        options: const ['Yes', 'No'],
        multi: false,
        since: DateTime.now(),
      );

  /// How many times the terminal was asked to open — by the machine's socket or by the session.
  int get opens =>
      conn.opens + sent.where((frame) => frame.$1 == 'terminal_open').length;

  /// The computer taking the terminal: the daemon closes this phone's stream as taken over.
  Future<void> takenByComputer() => session.handleFrame('terminal_closed', {
    'streamId': session.streamId,
    'code': 'TERMINAL_TAKEN_OVER',
    'reason': 'another client connected',
    'takenBy': {'machineId': 'm', 'label': 'MacBook'},
  });

  /// The daemon answering the session's latest open: a new stream, and its first screen — [screen],
  /// the terminal as it stands on the computer now — after which the session holds the terminal.
  Future<void> answerOpen({String screen = 'prompt> '}) async {
    final open = sent.lastWhere((frame) => frame.$1 == 'terminal_open').$2;
    final streamId = 'stream-${session.agentId}-again';
    await session.handleFrame('terminal_ready', {
      'requestId': open['requestId'],
      'agentId': session.agentId,
      'protocolVersion': TerminalSession.protocolVersion,
      'streamId': streamId,
    });
    await session.handleBinary(
      TerminalBinaryFrame(
        kind: TerminalBinaryKind.keyframe,
        streamId: streamId,
        seq: 0,
        bytes: Uint8List.fromList(utf8.encode(screen)),
        compressed: false,
        cols: session.terminal.viewWidth,
        rows: session.terminal.viewHeight,
      ),
    );
    // A keyframe swaps in a fresh terminal: what is typed into it is recorded too.
    _record(session.terminal, typed);
  }

  /// Records into [typed] everything typed into [terminal], and passes it on.
  static void _record(Terminal terminal, List<String> typed) {
    final forward = terminal.onOutput;
    terminal.onOutput = (data) {
      typed.add(data);
      forward?.call(data);
    };
  }

  /// A screenful of output, so the terminal fills the page rather than sitting anchored at its
  /// foot — where a tap on its middle would land on nothing.
  void fill() {
    for (var line = 0; line < 80; line++) {
      session.terminal.write('output line $line\r\n');
    }
  }

  /// A tap on the terminal's prompt — its last row, at the left, clear of the mic: the one part of
  /// the output a tap raises the keyboard from (`terminal_prompt_zone.dart`).
  Future<void> tapPrompt() async {
    final terminal = _widgetTester.getRect(find.byType(TerminalView));
    final screen =
        _widgetTester.view.physicalSize.height /
        _widgetTester.view.devicePixelRatio;
    final bottom = terminal.bottom < screen ? terminal.bottom : screen - 40;
    await _widgetTester.tapAt(Offset(terminal.left + 30, bottom - 8));
  }

  /// A tap on the terminal row that reads [text], at its left edge.
  Future<void> tapRow(String text) async {
    final lines = session.terminal.buffer.lines;
    var row = -1;
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].getText().contains(text)) row = i;
    }
    expect(row, isNot(-1), reason: '"$text" is on the screen');
    final view = _widgetTester.getRect(find.byType(TerminalView));
    final style = terminalFontStore.value;
    final cell = style.fontSize * style.height;
    final scrolled = lines.length - session.terminal.viewHeight;
    final y = view.top + (row - (scrolled < 0 ? 0 : scrolled) + 0.5) * cell;
    await _widgetTester.tapAt(Offset(view.left + 40, y));
  }

  /// A tap on the middle of [text] where the terminal draws it — the lowest place it appears.
  Future<void> tapText(String text) async {
    final view = _widgetTester.state<TerminalViewState>(
      find.byType(TerminalView),
    );
    final render = view.renderTerminal;
    final lines = view.widget.terminal.buffer.lines;
    var row = -1;
    var column = -1;
    for (var i = 0; i < lines.length; i++) {
      final at = lines[i].getText().indexOf(text);
      if (at < 0) continue;
      row = i;
      column = at;
    }
    expect(row, isNot(-1), reason: '"$text" is on the screen');
    final cell = render.getOffset(CellOffset(column + text.length ~/ 2, row));
    await _widgetTester.tapAt(
      render.localToGlobal(
        cell + Offset(render.cellSize.width / 2, render.lineHeight / 2),
      ),
    );
  }

  /// [agentId] stops to ask something, as its machine announces it.
  Future<void> question(String agentId) => app.handleMachineEventForTest('m', {
    'type': 'commander_question',
    'payload': {
      'agentId': agentId,
      'requestId': 'q-$agentId',
      'questions': [
        {
          'q': 'Run the migration?',
          'options': ['Yes', 'No'],
        },
      ],
    },
  });

  /// [agentId]'s question answered — here, elsewhere, or by hand.
  Future<void> answered(String agentId) => app.handleMachineEventForTest('m', {
    'type': 'commander_question_close',
    'payload': {'agentId': agentId, 'requestId': 'q-$agentId'},
  });

  /// Takes the page down, runs its clocks out and lets the app go — inside the test, so no timer
  /// the app started (an offline machine's retry) outlives it.
  Future<void> close() async {
    final tester = _widgetTester;
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 3));
    app.dispose();
    await tester.pump(const Duration(seconds: 30));
  }
}

/// A machine whose answer to `agent_restart` the test writes: held until the test gives it, or
/// thrown — the way a real socket hands the page a refusal ([WsRequestFailure]) and a reply that
/// never came ([WsRequestTimeout]).
class _RestartConn extends EdgeConn {
  _RestartConn(this.restart);

  /// What every `agent_restart` gets back.
  final Future<Map<String, dynamic>> Function() restart;

  /// How many restarts were sent.
  int get restarts => payloads['agent_restart']?.length ?? 0;

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) {
    if (type != 'agent_restart') {
      return super.request(type, payload: payload, timeout: timeout);
    }
    requests.add(type);
    (payloads[type] ??= []).add(payload);
    return restart();
  }
}

/// A machine whose every `agent_handoff_prepare` waits on [handoff] — a Change agent held mid-way.
class _SwitchConn extends EdgeConn {
  _SwitchConn(this.handoff);

  final Future<Map<String, dynamic>> Function() handoff;

  /// How many handoffs were asked for.
  int get handoffs => payloads['agent_handoff_prepare']?.length ?? 0;

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) {
    if (type != 'agent_handoff_prepare') {
      return super.request(type, payload: payload, timeout: timeout);
    }
    requests.add(type);
    (payloads[type] ??= []).add(payload);
    return handoff();
  }
}

/// A machine whose `agent_fork` answers only when [reply] does — a fork still on its way.
class _HeldForkConn extends EdgeConn {
  _HeldForkConn(this.reply);

  final Future<Map<String, dynamic>> reply;

  /// The receipt the fork was sent under, for the answer to echo.
  String? get receipt =>
      payloads['agent_fork']?.single['creationId'] as String?;

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) {
    if (type != 'agent_fork') {
      return super.request(type, payload: payload, timeout: timeout);
    }
    requests.add(type);
    (payloads[type] ??= []).add(payload);
    return reply;
  }
}

/// A machine that answers Delete's review with [review], and deletes under any review id.
class _PurgeConn extends EdgeConn {
  _PurgeConn(this.review);

  final Future<Map<String, dynamic>> review;

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) {
    if (type != 'agent_purge') {
      return super.request(type, payload: payload, timeout: timeout);
    }
    requests.add(type);
    (payloads[type] ??= []).add(payload);
    return payload['mode'] == 'inspect'
        ? review
        : Future.value({'deleted': true});
  }
}

/// A machine whose `agent_create` answers only when [reply] does — a clone still on its way.
class _HeldCreateConn extends EdgeConn {
  _HeldCreateConn(this.reply);

  final Future<Map<String, dynamic>> reply;

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) {
    if (type != 'agent_create') {
      return super.request(type, payload: payload, timeout: timeout);
    }
    requests.add(type);
    (payloads[type] ??= []).add(payload);
    return reply;
  }
}

class _Pushes extends NavigatorObserver {
  _Pushes(this.pushed);

  final List<Route<dynamic>> pushed;

  @override
  void didPush(Route<dynamic> route, Route<dynamic>? previousRoute) =>
      pushed.add(route);
}
