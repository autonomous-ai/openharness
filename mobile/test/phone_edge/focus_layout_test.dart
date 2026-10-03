import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/demo/sample_mode.dart';
import 'package:harness_mobile/phone/terminal_page.dart';
import 'package:harness_mobile/phone/voice_input_controller.dart';
import 'package:harness_mobile/phone/voice_mic_face.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:xterm/xterm.dart';

import 'edge_fixture.dart';

/// Focus — one agent's terminal, full screen — laid out at every phone, scale and brightness the
/// phone meets, with the names that break layouts. None may report an overflow.
void main() {
  setUpAll(loadRealFontsIfAsked);
  // The keyboard is kept once for the screen, not per page: see `resetKeyboardSession`.
  setUp(resetKeyboardSession);

  Future<void> pumpFocus(
    WidgetTester tester,
    AppNotifier app,
    double scale,
    Brightness brightness, {
    String agentId = 'a',
  }) async {
    final voice = edgeVoice().voice;
    await tester.pumpWidget(
      phoneApp(
        TerminalPage(
          notifier: app,
          machineId: 'm',
          agentId: agentId,
          voice: voice,
        ),
        textScale: scale,
        brightness: brightness,
      ),
    );
    await frames(tester);
  }

  for (final (label, name) in [
    ('a long name', longName),
    ('an emoji name', emojiName),
    ('a right-to-left name', rtlName),
  ]) {
    testWidgets('a live agent with $label', (tester) async {
      await expectNoLayoutErrors(tester, (scale, brightness) async {
        final app = edgeApp(
          machineName: longMachine,
          agents: [
            edgeAgent(
              'a',
              name: name,
              project: longProject,
              branch: longBranch,
            ),
          ],
        );
        addTearDown(app.dispose);
        await liveTerminal(app, 'a', name: name);
        await pumpFocus(tester, app, scale, brightness);
      });
    });
  }

  testWidgets('an agent among 200, several of them asking', (tester) async {
    await expectNoLayoutErrors(tester, (scale, brightness) async {
      final app = edgeApp(agents: manyAgents(200, firstName: longName));
      addTearDown(app.dispose);
      await liveTerminal(app, 'a0');
      await pumpFocus(tester, app, scale, brightness, agentId: 'a0');
    });
  });

  testWidgets('attaching: no terminal yet', (tester) async {
    await expectNoLayoutErrors(tester, (scale, brightness) async {
      final app = edgeApp(agents: [edgeAgent('a', name: longName)]);
      addTearDown(app.dispose);
      await pumpFocus(tester, app, scale, brightness);
    });
  });

  testWidgets('the agent is gone', (tester) async {
    await expectNoLayoutErrors(tester, (scale, brightness) async {
      final app = edgeApp(agents: [edgeAgent('other')]);
      addTearDown(app.dispose);
      app.stateOf('m')!.agentsFromCache = false;
      await pumpFocus(tester, app, scale, brightness);
    });
  });

  testWidgets('a question open, with its keys beside the mic', (tester) async {
    await expectNoLayoutErrors(tester, (scale, brightness) async {
      final app = edgeApp(agents: [edgeAgent('a', name: longName)]);
      addTearDown(app.dispose);
      final session = await liveTerminal(app, 'a');
      session.terminal.write(permissionDialog);
      await pumpFocus(tester, app, scale, brightness);
      expect(find.bySemanticsLabel(RegExp('^Answer 1')), findsOneWidget);
    });
  });

  testWidgets('the keyboard up, with the pane\'s own keys on the strip', (
    tester,
  ) async {
    await expectNoLayoutErrors(tester, (scale, brightness) async {
      final app = edgeApp(agents: [edgeAgent('a', name: emojiName)]);
      addTearDown(app.dispose);
      final session = await liveTerminal(app, 'a');
      session.terminal.write(
        '\r\n  ⏵⏵ accept edits on (shift+tab to cycle)\r\n',
      );
      await pumpFocus(tester, app, scale, brightness);
      await tester.tap(find.byType(TerminalView));
      await tester.pump();
      raiseKeyboard(tester);
      await frames(tester);
      expect(find.byKey(const ValueKey('terminal-key-esc')), findsOneWidget);
      lowerKeyboard(tester);
      await frames(tester);
    });
  });

  testWidgets('recording, with what was heard on the line above the mic', (
    tester,
  ) async {
    await expectNoLayoutErrors(tester, (scale, brightness) async {
      final app = edgeApp(agents: [edgeAgent('a', name: rtlName)]);
      addTearDown(app.dispose);
      await liveTerminal(app, 'a');
      final voice = edgeVoice().voice;
      await tester.pumpWidget(
        phoneApp(
          TerminalPage(
            notifier: app,
            machineId: 'm',
            agentId: 'a',
            voice: voice,
          ),
          textScale: scale,
          brightness: brightness,
        ),
      );
      await frames(tester);
      await tester.tap(find.byType(VoiceMicCore));
      await frames(tester);
      expect(voice.status, VoiceInputStatus.listening);
      voice.clear();
      await frames(tester);
    });
  });

  testWidgets('the title\'s menu, for an agent with every name long', (
    tester,
  ) async {
    await expectNoLayoutErrors(tester, (scale, brightness) async {
      final app = edgeApp(
        machineName: longMachine,
        agents: [
          edgeAgent(
            'a',
            name: longName,
            project: longProject,
            branch: longBranch,
          ),
        ],
      );
      addTearDown(app.dispose);
      await liveTerminal(app, 'a');
      await pumpFocus(tester, app, scale, brightness);
      await tester.tap(find.byKey(const ValueKey('terminal-title')));
      await frames(tester);
      expect(find.text('Rename…'), findsOneWidget);
    });
  });

  testWidgets('the sample\'s end card', (tester) async {
    await expectNoLayoutErrors(tester, (scale, brightness) async {
      final app = edgeApp(agents: [edgeAgent('sample-new-1', name: longName)]);
      addTearDown(app.dispose);
      await liveTerminal(app, 'sample-new-1');
      final voice = edgeVoice().voice;
      await tester.pumpWidget(
        phoneApp(
          SampleMode(
            session: FakeSample(app),
            child: TerminalPage(
              notifier: app,
              machineId: 'm',
              agentId: 'sample-new-1',
              voice: voice,
            ),
          ),
          textScale: scale,
          brightness: brightness,
        ),
      );
      await frames(tester);
      await tester.pump(const Duration(seconds: 9));
      await frames(tester);
      expect(find.text('That’s Harness.'), findsOneWidget);
    });
  });

  testWidgets('the machine is offline', (tester) async {
    await expectNoLayoutErrors(tester, (scale, brightness) async {
      final app = edgeApp(
        online: false,
        machineName: longMachine,
        agents: [edgeAgent('a', name: longName)],
      );
      addTearDown(app.dispose);
      await pumpFocus(tester, app, scale, brightness);
    });
  });
}
