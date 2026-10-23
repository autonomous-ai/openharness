import 'dart:io' show Platform;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:xterm/xterm.dart' show Terminal;

import 'package:harness_mobile/auth/auth_session.dart';
import 'package:harness_mobile/core/config.dart';
import 'package:harness_mobile/core/engine_availability.dart';
import 'package:harness_mobile/core/first_task.dart';
import 'package:harness_mobile/demo/main_sample.dart' show SampleApp;
import 'package:harness_mobile/demo/sample_mode.dart' show SampleMode;
import 'package:harness_mobile/phone/agent_home.dart';
import 'package:harness_mobile/phone/new_agent_draft.dart';
import 'package:harness_mobile/phone/new_agent_page.dart';
import 'package:harness_mobile/phone/phone_shell.dart';
import 'package:harness_mobile/phone/phone_shell_scope.dart';
import 'package:harness_mobile/phone/first_task_suggestion.dart';
import 'package:harness_mobile/phone/terminal_page.dart';
import 'package:harness_mobile/phone/tty_controls.dart';
import 'package:harness_mobile/phone/voice_input_controller.dart';
import 'package:harness_mobile/phone/voice_mic_button.dart';
import 'package:harness_mobile/phone/welcome/onboarding_copy.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart' as grid;
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/terminal/terminal_session.dart';

import '../test/voice_fakes.dart';

const _studio = 'sample-studio';

