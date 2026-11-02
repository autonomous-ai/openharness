import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/phone/voice_input_controller.dart';
import 'package:harness_mobile/phone/voice_language_store.dart';
import 'package:harness_mobile/phone/voice_mic_face.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart' as grid;
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_dictation.dart';
import 'package:harness_mobile/swarm/swarm_file_picker.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';
import 'package:harness_mobile/swarm/swarm_voice.dart';
import 'package:image_picker/image_picker.dart' show XFile;

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// A Swarm chat's mic on the phone's own speech recognizer (Tony, 10-28: the
/// one the keyboard's dictation uses): the words show in the message box as
/// they are said, and it listens on — through any pause — until Stop ends it
/// with the words left in the box, or Cancel takes back what it added. Voice
/// never sends by itself (Tony, 11-01): Send does. Only two minutes without a
/// new word stop it before that, the words left in the box (Lead, review of
/// #2056). Refused, or without the language, the mic records and the backend
/// transcribes.
void main() {
  const messages = '/api/super-tabs/$tab/conversations/g1/messages';
  const commands = '/api/super-tabs/$tab/commands';

  late FakeSwarm fake;
  late FakeDictation dictation;
  late FakeVoiceRecorder recorder;
  late FakeTranscriber stt;
  late List<String> uploads;
  late String language;

  /// Who is signed in, in the last [pump].
  late ValueNotifier<String?> account;

  setUp(() {
    dictation = FakeDictation();
    recorder = FakeVoiceRecorder();
    stt = FakeTranscriber();
    uploads = [];
    language = voiceLanguageStore.value;
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
    fake.routes[messages] = (_) => {'messages': <Object>[], 'next': null};
    fake.routes[commands] = (_) => {'result': <String, dynamic>{}};
  });

  tearDown(() => voiceLanguageStore.value = language);

  Future<void> pump(WidgetTester tester, {bool reduceMotion = false}) async {
    final features = ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
      ..value = {PhoneExperiment.swarm};
    account = ValueNotifier<String?>(me);
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
            required file,
            required cancel,
            required onProgress,
          }) {
            uploads.add(name);
            return Completer<Map<String, dynamic>>().future;
          },
      voice: () => VoiceInputController(
        transcriber: stt.call,
        recorder: recorder,
        language: ValueNotifier('vi'),
      ),
      dictation: dictation,
    )..foreground = false;
    addTearDown(host.dispose);
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context)
              .copyWith(disableAnimations: reduceMotion),
          child: SwarmScope(notifier: host, child: child!),
        ),
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

  /// The voice row's Stop: the take ends, its words left in the box.
  Future<void> stop(WidgetTester tester) async {
    await tester.tap(key('swarm-voice-stop'));
    await frames(tester);
  }

  /// The voice row's Cancel: what the take added leaves the box.
  Future<void> cancel(WidgetTester tester) async {
    await tester.tap(key('swarm-voice-cancel'));
    await frames(tester);
  }

  /// Back at rest: the mic and Send in the toolbar, no voice row.
  void atRest() {
    expect(key('swarm-voice-wave'), findsNothing);
    expect(key('swarm-mic'), findsOneWidget);
    expect(key('swarm-send'), findsOneWidget);
  }

  Future<void> say(WidgetTester tester, String words) async {
    dictation.say(words);
    await frames(tester);
  }

  String box(WidgetTester tester) =>
      tester.widget<TextField>(find.byType(TextField)).controller!.text;

  Future<void> lifecycle(
    WidgetTester tester,
    List<AppLifecycleState> states,
  ) async {
    for (final state in states) {
      tester.binding.handleAppLifecycleStateChanged(state);
    }
    await frames(tester);
  }

  testWidgets('words show in the box as they are said, revised as the '
      'recognizer changes its mind', (tester) async {
    voiceLanguageStore.value = 'vi';
    await pump(tester);

    await tapMic(tester);
    expect(dictation.locales, ['vi-VN']);
    expect(recorder.starts, 0, reason: 'the recognizer has the microphone');
    expect(key('swarm-voice-stop'), findsOneWidget);
    expect(key('swarm-mic'), findsNothing);

    await say(tester, 'hôm');
    expect(box(tester), 'hôm');
    await say(tester, 'hôm nay mình làm');
    expect(box(tester), 'hôm nay mình làm');
    await say(tester, 'Hôm nay mình làm gì?');
    expect(box(tester), 'Hôm nay mình làm gì?');
    expect(dictation.listening, isTrue);
    expect(fake.commands, isEmpty);
  });

  // Tony, 11-01: voice never sends by itself; sending is a tap on Send.
  testWidgets('Stop ends listening with its last words in the box, sends '
      'nothing and says nothing; Send then posts them', (tester) async {
    await pump(tester);
    await tapMic(tester);
    await say(tester, 'một hai ba');

    dictation.lastWords = 'một hai ba bốn';
    await stop(tester);
    await tester.pumpAndSettle();

    expect(dictation.stops, 1);
    expect(box(tester), 'một hai ba bốn');
    expect(fake.commands, isEmpty, reason: 'Stop never sends');
    expect(key('swarm-voice-note'), findsNothing);
    atRest();

    await tester.tap(key('swarm-send'));
    await tester.pumpAndSettle();
    expect(fake.commands.single['text'], 'một hai ba bốn');
    expect(box(tester), isEmpty);
  });

  testWidgets('what was typed stays in front, and an edit made while talking '
      'is kept in the box after Stop', (tester) async {
    await pump(tester);
    await tester.enterText(find.byType(TextField), 'Nova:');
    await tester.pump();

    await tapMic(tester);
    await say(tester, 'ship it');
    expect(box(tester), 'Nova: ship it');

    await tester.enterText(find.byType(TextField), 'Nova: ship it now');
    await tester.pump();
    await say(tester, 'ship it today');
    expect(box(tester), 'Nova: ship it now today');

    await stop(tester);
    await tester.pumpAndSettle();
    expect(box(tester), 'Nova: ship it now today');
    expect(fake.commands, isEmpty);
  });

  testWidgets('Cancel takes back what the take said and keeps what was typed '
      'before it', (tester) async {
    await pump(tester);
    await tester.enterText(find.byType(TextField), 'Nova:');
    await tester.pump();

    await tapMic(tester);
    await say(tester, 'ship it');
    expect(box(tester), 'Nova: ship it');

    await cancel(tester);
    await tester.pumpAndSettle();
    expect(box(tester), 'Nova:');
    expect(dictation.cancels, 1, reason: 'the microphone released');
    expect(dictation.listening, isFalse);
    expect(fake.commands, isEmpty);
    expect(key('swarm-voice-note'), findsNothing);
    atRest();
  });

  testWidgets('Cancel keeps an edit made during the take and drops only the '
      'words said after it', (tester) async {
    await pump(tester);
    await tapMic(tester);
    await say(tester, 'ship it');
    await tester.enterText(find.byType(TextField), 'ship it now');
    await tester.pump();
    await say(tester, 'ship it today');
    expect(box(tester), 'ship it now today');

    await cancel(tester);
    await tester.pumpAndSettle();
    expect(box(tester), 'ship it now');
    expect(fake.commands, isEmpty);
  });

  testWidgets('Cancel right after an edit, with no word since, keeps the box '
      'as the person left it', (tester) async {
    await pump(tester);
    await tapMic(tester);
    await say(tester, 'ship it');
    await tester.enterText(find.byType(TextField), 'ship it now!');
    await tester.pump();

    await cancel(tester);
    await tester.pumpAndSettle();
    expect(box(tester), 'ship it now!');
    expect(fake.commands, isEmpty);
  });

  testWidgets('Cancel while the recognizer is stopping drops what the take '
      'said', (tester) async {
    await pump(tester);
    await tester.enterText(find.byType(TextField), 'Draft');
    await tester.pump();
    await tapMic(tester);
    await say(tester, 'gửi đi');

    dictation.stopsSilently = true;
    await stop(tester);
    expect(key('swarm-voice-busy'), findsOneWidget);
    await cancel(tester);
    await tester.pumpAndSettle();

    expect(box(tester), 'Draft');
    expect(dictation.cancels, 1);
    expect(fake.commands, isEmpty);
    atRest();
  });

  testWidgets("only the row's Send during a take: no composer Send, +, Tag "
      'or X; they come back after Stop', (tester) async {
    await pump(tester);
    await tester.enterText(find.byType(TextField), 'Draft');
    await tester.pump();
    expect(key('swarm-field-clear'), findsOneWidget);

    await tapMic(tester);
    expect(key('swarm-send'), findsNothing);
    expect(key('swarm-attach'), findsNothing);
    expect(key('swarm-tag'), findsNothing);
    expect(key('swarm-mic'), findsNothing);
    expect(key('swarm-field-clear'), findsNothing);
    expect(key('swarm-voice-cancel'), findsOneWidget);
    expect(key('swarm-voice-wave'), findsOneWidget);
    expect(key('swarm-voice-stop'), findsOneWidget);
    expect(key('swarm-voice-send'), findsOneWidget);

    await say(tester, 'ship it');
    await stop(tester);
    await tester.pumpAndSettle();
    atRest();
    expect(key('swarm-voice-send'), findsNothing);
    expect(key('swarm-attach'), findsOneWidget);
    expect(key('swarm-tag'), findsOneWidget);
    expect(key('swarm-field-clear'), findsOneWidget);
    expect(
      tester.widget<SwarmRoundButton>(key('swarm-send')).onTap,
      isNotNull,
      reason: 'Send is live again',
    );
  });

  // Tony, 11-01: Send right of stop ends the take and posts the box, the last
  // words included. With the recognizer the words are in the box as they are
  // said: Send is off while it is empty.
  group("the voice row's Send", () {
    Future<void> rowSend(WidgetTester tester) async {
      await tester.tap(key('swarm-voice-send'));
      await frames(tester);
    }

    SwarmRoundButton sendButton(WidgetTester tester) =>
        tester.widget<SwarmRoundButton>(key('swarm-voice-send'));

    testWidgets('off while the box is empty, on once it has words', (
      tester,
    ) async {
      await pump(tester);
      await tapMic(tester);
      expect(sendButton(tester).onTap, isNull, reason: 'empty box');
      await rowSend(tester);
      expect(dictation.stops, 0, reason: 'an off Send ends nothing');
      expect(dictation.listening, isTrue);

      await say(tester, 'ship');
      expect(sendButton(tester).onTap, isNotNull);

      await tester.enterText(find.byType(TextField), ' ');
      await tester.pump();
      expect(sendButton(tester).onTap, isNull, reason: 'only a space');
      expect(fake.commands, isEmpty);
    });

    testWidgets('one tap ends the take and posts the box with its last '
        'words, once', (tester) async {
      await pump(tester);
      await tester.enterText(find.byType(TextField), 'Nova:');
      await tester.pump();
      await tapMic(tester);
      await say(tester, 'ship the');

      dictation.lastWords = 'ship the fix today';
      await rowSend(tester);
      await tester.pumpAndSettle();

      expect(dictation.stops, 1);
      expect(fake.commands.single['text'], 'Nova: ship the fix today');
      expect(box(tester), isEmpty);
      expect(key('swarm-voice-note'), findsNothing);
      atRest();
    });

    testWidgets('waits for the last words no longer than about two seconds, '
        'then posts what the box holds', (tester) async {
      await pump(tester);
      await tapMic(tester);
      await say(tester, 'ship it');

      dictation.stopsSilently = true;
      await rowSend(tester);
      expect(key('swarm-voice-sending'), findsOneWidget);
      await tester.pump(const Duration(milliseconds: 1900));
      expect(fake.commands, isEmpty, reason: 'still waiting for its words');

      await tester.pump(const Duration(milliseconds: 200));
      await tester.pumpAndSettle();
      expect(fake.commands.single['text'], 'ship it');
      expect(dictation.cancels, 1, reason: 'the microphone released');
      atRest();
    });

    testWidgets('a double tap posts once', (tester) async {
      await pump(tester);
      await tapMic(tester);
      await say(tester, 'just once');

      dictation.stopsSilently = true;
      final at = tester.getCenter(key('swarm-voice-send'));
      for (var i = 0; i < 2; i++) {
        await tester.tapAt(at);
        await tester.pump(const Duration(milliseconds: 40));
      }
      expect(dictation.stops, 1);
      dictation.end(SwarmDictationEnd.done);
      await tester.pump();
      await tester.tapAt(at);
      await tester.pumpAndSettle();

      expect(fake.commands, hasLength(1));
      expect(fake.commands.single['text'], 'just once');
    });

    testWidgets('while it ends the row takes no tap: cancel does not take '
        'the words back', (tester) async {
      await pump(tester);
      await tapMic(tester);
      await say(tester, 'keep these');

      dictation.stopsSilently = true;
      await rowSend(tester);
      expect(sendButton(tester).onTap, isNull);
      await cancel(tester);
      expect(box(tester), 'keep these');

      dictation.end(SwarmDictationEnd.done);
      await tester.pumpAndSettle();
      expect(fake.commands.single['text'], 'keep these');
    });

    testWidgets('a box emptied before the take ended posts nothing and says '
        'one line', (tester) async {
      await pump(tester);
      await tapMic(tester);
      await say(tester, 'oops');

      dictation.stopsSilently = true;
      await rowSend(tester);
      await tester.enterText(find.byType(TextField), '');
      await tester.pump();
      dictation.end(SwarmDictationEnd.done);
      await tester.pumpAndSettle();

      expect(fake.commands, isEmpty);
      expect(find.text(SwarmVoice.nothingSent), findsOneWidget);
    });

    testWidgets('the app leaving while the take ends posts nothing; the words '
        'stay in the box', (tester) async {
      await pump(tester);
      await tapMic(tester);
      await say(tester, 'not yet');

      dictation.stopsSilently = true;
      await rowSend(tester);
      await lifecycle(tester, [AppLifecycleState.inactive]);
      await lifecycle(tester, [AppLifecycleState.resumed]);
      dictation.end(SwarmDictationEnd.done);
      await tester.pump(const Duration(seconds: 3));
      await tester.pumpAndSettle();

      expect(fake.commands, isEmpty);
      expect(box(tester), 'not yet');
      expect(find.text(SwarmVoice.nothingSent), findsNothing);
    });

    testWidgets('signed out while the take ends: nothing is posted', (
      tester,
    ) async {
      await pump(tester);
      await tapMic(tester);
      await say(tester, 'after sign out');

      dictation.stopsSilently = true;
      await rowSend(tester);
      account.value = null;
      await frames(tester);
      dictation.end(SwarmDictationEnd.done);
      await tester.pump(const Duration(seconds: 3));
      await tester.pumpAndSettle();

      expect(fake.commands, isEmpty);
    });
  });

  testWidgets('the @ picker hides during a take and comes back after Cancel', (
    tester,
  ) async {
    await pump(tester);
    await tester.enterText(find.byType(TextField), '@');
    await tester.pump();
    expect(key('swarm-mention-picker'), findsOneWidget);

    await tapMic(tester);
    expect(key('swarm-mention-picker'), findsNothing);

    await cancel(tester);
    await tester.pumpAndSettle();
    expect(box(tester), '@');
    expect(key('swarm-mention-picker'), findsOneWidget);
  });

  // Lead, review of #2056 at a43760af3: an edit, then the recognizer revising
  // what it heard into fewer words.
  testWidgets('an edit, then a shorter revision of what was said, drops no '
      'spoken word', (tester) async {
    await pump(tester);
    await tapMic(tester);
    await say(tester, 'một hai');
    expect(box(tester), 'một hai');

    await tester.enterText(find.byType(TextField), 'một hai,');
    await tester.pump();
    await say(tester, '12');
    await say(tester, '123 bốn');
    expect(box(tester), 'một hai, 123 bốn');

    await stop(tester);
    await tester.pumpAndSettle();
    expect(box(tester), 'một hai, 123 bốn');
    expect(fake.commands, isEmpty);
  });

  // Tony, 10-29: "listening continues until I tap".
  testWidgets('listening goes on through a silence of nearly two minutes '
      'until Stop, which leaves what was said in the box', (tester) async {
    await pump(tester);
    await tapMic(tester);
    await say(tester, 'xong rồi');

    for (var i = 0; i < 11; i++) {
      await tester.pump(const Duration(seconds: 10));
    }
    await tester.pump(const Duration(seconds: 9));
    expect(dictation.stops, 0);
    expect(dictation.listening, isTrue);
    expect(key('swarm-voice-stop'), findsOneWidget);
    expect(fake.commands, isEmpty);

    await stop(tester);
    await tester.pumpAndSettle();
    expect(box(tester), 'xong rồi');
    expect(fake.commands, isEmpty, reason: 'only Send sends');
  });

  testWidgets('talking with pauses under two minutes never stops it', (
    tester,
  ) async {
    await pump(tester);
    await tapMic(tester);

    var said = 'một';
    await say(tester, said);
    for (var i = 0; i < 5; i++) {
      await tester.pump(const Duration(seconds: 115));
      said = '$said hai';
      await say(tester, said);
    }
    expect(dictation.listening, isTrue, reason: 'ten minutes in');
    expect(dictation.stops + dictation.cancels, 0);

    await stop(tester);
    await tester.pumpAndSettle();
    expect(box(tester), said);
    expect(fake.commands, isEmpty);
  });

  // Lead, review of #2056 at a43760af3 (privacy): the microphone is not held
  // open for nobody.
  testWidgets('two minutes without a new word stop listening and release the '
      'mic; the words stay, for Send or another take', (tester) async {
    await pump(tester);
    await tapMic(tester);
    await say(tester, 'gần xong');
    await tester.pump(const Duration(seconds: 60));
    // The same words said again by the recognizer are not new ones.
    await say(tester, 'gần xong');

    await tester.pump(const Duration(seconds: 59));
    expect(dictation.listening, isTrue);
    await tester.pump(const Duration(seconds: 1));
    await frames(tester);
    expect(dictation.listening, isFalse);
    expect(dictation.cancels, 1, reason: 'the microphone released at once');
    atRest();
    expect(box(tester), 'gần xong');
    expect(fake.commands, isEmpty);

    await tester.tap(key('swarm-send'));
    await tester.pumpAndSettle();
    expect(fake.commands.single['text'], 'gần xong');

    await tapMic(tester);
    expect(dictation.listening, isTrue, reason: 'a new take');
    expect(dictation.locales, hasLength(2));
  });

  testWidgets('two minutes with nothing said at all stop listening too', (
    tester,
  ) async {
    await pump(tester);
    await tester.enterText(find.byType(TextField), 'Draft');
    await tester.pump();
    await tapMic(tester);

    await tester.pump(const Duration(minutes: 2));
    await frames(tester);
    expect(dictation.listening, isFalse);
    expect(dictation.cancels, 1);
    expect(box(tester), 'Draft');
    expect(fake.commands, isEmpty);
  });

  testWidgets('stopping by itself says so quietly for three seconds; the '
      'words stay in the box', (tester) async {
    await pump(tester);
    await tapMic(tester);
    await say(tester, 'almost done');
    expect(find.text('Stopped listening'), findsNothing);

    await tester.pump(const Duration(minutes: 2));
    await frames(tester);
    expect(dictation.listening, isFalse);
    expect(
      tester.widget<Text>(key('swarm-voice-stopped')).data,
      'Stopped listening',
    );
    expect(box(tester), 'almost done');
    expect(key('swarm-voice-note'), findsNothing, reason: 'nothing went wrong');

    await tester.pump(const Duration(milliseconds: 2900));
    expect(find.text('Stopped listening'), findsOneWidget);
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.text('Stopped listening'), findsNothing);
    expect(box(tester), 'almost done');
    expect(fake.commands, isEmpty);
  });

  testWidgets('Stop ends no take with Stopped listening, and a new take '
      'takes it away', (tester) async {
    await pump(tester);
    await tapMic(tester);
    await say(tester, 'Ship it');
    await stop(tester);
    await tester.pumpAndSettle();
    expect(find.text('Stopped listening'), findsNothing, reason: 'stopped');

    await tapMic(tester);
    await tester.pump(const Duration(minutes: 2));
    await frames(tester);
    expect(find.text('Stopped listening'), findsOneWidget);
    await tapMic(tester);
    expect(find.text('Stopped listening'), findsNothing);
  });

  testWidgets('Stop with nothing said sends nothing', (tester) async {
    await pump(tester);
    await tapMic(tester);
    await stop(tester);
    await tester.pumpAndSettle();

    expect(dictation.stops, 1);
    expect(box(tester), isEmpty);
    expect(fake.commands, isEmpty);
  });

  testWidgets('Stop with nothing said leaves what was typed, unsent and with '
      'no notice', (tester) async {
    await pump(tester);
    await tester.enterText(find.byType(TextField), 'Draft');
    await tester.pump();

    await tapMic(tester);
    await stop(tester);
    await tester.pumpAndSettle();

    expect(box(tester), 'Draft');
    expect(fake.commands, isEmpty);
    expect(find.text("Didn't catch that · tap the mic again"), findsNothing);
  });

  testWidgets('Stop with nothing said and an empty box says so', (
    tester,
  ) async {
    await pump(tester);
    await tapMic(tester);
    await stop(tester);
    await tester.pumpAndSettle();

    expect(fake.commands, isEmpty);
    expect(find.text("Didn't catch that · tap the mic again"), findsOneWidget);
  });

  testWidgets('a recognizer that never says it stopped is given up after two '
      'seconds, its words left in the box, unsent', (tester) async {
    await pump(tester);
    await tapMic(tester);
    await say(tester, 'gửi đi');

    dictation.stopsSilently = true;
    await stop(tester);
    await tester.pump(const Duration(milliseconds: 1900));
    expect(
      tester.widget<VoiceMicCore>(find.byType(VoiceMicCore)).face,
      VoiceMicFace.busy,
      reason: 'still waiting for its last words',
    );
    expect(key('swarm-voice-stop'), findsNothing);
    expect(key('swarm-voice-cancel'), findsOneWidget);

    await tester.pump(const Duration(milliseconds: 200));
    await frames(tester);
    expect(find.byType(VoiceMicCore), findsNothing);
    expect(dictation.cancels, 1);
    await tester.pumpAndSettle();
    expect(box(tester), 'gửi đi');
    expect(fake.commands, isEmpty);
    expect(key('swarm-voice-note'), findsNothing);
    atRest();
  });

  testWidgets('Stop after the box was emptied leaves it empty and sends '
      'nothing, though files wait to go', (tester) async {
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

    await tapMic(tester);
    await say(tester, 'nhầm rồi');
    await tester.enterText(find.byType(TextField), '');
    await tester.pump();
    dictation.lastWords = 'nhầm rồi';
    await stop(tester);
    await tester.pumpAndSettle();

    expect(box(tester), isEmpty);
    expect(uploads, isEmpty);
    expect(fake.commands, isEmpty);
    expect(key('swarm-outgoing-crash.log'), findsOneWidget);
    expect(
      tester.widget<SwarmRoundButton>(key('swarm-send')).onTap,
      isNotNull,
      reason: 'the files can still go, by Send',
    );
  });

  testWidgets('listening that cannot go on stops, its words left unsent', (
    tester,
  ) async {
    await pump(tester);
    await tapMic(tester);
    await say(tester, 'một phút rồi');

    dictation.end(SwarmDictationEnd.done);
    await frames(tester);

    expect(box(tester), 'một phút rồi');
    expect(fake.commands, isEmpty);
    expect(find.byType(VoiceMicCore), findsNothing);
  });

  testWidgets('a recognizer that fails says so and keeps what it heard', (
    tester,
  ) async {
    await pump(tester);
    await tapMic(tester);
    await say(tester, 'một');

    dictation.end(SwarmDictationEnd.failed);
    await frames(tester);

    expect(box(tester), 'một');
    expect(
      find.text("Couldn't transcribe · tap the mic again"),
      findsOneWidget,
    );
    expect(fake.commands, isEmpty);
  });

  testWidgets('Stop on a recognizer that fails as it stops keeps the box, '
      'says nothing and sends nothing', (tester) async {
    await pump(tester);
    await tapMic(tester);
    await say(tester, 'gửi');

    dictation.stopEnd = SwarmDictationEnd.failed;
    await stop(tester);
    await tester.pumpAndSettle();

    expect(box(tester), 'gửi');
    expect(fake.commands, isEmpty);
    expect(find.text("Couldn't transcribe · tap the mic again"), findsNothing);
  });

  testWidgets('Stop keeps what was said though the last session heard '
      'nothing', (tester) async {
    await pump(tester);
    await tapMic(tester);
    await say(tester, 'xin chào');

    dictation.stopEnd = SwarmDictationEnd.noSpeech;
    await stop(tester);
    await tester.pumpAndSettle();

    expect(box(tester), 'xin chào');
    expect(fake.commands, isEmpty);
    expect(find.text("Didn't catch that · tap the mic again"), findsNothing);
  });

  testWidgets('nothing said before the recognizer gives up is said so', (
    tester,
  ) async {
    await pump(tester);
    await tapMic(tester);

    dictation.end(SwarmDictationEnd.noSpeech);
    await frames(tester);

    expect(find.text("Didn't catch that · tap the mic again"), findsOneWidget);
  });

  testWidgets('the wave follows how loud the recognizer hears', (tester) async {
    await pump(tester);
    await tapMic(tester);

    dictation.loud(0.8);
    await tester.pump();

    expect(
      tester.widget<SwarmVoiceWave>(key('swarm-voice-wave')).level!.value,
      0.8,
    );
  });

  /// The wave's bars as it paints them now, on a 200 x 44 strip: each one's
  /// height.
  List<double> waveBars(WidgetTester tester) {
    final painter = tester
        .widget<CustomPaint>(
          find.descendant(
            of: key('swarm-voice-wave'),
            matching: find.byType(CustomPaint),
          ),
        )
        .painter!;
    final canvas = _BarCanvas();
    painter.paint(canvas, const Size(200, 44));
    return canvas.heights;
  }

  double total(List<double> bars) => bars.fold(0, (sum, bar) => sum + bar);

  /// Half a second of the wave's frames.
  Future<void> wave(WidgetTester tester) async {
    for (var i = 0; i < 10; i++) {
      await tester.pump(const Duration(milliseconds: 50));
    }
  }

  // Lead, 10-29: "a live wave animation driven by the mic level".
  testWidgets('the wave rises as the voice does', (tester) async {
    await pump(tester);
    await tapMic(tester);
    dictation.loud(0);
    await wave(tester);
    final quiet = total(waveBars(tester));

    dictation.loud(0.8);
    await wave(tester);
    expect(total(waveBars(tester)), greaterThan(quiet + 40));
    expect(waveBars(tester).every((h) => h >= 3 && h <= 24), isTrue);
  });

  testWidgets('the wave is not frozen in silence: it keeps moving', (
    tester,
  ) async {
    await pump(tester);
    await tapMic(tester);
    dictation.loud(0);
    await wave(tester);
    final before = waveBars(tester);

    await wave(tester);
    final after = waveBars(tester);
    expect(after, isNot(equals(before)), reason: 'the history scrolls');
    expect(after.any((h) => h > 3), isTrue, reason: 'a breath, not a line');
  });

  testWidgets('with Reduce Motion on, the wave holds still but follows the '
      'voice', (tester) async {
    await pump(tester, reduceMotion: true);
    await tapMic(tester);
    dictation.loud(0);
    await tester.pump();
    final quiet = waveBars(tester);

    await wave(tester);
    expect(waveBars(tester), equals(quiet), reason: 'nothing scrolls');

    dictation.loud(0.8);
    await tester.pump();
    expect(total(waveBars(tester)), greaterThan(total(quiet) + 40));
  });

  testWidgets('the long-press language is the one listened in', (tester) async {
    voiceLanguageStore.value = 'ja';
    await pump(tester);

    await tapMic(tester);

    expect(dictation.locales, ['ja-JP']);
  });

  testWidgets('speech recognition refused: the mic records, Stop transcribes '
      'into the box unsent, and it is not asked again', (tester) async {
    dictation.answer = SwarmDictationAccess.denied;
    await pump(tester);
    stt.replies.addAll(['ghi âm', 'lần nữa']);

    await tapMic(tester);
    expect(dictation.locales, isEmpty);
    expect(recorder.recording, isTrue);
    await stop(tester);
    await tester.pumpAndSettle();
    expect(box(tester), 'ghi âm');
    expect(fake.commands, isEmpty);

    await tapMic(tester);
    expect(dictation.asks, 1);
    expect(recorder.recording, isTrue);
  });

  testWidgets('a language the recognizer lacks records and transcribes '
      'instead', (tester) async {
    dictation.hasLocale = false;
    await pump(tester);

    await tapMic(tester);

    expect(dictation.locales, hasLength(1));
    expect(recorder.recording, isTrue);
  });

  testWidgets('Cancel while the permission prompt is up calls the take off', (
    tester,
  ) async {
    dictation.pendingAccess = Completer();
    await pump(tester);

    await tapMic(tester);
    expect(key('swarm-voice-cancel'), findsOneWidget);
    expect(key('swarm-voice-stop'), findsNothing, reason: 'still opening');
    await cancel(tester);
    dictation.pendingAccess!.complete(SwarmDictationAccess.allowed);
    await frames(tester);

    expect(dictation.locales, isEmpty);
    expect(recorder.starts, 0);
    atRest();
  });

  testWidgets('the permission prompt over the app keeps the take it asks for', (
    tester,
  ) async {
    addTearDown(
      () => tester.binding.handleAppLifecycleStateChanged(
        AppLifecycleState.resumed,
      ),
    );
    dictation.pendingAccess = Completer();
    await pump(tester);

    await tapMic(tester);
    await lifecycle(tester, [AppLifecycleState.inactive]);
    dictation.pendingAccess!.complete(SwarmDictationAccess.allowed);
    await lifecycle(tester, [AppLifecycleState.resumed]);

    expect(dictation.listening, isTrue);
    await say(tester, 'được');
    expect(box(tester), 'được');
  });

  testWidgets('Control Center or the app going away stops listening; the '
      'words already shown stay', (tester) async {
    addTearDown(
      () => tester.binding.handleAppLifecycleStateChanged(
        AppLifecycleState.resumed,
      ),
    );
    await pump(tester);
    await tapMic(tester);
    await say(tester, 'trước');

    await lifecycle(tester, [AppLifecycleState.inactive]);

    expect(dictation.cancels, 1);
    expect(dictation.listening, isFalse);
    await lifecycle(tester, [AppLifecycleState.resumed]);
    await tester.pump(const Duration(seconds: 5));
    expect(box(tester), 'trước');
    expect(fake.commands, isEmpty);
  });

  testWidgets('what a take called off still says lands nowhere, even in the '
      'next take', (tester) async {
    addTearDown(
      () => tester.binding.handleAppLifecycleStateChanged(
        AppLifecycleState.resumed,
      ),
    );
    await pump(tester);
    await tapMic(tester);
    await say(tester, 'trước');
    final first = dictation.heard.single;
    await lifecycle(tester, [
      AppLifecycleState.inactive,
      AppLifecycleState.resumed,
    ]);
    await tapMic(tester);
    await say(tester, 'sau');

    first('trước nữa');
    await frames(tester);

    expect(box(tester), 'trước sau');
  });

  testWidgets('covering the chat stops listening', (tester) async {
    await pump(tester);
    await tapMic(tester);
    await say(tester, 'đang nói');

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

    expect(dictation.cancels, 1);
    expect(dictation.listening, isFalse);
    expect(fake.commands, isEmpty);
  });

  testWidgets('leaving the chat stops listening', (tester) async {
    await pump(tester);
    await tapMic(tester);

    await tester.pumpWidget(const SizedBox());

    expect(dictation.cancels, 1);
  });
}

