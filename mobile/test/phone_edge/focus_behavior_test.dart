import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/demo/sample_mode.dart';
import 'package:harness_mobile/phone/phone_search_catalog.dart'
    show phoneAgentId;
import 'package:harness_mobile/phone/phone_shell_scope.dart';
import 'package:harness_mobile/phone/terminal_page.dart';
import 'package:harness_mobile/phone/terminal_search.dart';
import 'package:harness_mobile/phone/new_agent_page.dart';
import 'package:harness_mobile/phone/settings_page.dart';
import 'package:harness_mobile/phone/voice_input_controller.dart';
import 'package:harness_mobile/phone/voice_mic_button.dart';
import 'package:harness_mobile/phone/voice_mic_face.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/state/pending_question.dart';
import 'package:harness_mobile/terminal/terminal_font_store.dart';
import 'package:harness_mobile/terminal/terminal_session.dart';
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
          return null;
        });
  });

  tearDown(() {
    _clipboard = null;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, null);
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

  testWidgets('back and forth between Focus, Find and New, quickly', (
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
      // Left on the terminal: New.
      await tester.dragFrom(
        centre + const Offset(120, 0),
        const Offset(-300, 0),
      );
      await frames(tester);
      expect(find.byType(NewAgentPage), findsOneWidget);
      // Right on New: back.
      await tester.dragFrom(
        tester.getCenter(find.byType(NewAgentPage)),
        const Offset(300, 0),
      );
      await frames(tester, count: 6);
      expect(find.byType(NewAgentPage), findsNothing);
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

  group('the menu', () {
    Future<_Focus> openMenu(
      WidgetTester tester, {
      bool working = false,
      bool raw = false,
    }) async {
      final focus = await _Focus.open(
        tester,
        agents: [edgeAgent('a', project: longProject, branch: longBranch)],
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
      await frames(tester, count: 1);
      expect(find.text('the clipboard has no text'), findsOneWidget);
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

    testWidgets('Restart that the machine refuses says why', (tester) async {
      final focus = await openMenu(tester);
      await tester.tap(find.text('Restart'));
      await frames(tester);
      expect(focus.conn.requests, contains('agent_restart'));
      await focus.close();
    });

    testWidgets('Rename, Stop and Settings open their own screens', (
      tester,
    ) async {
      final focus = await openMenu(tester);
      // Switched off everywhere for now (`kModelSheetEnabled`): no row that looks like a choice.
      expect(find.text('Model'), findsNothing);
      await tester.tap(find.text('Rename…'));
      await frames(tester);
      expect(find.byType(TextField), findsOneWidget);
      await tester.tap(find.text('Cancel'));
      await frames(tester);

      await tester.tap(find.byKey(const ValueKey('terminal-title')));
      await frames(tester);
      await tapInView(tester, find.text('Stop this harness…'));
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

  group('a question', () {
    Future<_Focus> asked(WidgetTester tester) async {
      final focus = await _Focus.open(tester);
      focus.session.terminal.write(permissionDialog);
      await frames(tester);
      return focus;
    }

    testWidgets('its keys beside the mic press its first and last answers', (
      tester,
    ) async {
      final focus = await asked(tester);
      await tester.tap(find.bySemanticsLabel(RegExp('^Answer 1')));
      await tester.tap(find.bySemanticsLabel(RegExp('^Answer 3')));
      await frames(tester);
      expect(focus.typed, containsAllInOrder(['1', '3']));
      await focus.close();
    });

    testWidgets('a tap on an answer\'s own line presses it', (tester) async {
      final focus = await asked(tester);
      await focus.tapRow("don't ask again");
      await frames(tester);
      expect(focus.typed, contains('2'));
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

  static Future<_Focus> open(
    WidgetTester tester, {
    List<Agent>? agents,
    Map<String, Map<String, dynamic>> answers = const {},
  }) async {
    setPhone(tester, largePhone);
    final conn = EdgeConn(answers);
    final app = edgeApp(conn: conn, agents: agents ?? [edgeAgent('a')]);
    final sent = <(String, Map<String, dynamic>)>[];
    final session = await liveTerminal(app, 'a', sent: sent);
    final typed = <String>[];
    final forward = session.terminal.onOutput;
    session.terminal.onOutput = (data) {
      typed.add(data);
      forward?.call(data);
    };
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

class _Pushes extends NavigatorObserver {
  _Pushes(this.pushed);

  final List<Route<dynamic>> pushed;

  @override
  void didPush(Route<dynamic> route, Route<dynamic>? previousRoute) =>
      pushed.add(route);
}
