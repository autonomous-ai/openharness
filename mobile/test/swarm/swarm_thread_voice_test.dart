import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/phone/voice_input_controller.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart' as grid;
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';
import 'package:harness_mobile/swarm/swarm_thread_page.dart';
import 'package:harness_mobile/swarm/swarm_voice.dart';

import '../voice_fakes.dart';
import 'swarm_chat_dictation_test.dart' show FakeDictation;
import 'swarm_fixture.dart';

/// Talking instead of typing in a thread (Dee, 11-01: "how do I voice in a
/// thread?"): the main chat's mic, in the thread's reply box beside Send. Tap
/// to talk; while talking the toolbar is cancel, the wave, stop and Send.
/// Voice never sends by itself (Tony, 11-01): stop leaves the words in the
/// box, and Send — the row's, or the box's after stop — posts them as a reply,
/// to the chat too with Also send. A take goes,
/// nothing of it written or sent, once the person can no longer reply there.
/// The mic itself: `swarm_chat_voice_test` and `swarm_chat_dictation_test`.
void main() {
  const messages = '/api/super-tabs/$tab/conversations/g1/messages';
  const commands = '/api/super-tabs/$tab/commands';
  const parts = '/api/super-tabs/$tab/parts';

  late FakeSwarm fake;
  late FakeVoiceRecorder recorder;
  late FakeTranscriber stt;
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
    stt = FakeTranscriber();
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
  });

  /// Chat g1's thread m1 open, its box's mic heard through [recorder] and
  /// [stt] — or the phone's own [dictation], or no voice input at all.
  Future<SwarmHost> pump(
    WidgetTester tester, {
    bool voice = true,
    FakeDictation? dictation,
  }) async {
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

  /// The voice row's stop: the take ends, its words left in the box.
  Future<void> stop(WidgetTester tester) async {
    await tester.tap(inBox(key('swarm-voice-stop')));
    await frames(tester);
  }

  /// The voice row's cancel: what the take added leaves the box.
  Future<void> cancel(WidgetTester tester) async {
    await tester.tap(inBox(key('swarm-voice-cancel')));
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

  /// The thread's draft as its chat keeps it, for the next time it opens.
  String kept(WidgetTester tester) => tester
      .widget<SwarmThreadPage>(find.byType(SwarmThreadPage))
      .chat
      .threadDraft('m1');

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

  testWidgets('stop leaves what was said in the reply box and sends nothing; '
      'Send then posts it as a reply in the thread, not to the chat', (
    tester,
  ) async {
    await pump(tester);
    stt.replies.add('ship the fix today');

    await tapMic(tester);
    expect(recorder.recording, isTrue);
    expect(inBox(key('swarm-voice-stop')), findsOneWidget);

    await stop(tester);
    await tester.pumpAndSettle();

    expect(recorder.recording, isFalse);
    expect(fake.commands, isEmpty, reason: 'voice never sends by itself');
    expect(box(tester), 'ship the fix today');
    expect(inBox(key('swarm-voice-stop')), findsNothing);

    await tester.tap(key('swarm-thread-send'));
    await tester.pumpAndSettle();

    expect(fake.commands.single, {
      'type': 'message.send',
      'conversationId': 'g1',
      'text': 'ship the fix today',
      'replyTo': 'm1',
      'recipientIds': <String>[],
    });
    expect(box(tester), isEmpty);
  });

  testWidgets('what was typed goes with what is said', (tester) async {
    await pump(tester);
    await tester.enterText(key('swarm-thread-field'), 'Nova:');
    await tester.pump();
    stt.replies.add('ship the fix');

    await tapMic(tester);
    await stop(tester);
    await tester.pumpAndSettle();
    expect(box(tester), 'Nova: ship the fix');
    expect(fake.commands, isEmpty);

    await tester.tap(key('swarm-thread-send'));
    await tester.pumpAndSettle();

    expect(fake.commands.single['text'], 'Nova: ship the fix');
    expect(fake.commands.single['replyTo'], 'm1');
  });

  testWidgets('Also send ticked, a take, stop, then Send posts to the chat '
      'too: the tick survives the take, and takes no taps during it', (
    tester,
  ) async {
    await pump(tester);
    await tester.tap(key('swarm-thread-options'));
    await tester.pump();
    await tester.tap(key('swarm-thread-also-send'));
    await tester.pump();
    stt.replies.add('also for everyone');
    final box = tester.getRect(key('swarm-thread-box'));
    bool? ticked() => tester
        .widget<Semantics>(key('swarm-thread-also-send'))
        .properties
        .checked;

    await tapMic(tester);
    expect(
      tester.getRect(key('swarm-thread-box')),
      box,
      reason: 'Reply options stays as it was: the box does not jump',
    );
    // In sight, as it will be sent: a tap during the take changes nothing.
    await tester.tap(key('swarm-thread-also-send'), warnIfMissed: false);
    await tester.tap(key('swarm-thread-options'), warnIfMissed: false);
    await tester.pump();
    expect(ticked(), isTrue);
    expect(key('swarm-thread-also-send'), findsOneWidget, reason: 'still open');
    await stop(tester);
    await tester.pumpAndSettle();
    expect(fake.commands, isEmpty);
    expect(
      tester
          .widget<Semantics>(key('swarm-thread-also-send'))
          .properties
          .checked,
      isTrue,
      reason: 'still ticked after the take',
    );

    await tester.tap(key('swarm-thread-send'));
    await tester.pumpAndSettle();

    expect(fake.commands.single['text'], 'also for everyone');
    expect(fake.commands.single['replyTo'], 'm1');
    expect(fake.commands.single['alsoSend'], isTrue);
  });

  // Tony, 11-01: the row's Send, as in the main chat.
  testWidgets("the row's Send ends the take and posts it as one reply, to the "
      'chat too with Also send ticked', (tester) async {
    await pump(tester);
    await tester.tap(key('swarm-thread-options'));
    await tester.pump();
    await tester.tap(key('swarm-thread-also-send'));
    await tester.pump();
    await tester.enterText(key('swarm-thread-field'), 'Nova:');
    await tester.pump();
    stt.pending = Completer<String>();

    await tapMic(tester);
    final at = tester.getCenter(inBox(key('swarm-voice-send')));
    await tester.tapAt(at);
    await tester.pump(const Duration(milliseconds: 40));
    await tester.tapAt(at);
    await frames(tester);
    expect(inBox(key('swarm-voice-sending')), findsOneWidget);
    stt.pending!.complete('ship it');
    await tester.pumpAndSettle();

    expect(fake.commands, hasLength(1));
    expect(fake.commands.single['text'], 'Nova: ship it');
    expect(fake.commands.single['replyTo'], 'm1');
    expect(fake.commands.single['alsoSend'], isTrue);
    expect(box(tester), isEmpty);
  });

  testWidgets("the row's Send with nothing heard posts nothing and keeps "
      'what was typed', (tester) async {
    await pump(tester);
    await tester.enterText(key('swarm-thread-field'), 'Draft');
    await tester.pump();

    await tapMic(tester);
    await tester.tap(inBox(key('swarm-voice-send')));
    await tester.pumpAndSettle();

    expect(fake.commands, isEmpty);
    expect(box(tester), 'Draft');
    expect(find.text(SwarmVoice.nothingSent), findsOneWidget);
  });

  testWidgets("access lost while the row's Send transcribes: nothing posted, "
      'nothing kept', (tester) async {
    final host = await pump(tester);
    stt.pending = Completer<String>();
    await tapMic(tester);
    await tester.tap(inBox(key('swarm-voice-send')));
    await frames(tester);

    await reread(tester, host, listed: false);
    stt.pending!.complete('too late');
    await tester.pumpAndSettle();

    expect(fake.commands, isEmpty);
    expect(find.text('too late'), findsNothing);
    expect(kept(tester), isEmpty);
    expect(find.text(SwarmVoice.nothingSent), findsNothing);
  });

  // After #2471 a reply on its way no longer holds the box: a take stopped
  // meanwhile leaves its words for the next reply, which Send posts after the
  // first, and the first keeps its own text.
  testWidgets('a take stopped while a reply is still on its way: Send posts '
      'it as the next reply, in order', (tester) async {
    await pump(tester);
    final first = Completer<Object?>();
    fake.routes[commands] = (_) =>
        first.isCompleted ? {'result': <String, dynamic>{}} : first.future;
    await tester.enterText(key('swarm-thread-field'), 'typed reply');
    await tester.pump();
    await tester.tap(key('swarm-thread-send'));
    await frames(tester);
    expect(fake.commands.single['text'], 'typed reply');
    expect(box(tester), isEmpty);

    stt.replies.add('spoken reply');
    await tapMic(tester);
    await stop(tester);
    await frames(tester);
    expect(box(tester), 'spoken reply');
    expect(fake.commands, hasLength(1), reason: 'stop sends nothing');
    await tester.tap(key('swarm-thread-send'));
    await frames(tester);
    first.complete({'result': <String, dynamic>{}});
    await tester.pumpAndSettle();

    expect(
      [for (final c in fake.commands) (c['text'], c['replyTo'])],
      [('typed reply', 'm1'), ('spoken reply', 'm1')],
    );
    expect(box(tester), isEmpty);
  });

  testWidgets('a take not heard says so in the thread, and sends nothing', (
    tester,
  ) async {
    await pump(tester);

    await tapMic(tester);
    await stop(tester);
    await tester.pumpAndSettle();

    expect(fake.commands, isEmpty);
    expect(inBox(key('swarm-thread-voice-note')), findsOneWidget);
  });

  testWidgets("during a take the toolbar is cancel, the wave, stop and the "
      "row's Send: no box Send, + or X, which come back after stop; Reply "
      'options stays, folded', (tester) async {
    await pump(tester);
    await tester.enterText(key('swarm-thread-field'), 'Nova:');
    await tester.pump();
    expect(inBox(key('swarm-thread-clear')), findsOneWidget);
    stt.replies.add('ship it');

    await tapMic(tester);

    for (final gone in [
      'swarm-thread-send',
      'swarm-thread-attach',
      'swarm-thread-clear',
      'swarm-mic',
    ]) {
      expect(inBox(key(gone)), findsNothing, reason: gone);
    }
    for (final shown in [
      'swarm-voice-cancel',
      'swarm-voice-wave',
      'swarm-voice-stop',
      'swarm-voice-send',
      'swarm-thread-options',
    ]) {
      expect(inBox(key(shown)), findsOneWidget, reason: shown);
    }
    // Folded it stays: a tap during the take does not open it.
    await tester.tap(key('swarm-thread-options'), warnIfMissed: false);
    await tester.pump();
    expect(inBox(key('swarm-thread-also-send')), findsNothing);

    await stop(tester);
    await tester.pumpAndSettle();

    for (final back in [
      'swarm-thread-send',
      'swarm-thread-options',
      'swarm-thread-attach',
      'swarm-thread-clear',
      'swarm-mic',
    ]) {
      expect(inBox(key(back)), findsOneWidget, reason: back);
    }
    expect(inBox(key('swarm-voice-stop')), findsNothing);
    expect(fake.commands, isEmpty);
  });

  testWidgets('cancel throws the take away: nothing transcribed, the box as '
      'it was before, nothing sent', (tester) async {
    await pump(tester);
    await tester.enterText(key('swarm-thread-field'), 'Nova:');
    await tester.pump();
    stt.replies.add('never said');

    await tapMic(tester);
    expect(recorder.recording, isTrue);
    await cancel(tester);
    await tester.pumpAndSettle();

    expect(recorder.recording, isFalse);
    expect(recorder.cancels, 1);
    expect(stt.calls, isEmpty, reason: 'nothing leaves the phone');
    expect(box(tester), 'Nova:');
    expect(fake.commands, isEmpty);
    expect(inBox(key('swarm-mic')), findsOneWidget);
  });

  testWidgets('cancel while the take is transcribed puts nothing in the box', (
    tester,
  ) async {
    await pump(tester);
    stt.pending = Completer<String>();
    await tapMic(tester);
    await stop(tester);
    expect(stt.calls, hasLength(1), reason: 'the take is being transcribed');
    expect(inBox(key('swarm-voice-stop')), findsNothing, reason: 'busy');
    expect(inBox(key('swarm-voice-cancel')), findsOneWidget);

    await cancel(tester);
    stt.pending!.complete('too late');
    await tester.pumpAndSettle();

    expect(box(tester), isEmpty);
    expect(fake.commands, isEmpty);
    expect(inBox(key('swarm-mic')), findsOneWidget);
  });

  testWidgets('taken out of the chat mid-take: the microphone closes, and '
      'nothing is transcribed, written or sent', (tester) async {
    final host = await pump(tester);
    stt.replies.add('the secret plan');
    await tapMic(tester);
    expect(recorder.recording, isTrue);

    await reread(tester, host, listed: false);

    expect(find.text('This chat is not open to you.'), findsOneWidget);
    expect(recorder.recording, isFalse);
    expect(recorder.cancels, 1);
    expect(stt.calls, isEmpty, reason: 'nothing leaves the phone');
    await tester.pumpAndSettle();
    expect(fake.commands, isEmpty);
    expect(find.text('the secret plan'), findsNothing);
  });

  testWidgets('words transcribed after access was lost land nowhere', (
    tester,
  ) async {
    final host = await pump(tester);
    stt.pending = Completer<String>();
    await tapMic(tester);
    await stop(tester);
    expect(stt.calls, hasLength(1), reason: 'the take is being transcribed');

    await reread(tester, host, listed: false);
    stt.pending!.complete('too late');
    await tester.pumpAndSettle();

    expect(fake.commands, isEmpty);
    expect(find.text('too late'), findsNothing);
    expect(kept(tester), isEmpty, reason: 'not kept for the thread either');
  });

  testWidgets('made read-only mid-take: the take goes with the box, and '
      'nothing is sent', (tester) async {
    final host = await pump(tester);
    stt.replies.add('one more thing');
    await tapMic(tester);
    expect(recorder.recording, isTrue);

    await reread(tester, host, role: 'viewer');

    expect(key('swarm-thread-box'), findsNothing);
    expect(recorder.recording, isFalse);
    expect(stt.calls, isEmpty);
    await tester.pumpAndSettle();
    expect(fake.commands, isEmpty);
  });

  testWidgets('signed out mid-take: the microphone closes and nothing is '
      'sent', (tester) async {
    await pump(tester);
    stt.replies.add('after sign out');
    await tapMic(tester);
    expect(recorder.recording, isTrue);

    account.value = null;
    await frames(tester);

    expect(recorder.recording, isFalse);
    expect(stt.calls, isEmpty);
    await tester.pumpAndSettle();
    expect(fake.commands, isEmpty);
  });

  testWidgets('another account signed in mid-take: the microphone closes '
      'and nothing is sent', (tester) async {
    await pump(tester);
    stt.replies.add('meant for the first account');
    await tapMic(tester);
    expect(recorder.recording, isTrue);

    account.value = 'someone-else';
    await frames(tester);

    expect(recorder.recording, isFalse);
    expect(stt.calls, isEmpty);
    await tester.pumpAndSettle();
    expect(fake.commands, isEmpty);
  });

  testWidgets('covering the thread cancels its recording', (tester) async {
    await pump(tester);
    await tapMic(tester);
    expect(recorder.recording, isTrue);

    final context = tester.element(find.byType(SwarmThreadPage));
    unawaited(
      Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => const Scaffold(body: Text('Other screen')),
        ),
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(seconds: 1));

    expect(recorder.recording, isFalse);
    expect(stt.calls, isEmpty);
    expect(fake.commands, isEmpty);
  });

  testWidgets('leaving the thread mid-take closes the microphone', (
    tester,
  ) async {
    await pump(tester);
    await tapMic(tester);
    expect(recorder.recording, isTrue);

    await tester.tap(find.bySemanticsLabel('Back'));
    await tester.pumpAndSettle();

    expect(find.byType(SwarmThreadPage), findsNothing);
    expect(recorder.recording, isFalse);
    expect(stt.calls, isEmpty);
    expect(fake.commands, isEmpty);
  });

  group('with the phone\'s own recognizer', () {
    late FakeDictation dictation;
    setUp(() => dictation = FakeDictation());

    testWidgets('words show in the reply box as they are said; stop keeps '
        'them and sends nothing, and Send posts them as a reply', (
      tester,
    ) async {
      await pump(tester, dictation: dictation);

      await tapMic(tester);
      dictation.say('looks good to me');
      await frames(tester);
      expect(box(tester), 'looks good to me');
      expect(fake.commands, isEmpty);

      await stop(tester);
      await tester.pumpAndSettle();

      expect(dictation.stops, 1);
      expect(box(tester), 'looks good to me');
      expect(fake.commands, isEmpty, reason: 'voice never sends by itself');

      await tester.tap(key('swarm-thread-send'));
      await tester.pumpAndSettle();

      expect(fake.commands.single['text'], 'looks good to me');
      expect(fake.commands.single['replyTo'], 'm1');
      expect(box(tester), isEmpty);
    });

    testWidgets("the row's Send ends the take and posts its last words as a "
        'reply', (tester) async {
      await pump(tester, dictation: dictation);

      await tapMic(tester);
      expect(
        tester.widget<SwarmRoundButton>(inBox(key('swarm-voice-send'))).onTap,
        isNull,
        reason: 'an empty box',
      );
      dictation.say('looks good');
      await frames(tester);
      dictation.lastWords = 'looks good to me';
      await tester.tap(inBox(key('swarm-voice-send')));
      await tester.pumpAndSettle();

      expect(dictation.stops, 1);
      expect(fake.commands.single['text'], 'looks good to me');
      expect(fake.commands.single['replyTo'], 'm1');
      expect(box(tester), isEmpty);
    });

    testWidgets('cancel takes back what the take added and keeps what was '
        'typed before it', (tester) async {
      await pump(tester, dictation: dictation);
      await tester.enterText(key('swarm-thread-field'), 'Nova:');
      await tester.pump();

      await tapMic(tester);
      dictation.say('scrap that');
      await frames(tester);
      expect(box(tester), 'Nova: scrap that');

      await cancel(tester);
      await tester.pumpAndSettle();

      expect(box(tester), 'Nova:');
      expect(dictation.cancels, 1);
      expect(dictation.listening, isFalse);
      expect(fake.commands, isEmpty);
    });

    testWidgets('taken out of the chat while listening: the recognizer stops, '
        'and what it still says lands nowhere', (tester) async {
      final host = await pump(tester, dictation: dictation);
      await tapMic(tester);
      dictation.say('half a');
      await frames(tester);
      final heard = dictation.heard.single;

      await reread(tester, host, listed: false);
      heard('half a secret');
      await tester.pumpAndSettle();

      expect(dictation.cancels, 1);
      expect(dictation.listening, isFalse);
      expect(find.text('This chat is not open to you.'), findsOneWidget);
      expect(find.textContaining('secret'), findsNothing);
      expect(find.textContaining('half a'), findsNothing);
      expect(kept(tester), isEmpty);
      expect(fake.commands, isEmpty);
    });
  });
}
