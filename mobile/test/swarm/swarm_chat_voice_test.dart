import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/phone/voice_input_controller.dart';
import 'package:harness_mobile/phone/voice_mic_face.dart';
import 'package:harness_mobile/phone/voice_recorder.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart' as grid;
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// Talking instead of typing in a Swarm chat (Tony, 10-28), where the phone
/// has no speech recognizer of its own to use: the terminal's mic in the
/// composer records, and what the backend hears lands in the message box as
/// the take ends; a second tap on the mic stops and sends what is in the box.
/// A pause leaves the words in the box unsent. A long press on the mic picks
/// the language. With the phone's recognizer: `swarm_chat_dictation_test`.
void main() {
  const messages = '/api/super-tabs/$tab/conversations/g1/messages';
  const commands = '/api/super-tabs/$tab/commands';

  late FakeSwarm fake;
  late _MeteredRecorder recorder;
  late FakeTranscriber stt;

  setUp(() {
    recorder = _MeteredRecorder();
    stt = FakeTranscriber();
    fake = FakeSwarm();
    fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
      ],
      'next': null,
    };
    fake.routes['/api/super-tabs/$tab/parts'] = (_) => firstLoad(
      groups: [
        groupData(
          'g1',
          title: 'Fix login',
          agentIds: ['agent-lead', 'agent-builder'],
          lastMessageSequence: 1,
        ),
      ],
    );
    fake.routes['/api/super-tabs/$tab/changes'] = (_) => changes(cursor: 'c2');
    fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
      'decisions': <Object>[],
    };
    fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
      'mentions': <Object>[],
    };
    fake.routes[messages] = (_) => {
      'messages': [
        {
          'id': 'm1',
          'conversationId': 'g1',
          'text': 'Which build should I ship?',
          'sequence': 1,
          'author': {'kind': 'agent', 'id': 'agent-builder', 'name': 'Nova'},
          'attachments': <Object>[],
          'reactions': <Object>[],
          'createdAt': DateTime.utc(2026, 10, 28, 1).toIso8601String(),
        },
      ],
      'next': null,
    };
    fake.routes[commands] = (_) => {'result': <String, dynamic>{}};
  });

  /// Chat g1 on screen, its composer's mic heard through [recorder] and
  /// [stt] — or with no voice input at all.
  Future<void> pump(WidgetTester tester, {bool voice = true}) async {
    final features = ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
      ..value = {PhoneExperiment.swarm};
    final account = ValueNotifier<String?>(me);
    final host = SwarmHost(
      accountId: () => account.value,
      account: account,
      request: fake.request,
      notices: SilentSystemNotices(),
      features: features,
      voice: voice
          ? () => VoiceInputController(
              transcriber: stt.call,
              recorder: recorder,
              language: ValueNotifier('en'),
            )
          : null,
    )..foreground = false;
    addTearDown(host.dispose);
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        builder: (context, child) => SwarmScope(notifier: host, child: child!),
        home: const SwarmConversationPage(swarmId: tab, conversationId: 'g1'),
      ),
    );
    await tester.pumpAndSettle();
  }

  Finder key(String value) => find.byKey(ValueKey(value));

  /// A few frames, for the take's awaits to land. Never settling: the mic's
  /// bars move for as long as it listens.
  Future<void> frames(WidgetTester tester) async {
    for (var i = 0; i < 5; i++) {
      await tester.pump();
    }
  }

  Future<void> tapMic(WidgetTester tester) async {
    await tester.tap(key('swarm-mic'));
    await frames(tester);
  }

  String box(WidgetTester tester) =>
      tester.widget<TextField>(find.byType(TextField)).controller!.text;

  testWidgets('a second tap stops the take and sends what it heard', (
    tester,
  ) async {
    await pump(tester);
    stt.replies.add('ship the fix today');

    await tapMic(tester);
    expect(recorder.recording, isTrue);
    expect(
      tester.widget<VoiceMicCore>(find.byType(VoiceMicCore)).face,
      VoiceMicFace.listening,
      reason: 'the terminal\'s listening face, its bars moving with the voice',
    );

    await tapMic(tester);
    await tester.pumpAndSettle();
    expect(recorder.recording, isFalse);
    expect(fake.commands.single['text'], 'ship the fix today');
    expect(box(tester), isEmpty);
  });

  testWidgets('what was typed goes with what is said, on the second tap', (
    tester,
  ) async {
    await pump(tester);
    await tester.enterText(find.byType(TextField), 'Nova:');
    await tester.pump();
    stt.replies.add('ship the fix');

    await tapMic(tester);
    await tapMic(tester);
    await tester.pumpAndSettle();

    expect(fake.commands.single['text'], 'Nova: ship the fix');
    expect(box(tester), isEmpty);
  });

  testWidgets('a second tap with nothing in the box sends nothing', (
    tester,
  ) async {
    await pump(tester);

    await tapMic(tester);
    await tapMic(tester);
    await tester.pumpAndSettle();

    expect(recorder.recording, isFalse);
    expect(box(tester), isEmpty);
    expect(fake.commands, isEmpty);
    expect(find.text("Didn't catch that · tap the mic again"), findsOneWidget);
  });

  testWidgets('a pause after speaking ends the take, its words left in the box '
      'unsent', (tester) async {
    await pump(tester);
    stt.replies.add('looks good');

    await tapMic(tester);
    recorder.meter.value = 0.8;
    await tester.pump(const Duration(milliseconds: 500));
    recorder.meter.value = 0.02;
    await tester.pump(const Duration(milliseconds: 2900));
    expect(recorder.recording, isTrue, reason: 'three seconds of quiet');

    await tester.pump(const Duration(milliseconds: 200));
    await frames(tester);
    expect(recorder.recording, isFalse);
    expect(box(tester), 'looks good');
    expect(fake.commands, isEmpty);
  });

  testWidgets('the take runs on through quiet before anything is said, and '
      'through a short pause', (tester) async {
    await pump(tester);

    await tapMic(tester);
    recorder.meter.value = 0.02;
    await tester.pump(const Duration(seconds: 10));
    expect(recorder.recording, isTrue, reason: 'nothing said yet');

    recorder.meter.value = 0.8;
    await tester.pump(const Duration(milliseconds: 500));
    recorder.meter.value = 0.02;
    await tester.pump(const Duration(seconds: 2));
    recorder.meter.value = 0.8;
    await tester.pump(const Duration(milliseconds: 500));
    recorder.meter.value = 0.02;
    await tester.pump(const Duration(seconds: 2));
    expect(recorder.recording, isTrue, reason: 'talking again restarts it');
  });

  /// The microphone as loud as [levels] (hundredths), a 100 ms buffer each —
  /// what Tony's iPhone 14 measured in his room on 10-29.
  Future<void> feed(WidgetTester tester, List<int> levels) async {
    for (final level in levels) {
      recorder.meter.value = level / 100;
      await tester.pump(const Duration(milliseconds: 100));
    }
  }

  /// His mic opening (a click, then warming up), and a sentence.
  const opening = [21, 34, 34, 36, 36, 37, 38, 40, 40, 38, 38, 41];
  const sentence = [87, 90, 79, 80, 93, 92, 88, 94, 91, 87, 63, 63, 75, 81, 78];

  /// A second of his room, quiet: louder than speech was assumed to be.
  const room = [43, 43, 42, 44, 42, 44, 43, 45, 43, 42];

  testWidgets('in a room as loud as Tony\'s, a pause after speaking still '
      'ends the take, its words left in the box unsent', (tester) async {
    await pump(tester);
    stt.replies.add('hôm nay mình làm gì');

    await tapMic(tester);
    await feed(tester, [...opening, ...sentence, 52]);
    await feed(tester, [...room, ...room, 43, 44, 42, 43, 44]);
    expect(recorder.recording, isTrue, reason: 'two and a half seconds');

    await feed(tester, [...room]);
    await frames(tester);
    expect(recorder.recording, isFalse);
    expect(box(tester), 'hôm nay mình làm gì');
    expect(fake.commands, isEmpty);
  });

  testWidgets('in a room as loud as Tony\'s, the room alone never ends a '
      'take, nor does a breath between sentences', (tester) async {
    await pump(tester);

    await tapMic(tester);
    await feed(tester, [...opening, for (var i = 0; i < 8; i++) ...room]);
    await feed(tester, [...sentence, ...room, ...room, ...sentence]);
    await feed(tester, [...room, 45, 46, 47, 46, 47, 47, 45, 45, 46, 45]);
    expect(recorder.recording, isTrue);
  });

  testWidgets('in a loud room, a rustle a little above it is not speech: the '
      'take runs on', (tester) async {
    await pump(tester);

    await tapMic(tester);
    await feed(tester, [...opening, ...room, ...room, 58, 60, 57]);
    await feed(tester, [...room, ...room, ...room, ...room]);
    expect(recorder.recording, isTrue, reason: 'nothing said yet');
  });

  testWidgets('a second take in the same loud room pauses as the first did', (
    tester,
  ) async {
    await pump(tester);
    stt.replies.addAll(['một', 'hai']);

    for (final _ in ['first', 'second']) {
      await tapMic(tester);
      await feed(tester, [...opening, ...sentence, 52]);
      await feed(tester, [...room, ...room, ...room, ...room]);
      await frames(tester);
      expect(recorder.recording, isFalse);
    }
    expect(box(tester), 'một hai');
  });

  testWidgets('a tap while the microphone is opening calls the take off', (
    tester,
  ) async {
    recorder.pendingPermission = Completer();
    await pump(tester);

    await tapMic(tester);
    await tapMic(tester);
    recorder.pendingPermission!.complete(true);
    await frames(tester);

    expect(recorder.starts, 0);
    expect(find.byType(VoiceMicCore), findsNothing, reason: 'back at rest');
  });

  testWidgets('a refused microphone says so, and records nothing', (
    tester,
  ) async {
    recorder.permitted = false;
    await pump(tester);

    await tapMic(tester);

    expect(recorder.starts, 0);
    expect(find.text('No mic access · allow it in Settings'), findsOneWidget);
  });

  testWidgets('a take that is not heard says so, and leaves the box as it '
      'was', (tester) async {
    await pump(tester);
    await tester.enterText(find.byType(TextField), 'Draft');
    await tester.pump();
    stt.fails = true;

    await tapMic(tester);
    await tapMic(tester);

    expect(box(tester), 'Draft');
    expect(
      find.text("Couldn't transcribe · tap the mic again"),
      findsOneWidget,
    );
    expect(fake.commands, isEmpty);
  });

  testWidgets('a long press on the mic opens the voice language list', (
    tester,
  ) async {
    await pump(tester);

    await tester.longPress(key('swarm-mic'));
    await tester.pumpAndSettle();

    expect(find.text('Voice input language'), findsOneWidget);
    expect(find.text('Tiếng Việt'), findsOneWidget);
    expect(recorder.starts, 0, reason: 'a long press records nothing');
    // Put away without choosing: a choice writes the real preferences file.
  });

  testWidgets('VoiceOver can talk, finish and choose the language', (
    tester,
  ) async {
    final semantics = tester.ensureSemantics();
    await pump(tester);
    stt.replies.add('on my way');

    expect(
      tester.getSemantics(key('swarm-mic')),
      matchesSemantics(
        label: 'Talk',
        isButton: true,
        hasEnabledState: true,
        isEnabled: true,
        hasTapAction: true,
        hasLongPressAction: true,
        onLongPressHint: 'Choose language',
      ),
    );

    tester.semantics.tap(find.semantics.byLabel('Talk'));
    await frames(tester);
    expect(recorder.recording, isTrue);
    expect(find.semantics.byLabel('Done'), findsOne);

    tester.semantics.tap(find.semantics.byLabel('Done'));
    await tester.pumpAndSettle();
    expect(fake.commands.single['text'], 'on my way');

    tester.semantics.longPress(find.semantics.byLabel('Talk'));
    await tester.pumpAndSettle();
    expect(find.text('Voice input language'), findsOneWidget);
    semantics.dispose();
  });

  testWidgets('leaving the chat mid-take closes the microphone', (
    tester,
  ) async {
    await pump(tester);
    await tapMic(tester);
    expect(recorder.recording, isTrue);

    await tester.pumpWidget(const SizedBox());

    expect(recorder.cancels, 1);
    expect(recorder.recording, isFalse);
  });

  /// Another screen over the chat, its push done.
  Future<void> cover(WidgetTester tester) async {
    final context = tester.element(find.byType(SwarmConversationPage));
    unawaited(
      Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => const Scaffold(body: Text('Other screen')),
        ),
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(seconds: 1));
  }

  Future<void> uncover(WidgetTester tester) async {
    final context = tester.element(find.text('Other screen'));
    Navigator.of(context).pop();
    await tester.pump();
    await tester.pump(const Duration(seconds: 1));
  }

  Future<void> lifecycle(
    WidgetTester tester,
    List<AppLifecycleState> states,
  ) async {
    for (final state in states) {
      tester.binding.handleAppLifecycleStateChanged(state);
    }
    await frames(tester);
  }

  // Review of #2014 at ad9dee05d: the reviewer's probe, as it was.
  testWidgets('covering a chat cancels its recording', (tester) async {
    await pump(tester);
    await tapMic(tester);
    expect(recorder.recording, isTrue);

    await cover(tester);

    expect(
      recorder.recording,
      isFalse,
      reason: 'A covered chat must not keep recording speech',
    );
  });

  testWidgets('a take covered in its pause is thrown away, not transcribed', (
    tester,
  ) async {
    await pump(tester);
    stt.replies.add('said behind another screen');
    await tapMic(tester);
    recorder.meter.value = 0.8;
    await tester.pump(const Duration(milliseconds: 500));
    recorder.meter.value = 0.02;

    await cover(tester);
    await tester.pump(const Duration(seconds: 5));

    expect(recorder.cancels, 1);
    expect(recorder.stops, 0, reason: 'a take is only stopped to be sent');
    expect(stt.calls, isEmpty);
    await uncover(tester);
    expect(box(tester), isEmpty);
  });

  testWidgets('the app going to the background mid-take throws the take '
      'away; a system prompt over it does not', (tester) async {
    addTearDown(
      () => tester.binding.handleAppLifecycleStateChanged(
        AppLifecycleState.resumed,
      ),
    );
    await pump(tester);
    await tapMic(tester);

    // The microphone permission prompt and Control Center leave the app
    // inactive, still in front.
    await lifecycle(tester, [AppLifecycleState.inactive]);
    expect(recorder.recording, isTrue);

    await lifecycle(tester, [
      AppLifecycleState.hidden,
      AppLifecycleState.paused,
    ]);
    expect(recorder.recording, isFalse);
    expect(recorder.cancels, 1);

    await lifecycle(tester, [
      AppLifecycleState.hidden,
      AppLifecycleState.inactive,
      AppLifecycleState.resumed,
    ]);
    await tester.pump(const Duration(seconds: 5));
    expect(stt.calls, isEmpty);
    expect(box(tester), isEmpty);
    expect(find.byType(VoiceMicCore), findsNothing, reason: 'back at rest');
  });

  // Review of #2014 at 42c8eac9c: the reviewer's probe, in its order.
  testWidgets('a pause under a system prompt sends nothing; the take waits '
      'for the app to be back', (tester) async {
    addTearDown(
      () => tester.binding.handleAppLifecycleStateChanged(
        AppLifecycleState.resumed,
      ),
    );
    await pump(tester);
    stt.replies.add('said before Control Center');
    await tapMic(tester);
    recorder.meter.value = 0.8;
    await tester.pump(const Duration(milliseconds: 500));

    await lifecycle(tester, [AppLifecycleState.inactive]);
    recorder.meter.value = 0.02;
    await tester.pump(const Duration(seconds: 4));
    expect(stt.calls, isEmpty, reason: 'Control Center over the chat');
    expect(recorder.recording, isTrue, reason: 'the take is kept');

    await lifecycle(tester, [AppLifecycleState.resumed]);
    await tester.pump(const Duration(milliseconds: 2900));
    expect(recorder.recording, isTrue, reason: 'the pause starts again');
    await tester.pump(const Duration(milliseconds: 200));
    await frames(tester);
    expect(box(tester), 'said before Control Center');
    expect(fake.commands, isEmpty);
  });

  testWidgets('a pause already counting stops under a system prompt, and the '
      'take goes if the app then goes away', (tester) async {
    addTearDown(
      () => tester.binding.handleAppLifecycleStateChanged(
        AppLifecycleState.resumed,
      ),
    );
    await pump(tester);
    await tapMic(tester);
    recorder.meter.value = 0.8;
    await tester.pump(const Duration(milliseconds: 500));
    recorder.meter.value = 0.02;
    await tester.pump(const Duration(seconds: 2));

    await lifecycle(tester, [AppLifecycleState.inactive]);
    await tester.pump(const Duration(seconds: 4));
    expect(stt.calls, isEmpty);
    expect(recorder.recording, isTrue);

    await lifecycle(tester, [
      AppLifecycleState.hidden,
      AppLifecycleState.paused,
    ]);
    await lifecycle(tester, [
      AppLifecycleState.hidden,
      AppLifecycleState.inactive,
      AppLifecycleState.resumed,
    ]);
    await tester.pump(const Duration(seconds: 5));
    expect(recorder.cancels, 1);
    expect(stt.calls, isEmpty);
    expect(box(tester), isEmpty);
  });

  testWidgets('a take that reaches its limit puts its words in the box', (
    tester,
  ) async {
    await pump(tester);
    stt.replies.add('five minutes of it');
    await tapMic(tester);

    await tester.pump(const Duration(minutes: 5));
    await frames(tester);

    expect(recorder.recording, isFalse);
    expect(box(tester), 'five minutes of it');
    expect(fake.commands, isEmpty);
  });

  testWidgets('a take that reaches its limit under a system prompt is held '
      'until the app is back', (tester) async {
    addTearDown(
      () => tester.binding.handleAppLifecycleStateChanged(
        AppLifecycleState.resumed,
      ),
    );
    await pump(tester);
    stt.replies.add('held over the limit');
    await tapMic(tester);

    await lifecycle(tester, [AppLifecycleState.inactive]);
    await tester.pump(const Duration(minutes: 5, seconds: 10));
    expect(stt.calls, isEmpty);
    expect(recorder.recording, isTrue);

    await lifecycle(tester, [AppLifecycleState.resumed]);
    await frames(tester);
    expect(recorder.recording, isFalse);
    expect(box(tester), 'held over the limit');
  });

  // Review of #2014 at 61a2bce93: the reviewer's probe, in its order — the
  // pause ends the take in front, and a system prompt comes up while the
  // microphone is still closing.
  testWidgets('a take whose microphone closes under a system prompt is sent '
      'to be transcribed only once the app is back', (tester) async {
    addTearDown(
      () => tester.binding.handleAppLifecycleStateChanged(
        AppLifecycleState.resumed,
      ),
    );
    await pump(tester);
    stt.replies.add('said just before Control Center');
    recorder.heldStop = Completer();
    await tapMic(tester);
    recorder.meter.value = 0.8;
    await tester.pump(const Duration(milliseconds: 500));
    recorder.meter.value = 0.02;
    await tester.pump(const Duration(seconds: 4));
    await frames(tester);
    expect(recorder.stops, 1);
    expect(stt.calls, isEmpty);

    await lifecycle(tester, [AppLifecycleState.inactive]);
    recorder.heldStop!.complete(recorder.captured);
    await frames(tester);
    await tester.pump(const Duration(seconds: 10));
    expect(
      stt.calls,
      isEmpty,
      reason: 'checked again once the microphone has closed',
    );
    expect(box(tester), isEmpty);

    await lifecycle(tester, [AppLifecycleState.resumed]);
    expect(stt.calls, hasLength(1));
    expect(box(tester), 'said just before Control Center');
    expect(fake.commands, isEmpty);
  });

  testWidgets('a take that reaches its limit as a system prompt comes up '
      'waits for the app too', (tester) async {
    addTearDown(
      () => tester.binding.handleAppLifecycleStateChanged(
        AppLifecycleState.resumed,
      ),
    );
    await pump(tester);
    stt.replies.add('five minutes, then Control Center');
    recorder.heldStop = Completer();
    await tapMic(tester);
    await tester.pump(const Duration(minutes: 5));
    await frames(tester);
    expect(recorder.stops, 1);

    await lifecycle(tester, [AppLifecycleState.inactive]);
    recorder.heldStop!.complete(recorder.captured);
    await frames(tester);
    expect(stt.calls, isEmpty);

    await lifecycle(tester, [AppLifecycleState.resumed]);
    expect(box(tester), 'five minutes, then Control Center');
  });

  testWidgets('a take held under a system prompt is thrown away if the app '
      'goes away', (tester) async {
    addTearDown(
      () => tester.binding.handleAppLifecycleStateChanged(
        AppLifecycleState.resumed,
      ),
    );
    await pump(tester);
    stt.replies.add('never heard');
    recorder.heldStop = Completer();
    await tapMic(tester);
    await tapMic(tester);
    expect(recorder.stops, 1);

    await lifecycle(tester, [AppLifecycleState.inactive]);
    recorder.heldStop!.complete(recorder.captured);
    await frames(tester);
    await lifecycle(tester, [
      AppLifecycleState.hidden,
      AppLifecycleState.paused,
    ]);
    await lifecycle(tester, [
      AppLifecycleState.hidden,
      AppLifecycleState.inactive,
      AppLifecycleState.resumed,
    ]);
    await tester.pump(const Duration(seconds: 5));

    expect(stt.calls, isEmpty);
    expect(box(tester), isEmpty);
    expect(find.byType(VoiceMicCore), findsNothing, reason: 'back at rest');
  });

  testWidgets('a take whose microphone closes after the chat was covered is '
      'not transcribed', (tester) async {
    await pump(tester);
    stt.replies.add('said behind another screen');
    recorder.heldStop = Completer();
    await tapMic(tester);
    await tapMic(tester);

    await cover(tester);
    recorder.heldStop!.complete(recorder.captured);
    await frames(tester);
    await uncover(tester);

    expect(stt.calls, isEmpty);
    expect(box(tester), isEmpty);
  });

  testWidgets('back on the chat, the mic starts a fresh take', (tester) async {
    await pump(tester);
    stt.replies.add('second try');
    await tapMic(tester);
    await cover(tester);
    await uncover(tester);

    await tapMic(tester);
    expect(recorder.starts, 2);
    expect(recorder.recording, isTrue);
    await tapMic(tester);
    await tester.pumpAndSettle();
    expect(fake.commands.single['text'], 'second try');
  });

  testWidgets('a microphone allowed after the chat was covered never opens', (
    tester,
  ) async {
    recorder.pendingPermission = Completer();
    await pump(tester);
    await tapMic(tester);

    await cover(tester);
    recorder.pendingPermission!.complete(true);
    await frames(tester);

    expect(recorder.starts, 0);
  });

  testWidgets('words transcribed after the chat was covered are dropped', (
    tester,
  ) async {
    await pump(tester);
    stt.pending = Completer();
    await tapMic(tester);
    await tapMic(tester);
    expect(stt.calls, hasLength(1), reason: 'sent while the chat was seen');

    await cover(tester);
    stt.pending!.complete('late words');
    await frames(tester);
    await uncover(tester);

    expect(box(tester), isEmpty);
    expect(fake.commands, isEmpty);
  });

  testWidgets('with no voice input the composer has no mic', (tester) async {
    await pump(tester, voice: false);

    expect(key('swarm-mic'), findsNothing);
    expect(key('swarm-send'), findsOneWidget);
  });
}

/// A microphone that also says how loud it is: what the pause that ends a
/// take listens to.
class _MeteredRecorder extends FakeVoiceRecorder implements VoiceLevelMeter {
  final meter = ValueNotifier<double>(0);

  /// Holds [stop] open until the test completes it: a microphone that takes
  /// its time to close, as a real one does.
  Completer<VoiceTake?>? heldStop;

  @override
  ValueListenable<double> get level => meter;

  @override
  Future<VoiceTake?> stop() async {
    final take = await super.stop();
    return heldStop?.future ?? take;
  }
}