/// The first session's chips and New Harness's engine choice, in the real app on a phone, over the
/// offline sample: its computer stands in for the owner's, so no account, no network and no real
/// computer is touched. A screenshot at each step.
///
///     HARNESS_PHONE=iphone14 flutter drive -d <phone> --driver=test_driver/first_task_driver.dart \
///       --target=integration_test/first_task_test.dart
///
/// Android needs its surface converted to an image before a screenshot can read it (once).
void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('first session chips, and the engine New Harness opens on', (
    tester,
  ) async {
    var step = 0;
    var surfaceReady = !Platform.isAndroid;
    Future<void> shot(String name) async {
      await tester.pump(const Duration(milliseconds: 300));
      if (!surfaceReady) {
        await binding.convertFlutterSurfaceToImage();
        await tester.pump();
        surfaceReady = true;
      }
      step++;
      await binding.takeScreenshot('${step.toString().padLeft(2, '0')}-$name');
    }

    Future<void> wait([int ms = 600]) async {
      for (var elapsed = 0; elapsed < ms; elapsed += 100) {
        await tester.pump(const Duration(milliseconds: 100));
      }
    }

    Future<void> waitFor(Finder finder, {int seconds = 20}) async {
      for (var i = 0; i < seconds * 10; i++) {
        if (finder.evaluate().isNotEmpty) return;
        await tester.pump(const Duration(milliseconds: 100));
      }
      fail('never appeared: $finder');
    }

    late AppNotifier notifier;
    Future<void> openAgent(String agentId) async {
      PhoneShellScope.maybeOf(tester.element(find.byType(AgentHome)))!
          .onOpenAgent(_studio, agentId);
      await wait(2000);
    }

    String screenOf(String agentId) {
      final session = notifier.paneOfAgent(_studio, agentId)?.session;
      if (session == null) return '';
      final lines = session.terminal.buffer.lines;
      return [for (var i = 0; i < lines.length; i++) lines[i].toString()]
          .join('\n')
          .replaceAll(RegExp(r'\s*\n\s*'), ' ');
    }

    String agentRow() => tester
        .widget<TtyFormRow>(
          find.byWidgetPredicate((w) => w is TtyFormRow && w.label == 'agent'),
        )
        .value;

    Future<void> openNewHarness() async {
      await openAgent('sample-fix-login');
      await tester.dragFrom(
        tester.getCenter(find.byType(AgentHome).first) - const Offset(120, 0),
        const Offset(300, 0),
      );
      await wait(900);
      await tester.tap(find.byKey(const ValueKey('find-new-harness')));
      await waitFor(find.byType(NewAgentPage));
      await wait(1200);
    }

    Future<void> leaveNewHarness() async {
      Navigator.of(tester.element(find.byType(NewAgentPage))).pop();
      await wait(900);
      // A form left keeps its draft, engine included (saved as it is taken down); each visit here
      // starts fresh.
      newAgentDraft = null;
    }

    await tester.pumpWidget(const SampleApp());
    await waitFor(find.text('fix-login', findRichText: true));
    await wait(3000);
    notifier = tester.widget<PhoneShell>(find.byType(PhoneShell)).notifier;
    // The sample's computer is signed in to Claude Code and Codex, Claude Code used last.
    await shot('computer-reached');

    // New Harness on a computer with Claude signed in: it opens on Claude Code.
    await openNewHarness();
    expect(agentRow(), 'Claude Code');
    await shot('new-harness-claude-signed-in');
    await leaveNewHarness();

    // Nothing signed in on the computer: OpenCode, never an engine that cannot be used.
    notifier.machineStates[_studio]!.engines.replace(const [
      EngineAvailability(engine: 'claude', installed: true, signedIn: false),
      EngineAvailability(engine: 'codex', installed: true, signedIn: false),
      EngineAvailability(engine: 'opencode', installed: true, signedIn: false),
    ]);
    await openNewHarness();
    expect(agentRow(), 'OpenCode');
    await shot('new-harness-nothing-signed-in');
    await leaveNewHarness();
    notifier.machineStates[_studio]!.engines.replace(const [
      EngineAvailability(
        engine: 'claude',
        installed: true,
        signedIn: true,
        lastUsedAt: 2,
      ),
      EngineAvailability(engine: 'codex', installed: true, signedIn: false),
    ]);

    // A harness of the person's own, started on Claude Code. The sample's tour is over (its guide
    // would otherwise own the line by the mic), as it is on a real computer.
    SampleMode.maybeOf(tester.element(find.byType(AgentHome)))!.endCardSeen =
        true;
    await openNewHarness();
    expect(agentRow(), 'Claude Code');
    await tester.tap(find.text('project'));
    await wait(500);
    await tester.tap(
      find.textContaining('studio:~/code/web', findRichText: true),
    );
    await wait(500);
    await tester.tap(find.text('Start'));
    await wait(3000);
    final agentId = notifier
        .stateOf(_studio)!
        .agents
        .map((agent) => agent.id)
        .singleWhere((id) => id.startsWith('sample-new-'));

    // The first session, as the hand-over from the onboarding opens it.
    // Leaving a session spends its line, so the harness's page goes first and is opened again.
    await openAgent('sample-api-tests');
    notifier.firstSessionLine = (
      machineId: _studio,
      agentId: agentId,
      text: OnboardingCopy.micSayWhat,
    );
    await openAgent(agentId);
    await waitFor(find.text(OnboardingCopy.micSayWhat));
    expect(find.text(firstTaskIdeas.first, findRichText: true), findsOneWidget);
    for (final other in firstTaskIdeas.skip(1)) {
      expect(find.text(other, findRichText: true), findsNothing);
    }
    await shot('first-session-suggestion');

    // Send sends the suggestion at once, and the computer gets it. (The sample never spends the
    // line: a sample's sends do not answer the onboarding — `_onLineSent` — so its suggestion stays;
    // the real page below shows it go.)
    await tester.tap(find.byKey(FirstSessionSuggestion.sendKey));
    await wait(200);
    await shot('send-tapped');
    await wait(2500);
    expect(screenOf(agentId), contains('> ${firstTaskIdeas.first}'));
    await shot('task-on-the-computer');

    // The production page over a fake transport, and the production voice controller over a fake
    // recorder and recognizer: no microphone, no network. A page is opened for each run.
    final language = ValueNotifier('en');
    addTearDown(language.dispose);
    Future<
      ({
        AppNotifier app,
        TerminalSession session,
        VoiceInputController voice,
        FakeTranscriber transcriber,
        List<(String, Object)> sent,
      })
    >
    openRealPage({
      TerminalSessionStatus status = TerminalSessionStatus.controlling,
    }) async {
      final sent = <(String, Object)>[];
      late TerminalSession session;
      final app = AppNotifier(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      );
      session =
          TerminalSession(
              machineId: 'm',
              agentId: 'a',
              agentName: 'Agent',
              engineId: 'claude',
              send: (type, payload) async {
                sent.add((type, payload));
                if (type == 'message') {
                  session.terminal.write(
                    '\r\n> ${(payload as Map)['content']}\r\n⏺ On it.\r\n',
                  );
                }
                return true;
              },
              sendBinary: (frame) async => true,
            )
            ..status = status
            ..streamId = 'stream';
      app.adoptSessionForTest(session);
      // What the agent had drawn before the first message: its welcome and an empty prompt.
      session.seedScreen(
        Terminal(maxLines: 500)..write(
          '\u2554 Welcome to Claude Code!\r\n  cwd: ~/code/web\r\n\r\n> ',
        ),
      );
      final transcriber = FakeTranscriber();
      final voice = VoiceInputController(
        transcriber: transcriber.call,
        recorder: FakeVoiceRecorder(),
        language: language,
      );
      app.firstSessionLine = (
        machineId: 'm',
        agentId: 'a',
        text: OnboardingCopy.micSayWhat,
      );
      await tester.pumpWidget(
        MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: TerminalPage(
            notifier: app,
            machineId: 'm',
            agentId: 'a',
            voice: voice,
          ),
        ),
      );
      await waitFor(find.text(OnboardingCopy.micSayWhat));
      return (
        app: app,
        session: session,
        voice: voice,
        transcriber: transcriber,
        sent: sent,
      );
    }

    Future<void> closeRealPage(
      VoiceInputController voice,
      AppNotifier app,
    ) async {
      await tester.pumpWidget(const SizedBox());
      voice.dispose();
      app.dispose();
    }

    List<Object?> messages(List<(String, Object)> sent) => [
      for (final m in sent)
        if (m.$1 == 'message') (m.$2 as Map)['content'],
    ];
    final send = find.byKey(FirstSessionSuggestion.sendKey);
    bool sendEnabled() =>
        tester
            .widget<FirstSessionSuggestion>(find.byType(FirstSessionSuggestion))
            .onSend !=
        null;

    // Send is disabled while the session does not take input (here resyncing), and wakes with it.
    final waiting = await openRealPage(status: TerminalSessionStatus.resyncing);
    expect(sendEnabled(), isFalse);
    await shot('send-disabled-app-page');
    await tester.tap(send, warnIfMissed: false);
    await wait(300);
    expect(messages(waiting.sent), isEmpty);
    waiting.session.status = TerminalSessionStatus.controlling;
    waiting.session.notifyListeners();
    await wait(300);
    expect(sendEnabled(), isTrue);
    await shot('send-enabled-app-page');

    // One tap sends exactly the suggestion once, and the suggestion goes with the line.
    await tester.tap(send);
    await tester.tap(send, warnIfMissed: false);
    await wait(300);
    await shot('send-tapped-app-page');
    await wait(1500);
    expect(messages(waiting.sent), [firstTaskIdeas.first]);
    expect(waiting.app.firstSessionLine, isNull);
    expect(send, findsNothing);
    expect(find.text(firstTaskIdeas.first), findsNothing);
    await shot('suggestion-gone-app-page');
    await closeRealPage(waiting.voice, waiting.app);

    // The mic is the other way in: the real controller and mic button, an injected transcript.
    final spoken = await openRealPage();
    await shot('voice-suggestion-app-page');
    spoken.transcriber.replies.add('add a login page');
    await tester.tap(find.byType(VoiceMicButton));
    await wait(600);
    expect(spoken.voice.status, VoiceInputStatus.listening);
    // The take is on: the suggestion and its line wait, nothing is left standing over an empty row.
    expect(send, findsNothing);
    expect(find.text(OnboardingCopy.micSayWhat), findsNothing);
    await shot('voice-listening-app-page');
    await tester.tap(find.byType(VoiceMicButton));
    await wait(1500);
    expect(messages(spoken.sent), ['add a login page']);
    expect(spoken.app.firstSessionLine, isNull);
    expect(send, findsNothing);
    await shot('voice-sent-suggestion-gone-app-page');
    await closeRealPage(spoken.voice, spoken.app);
  });
}
