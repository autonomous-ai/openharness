import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart' as grid;
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';
import 'package:harness_mobile/swarm/swarm_thread_page.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// Voice messages in a thread (task #2584): the main chat's mic, in the
/// thread's reply box beside Send. Its row's Send posts the take as a reply,
/// as audio; nothing goes into the box. A take never leaves the phone once the
/// person can no longer reply there. The mic itself: `swarm_chat_voice_test`.
void main() {
  const messages = '/api/super-tabs/$tab/conversations/g1/messages';
  const commands = '/api/super-tabs/$tab/commands';
  const parts = '/api/super-tabs/$tab/parts';

  late FakeSwarm fake;
  late FakeVoiceRecorder recorder;
  late FakeUploads uploads;
  late ValueNotifier<String?> account;

  Map<String, dynamic> message(String id, int sequence, String text) => {
    'id': id,
    'conversationId': 'g1',
    'text': text,
    'sequence': sequence,
    'thread': 'm1',
    if (id != 'm1') 'replyTo': 'm1',
    'author': {'kind': 'agent', 'id': 'agent-builder', 'name': 'Nova'},
    'attachments': <Object>[],
    'reactions': <Object>[],
    'createdAt': DateTime.utc(2026, 11, 1, 1, sequence).toIso8601String(),
  };

  /// The Swarm's read: chat g1 while [listed], the person in it as [role].
  Map<String, dynamic> read({bool listed = true, String role = 'owner'}) => {
    ...firstLoad(
      groups: [
        if (listed)
          groupData(
            'g1',
            title: 'Fix login',
            agentIds: ['agent-lead', 'agent-builder'],
            lastMessageSequence: 2,
          ),
      ],
    ),
    'members': [part(me, 1, person(me, role: role))],
  };

  setUp(() {
    recorder = FakeVoiceRecorder();
    uploads = FakeUploads();
    fake = FakeSwarm();
    fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
      ],
      'next': null,
    };
    fake.routes[parts] = (_) => read();
    fake.routes['/api/super-tabs/$tab/changes'] = (_) => changes(cursor: 'c2');
    fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
      'decisions': <Object>[],
    };
    fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
      'mentions': <Object>[],
    };
    final rows = [
      message('m1', 1, 'Can you check the drawer mockup?'),
      message('m2', 2, 'Looks good. One question.'),
    ];
    final line = {
      'id': 'm1',
      'replies': 1,
      'lastSequence': 2,
      'lastAt': DateTime.now().toUtc().toIso8601String(),
      'authors': [
        {'kind': 'agent', 'id': 'agent-builder', 'name': 'Nova'},
      ],
      'people': <String>[],
    };
    fake.routes[messages] = (_) => {
      'messages': rows.reversed.toList(),
      'next': null,
      'threads': [line],
    };
    fake.routes['$messages?thread=m1'] = (_) => {
      'messages': rows.reversed.toList(),
      'next': null,
      'threads': [line],
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

  /// Chat g1's thread m1 open, its box's mic recording into [recorder] — or
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
    await tester.tap(find.byKey(const ValueKey('swarm-thread-line-m1')));
    await tester.pumpAndSettle();
    expect(find.byType(SwarmThreadPage), findsOneWidget);
    return host;
  }

  Finder key(String value) => find.byKey(ValueKey(value));

  Finder inBox(Finder finder) =>
      find.descendant(of: key('swarm-thread-box'), matching: finder);

  /// A few frames, for the take's awaits to land. Never settling: the mic's
  /// bars move for as long as it listens.
  Future<void> frames(WidgetTester tester) async {
    for (var i = 0; i < 5; i++) {
      await tester.pump();
    }
  }

  Future<void> tapMic(WidgetTester tester) async {
    await tester.tap(inBox(key('swarm-mic')));
    await frames(tester);
  }

  String box(WidgetTester tester) => tester
      .widget<TextField>(
        find.descendant(
          of: key('swarm-thread-field'),
          matching: find.byType(TextField),
        ),
      )
      .controller!
      .text;

  /// The Swarm read again: [listed] or not, the person as [role].
  Future<void> reread(
    WidgetTester tester,
    SwarmHost host, {
    bool listed = true,
    String role = 'owner',
  }) async {
    fake.routes[parts] = (_) => read(listed: listed, role: role);
    fake.routes['/api/super-tabs/$tab/changes'] = (_) => {'reload': true};
    await host.session!.inbox.reader(tab)!.refresh();
    await frames(tester);
  }

  testWidgets('the thread\'s reply box: +, then the main chat\'s mic just '
      'left of Send, in one row; Reply options on its own line under it', (
    tester,
  ) async {
    await pump(tester);

    expect(inBox(key('swarm-mic')), findsOneWidget);
    final mic = tester.getCenter(inBox(key('swarm-mic')));
    final send = tester.getCenter(key('swarm-thread-send'));
    final attach = tester.getCenter(key('swarm-thread-attach'));
    final options = tester.getCenter(key('swarm-thread-options'));
    for (final other in [send, attach]) {
      expect(mic.dy, other.dy, reason: 'in one row');
    }
    expect(options.dy, greaterThan(send.dy), reason: 'its own line, under');
    expect(attach.dx, lessThan(mic.dx), reason: '+ moved to the left');
    expect(mic.dx, lessThan(send.dx));
  });

  testWidgets('with no voice input the reply box has no mic', (tester) async {
    await pump(tester, voice: false);

    expect(key('swarm-mic'), findsNothing);
    expect(key('swarm-thread-send'), findsOneWidget);
  });

  testWidgets("the row's Send posts the take as a reply, as audio, and the "
      'box keeps what was typed', (tester) async {
    await pump(tester);
    await tester.enterText(inBox(find.byType(TextField)), 'typed first');
    await tapMic(tester);
    expect(inBox(key('swarm-voice-send')), findsOneWidget);
    await tester.tap(inBox(key('swarm-voice-send')));
    await frames(tester);
    await tester.pump(const Duration(milliseconds: 100));
    await frames(tester);

    final sent = fake.commands.single;
    expect(sent['replyTo'], 'm1');
    expect(sent['text'], '');
    expect(sent['attachmentIds'], ['id-Voice message.wav']);
    expect(box(tester), 'typed first');
  });

  testWidgets('access lost mid-take: the microphone closes and nothing is '
      'sent', (tester) async {
    final host = await pump(tester);
    await tapMic(tester);
    expect(recorder.recording, isTrue);

    await reread(tester, host, role: 'viewer');

    expect(recorder.recording, isFalse);
    expect(uploads.asked, isEmpty);
    expect(fake.commands, isEmpty);
  });
}
