import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show RenderParagraph;
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart' as grid;
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';
import 'swarm_session_fixture.dart';

/// New session on the phone's Buddy chat (task #2118): the chip and its
/// "Works in" pick in the composer, the reply box's New session in a thread,
/// the session's status line with End session, and the line of a session that
/// ended. Behaviour as Desktop's (spec 2026-10-30-buddy-thread-sessions).
void main() {
  Finder key(String value) => find.byKey(ValueKey(value));

  Future<SwarmHost> pump(
    WidgetTester tester,
    FakeSwarm fake, {
    String? thread,
  }) async {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    final features = ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
      ..value = {PhoneExperiment.swarm};
    final account = ValueNotifier<String?>(me);
    final host = SwarmHost(
      accountId: () => account.value,
      account: account,
      request: fake.request,
      upload: refuseSwarmUpload,
      notices: SilentSystemNotices(),
      features: features,
    )..foreground = false;
    addTearDown(host.dispose);
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        builder: (context, child) => SwarmScope(notifier: host, child: child!),
        home: SwarmConversationPage(
          swarmId: tab,
          conversationId: sessionChat,
          messageId: thread,
          threadId: thread,
        ),
      ),
    );
    await tester.pumpAndSettle();
    return host;
  }

  Map<String, dynamic> sent(FakeSwarm fake) =>
      fake.commands.lastWhere((c) => c['type'] == 'message.send');

  /// A backend whose thread m1 reads [replies].
  FakeSwarm threadBackend({
    required List<Map<String, dynamic>> replies,
    List<Map<String, dynamic>> sessions = const [],
    List<Map<String, dynamic>> extraAgents = const [],
    String engine = 'claude',
  }) {
    final rows = [sessionMessage('m1', 1, author: me), ...replies];
    final fake = sessionBackend(
      page: rows,
      sessions: sessions,
      extraAgents: extraAgents,
      engine: engine,
    );
    fake.routes['$sessionMessages?thread=m1'] = (_) => {
      'messages': rows.reversed.toList(),
      'next': null,
    };
    return fake;
  }

  group('the chat composer', () {
    testWidgets('has no New session where the server does not take it', (
      tester,
    ) async {
      await pump(tester, sessionBackend(sessionsFromChat: false));
      expect(key('swarm-new-session'), findsNothing);
    });

    testWidgets('New session over All projects: no project is sent, and the '
        'session\'s thread opens', (tester) async {
      final fake = sessionBackend();
      await pump(tester, fake);
      expect(key('swarm-new-session'), findsOneWidget);
      expect(key('swarm-session-project'), findsNothing);
      await tester.tap(key('swarm-new-session'));
      await tester.pumpAndSettle();
      expect(
        tester.widget<Text>(key('swarm-session-project-name')).data,
        'All projects',
      );
      await tester.enterText(find.byType(TextField), 'Fix the flaky test');
      await tester.pump();
      await tester.tap(key('swarm-send'));
      await tester.pumpAndSettle();
      expect(sent(fake)['newSession'], isTrue);
      expect(sent(fake).containsKey('sessionProjectId'), isFalse);
      // Its thread is up, the session answering there.
      expect(key('swarm-thread-header'), findsOneWidget);
    });

    testWidgets('New session over one project sends that project', (
      tester,
    ) async {
      final fake = sessionBackend();
      await pump(tester, fake);
      await tester.tap(key('swarm-new-session'));
      await tester.pumpAndSettle();
      await tester.tap(key('swarm-session-project'));
      await tester.pumpAndSettle();
      expect(find.text('All projects · ask anything'), findsOneWidget);
      expect(find.text('Mobile · ask and hand off work'), findsOneWidget);
      await tester.tap(find.text('Web · ask and hand off work'));
      await tester.pumpAndSettle();
      expect(
        tester.widget<Text>(key('swarm-session-project-name')).data,
        'Web',
      );
      await tester.enterText(find.byType(TextField), 'Ship the web fix');
      await tester.pump();
      await tester.tap(key('swarm-send'));
      await tester.pumpAndSettle();
      expect(sent(fake)['newSession'], isTrue);
      expect(sent(fake)['sessionProjectId'], webProject);
    });

    testWidgets('a project\'s own Buddy chat, where the Swarm has no one '
        'Buddy, offers no project to pick', (tester) async {
      final fake = sessionBackend(swarmChat: false, swarmBuddy: false);
      await pump(tester, fake);
      await tester.tap(key('swarm-new-session'));
      await tester.pumpAndSettle();
      expect(key('swarm-session-project'), findsNothing);
    });

    testWidgets('the chip shows its whole label when the row has room for it '
        '(the test font is wider than the phone\'s)', (tester) async {
      await pump(tester, sessionBackend());
      // Room for the label beside + and Tag, but not for twice its width:
      // the chip is not squeezed to half of what is left.
      tester.view.physicalSize = const Size(1680, 2532);
      await tester.pumpAndSettle();
      final label = tester.renderObject<RenderParagraph>(
        find.text('New session'),
      );
      expect(label.didExceedMaxLines, isFalse);
    });

    testWidgets('the chip sits right after Tag, not in the middle of the '
        'row', (tester) async {
      await pump(tester, sessionBackend());
      // Room to spare beside + and Tag: the chip is not centred in it.
      tester.view.physicalSize = const Size(2100, 2532);
      await tester.pumpAndSettle();
      final tag = tester.getTopRight(key('swarm-tag'));
      // Its label, past the chip's own icon and padding.
      final label = tester.getTopLeft(find.text('New session'));
      expect(label.dx - tag.dx, lessThan(60));
    });

    testWidgets('a chat that cannot start one says why when the chip is '
        'tapped, and sends plain', (tester) async {
      final fake = sessionBackend(engine: 'codex');
      await pump(tester, fake);
      await tester.tap(key('swarm-new-session'));
      await tester.pumpAndSettle();
      expect(
        tester.widget<Text>(key('swarm-session-note')).data,
        'Sessions need a Claude Code Buddy',
      );
      expect(key('swarm-session-project'), findsNothing);
      await tester.enterText(find.byType(TextField), 'Hello');
      await tester.pump();
      await tester.tap(key('swarm-send'));
      await tester.pumpAndSettle();
      expect(sent(fake).containsKey('newSession'), isFalse);
    });
  });

  group('a thread', () {
    final plain = [sessionMessage('m2', 2, root: 'm1', author: me)];
    final live = [
      sessionMessage('m2', 2, root: 'm1', author: me, session: true),
      sessionMessage('m3', 3, root: 'm1', session: true),
    ];

    testWidgets('a reply with New session starts one, and never also goes '
        'to the chat', (tester) async {
      final fake = threadBackend(replies: plain);
      await pump(tester, fake, thread: 'm1');
      expect(key('swarm-thread-session-line'), findsNothing);
      await tester.tap(key('swarm-thread-also-send'));
      await tester.pump();
      await tester.tap(key('swarm-thread-new-session'));
      await tester.pump();
      // A reply that starts a session is not offered to the chat too.
      expect(key('swarm-thread-also-send'), findsNothing);
      await tester.enterText(key('swarm-thread-field'), 'Look into it');
      await tester.pump();
      await tester.tap(key('swarm-thread-send'));
      await tester.pumpAndSettle();
      expect(sent(fake)['newSession'], isTrue);
      expect(sent(fake)['replyTo'], 'm1');
      expect(sent(fake).containsKey('alsoSend'), isFalse);
    });

    testWidgets('a live session shows its status line; End session ends it '
        'once', (tester) async {
      final fake = threadBackend(
        replies: live,
        sessions: [
          {
            'thread': 'm1',
            'startId': 's1',
            'agentId': 'agent-session',
            'at': 1,
          },
        ],
        extraAgents: [
          {
            ...agent('agent-session', name: 'Session'),
            'buddySession': {
              'thread': 'm1',
              'from': 1,
              'projectId': webProject,
            },
          },
        ],
      );
      await pump(tester, fake, thread: 'm1');
      expect(
        tester.widget<Text>(key('swarm-thread-session-state')).data,
        'Web session · Running',
      );
      await tester.tap(key('swarm-thread-session-end'));
      await tester.pumpAndSettle();
      final ends = fake.commands.where((c) => c['type'] == 'buddy.sessionEnd');
      expect(ends, hasLength(1));
      expect(ends.single['thread'], 'm1');
      expect(ends.single['reason'], 'ended');
    });

    testWidgets('a session\'s thread offers neither New session nor Also '
        'send', (tester) async {
      final fake = threadBackend(
        replies: live,
        sessions: [
          {'thread': 'm1', 'startId': 's1', 'at': 1},
        ],
      );
      await pump(tester, fake, thread: 'm1');
      expect(key('swarm-thread-new-session'), findsNothing);
      expect(key('swarm-thread-also-send'), findsNothing);
    });

    testWidgets('a refused End session says why on the thread page', (
      tester,
    ) async {
      final fake = threadBackend(
        replies: live,
        sessions: [
          {'thread': 'm1', 'startId': 's1', 'at': 1},
        ],
      );
      fake.routes[sessionCommands] = (_) => throw const SuperTabFailure(
        'FORBIDDEN',
        'The session could not be ended.',
        statusCode: 403,
      );
      await pump(tester, fake, thread: 'm1');
      await tester.tap(key('swarm-thread-session-end'));
      await tester.pumpAndSettle();
      expect(
        tester.widget<Text>(key('swarm-thread-post-error')).data,
        'The session could not be ended.',
      );
      expect(find.text('End session'), findsOneWidget);
    });

    testWidgets('a session still starting says so', (tester) async {
      final fake = threadBackend(
        replies: live,
        sessions: [
          {'thread': 'm1', 'startId': 's1', 'at': 1},
        ],
      );
      await pump(tester, fake, thread: 'm1');
      expect(
        tester.widget<Text>(key('swarm-thread-session-state')).data,
        'Own session · Starting…',
      );
    });

    testWidgets('an ended session says why, and the reply starts a new one: '
        'New session is ticked and locked', (tester) async {
      final fake = threadBackend(
        replies: [
          ...live,
          sessionMessage(
            'm4',
            4,
            root: 'm1',
            session: true,
            source: {'kind': 'buddy-session-ended', 'reason': 'idle'},
          ),
        ],
      );
      await pump(tester, fake, thread: 'm1');
      expect(
        tester.widget<Text>(key('swarm-thread-session-ended')).data,
        'Session ended: idle for 30 minutes',
      );
      expect(key('swarm-thread-session-end'), findsNothing);
      expect(
        tester.widget<Text>(key('swarm-thread-new-session-note')).data,
        'This thread\'s session ended. Your reply starts a new one.',
      );
      final check = tester.widget<Checkbox>(
        find.descendant(
          of: key('swarm-thread-new-session'),
          matching: find.byType(Checkbox),
        ),
      );
      expect(check.value, isTrue);
      expect(check.onChanged, isNull);
      await tester.enterText(key('swarm-thread-field'), 'Carry on');
      await tester.pump();
      await tester.tap(key('swarm-thread-send'));
      await tester.pumpAndSettle();
      expect(sent(fake)['newSession'], isTrue);
    });

    testWidgets('a blocked chat shows New session greyed with its reason', (
      tester,
    ) async {
      final fake = threadBackend(replies: plain, engine: 'codex');
      await pump(tester, fake, thread: 'm1');
      expect(
        tester.widget<Text>(key('swarm-thread-new-session-note')).data,
        'Sessions need a Claude Code Buddy',
      );
      final check = tester.widget<Checkbox>(
        find.descendant(
          of: key('swarm-thread-new-session'),
          matching: find.byType(Checkbox),
        ),
      );
      expect(check.onChanged, isNull);
    });
  });
}
