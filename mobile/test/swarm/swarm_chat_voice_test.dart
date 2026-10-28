import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:image_picker/image_picker.dart' show XFile;
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/phone/voice_input_controller.dart';
import 'package:harness_mobile/phone/voice_mic_face.dart';
import 'package:harness_mobile/phone/voice_recorder.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart' as grid;
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_file_picker.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';
import 'package:harness_mobile/swarm/swarm_voice.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// Talking instead of typing in a Swarm chat (Tony, 10-28): the terminal's
/// mic in the composer puts what is said into the message box phrase by
/// phrase while the person talks, where it can be edited; a second tap on the
/// mic stops and sends what is in the box (10-28). A pause leaves the words in
/// the box unsent. A long press on the mic picks the language.
void main() {
  const messages = '/api/super-tabs/$tab/conversations/g1/messages';
  const commands = '/api/super-tabs/$tab/commands';

  late FakeSwarm fake;
  late _MeteredRecorder recorder;
  late FakeTranscriber stt;

  /// The names of the files a post began to upload.
  late List<String> uploads;

  setUp(() {
    recorder = _MeteredRecorder();
    stt = FakeTranscriber();
    uploads = [];
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
      upload:
          ({
            required tabId,
            required conversationId,
            required name,
            required mime,
            required bytes,
            required cancel,
            required onProgress,
          }) {
            uploads.add(name);
            return Completer<Map<String, dynamic>>().future;
          },
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

  /// Speech for half a second, then a breath: the phrase is cut.
  Future<void> sayPhrase(WidgetTester tester) async {
    recorder.meter.value = 0.8;
    await tester.pump(const Duration(milliseconds: 500));
    recorder.meter.value = 0.02;
    await tester.pump(SwarmVoice.breath);
    await frames(tester);
  }

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

  testWidgets('words show in the box while the person is still talking', (
    tester,
  ) async {
    await pump(tester);
    recorder.phrases.addAll([
      FakePhraseRecorder.said(),
      FakePhraseRecorder.said(),
    ]);
    stt.replies.addAll(['hôm nay mình làm', 'gì nữa']);

    await tapMic(tester);
    await sayPhrase(tester);
    expect(box(tester), 'hôm nay mình làm');
    expect(recorder.recording, isTrue, reason: 'still listening');

    await sayPhrase(tester);
    expect(box(tester), 'hôm nay mình làm gì nữa');
    expect(recorder.recording, isTrue);
    expect(fake.commands, isEmpty);

    await tapMic(tester);
    await tester.pumpAndSettle();
    expect(fake.commands.single['text'], 'hôm nay mình làm gì nữa');
  });

  testWidgets('what was typed, and what is typed while talking, goes with the '
      'second tap', (tester) async {
    await pump(tester);
    await tester.enterText(find.byType(TextField), 'Nova:');
    await tester.pump();
    recorder.phrases.add(FakePhraseRecorder.said());
    stt.replies.add('ship the fix');

    await tapMic(tester);
    await sayPhrase(tester);
    expect(box(tester), 'Nova: ship the fix');

    await tester.enterText(find.byType(TextField), 'Nova: ship it tomorrow');
    await tester.pump();
    expect(fake.commands, isEmpty);

    await tapMic(tester);
    await tester.pumpAndSettle();
    expect(fake.commands.single['text'], 'Nova: ship it tomorrow');
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

  testWidgets('a second tap sends nothing once the box was emptied, though '
      'files wait to go', (tester) async {
    final documents = pickSwarmFiles, copies = swarmPickerCopyFolders;
    addTearDown(() {
      pickSwarmFiles = documents;
      swarmPickerCopyFolders = copies;
    });
    swarmPickerCopyFolders = () async => const [];
    pickSwarmFiles = () async => [
      XFile.fromData(
        Uint8List(12),
        path: '/picker-copies/crash.log',
        length: 12,
      ),
    ];
    await pump(tester);
    await tester.tap(key('swarm-attach'));
    await tester.pumpAndSettle();
    await tester.tap(key('swarm-attach-files'));
    await tester.pumpAndSettle();
    expect(key('swarm-outgoing-crash.log'), findsOneWidget);
    recorder.phrases.add(FakePhraseRecorder.said());
    stt.replies.add('wrong words');

    await tapMic(tester);
    await sayPhrase(tester);
    expect(box(tester), 'wrong words');
    await tester.enterText(find.byType(TextField), '');
    await tester.pump();
    await tapMic(tester);
    await tester.pumpAndSettle();

    expect(uploads, isEmpty);
    expect(fake.commands, isEmpty);
    expect(key('swarm-outgoing-crash.log'), findsOneWidget);
  });

  testWidgets('a take that lost a phrase keeps the box and sends nothing', (
    tester,
  ) async {
    await pump(tester);
    recorder.phrases.add(FakePhraseRecorder.said());
    stt.fails = true;

    await tapMic(tester);
    await sayPhrase(tester);
    expect(
      find.text("Couldn't transcribe · tap the mic again"),
      findsOneWidget,
    );

    stt.fails = false;
    stt.replies.add('and the rest');
    await tapMic(tester);
    await tester.pumpAndSettle();
    expect(box(tester), 'and the rest');
    expect(fake.commands, isEmpty);
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

/// A microphone that also says how loud it is: what the breath that cuts a
/// phrase, and the pause that ends a take, listen to.
class _MeteredRecorder extends FakePhraseRecorder implements VoiceLevelMeter {
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
