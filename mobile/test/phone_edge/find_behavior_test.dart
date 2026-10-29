import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/notify/agent_notice.dart' show NoticeKind;
import 'package:harness_mobile/phone/new_agent_page.dart';
import 'package:harness_mobile/phone/phone_shell_scope.dart';
import 'package:harness_mobile/phone/settings_page.dart';
import 'package:harness_mobile/phone/terminal_search.dart';
import 'package:harness_mobile/phone/tty_controls.dart' show TtyFieldMic;
import 'package:harness_mobile/phone/voice_input_controller.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/swarm/swarm_page.dart';

import '../voice_fakes.dart';
import 'edge_fixture.dart';

/// Find as somebody uses it: every word a row can wear, the field's mic and its clear, Back
/// stepping out one step at a time, `+ New Harness`, a command, a paused harness brought back and a
/// conversation Harness did not start.
void main() {
  /// A conversation this machine's index heard "dial" in, one Harness did not start.
  Map<String, dynamic>? machine(String type, Map<String, dynamic> payload) {
    if (type == 'session_search') {
      return {
        'hits': [
          if ((payload['query'] as String).startsWith('dial'))
            {
              'agentId': '',
              'sessionId': 'c0ffee',
              'engine': 'claude',
              'field': 'ask',
              'snippet': 'make the \u0002dial\u0003 scroll smoothly',
              'together': true,
              'score': 1,
              'external': {
                'cwd': '/home/u/code/dial',
                'title': 'Fix the dial',
                'origin': 'terminal',
                'open': false,
              },
            },
        ],
      };
    }
    if (type == 'agent_resume') return {'error': 'That harness is gone.'};
    return startsAgents(type, payload);
  }

  Future<
    ({
      AppNotifier app,
      List<int> closes,
      List<(String, String)> opened,
      VoiceInputController voice,
      FakeTranscriber stt,
    })
  >
  openFind(WidgetTester tester, {bool handshaken = false}) async {
    setPhone(tester, largePhone);
    final app = edgeApp(
      conn: EdgeConn(const {}, machine)..handshaken = handshaken,
      agents: [
        edgeAgent('a0', name: 'on-screen'),
        edgeAgent('work', name: 'working'),
        edgeAgent('done', name: 'finished'),
        Agent(
          id: 'paused',
          name: 'paused-work',
          engine: 'claude',
          sessionId: 's-paused',
          status: 'stopped',
          project: const AgentProject(name: 'web', cwd: '/code/web'),
        ),
        const Agent(
          id: 'gone',
          name: 'exited-one',
          engine: 'aider',
          project: AgentProject(name: 'web', cwd: '/code/web'),
        ),
      ],
    );
    app.stateOf('m')!.processingAgentIds.add('work');
    app.agentNotices.unread.mark((
      machineId: 'm',
      agentId: 'done',
    ), NoticeKind.done);
    final closes = <int>[];
    final opened = <(String, String)>[];
    final voice = edgeVoice();
    await tester.pumpWidget(
      PhoneShellScope(
        onMachineLinked: (_) {},
        onOpenAgent: (machineId, agentId) => opened.add((machineId, agentId)),
        child: phoneApp(
          Scaffold(
            body: TerminalSearchOverlay(
              notifier: app,
              animation: const AlwaysStoppedAnimation(1),
              onClose: () => closes.add(closes.length),
              showing: (machineId: 'm', agentId: 'a0'),
              voice: voice.voice,
            ),
          ),
        ),
      ),
    );
    await frames(tester);
    return (
      app: app,
      closes: closes,
      opened: opened,
      voice: voice.voice,
      stt: voice.stt,
    );
  }

  Future<void> close(WidgetTester tester, AppNotifier app) async {
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 3));
    app.dispose();
    await tester.pump(const Duration(seconds: 30));
  }

  /// A row's state word, at the end of its first line: alone, or ahead of the row's age
  /// (`done · 5m`).
  Finder state(String word) =>
      find.textContaining(RegExp('^${RegExp.escape(word)}( · |\$)'));

  testWidgets('each row says what its harness is doing', (tester) async {
    final (:app, closes: _, opened: _, voice: _, stt: _) = await openFind(
      tester,
    );
    // `working` is that harness's name too: its word is the one ahead of its age.
    expect(find.textContaining(RegExp(r'^working · ')), findsOneWidget);
    expect(state('done'), findsOneWidget);
    expect(state('paused'), findsOneWidget);
    expect(state('exited'), findsOneWidget);
    // The harness on screen says `current` where its age would be — and, idle, no word ahead of
    // it: idle says nothing (owner, 2026-09-30).
    expect(find.text('current'), findsOneWidget);
    await close(tester, app);
  });

  testWidgets('the harness on screen is Cancel; another opens as the home '
      'screen', (tester) async {
    final (:app, :closes, :opened, voice: _, stt: _) = await openFind(tester);
    await tester.tap(find.text('on-screen', findRichText: true).first);
    await tester.pump();
    expect(closes, hasLength(1));
    expect(opened, isEmpty);

    await tester.tap(find.text('working', findRichText: true).first);
    await tester.pump();
    expect(opened, [('m', 'work')]);
    await close(tester, app);
  });

  testWidgets('Find opens with the keys down, and a tap on the field takes a '
      'query', (tester) async {
    final (:app, closes: _, opened: _, voice: _, stt: _) = await openFind(
      tester,
    );
    // The rows are what Find is opened to see: the keyboard comes with a tap on the field.
    expect(tester.testTextInput.isVisible, isFalse);
    await tester.tap(find.byType(TextField));
    await tester.pump();
    expect(tester.testTextInput.isVisible, isTrue);
    tester.testTextInput.updateEditingValue(
      const TextEditingValue(text: 'working'),
    );
    await frames(tester);
    expect(find.text('working', findRichText: true), findsWidgets);
    expect(find.text('paused-work', findRichText: true), findsNothing);
    await close(tester, app);
  });

  testWidgets('a paused harness the machine cannot bring back says why', (
    tester,
  ) async {
    final (:app, closes: _, :opened, voice: _, stt: _) = await openFind(tester);
    await tester.tap(find.text('paused-work', findRichText: true).first);
    await tester.pump();
    await frames(tester, count: 10);
    expect(opened, isEmpty);
    await close(tester, app);
  });

  testWidgets('a conversation Harness did not start: resumed as a harness', (
    tester,
  ) async {
    // The harness it becomes is opened once its terminal is asked for, which waits for the socket.
    final (:app, closes: _, :opened, voice: _, stt: _) = await openFind(
      tester,
      handshaken: true,
    );
    await tester.tap(find.byType(TextField));
    await tester.enterText(find.byType(TextField), 'dial');
    await frames(tester, count: 6);
    expect(find.text('resume'), findsOneWidget);
    await tester.tap(find.text('Fix the dial', findRichText: true).first);
    await frames(tester, count: 20);
    expect(opened, [('m', 'new-agent')]);
    await close(tester, app);
  });

  testWidgets('the field: typed, cleared, return opens the first, Back steps '
      'out', (tester) async {
    final (:app, :closes, :opened, voice: _, stt: _) = await openFind(tester);
    await tester.tap(find.byType(TextField));
    await tester.enterText(find.byType(TextField), 'work');
    await frames(tester);
    await tester.tap(find.byIcon(LucideIcons.x300));
    await frames(tester);
    expect(find.text('work'), findsNothing);

    await tester.enterText(find.byType(TextField), 'finished');
    await frames(tester);
    await tester.testTextInput.receiveAction(TextInputAction.search);
    await frames(tester);
    expect(opened, [('m', 'done')]);

    // Back: out of the search first, then out of Find.
    await tester.enterText(find.byType(TextField), '@');
    await frames(tester);
    await tester.binding.handlePopRoute();
    await frames(tester);
    await tester.binding.handlePopRoute();
    await frames(tester);
    await tester.binding.handlePopRoute();
    await frames(tester);
    expect(closes, isNotEmpty);
    await close(tester, app);
  });

  testWidgets('the field\'s mic: what was said becomes the query', (
    tester,
  ) async {
    final (:app, closes: _, opened: _, :voice, :stt) = await openFind(tester);
    stt.replies.add('Finished.');
    await tester.tap(find.byType(TtyFieldMic));
    await frames(tester);
    expect(voice.status, VoiceInputStatus.listening);
    await tester.tap(find.byType(TtyFieldMic));
    await frames(tester);
    expect(find.text('Finished'), findsOneWidget);
    await close(tester, app);
  });

  testWidgets('+ New Harness, on the machine on screen', (tester) async {
    final (:app, :closes, opened: _, voice: _, stt: _) = await openFind(tester);
    await tapInView(
      tester,
      find.text('+ New Harness', findRichText: true).last,
    );
    await frames(tester, count: 6);
    expect(closes, hasLength(1));
    expect(find.byType(NewAgentPage), findsOneWidget);
    await close(tester, app);
  });

  testWidgets('a command, by name', (tester) async {
    final (:app, :closes, opened: _, voice: _, stt: _) = await openFind(tester);
    await tester.enterText(find.byType(TextField), '>sett');
    await frames(tester);
    await tester.tap(find.text('Settings', findRichText: true).last);
    await frames(tester, count: 6);
    expect(closes, isNotEmpty);
    expect(find.byType(SettingsPage), findsOneWidget);
    await close(tester, app);
  });

  testWidgets('Swarm is a command only while its experiment is on', (
    tester,
  ) async {
    // In memory only: the value, not the store's write, so nothing reaches the state file.
    addTearDown(() => experimentalFeaturesStore.value = const {});
    final (:app, :closes, opened: _, voice: _, stt: _) = await openFind(tester);
    await tester.enterText(find.byType(TextField), 'swarm');
    await frames(tester);
    expect(find.text('Swarm', findRichText: true), findsNothing);

    experimentalFeaturesStore.value = {PhoneExperiment.swarm};
    await tester.enterText(find.byType(TextField), 'swar');
    await frames(tester);
    await tester.tap(find.text('Swarm', findRichText: true).last);
    await frames(tester, count: 6);
    expect(closes, isNotEmpty);
    expect(find.byType(SwarmPage), findsOneWidget);
    expect(find.byKey(const ValueKey('swarm-building')), findsOneWidget);
    await close(tester, app);
  });

  testWidgets('a pull left that does not go far enough settles back', (
    tester,
  ) async {
    final (:app, :closes, opened: _, voice: _, stt: _) = await openFind(tester);
    await tester.timedDrag(
      find.byType(TerminalSearchOverlay),
      const Offset(-60, 0),
      const Duration(milliseconds: 800),
    );
    await frames(tester);
    expect(closes, isEmpty);
    await tester.fling(
      find.byType(TerminalSearchOverlay),
      const Offset(-300, 0),
      1500,
    );
    await frames(tester);
    expect(closes, hasLength(1));
    await close(tester, app);
  });
}
