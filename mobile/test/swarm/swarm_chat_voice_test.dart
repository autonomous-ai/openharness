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

/// Talking instead of typing in a Swarm chat (Tony, 10-28): the terminal's
/// mic in the composer puts what was said into the message box, where it can
/// be edited; only Send posts it. A long press on the mic picks the language.
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

  testWidgets('the mic hears what is said into the message box, and sends '
      'nothing', (tester) async {
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
    expect(recorder.recording, isFalse);
    expect(box(tester), 'ship the fix today');
    expect(fake.commands, isEmpty);
  });

  testWidgets('what is said joins what was typed, stays editable, and goes '
      'only with Send', (tester) async {
    await pump(tester);
    await tester.enterText(find.byType(TextField), 'Nova:');
    await tester.pump();
    stt.replies.add('ship the fix');

    await tapMic(tester);
    await tapMic(tester);
    expect(box(tester), 'Nova: ship the fix');

    await tester.enterText(find.byType(TextField), 'Nova: ship it tomorrow');
    await tester.pump();
    expect(fake.commands, isEmpty);

    await tester.tap(key('swarm-send'));
    await tester.pumpAndSettle();
    expect(fake.commands.single['text'], 'Nova: ship it tomorrow');
  });

  testWidgets('a pause after speaking ends the take, as a second tap does', (
    tester,
  ) async {
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

  @override
  ValueListenable<double> get level => meter;
}