/// The phone's own recognizer, spoken for by the test: [say] is what it
/// heard so far, [end] how it stopped by itself; [stop] delivers [lastWords]
/// and ends with [stopEnd] — or, [stopsSilently], never says it has.
class FakeDictation implements SwarmDictation {
  SwarmDictationAccess answer = SwarmDictationAccess.allowed;
  Completer<SwarmDictationAccess>? pendingAccess;
  bool hasLocale = true;
  String? lastWords;
  SwarmDictationEnd stopEnd = SwarmDictationEnd.done;
  bool stopsSilently = false;

  final List<String> locales = [];

  /// Each take's `onWords`, called off or not.
  final List<void Function(String)> heard = [];
  int asks = 0, stops = 0, cancels = 0;

  void Function(String)? _words;
  void Function(double)? _level;
  void Function(SwarmDictationEnd)? _end;

  bool get listening => _end != null;

  void say(String words) => _words?.call(words);

  void loud(double level) => _level?.call(level);

  void end(SwarmDictationEnd end) {
    final ended = _end;
    _forget();
    ended?.call(end);
  }

  @override
  Future<SwarmDictationAccess> access() {
    asks++;
    return pendingAccess?.future ?? Future.value(answer);
  }

  @override
  Future<bool> start(
    String locale, {
    required void Function(String words) onWords,
    required void Function(double level) onLevel,
    required void Function(SwarmDictationEnd end) onEnd,
  }) async {
    locales.add(locale);
    if (!hasLocale) return false;
    heard.add(onWords);
    _words = onWords;
    _level = onLevel;
    _end = onEnd;
    return true;
  }

  @override
  Future<void> stop() async {
    stops++;
    if (stopsSilently) return;
    if (lastWords case final words?) say(words);
    end(stopEnd);
  }

  @override
  Future<void> cancel() async {
    cancels++;
    _forget();
  }

  void _forget() {
    _words = null;
    _level = null;
    _end = null;
  }
}

/// A canvas that keeps the height of each bar painted on it, and nothing else.
class _BarCanvas implements Canvas {
  final List<double> heights = [];

  @override
  void drawRRect(RRect rrect, Paint paint) => heights.add(rrect.height);

  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}
