import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:image_picker/image_picker.dart' show XFile;
import 'package:harness_mobile/swarm/swarm_file_picker.dart';
import 'package:harness_mobile/swarm/swarm_voice_bubble.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/phone/voice_recorder.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart' as grid;
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// A Swarm chat's voice messages (task #2584, Dee: "just send the full
/// audio"): the composer's mic records, and its row is X, the red dot and the
/// time, the wave and Send. Send posts the take as audio; nothing goes into
/// the message box.
void main() {
  const messages = '/api/super-tabs/$tab/conversations/g1/messages';
  const commands = '/api/super-tabs/$tab/commands';

  late FakeSwarm fake;
  late _MeteredRecorder recorder;
  late FakeUploads uploads;

  setUp(() {
    recorder = _MeteredRecorder();
    uploads = FakeUploads();
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
    fake.routes['/api/super-tabs/$tab/attachments/'] = (_) => {
      'voice': {
        'durationMs': 2000,
        'waveform': List.filled(48, 9),
        'transcribed': true,
      },
    };
  });

  /// Who is signed in, in the last [pump].
  late ValueNotifier<String?> account;

  /// Chat g1 on screen, its composer's mic recording into [recorder] — or
  /// with no mic at all.
  Future<SwarmHost> pump(WidgetTester tester, {bool voice = true}) async {
    final features = ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
      ..value = {PhoneExperiment.swarm};
    account = ValueNotifier<String?>(me);
    final host = SwarmHost(
      accountId: () => account.value,
      account: account,
      request: fake.request,
      upload: uploads.upload,
      notices: SilentSystemNotices(),
      features: features,
      voice: voice ? () => recorder : null,
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

  TextField field(WidgetTester tester) =>
      tester.widget<TextField>(find.byType(TextField));

  testWidgets('a tap records: X, the red dot and its time, the wave and '
      'Send, and nothing in the box', (tester) async {
    await pump(tester);
    await tester.enterText(find.byType(TextField), 'typed first');
    await tapMic(tester);
    expect(recorder.recording, isTrue);
    for (final part in [
      'swarm-voice-cancel',
      'swarm-voice-dot',
      'swarm-voice-time',
      'swarm-voice-wave',
      'swarm-voice-send',
    ]) {
      expect(key(part), findsOneWidget, reason: part);
    }
    expect(key('swarm-mic'), findsNothing);
    expect(find.text('0:00'), findsOneWidget);
    await tester.pump(const Duration(seconds: 3));
    expect(find.text('0:03'), findsOneWidget);
    expect(field(tester).controller!.text, 'typed first');
  });

  testWidgets("the row's Send posts the take as a voice message and leaves "
      'the box as it was', (tester) async {
    await pump(tester);
    await tester.enterText(find.byType(TextField), 'typed first');
    await tapMic(tester);
    await tester.tap(key('swarm-voice-send'));
    await frames(tester);
    await tester.pump(const Duration(milliseconds: 100));
    await frames(tester);

    expect(uploads.asked.single.mime, 'audio/wav');
    final sent = fake.commands.single;
    expect(sent['text'], '');
    expect(sent['attachmentIds'], ['id-Voice message.wav']);
    expect(key('swarm-mic'), findsOneWidget, reason: 'back at rest');
    expect(field(tester).controller!.text, 'typed first');
  });

  testWidgets('a pending image and clip retain the voice bubble', (
    tester,
  ) async {
    final originalPicker = pickSwarmFiles;
    final originalFolders = swarmPickerCopyFolders;
    swarmPickerCopyFolders = () async => const [];
    addTearDown(() {
      pickSwarmFiles = originalPicker;
      swarmPickerCopyFolders = originalFolders;
    });
    pickSwarmFiles = () async => [
      XFile.fromData(
        Uint8List.fromList([1, 2, 3]),
        name: 'picture.png',
        path: '/copies/picture.png',
      ),
    ];
    await pump(tester);
    await tester.tap(key('swarm-attach'));
    await tester.pumpAndSettle();
    await tester.tap(key('swarm-attach-files'));
    await tester.pumpAndSettle();
    expect(key('swarm-outgoing-picture.png'), findsOneWidget);
    await tapMic(tester);
    await tester.tap(key('swarm-voice-send'));
    await frames(tester);
    await tester.pump(const Duration(milliseconds: 100));
    await frames(tester);
    expect(fake.commands.single['attachmentIds'], [
      'id-picture.png',
      'id-Voice message.wav',
    ]);
    expect(
      find.descendant(
        of: key('swarm-pending'),
        matching: find.byType(SwarmVoiceBubble),
      ),
      findsOneWidget,
    );
    expect(
      find.descendant(
        of: key('swarm-pending'),
        matching: find.text('picture.png'),
      ),
      findsOneWidget,
    );
  });

  testWidgets('X throws the take away and sends nothing', (tester) async {
    await pump(tester);
    await tapMic(tester);
    await tester.tap(key('swarm-voice-cancel'));
    await frames(tester);
    expect(recorder.cancels, 1);
    expect(fake.commands, isEmpty);
    expect(uploads.asked, isEmpty);
    expect(key('swarm-mic'), findsOneWidget);
  });

  testWidgets('a take kept as the phone locks, Send ready', (tester) async {
    await pump(tester);
    await tapMic(tester);
    // The phone locked, and back: through inactive each way, as iOS goes.
    for (final state in [
      AppLifecycleState.inactive,
      AppLifecycleState.hidden,
      AppLifecycleState.inactive,
      AppLifecycleState.resumed,
    ]) {
      tester.binding.handleAppLifecycleStateChanged(state);
      await frames(tester);
    }
    expect(recorder.recording, isFalse);
    expect(key('swarm-voice-send'), findsOneWidget);
    expect(fake.commands, isEmpty);
  });

  testWidgets('a voice message draws its bubble, which plays only', (
    tester,
  ) async {
    fake.routes[messages] = (_) => {
      'messages': [
        {
          'id': 'm1',
          'conversationId': 'g1',
          'text': 'Ship the parser today.',
          'sequence': 1,
          'author': {'kind': 'person', 'id': 'dee', 'name': 'dee'},
          'attachments': [
            {
              'id': 'clip',
              'name': 'Voice message.wav',
              'mime': 'audio/wav',
              'size': 2592044,
              'url': 'https://cdn.example.test/super-tabs/$tab/a/clip.wav',
              'voice': {
                'durationMs': 81000,
                'waveform': List.filled(48, 9),
                'transcribed': true,
              },
            },
          ],
          'reactions': <Object>[],
          'createdAt': DateTime.utc(2026, 11, 4, 2).toIso8601String(),
        },
      ],
      'next': null,
    };
    await pump(tester);
    expect(key('swarm-voice-bubble-clip'), findsOneWidget);
    expect(find.text('1:21'), findsOneWidget);
    expect(find.text('Ship the parser today.'), findsNothing);
    expect(find.text('Voice message.wav'), findsNothing, reason: 'no chip');
    expect(find.text('→A'), findsNothing);
    expect(key('swarm-voice-words-toggle'), findsNothing);
  });

  testWidgets('no mic where none can be heard', (tester) async {
    await pump(tester, voice: false);
    expect(key('swarm-mic'), findsNothing);
  });
}

/// A microphone that also says how loud it is: what the wave follows.
class _MeteredRecorder extends FakeVoiceRecorder implements VoiceLevelMeter {
  final meter = ValueNotifier<double>(0);

  @override
  ValueListenable<double> get level => meter;
}
