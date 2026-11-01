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
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';
import 'package:harness_mobile/swarm/swarm_voice.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// Talking instead of typing in a Swarm chat (Tony, 10-28), where the phone
/// has no speech recognizer of its own to use: the terminal's mic in the
/// composer records, and what the backend hears lands in the message box as
/// the take ends. While a take runs the toolbar is cancel, wave, stop and
/// Send: stop leaves the words in the box and sends nothing — sending is a
/// tap on Send, the row's or the composer's (Tony, 11-01) — and nothing but
/// stop, Send, cancel or its 5-minute limit ends a take (Tony, 10-29). A long press on the mic picks the language.
/// With the phone's recognizer: `swarm_chat_dictation_test`.
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

  /// Who is signed in, in the last [pump].
  late ValueNotifier<String?> account;

  /// Chat g1 on screen, its composer's mic heard through [recorder] and
  /// [stt] — or with no voice input at all.
  Future<SwarmHost> pump(WidgetTester tester, {bool voice = true}) async {
    final features = ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
      ..value = {PhoneExperiment.swarm};
    account = ValueNotifier<String?>(me);
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
    return host;
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

  /// The voice row's stop: the take ends with its words left in the box.
  Future<void> stop(WidgetTester tester) async {
    await tester.tap(key('swarm-voice-stop'));
    await frames(tester);
  }

  /// The voice row's cancel: the take is thrown away.
  Future<void> cancel(WidgetTester tester) async {
    await tester.tap(key('swarm-voice-cancel'));
    await frames(tester);
  }

  Future<void> send(WidgetTester tester) async {
    await tester.tap(key('swarm-send'));
    await tester.pumpAndSettle();
  }

  String box(WidgetTester tester) =>
      tester.widget<TextField>(find.byType(TextField)).controller!.text;

  testWidgets('stop ends the take with what it heard in the box and sends '
      'nothing; Send then posts it', (tester) async {
    await pump(tester);
    stt.replies.add('ship the fix today');

    await tapMic(tester);
    expect(recorder.recording, isTrue);
    expect(key('swarm-voice-stop'), findsOneWidget);
    expect(
      find.byType(SwarmVoiceWave),
      findsOneWidget,
      reason: 'the wave, moving with the voice',
    );

    await stop(tester);
    await tester.pumpAndSettle();
    expect(recorder.recording, isFalse);
    expect(box(tester), 'ship the fix today');
    expect(fake.commands, isEmpty, reason: 'voice never sends by itself');

    await send(tester);
    expect(fake.commands.single['text'], 'ship the fix today');
    expect(box(tester), isEmpty);
  });

  testWidgets('what was typed stays in front of what is said; stop leaves '
      'both in the box, unsent', (tester) async {
    await pump(tester);
    await tester.enterText(find.byType(TextField), 'Nova:');
    await tester.pump();
    stt.replies.add('ship the fix');

    await tapMic(tester);
    await stop(tester);
    await tester.pumpAndSettle();

    expect(box(tester), 'Nova: ship the fix');
    expect(fake.commands, isEmpty);
    await send(tester);
    expect(fake.commands.single['text'], 'Nova: ship the fix');
  });

  testWidgets('a stop with nothing heard sends nothing and says so', (
    tester,
  ) async {
    await pump(tester);

    await tapMic(tester);
    await stop(tester);
    await tester.pumpAndSettle();

    expect(recorder.recording, isFalse);
    expect(box(tester), isEmpty);
    expect(fake.commands, isEmpty);
    expect(find.text("Didn't catch that · tap the mic again"), findsOneWidget);
  });

  // Tony, 10-29: "listening continues until I tap".
  testWidgets('a pause after speaking does not end the take: it records until '
      'stop, which leaves the words in the box', (tester) async {
    await pump(tester);
    stt.replies.add('looks good');

    await tapMic(tester);
    recorder.meter.value = 0.8;
    await tester.pump(const Duration(milliseconds: 500));
    recorder.meter.value = 0.02;
    await tester.pump(const Duration(seconds: 30));
    expect(recorder.recording, isTrue);
    expect(fake.commands, isEmpty);

    await stop(tester);
    await tester.pumpAndSettle();
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

  testWidgets('while the microphone opens the row is cancel and a flat '
      'wave, no stop; cancel calls the take off', (tester) async {
    recorder.pendingPermission = Completer();
    await pump(tester);

    await tapMic(tester);
    expect(key('swarm-voice-cancel'), findsOneWidget);
    expect(key('swarm-voice-wave'), findsOneWidget);
    expect(tester.widget<SwarmVoiceWave>(key('swarm-voice-wave')).flat, isTrue);
    expect(key('swarm-voice-stop'), findsNothing);
    expect(key('swarm-mic'), findsNothing);

    await cancel(tester);
    recorder.pendingPermission!.complete(true);
    await frames(tester);

    expect(recorder.starts, 0);
    expect(key('swarm-voice-cancel'), findsNothing, reason: 'back at rest');
    expect(key('swarm-mic'), findsOneWidget);
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
    await stop(tester);

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

  testWidgets('VoiceOver can talk, stop, cancel and choose the language, '
      'each a one-word label while the mic is open', (tester) async {
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
    for (final (control, label) in [
      ('swarm-voice-cancel', 'Cancel'),
      ('swarm-voice-stop', 'Stop'),
    ]) {
      expect(
        tester.getSemantics(key(control)),
        matchesSemantics(
          label: label,
          isButton: true,
          hasEnabledState: true,
          isEnabled: true,
          hasTapAction: true,
        ),
      );
    }

    tester.semantics.tap(find.semantics.byLabel('Stop'));
    await tester.pumpAndSettle();
    expect(box(tester), 'on my way');
    expect(fake.commands, isEmpty);

    tester.semantics.tap(find.semantics.byLabel('Talk'));
    await frames(tester);
    tester.semantics.tap(find.semantics.byLabel('Cancel'));
    await tester.pumpAndSettle();
    expect(recorder.recording, isFalse);
    expect(box(tester), 'on my way', reason: 'what was there before stays');

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

  testWidgets('a take covered after speaking is thrown away, not '
      'transcribed', (tester) async {
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
  testWidgets('quiet under a system prompt ends nothing; the take goes on '
      'once the app is back, until stop', (tester) async {
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
    await tester.pump(const Duration(seconds: 10));
    expect(recorder.recording, isTrue);
    await stop(tester);
    await tester.pumpAndSettle();
    expect(box(tester), 'said before Control Center');
    expect(fake.commands, isEmpty);
  });

  testWidgets('a take kept under a system prompt goes if the app then goes '
      'away', (tester) async {
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

  // Review of #2014 at 61a2bce93: the reviewer's probe, with stop ending the
  // take now (Tony, 11-01) — a system prompt comes up while the microphone is
  // still closing.
  testWidgets('a take whose microphone closes under a system prompt is sent '
      'to be transcribed only once the app is back, into the box', (
    tester,
  ) async {
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
    await stop(tester);
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
    expect(fake.commands, isEmpty);

    await lifecycle(tester, [AppLifecycleState.resumed]);
    await tester.pumpAndSettle();
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
    await stop(tester);
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
    await stop(tester);

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
    await stop(tester);
    await tester.pumpAndSettle();
    expect(box(tester), 'second try');
    expect(fake.commands, isEmpty);
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
    await stop(tester);
    expect(stt.calls, hasLength(1), reason: 'sent while the chat was seen');

    await cover(tester);
    stt.pending!.complete('late words');
    await frames(tester);
    await uncover(tester);

    expect(box(tester), isEmpty);
    expect(fake.commands, isEmpty);
  });

  testWidgets('during a take the toolbar is cancel, wave, stop and the '
      "row's Send: no +, Tag, mic, X or @ picker; all come back after stop", (
    tester,
  ) async {
    await pump(tester);
    await tester.enterText(find.byType(TextField), '@');
    await tester.pump();
    expect(key('swarm-mention-picker'), findsOneWidget);
    expect(key('swarm-field-clear'), findsOneWidget);
    stt.replies.add('Nova');

    await tapMic(tester);
    for (final gone in [
      'swarm-send',
      'swarm-attach',
      'swarm-tag',
      'swarm-mic',
      'swarm-field-clear',
      'swarm-mention-picker',
    ]) {
      expect(key(gone), findsNothing, reason: '$gone during a take');
    }
    for (final shown in [
      'swarm-voice-cancel',
      'swarm-voice-wave',
      'swarm-voice-stop',
      'swarm-voice-send',
    ]) {
      expect(key(shown), findsOneWidget, reason: '$shown during a take');
    }
    // Right of stop, as the composer's Send is right of the mic.
    expect(
      tester.getCenter(key('swarm-voice-send')).dx,
      greaterThan(tester.getCenter(key('swarm-voice-stop')).dx),
    );

    await stop(tester);
    await tester.pumpAndSettle();
    expect(box(tester), '@ Nova');
    expect(key('swarm-voice-send'), findsNothing);
    for (final back in [
      'swarm-send',
      'swarm-attach',
      'swarm-tag',
      'swarm-mic',
      'swarm-field-clear',
    ]) {
      expect(key(back), findsOneWidget, reason: '$back after stop');
    }
    expect(key('swarm-voice-stop'), findsNothing);
    expect(fake.commands, isEmpty);
  });

  testWidgets('cancel throws the take away and leaves what was typed before', (
    tester,
  ) async {
    await pump(tester);
    await tester.enterText(find.byType(TextField), 'Draft');
    await tester.pump();
    stt.replies.add('never wanted');

    await tapMic(tester);
    recorder.meter.value = 0.8;
    await tester.pump(const Duration(milliseconds: 500));
    await cancel(tester);
    await tester.pumpAndSettle();

    expect(recorder.recording, isFalse);
    expect(recorder.cancels, 1);
    expect(stt.calls, isEmpty, reason: 'a cancelled take is not transcribed');
    expect(box(tester), 'Draft');
    expect(fake.commands, isEmpty);
    expect(key('swarm-mic'), findsOneWidget);
  });

  testWidgets('while the words are being transcribed the row is cancel and '
      'the busy face, no stop; cancel then puts nothing in the box', (
    tester,
  ) async {
    await pump(tester);
    await tester.enterText(find.byType(TextField), 'Draft');
    await tester.pump();
    stt.pending = Completer();

    await tapMic(tester);
    await stop(tester);
    expect(stt.calls, hasLength(1));
    expect(key('swarm-voice-busy'), findsOneWidget);
    expect(key('swarm-voice-stop'), findsNothing);
    expect(key('swarm-send'), findsNothing);
    expect(
      tester.widget<SwarmRoundButton>(key('swarm-voice-send')).onTap,
      isNull,
      reason: 'after stop the words go to the box, not out',
    );

    await cancel(tester);
    stt.pending!.complete('late words');
    await frames(tester);
    await tester.pumpAndSettle();

    expect(box(tester), 'Draft');
    expect(fake.commands, isEmpty);
    expect(key('swarm-voice-busy'), findsNothing);
    expect(key('swarm-mic'), findsOneWidget);
  });

  testWidgets('with no voice input the composer has no mic', (tester) async {
    await pump(tester, voice: false);

    expect(key('swarm-mic'), findsNothing);
    expect(key('swarm-send'), findsOneWidget);
  });

  // Tony, 11-01: Send right of stop ends the take and posts it, last words
  // and all. A recording's words reach the box only once transcribed, so the
  // row's Send is live from the first moment of the take.
  group("the voice row's Send", () {
    Future<void> rowSend(WidgetTester tester) async {
      await tester.tap(key('swarm-voice-send'));
      await frames(tester);
    }

    SwarmRoundButton sendButton(WidgetTester tester) =>
        tester.widget<SwarmRoundButton>(key('swarm-voice-send'));

    testWidgets('live while recording with an empty box; one tap stops, '
        'transcribes and posts the words once', (tester) async {
      await pump(tester);
      stt.pending = Completer<String>();

      await tapMic(tester);
      expect(box(tester), isEmpty);
      expect(sendButton(tester).onTap, isNotNull, reason: 'empty box, live');

      await rowSend(tester);
      expect(recorder.recording, isFalse, reason: 'the take ended');
      expect(stt.calls, hasLength(1));
      expect(key('swarm-voice-sending'), findsOneWidget);
      expect(fake.commands, isEmpty, reason: 'not before the words are back');

      stt.pending!.complete('ship the fix today');
      await tester.pumpAndSettle();
      expect(fake.commands.single['text'], 'ship the fix today');
      expect(box(tester), isEmpty);
      expect(key('swarm-voice-wave'), findsNothing);
      expect(key('swarm-mic'), findsOneWidget);
      expect(key('swarm-voice-note'), findsNothing);
    });

    testWidgets('posts what was typed, then what was said', (tester) async {
      await pump(tester);
      await tester.enterText(find.byType(TextField), 'Nova:');
      await tester.pump();
      stt.replies.add('ship the fix');

      await tapMic(tester);
      await rowSend(tester);
      await tester.pumpAndSettle();

      expect(fake.commands.single['text'], 'Nova: ship the fix');
      expect(box(tester), isEmpty);
    });

    testWidgets('while it sends the row takes no tap: a second Send, stop or '
        'cancel changes nothing, and the post goes once', (tester) async {
      await pump(tester);
      stt.pending = Completer<String>();

      await tapMic(tester);
      await rowSend(tester);
      expect(sendButton(tester).onTap, isNull);
      expect(key('swarm-voice-stop'), findsNothing);
      await rowSend(tester);
      await cancel(tester);
      expect(stt.calls, hasLength(1));
      expect(
        key('swarm-voice-sending'),
        findsOneWidget,
        reason: 'not called off',
      );

      stt.pending!.complete('once');
      await tester.pumpAndSettle();
      expect(fake.commands, hasLength(1));
      expect(fake.commands.single['text'], 'once');
    });

    testWidgets('a double tap posts once', (tester) async {
      await pump(tester);
      stt.pending = Completer<String>();

      await tapMic(tester);
      // Where Send is, whatever is there by then: the row's Send, or the
      // composer's once the row has gone.
      final at = tester.getCenter(key('swarm-voice-send'));
      for (var i = 0; i < 2; i++) {
        await tester.tapAt(at);
        await tester.pump(const Duration(milliseconds: 40));
      }
      stt.pending!.complete('just once');
      await tester.pump();
      await tester.tapAt(at);
      await tester.pumpAndSettle();

      expect(fake.commands, hasLength(1));
      expect(fake.commands.single['text'], 'just once');
    });

    testWidgets('nothing heard posts nothing, keeps what was typed, and says '
        'one line', (tester) async {
      await pump(tester);
      await tester.enterText(find.byType(TextField), 'Draft');
      await tester.pump();
      stt.replies.add('');

      await tapMic(tester);
      await rowSend(tester);
      await tester.pumpAndSettle();

      expect(fake.commands, isEmpty);
      expect(box(tester), 'Draft');
      expect(key('swarm-voice-note'), findsOneWidget);
      expect(find.text(SwarmVoice.nothingSent), findsOneWidget);
      expect(find.text("Didn't catch that · tap the mic again"), findsNothing);
      expect(key('swarm-mic'), findsOneWidget);
    });

    testWidgets('a transcription that fails posts nothing and says the same '
        'line', (tester) async {
      await pump(tester);
      await tester.enterText(find.byType(TextField), 'Draft');
      await tester.pump();
      stt.fails = true;

      await tapMic(tester);
      await rowSend(tester);
      await tester.pumpAndSettle();

      expect(fake.commands, isEmpty);
      expect(box(tester), 'Draft');
      expect(find.text(SwarmVoice.nothingSent), findsOneWidget);
    });

    testWidgets('a silent take posts nothing and says the same line', (
      tester,
    ) async {
      await pump(tester);
      recorder.captured = (
        wav: Uint8List.fromList([0, 0]),
        length: const Duration(seconds: 2),
        peak: 0,
      );

      await tapMic(tester);
      await rowSend(tester);
      await tester.pumpAndSettle();

      expect(stt.calls, isEmpty, reason: 'silence is not uploaded');
      expect(fake.commands, isEmpty);
      expect(find.text(SwarmVoice.nothingSent), findsOneWidget);
    });

    testWidgets('off while the microphone opens', (tester) async {
      await pump(tester);
      recorder.pendingPermission = Completer<bool>();

      await tapMic(tester);
      expect(sendButton(tester).onTap, isNull);
      recorder.pendingPermission!.complete(true);
      await frames(tester);
      expect(sendButton(tester).onTap, isNotNull);
    });

    testWidgets('a chat covered while its Send transcribes posts nothing, and '
        'says nothing', (tester) async {
      await pump(tester);
      stt.pending = Completer<String>();
      await tapMic(tester);
      await rowSend(tester);

      final navigator = tester.state<NavigatorState>(find.byType(Navigator));
      unawaited(
        navigator.push(
          MaterialPageRoute<void>(builder: (_) => const SizedBox()),
        ),
      );
      await tester.pumpAndSettle();
      stt.pending!.complete('behind your back');
      await tester.pumpAndSettle();
      navigator.pop();
      await tester.pumpAndSettle();

      expect(fake.commands, isEmpty);
      expect(box(tester), isEmpty);
      expect(find.text(SwarmVoice.nothingSent), findsNothing);
      expect(key('swarm-mic'), findsOneWidget);
    });

    testWidgets('signed out while its Send transcribes: nothing is posted', (
      tester,
    ) async {
      await pump(tester);
      stt.pending = Completer<String>();
      await tapMic(tester);
      await rowSend(tester);

      account.value = null;
      await frames(tester);
      stt.pending!.complete('after sign out');
      await tester.pumpAndSettle();

      expect(fake.commands, isEmpty);
      expect(find.text('after sign out'), findsNothing);
    });
  });

  // The composer goes with the right to post, and its mic with it: a take
  // must not go on recording, or land its words, once the person can no
  // longer post here (as a thread's reply box already guards).
  group('access lost mid-take', () {
    const refused = SuperTabFailure('FORBIDDEN', 'Not yours.', statusCode: 403);

    /// The Swarm read again: refused, or with the person a [role].
    Future<void> reread(
      WidgetTester tester,
      SwarmHost host, {
      bool lost = false,
      String? role,
    }) async {
      if (lost) {
        fake.routes['/api/super-tabs/$tab/changes'] = (_) => throw refused;
        fake.routes['/api/super-tabs/$tab/parts'] = (_) => throw refused;
      } else {
        final parts = fake.routes['/api/super-tabs/$tab/parts']!;
        fake.routes['/api/super-tabs/$tab/parts'] = (body) => {
          ...(parts(body) as Map<String, dynamic>),
          'members': [part(me, 2, person(me, role: role!))],
        };
        fake.routes['/api/super-tabs/$tab/changes'] = (_) => {'reload': true};
      }
      await host.session!.inbox.reader(tab)!.refresh();
      await frames(tester);
    }

    testWidgets('signed out: the microphone closes, nothing is transcribed '
        'or sent', (tester) async {
      await pump(tester);
      stt.replies.add('after sign out');
      await tapMic(tester);
      expect(recorder.recording, isTrue);

      account.value = null;
      await frames(tester);

      expect(recorder.recording, isFalse);
      expect(stt.calls, isEmpty);
      expect(fake.commands, isEmpty);
    });

    testWidgets('made read-only: the take goes with the composer', (
      tester,
    ) async {
      final host = await pump(tester);
      await tapMic(tester);
      expect(recorder.recording, isTrue);

      await reread(tester, host, role: 'viewer');

      expect(key('swarm-read-only'), findsOneWidget);
      expect(key('swarm-mic'), findsNothing);
      expect(recorder.recording, isFalse);
      expect(stt.calls, isEmpty);
      expect(fake.commands, isEmpty);
    });

    testWidgets('the Swarm lost: the microphone closes', (tester) async {
      final host = await pump(tester);
      await tapMic(tester);
      expect(recorder.recording, isTrue);

      await reread(tester, host, lost: true);

      expect(recorder.recording, isFalse);
      expect(stt.calls, isEmpty);
    });

    testWidgets('words transcribed after the person was made read-only land '
        'nowhere: not sent, and not kept in the draft', (tester) async {
      final host = await pump(tester);
      stt.pending = Completer<String>();
      await tapMic(tester);
      recorder.meter.value = 0.8;
      await tester.pump(const Duration(milliseconds: 500));
      await stop(tester);
      expect(stt.calls, hasLength(1), reason: 'the take is being transcribed');

      await reread(tester, host, role: 'viewer');
      stt.pending!.complete('too late');
      await tester.pumpAndSettle();

      expect(fake.commands, isEmpty);
      expect(find.text('too late'), findsNothing);

      // Nor kept in the draft for when the person may post again.
      await reread(tester, host, role: 'owner');
      await tester.pumpAndSettle();
      expect(key('swarm-mic'), findsOneWidget);
      expect(box(tester), isEmpty);
    });
  });
}

/// A microphone that also says how loud it is, for the mic's bars.
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
