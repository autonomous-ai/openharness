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
import 'package:image_picker/image_picker.dart' show XFile;

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// A Swarm chat's mic on the phone's own speech recognizer (Tony, 10-28: the
/// one the keyboard's dictation uses): the words show in the message box as
/// they are said, a second tap stops and sends what is in the box, and three
/// seconds without a new word stop it with the words left unsent. Refused,
/// or without the language, the mic records and the backend transcribes.
void main() {
  const messages = '/api/super-tabs/$tab/conversations/g1/messages';
  const commands = '/api/super-tabs/$tab/commands';

  late FakeSwarm fake;
  late FakeDictation dictation;
  late FakeVoiceRecorder recorder;
  late FakeTranscriber stt;
  late List<String> uploads;
  late String language;

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

  Future<void> pump(WidgetTester tester) async {
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
    expect(
      tester.widget<VoiceMicCore>(find.byType(VoiceMicCore)).face,
      VoiceMicFace.listening,
    );

    await say(tester, 'hôm');
    expect(box(tester), 'hôm');
    await say(tester, 'hôm nay mình làm');
    expect(box(tester), 'hôm nay mình làm');
    await say(tester, 'Hôm nay mình làm gì?');
    expect(box(tester), 'Hôm nay mình làm gì?');
    expect(dictation.listening, isTrue);
    expect(fake.commands, isEmpty);
  });

  testWidgets('the second tap stops listening and sends what is in the box, '
      'its last words included', (tester) async {
    await pump(tester);
    await tapMic(tester);
    await say(tester, 'một hai ba');

    dictation.lastWords = 'một hai ba bốn';
    await tapMic(tester);
    await tester.pumpAndSettle();

    expect(dictation.stops, 1);
    expect(fake.commands.single['text'], 'một hai ba bốn');
    expect(box(tester), isEmpty);
  });

  testWidgets('what was typed stays in front, and an edit made while talking '
      'is kept and sent', (tester) async {
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

    await tapMic(tester);
    await tester.pumpAndSettle();
    expect(fake.commands.single['text'], 'Nova: ship it now today');
  });

  testWidgets('three seconds without a new word stop listening, the words '
      'left in the box unsent', (tester) async {
    await pump(tester);
    await tapMic(tester);
    await say(tester, 'xong rồi');

    await tester.pump(const Duration(milliseconds: 2900));
    expect(dictation.stops, 0);
    await say(tester, 'xong rồi nhé');
    await tester.pump(const Duration(milliseconds: 2900));
    expect(dictation.stops, 0, reason: 'a new word starts the count again');

    await tester.pump(const Duration(milliseconds: 200));
    await frames(tester);
    expect(dictation.stops, 1);
    expect(box(tester), 'xong rồi nhé');
    expect(fake.commands, isEmpty);
    expect(find.byType(VoiceMicCore), findsNothing, reason: 'back at rest');
  });

  testWidgets('listening runs on through quiet before anything is said, and '
      'ends by itself after five minutes', (tester) async {
    await pump(tester);
    await tapMic(tester);

    await tester.pump(const Duration(seconds: 30));
    expect(dictation.listening, isTrue, reason: 'nothing said yet');

    await tester.pump(VoiceInputController.maxTake);
    await frames(tester);
    expect(dictation.stops, 1);
    expect(fake.commands, isEmpty);
  });

  testWidgets('a second tap with nothing said sends nothing', (tester) async {
    await pump(tester);
    await tapMic(tester);
    await tapMic(tester);
    await tester.pumpAndSettle();

    expect(dictation.stops, 1);
    expect(box(tester), isEmpty);
    expect(fake.commands, isEmpty);
  });

  testWidgets('a second tap with nothing said keeps what was typed, unsent', (
    tester,
  ) async {
    await pump(tester);
    await tester.enterText(find.byType(TextField), 'Draft');
    await tester.pump();

    await tapMic(tester);
    await tapMic(tester);
    await tester.pumpAndSettle();

    expect(box(tester), 'Draft');
    expect(fake.commands, isEmpty);
    expect(find.text("Didn't catch that · tap the mic again"), findsOneWidget);
  });

  testWidgets('a recognizer that never says it stopped is given up after two '
      'seconds, and nothing is sent', (tester) async {
    await pump(tester);
    await tapMic(tester);
    await say(tester, 'gửi đi');

    dictation.stopsSilently = true;
    await tapMic(tester);
    await tester.pump(const Duration(milliseconds: 1900));
    expect(
      tester.widget<VoiceMicCore>(find.byType(VoiceMicCore)).face,
      VoiceMicFace.busy,
      reason: 'still waiting for its last words',
    );

    await tester.pump(const Duration(milliseconds: 200));
    await frames(tester);
    expect(find.byType(VoiceMicCore), findsNothing);
    expect(dictation.cancels, 1);
    expect(box(tester), 'gửi đi');
    expect(fake.commands, isEmpty);
    expect(
      find.text("Couldn't transcribe · tap the mic again"),
      findsOneWidget,
    );
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

    await tapMic(tester);
    await say(tester, 'nhầm rồi');
    await tester.enterText(find.byType(TextField), '');
    await tester.pump();
    dictation.lastWords = 'nhầm rồi';
    await tapMic(tester);
    await tester.pumpAndSettle();

    expect(box(tester), isEmpty);
    expect(uploads, isEmpty);
    expect(fake.commands, isEmpty);
    expect(key('swarm-outgoing-crash.log'), findsOneWidget);
  });

  testWidgets('the recognizer stopping by itself leaves its words unsent', (
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

  testWidgets('a second tap on a recognizer that fails as it stops sends '
      'nothing', (tester) async {
    await pump(tester);
    await tapMic(tester);
    await say(tester, 'gửi');

    dictation.stopEnd = SwarmDictationEnd.failed;
    await tapMic(tester);
    await tester.pumpAndSettle();

    expect(box(tester), 'gửi');
    expect(fake.commands, isEmpty);
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

  testWidgets('the mic is drawn as loud as the recognizer hears', (
    tester,
  ) async {
    await pump(tester);
    await tapMic(tester);

    dictation.loud(0.8);
    await tester.pump();

    expect(
      tester.widget<VoiceMicCore>(find.byType(VoiceMicCore)).level!.value,
      0.8,
    );
  });

  testWidgets('the long-press language is the one listened in', (tester) async {
    voiceLanguageStore.value = 'ja';
    await pump(tester);

    await tapMic(tester);

    expect(dictation.locales, ['ja-JP']);
  });

  testWidgets('speech recognition refused: the mic records and transcribes, '
      'and is not asked again', (tester) async {
    dictation.answer = SwarmDictationAccess.denied;
    await pump(tester);
    stt.replies.addAll(['ghi âm', 'lần nữa']);

    await tapMic(tester);
    expect(dictation.locales, isEmpty);
    expect(recorder.recording, isTrue);
    await tapMic(tester);
    await tester.pumpAndSettle();
    expect(fake.commands.single['text'], 'ghi âm');

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

  testWidgets('a tap while the permission prompt is up calls the take off', (
    tester,
  ) async {
    dictation.pendingAccess = Completer();
    await pump(tester);

    await tapMic(tester);
    await tapMic(tester);
    dictation.pendingAccess!.complete(SwarmDictationAccess.allowed);
    await frames(tester);

    expect(dictation.locales, isEmpty);
    expect(recorder.starts, 0);
    expect(find.byType(VoiceMicCore), findsNothing, reason: 'back at rest');
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
