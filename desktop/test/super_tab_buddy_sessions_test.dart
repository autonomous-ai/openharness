import 'dart:async';
import 'dart:typed_data';

import 'package:clock/clock.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/harness_attachments.dart';
import 'package:harness/super_tabs/composer_toggle.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/message_row.dart' show SuperTabLink;
import 'package:harness/super_tabs/view.dart';

import 'support/super_tab_fixture.dart';

/// Buddy thread sessions on Desktop (spec docs/superpowers/specs/2026-10-30-
/// buddy-thread-sessions-design.md): in the reader's own Buddy chat a thread
/// may get its own Buddy session. The thread pane offers New session, says
/// which session answers and whether it works, and ends it quietly; the chat's
/// thread line marks a thread its session answers.
void main() {
  final newSession = find.byKey(const ValueKey('super-thread-new-session'));
  final alsoSend = find.byKey(const ValueKey('super-thread-also-send'));
  final composer = find.byKey(const ValueKey('super-thread-composer'));
  final send = find.byKey(const ValueKey('super-thread-send'));
  final state = find.byKey(const ValueKey('super-thread-session-state'));
  final end = find.byKey(const ValueKey('super-thread-session-end'));
  final ended = find.byKey(const ValueKey('super-thread-session-ended'));

  late SuperTabController shown;

  void testSessions(
    String description,
    Future<void> Function(WidgetTester tester) body,
  ) => testWidgets(description, (tester) async {
    await body(tester);
    await tester.pumpWidget(const SizedBox());
    await shown.flush();
  });

  Map<String, dynamic> chatOf(ConversationServer server) =>
      (server.state['conversations'] as List)[1] as Map<String, dynamic>;

  /// The reader's own Buddy chat ('offline' in the fixture) with their Buddy
  /// running, a root, and a second thread to switch to, on a server that takes
  /// New session unless [sessions] is false (an older backend).
  ConversationServer buddyChat({bool buddy = true, bool sessions = true}) {
    final server = ConversationServer()..threads = true;
    if (sessions) server.state['threadSessions'] = true;
    final chat = chatOf(server)
      ..['kind'] = 'buddy'
      ..['buddyOwnerId'] = 'owner'
      ..['title'] = 'Wren';
    if (buddy) {
      (server.state['agents'] as List).add({
        'id': 'buddy-main',
        'name': 'Wren',
        'displayName': 'Wren',
        'machineId': 'mac',
        'harnessId': 'h-main',
        'contributorId': 'owner',
        'buddyOf': {'personId': 'owner', 'generation': 'g1'},
        'configuration': {'engine': 'claude'},
      });
      chat['agentIds'] = ['buddy-main'];
    }
    server.append(
      'Measure prod CPU for the last day',
      conversationId: 'offline',
    );
    server.append('What is the PR number?', conversationId: 'offline');
    return server;
  }

  /// A thread session of [thread], started (with [agentId]) or starting.
  void addSession(
    ConversationServer server,
    String thread, {
    String? agentId,
    bool down = false,
  }) {
    final chat = chatOf(server);
    chat['buddySessions'] = [
      ...(chat['buddySessions'] as List? ?? const []),
      {
        'thread': thread,
        'startId': 'start-$thread',
        'agentId': ?agentId,
        'at': 1,
      },
    ];
    if (agentId != null) {
      (server.state['agents'] as List).add({
        'id': agentId,
        'name': 'Wren',
        'displayName': 'Wren',
        'machineId': 'mac',
        'harnessId': 'h-$agentId',
        'contributorId': 'owner',
        'buddyOf': {'personId': 'owner', 'generation': 'g1'},
        'buddySession': {'thread': thread, 'from': 1},
        'configuration': {'engine': 'claude'},
        if (down) 'downSince': '2026-10-30T00:00:00Z',
      });
      chat['agentIds'] = [...chat['agentIds'] as List, agentId];
    }
  }

  /// The Buddy's machine as its pool row reads, its host able to run sessions
  /// unless [capable] is false.
  Map<String, dynamic> machine({bool capable = true}) => {
    'machineId': 'mac',
    'name': 'Studio',
    'contributorId': 'owner',
    'scope': 'swarm',
    'engines': ['claude'],
    'observation': {
      'receivedAt': 1,
      'runningHarnessIds': <String>[],
      'stoppedHarnessIds': <String>[],
      if (capable) 'capabilities': ['buddySessions'],
    },
  };

  /// A reply in [thread] from or to its session, with no ended line.
  void sessionReply(ConversationServer server, String thread, String text) {
    server.append(text, conversationId: 'offline');
    server.messages.last
      ..['thread'] = thread
      ..['replyTo'] = thread
      ..['buddySession'] = true;
  }

  Future<SuperTabController> show(
    WidgetTester tester,
    ConversationServer server, {
    Brightness brightness = Brightness.dark,
    bool select = true,
    Map<String, dynamic>? initial,
  }) async {
    await tester.binding.setSurfaceSize(const Size(1400, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final c = shown = server.controller(initial: initial);
    await c.refresh();
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: brightness),
        home: Scaffold(
          body: SuperTabView(
            controller: c,
            onInvite: () {},
            onAddAgent: (_) {},
            onOpenTerminal: (_) {},
            machineName: (_) => 'Mac Studio',
          ),
        ),
      ),
    );
    if (select) {
      c.select('offline');
      await tester.pumpAndSettle();
    }
    addTearDown(c.dispose);
    return c;
  }

  Future<void> openThread(
    WidgetTester tester,
    SuperTabController c,
    String root,
  ) async {
    c.openThread(root);
    await tester.pumpAndSettle();
  }

  SuperTabComposerToggle box(WidgetTester tester, Finder finder) =>
      tester.widget<SuperTabComposerToggle>(finder);

  Map<String, dynamic> lastCommand(ConversationServer server) =>
      Map<String, dynamic>.from(server.posts.last['command'] as Map);

  testSessions('New session sits beside Also send, hides it, and is sent', (
    tester,
  ) async {
    final server = buddyChat();
    final c = await show(tester, server);
    await openThread(tester, c, 'message-1');

    expect(newSession, findsOneWidget);
    expect(alsoSend, findsOneWidget);
    expect(box(tester, newSession).on, isFalse);
    // Before Also send in reading order: left of it on one row, or above it
    // where a narrow pane wraps them.
    final a = tester.getRect(newSession), b = tester.getRect(alsoSend);
    expect(a.top < b.top || (a.top == b.top && a.left < b.left), isTrue);
    expect(
      find.byTooltip('Starts a separate Buddy session for this thread'),
      findsOneWidget,
    );

    await tester.tap(newSession);
    await tester.pump();
    expect(box(tester, newSession).on, isTrue);
    // A session's thread stays in the thread.
    expect(alsoSend, findsNothing);

    await tester.enterText(composer, 'Measure it now');
    await tester.pump();
    await tester.tap(send);
    await tester.pumpAndSettle();
    final sent = lastCommand(server);
    expect(sent['type'], 'message.send');
    expect(sent['replyTo'], 'message-1');
    expect(sent['newSession'], isTrue);
    expect(sent.containsKey('alsoSend'), isFalse);
    // The next reply starts as plain again.
    expect(box(tester, newSession).on, isFalse);
  });

  testSessions('the choices are compact chips on the send row, not '
      'checkboxes', (tester) async {
    final server = buddyChat();
    final c = await show(tester, server);
    await openThread(tester, c, 'message-1');
    final panel = find.byKey(const ValueKey('super-thread-panel'));
    expect(
      find.descendant(of: panel, matching: find.byType(Checkbox)),
      findsNothing,
    );
    expect(box(tester, newSession).label, 'New session');
    expect(box(tester, alsoSend).label, 'Also send');
    expect(find.byTooltip('Also send to the chat'), findsOneWidget);
    // Both sit on the send row, left of its buttons, and are compact: no
    // taller than the send button. (One line at real fonts: the PR's
    // screenshots; the test font is far wider.)
    final row = tester.getRect(send);
    final surface = tester.getRect(
      find.byKey(const ValueKey('super-thread-composer-surface')),
    );
    for (final chip in [newSession, alsoSend]) {
      final rect = tester.getRect(chip);
      expect(rect.right, lessThan(row.left));
      expect(rect.height, lessThanOrEqualTo(row.height));
      expect(surface.contains(rect.center), isTrue);
    }
    final note = find.byKey(const ValueKey('super-thread-session-note'));
    expect(note, findsNothing);

    await tester.tap(newSession);
    await tester.pump();
    expect(box(tester, newSession).on, isTrue);
    expect(alsoSend, findsNothing);
    expect(
      tester.widget<Text>(note).data,
      'Your reply starts a new Buddy session',
    );
    // Its line sits under the box.
    expect(
      tester.getRect(note).top,
      greaterThanOrEqualTo(
        tester
            .getRect(
              find.byKey(const ValueKey('super-thread-composer-surface')),
            )
            .bottom,
      ),
    );

    await tester.tap(newSession);
    await tester.pump();
    expect(box(tester, newSession).on, isFalse);
    expect(alsoSend, findsOneWidget);
    expect(note, findsNothing);
  });

  testSessions('a reply takes at most 10 files, and the box says so', (
    tester,
  ) async {
    final server = buddyChat();
    final c = await show(tester, server);
    await openThread(tester, c, 'message-1');
    final files = c.threadAttachments('offline', 'message-1');
    final problem = files.add([
      for (var i = 0; i < 11; i++)
        HarnessAttachment('f$i.txt', Uint8List.fromList([i + 1])),
    ]);
    await tester.pumpAndSettle();
    expect(files.files, hasLength(10));
    expect(problem, 'Attach at most 10 files.');
  });

  testSessions('a New session reply refused for another field keeps New '
      'session offered and says so plainly', (tester) async {
    final server = buddyChat();
    final c = await show(tester, server);
    await openThread(tester, c, 'message-1');
    server
      ..refuse = {
        'code': 'VALIDATION_ERROR',
        'message':
            'command.attachmentIds: Too big: expected array to have <=10 items',
      }
      ..refuseStatus = 400;
    await tester.tap(newSession);
    await tester.enterText(composer, 'Continue the session');
    await tester.pump();
    await tester.tap(send);
    await tester.pumpAndSettle();
    expect(find.text(superTabSessionsUnavailable), findsNothing);
    expect(find.textContaining('Too big'), findsNothing);
    expect(find.text("The server couldn't take this message."), findsWidgets);
    // Still offered: the server takes New session.
    expect(c.offersThreadSessions('message-1'), isTrue);
    expect(newSession, findsOneWidget);
    // The reply stays Not sent with New session, for Retry.
    final refused = c.outgoing('offline').single;
    expect(refused.state, SuperTabOutgoingState.refused);
  });

  testSessions('a New session tick stays with its own thread', (tester) async {
    final server = buddyChat();
    final c = await show(tester, server);
    await openThread(tester, c, 'message-1');
    await tester.tap(newSession);
    await tester.pump();
    expect(box(tester, newSession).on, isTrue);
    await openThread(tester, c, 'message-2');
    expect(box(tester, newSession).on, isFalse);
    expect(alsoSend, findsOneWidget);
  });

  testSessions('a plain reply in a Buddy chat sends no new session', (
    tester,
  ) async {
    final server = buddyChat();
    final c = await show(tester, server);
    await openThread(tester, c, 'message-1');
    await tester.enterText(composer, 'Just a note');
    await tester.pump();
    await tester.tap(send);
    await tester.pumpAndSettle();
    expect(lastCommand(server).containsKey('newSession'), isFalse);
  });

  testSessions('New session is offered only in the reader\'s own Buddy chat, '
      'with their Buddy running', (tester) async {
    // A workgroup's thread.
    final work = ConversationServer()..threads = true;
    work.append('A workgroup topic');
    var c = await show(tester, work, select: false);
    await openThread(tester, c, 'message-1');
    expect(newSession, findsNothing);
    expect(alsoSend, findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    await shown.flush();

    // Their Buddy chat, with no Buddy running.
    c = await show(tester, buddyChat(buddy: false));
    await openThread(tester, c, 'message-1');
    expect(newSession, findsNothing);
  });

  testSessions('at the limit the choice is unavailable and says why', (
    tester,
  ) async {
    final server = buddyChat();
    for (final thread in ['t-a', 't-b', 't-c']) {
      addSession(server, thread, agentId: 'session-$thread');
    }
    final c = await show(tester, server);
    await openThread(tester, c, 'message-1');
    expect(find.text('New session'), findsOneWidget);
    expect(box(tester, newSession).onChanged, isNull);
    expect(box(tester, newSession).on, isFalse);
    expect(
      find.byTooltip('3 sessions running. End one to start another.'),
      findsOneWidget,
    );
    // Tapping the words does nothing either; a reply goes plain.
    await tester.tap(newSession);
    await tester.enterText(composer, 'Plain');
    await tester.pump();
    await tester.tap(send);
    await tester.pumpAndSettle();
    expect(lastCommand(server).containsKey('newSession'), isFalse);
  });

  testSessions('a starting session says so, and its thread offers no choice', (
    tester,
  ) async {
    final server = buddyChat();
    addSession(server, 'message-1');
    final c = await show(tester, server);
    await openThread(tester, c, 'message-1');
    expect(tester.widget<Text>(state).data, 'Own session · Starting…');
    expect(newSession, findsNothing);
    expect(alsoSend, findsNothing);
  });

  testSessions('a session on a computer that went offline names it', (
    tester,
  ) async {
    final server = buddyChat();
    addSession(server, 'message-1', agentId: 'session-1', down: true);
    final c = await show(tester, server);
    await openThread(tester, c, 'message-1');
    // A machine this computer has no row for is not guessed at.
    expect(
      tester.widget<Text>(state).data,
      'Own session · Its computer is offline',
    );
    server.state['machines'] = [machine()];
    server.revision++;
    await c.refresh();
    await tester.pumpAndSettle();
    expect(tester.widget<Text>(state).data, 'Own session · Studio is offline');
  });

  testSessions('End session is a quiet text action that ends that thread\'s '
      'session', (tester) async {
    final server = buddyChat();
    addSession(server, 'message-1', agentId: 'session-1');
    final c = await show(tester, server);
    await openThread(tester, c, 'message-1');
    expect(end, findsOneWidget);
    // Not a button: no filled or outlined button anywhere in the line.
    expect(
      find.descendant(
        of: find.byKey(const ValueKey('super-thread-session-message-1')),
        matching: find.byWidgetPredicate(
          (w) => w is ButtonStyleButton || w is MaterialButton,
        ),
      ),
      findsNothing,
    );
    await tester.tap(end);
    await tester.pumpAndSettle();
    expect(lastCommand(server), {
      'type': 'buddy.sessionEnd',
      'conversationId': 'offline',
      'thread': 'message-1',
      'reason': 'ended',
    });
  });

  testSessions('an ended session\'s thread says why, and a reply must start '
      'a new one', (tester) async {
    final server = buddyChat();
    server.append(
      'Session ended: idle for 30 minutes.',
      conversationId: 'offline',
    );
    server.messages.last
      ..['thread'] = 'message-1'
      ..['replyTo'] = 'message-1'
      ..['buddySession'] = true
      ..['source'] = {
        'kind': 'buddy-session-ended',
        'reason': 'idle',
        'thread': 'message-1',
      };
    final c = await show(tester, server);
    await openThread(tester, c, 'message-1');
    expect(
      tester.widget<Text>(ended).data,
      'Session ended: idle for 30 minutes',
    );
    expect(box(tester, newSession).on, isTrue);
    expect(box(tester, newSession).onChanged, isNull);
    expect(alsoSend, findsNothing);
    await tester.enterText(composer, 'Go on');
    await tester.pump();
    await tester.tap(send);
    await tester.pumpAndSettle();
    expect(lastCommand(server)['newSession'], isTrue);
  });

  testSessions('the chat\'s thread line marks a thread its session answers', (
    tester,
  ) async {
    final server = buddyChat();
    server.append('Reading the pod logs…', conversationId: 'offline');
    server.messages.last
      ..['thread'] = 'message-1'
      ..['replyTo'] = 'message-1'
      ..['buddySession'] = true;
    server.append('Second topic', conversationId: 'offline');
    server.append('A reply', conversationId: 'offline');
    server.messages.last
      ..['thread'] = 'message-4'
      ..['replyTo'] = 'message-4';
    addSession(server, 'message-1', agentId: 'session-1');
    await show(tester, server);
    expect(
      find.byKey(const ValueKey('super-thread-session-mark-message-1')),
      findsOneWidget,
    );
    expect(find.text('Own session'), findsOneWidget);
    // A thread without a session has a plain line.
    expect(
      find.byKey(const ValueKey('super-thread-session-mark-message-4')),
      findsNothing,
    );
  });

  test('the Buddy is the main session, never a thread\'s own', () async {
    final server = buddyChat();
    // A session listed first, and its start, must not stand for the Buddy.
    addSession(server, 'message-1', agentId: 'session-1');
    final agents = server.state['agents'] as List;
    agents.insert(0, agents.removeLast());
    server.state['starts'] = [
      {
        'id': 'start-message-1',
        'request': {
          'conversationId': 'offline',
          'buddyOf': {'personId': 'owner', 'generation': 'g1'},
          'buddySession': {'thread': 'message-1', 'from': 1},
        },
        'harnessId': null,
        'error': null,
      },
    ];
    final c = shown = server.controller();
    addTearDown(c.dispose);
    await c.refresh();
    expect(c.buddy('lead')?.id, 'buddy-main');
    expect(c.buddyStart('lead'), isNull);
    expect(c.snapshot!.agent('session-1')!.isMainBuddy, isFalse);
    expect(c.snapshot!.agent('buddy-main')!.isMainBuddy, isTrue);
    await c.flush();
  });

  testSessions('access lost while a session\'s thread is open clears it all', (
    tester,
  ) async {
    final server = buddyChat();
    addSession(server, 'message-1', agentId: 'session-1');
    final c = await show(tester, server);
    await openThread(tester, c, 'message-1');
    expect(state, findsOneWidget);
    c.revokeAccess('You no longer have access to this Swarm.');
    await tester.pumpAndSettle();
    expect(state, findsNothing);
    expect(end, findsNothing);
    expect(newSession, findsNothing);
    expect(c.threadSession('message-1'), isNull);
    expect(c.offersThreadSessions('message-1'), isFalse);
    expect(await c.endThreadSession('message-1'), isFalse);
  });

  testSessions('a late End session answer leaves another thread as it is', (
    tester,
  ) async {
    final server = buddyChat();
    addSession(server, 'message-1', agentId: 'session-1');
    final c = await show(tester, server);
    await openThread(tester, c, 'message-1');
    final hold = server.holdCommands = Completer<void>();
    await tester.tap(end);
    await tester.pump();
    expect(find.text('Ending…'), findsOneWidget);

    // Another thread is opened while the answer is on its way.
    await openThread(tester, c, 'message-2');
    expect(find.text('Ending…'), findsNothing);
    expect(newSession, findsOneWidget);
    expect(box(tester, newSession).on, isFalse);
    hold.complete();
    server.holdCommands = null;
    await tester.pumpAndSettle();
    expect(find.text('Ending…'), findsNothing);
    expect(state, findsNothing);
    expect(newSession, findsOneWidget);
    expect(box(tester, newSession).on, isFalse);
  });

  testSessions('a first read that failed and then recovered still offers New '
      'session', (tester) async {
    final server = buddyChat()..failReads = true;
    final c = await show(tester, server, select: false);
    expect(c.snapshot, isNull);
    server.failReads = false;
    await c.refresh();
    c.select('offline');
    await tester.pumpAndSettle();
    await openThread(tester, c, 'message-1');
    expect(newSession, findsOneWidget);
    expect(box(tester, newSession).onChanged, isNotNull);
  });

  testSessions('any session reply locks New session, ended line or not', (
    tester,
  ) async {
    final server = buddyChat();
    sessionReply(server, 'message-1', 'Reading the logs…');
    final c = await show(tester, server);
    await openThread(tester, c, 'message-1');
    expect(box(tester, newSession).on, isTrue);
    expect(box(tester, newSession).onChanged, isNull);
    expect(alsoSend, findsNothing);
    expect(tester.widget<Text>(ended).data, 'Session ended');
  });

  testSessions('after the Buddy is removed, an old session thread stays '
      'locked and says why', (tester) async {
    final server = buddyChat(buddy: false);
    sessionReply(server, 'message-1', 'Reading the logs…');
    server.append(
      'Session ended: its Buddy was removed or replaced.',
      conversationId: 'offline',
    );
    server.messages.last
      ..['thread'] = 'message-1'
      ..['replyTo'] = 'message-1'
      ..['buddySession'] = true
      ..['source'] = {
        'kind': 'buddy-session-ended',
        'reason': 'removed',
        'thread': 'message-1',
      };
    final c = await show(tester, server);
    await openThread(tester, c, 'message-1');
    expect(
      tester.widget<Text>(ended).data,
      'Session ended: its Buddy was removed or replaced',
    );
    expect(box(tester, newSession).on, isTrue);
    expect(box(tester, newSession).onChanged, isNull);
    expect(find.byTooltip('Start your Buddy first'), findsOneWidget);
    // A thread with no session past offers nothing without a Buddy.
    await openThread(tester, c, 'message-2');
    expect(newSession, findsNothing);
  });

  testSessions('New session says why the server would refuse it, before '
      'sending', (tester) async {
    final server = buddyChat();
    final c = await show(tester, server);
    await openThread(tester, c, 'message-1');
    Future<void> blockedBy(String reason) async {
      server.revision++;
      await c.refresh();
      await tester.pumpAndSettle();
      expect(find.byTooltip(reason), findsOneWidget);
      expect(find.text('New session'), findsOneWidget);
      expect(box(tester, newSession).onChanged, isNull);
      expect(box(tester, newSession).on, isFalse);
    }

    server.state['paused'] = true;
    await blockedBy('New work is paused in this Swarm');
    server.state['paused'] = false;
    final main = (server.state['agents'] as List).last as Map<String, dynamic>;
    main['downSince'] = '2026-10-30T00:00:00Z';
    await blockedBy('Start your Buddy first');
    main.remove('downSince');
    main['configuration'] = {'engine': 'codex'};
    await blockedBy('Sessions need a Claude Code Buddy');
    main['configuration'] = {'engine': 'claude'};
    server.state['machines'] = [machine(capable: false)];
    await blockedBy('Update Harness on Studio to start sessions');
    // A block wins over the limit: it is what would be refused.
    addSession(server, 'message-2', agentId: 's2');
    final chat = chatOf(server);
    chat['buddySessions'] = [
      ...chat['buddySessions'] as List,
      {'thread': 'x', 'startId': 'sx', 'at': 1},
      {'thread': 'y', 'startId': 'sy', 'at': 1},
    ];
    await blockedBy('Update Harness on Studio to start sessions');
    server.state['machines'] = [machine()];
    chat['buddySessions'] = <dynamic>[];
    server.revision++;
    await c.refresh();
    await tester.pumpAndSettle();
    expect(find.text('New session'), findsOneWidget);
    expect(box(tester, newSession).onChanged, isNotNull);
  });

  // ── An older server (2026-10-31, Scholes): a test build offered New session
  // against production, whose schema refused it with its raw text. ──────────

  const unavailable = "New sessions aren't available yet; send without it?";
  const rawRefusal = 'command: Unrecognized key: "newSession"';
  final threadError = find.byKey(const ValueKey('super-thread-error'));

  /// Makes [server] refuse every command as a backend from before New session
  /// refuses one with it.
  void refuseAsOlderServer(ConversationServer server) {
    server
      ..refuse = {'code': 'VALIDATION_ERROR', 'message': rawRefusal}
      ..refuseStatus = 400;
  }

  testSessions('a server that does not take New session never offers it, '
      'and offers it once it says it does', (tester) async {
    final server = buddyChat(sessions: false);
    server.state['machines'] = [machine()];
    final c = await show(tester, server);
    await openThread(tester, c, 'message-1');
    // The Buddy's machine can run sessions; the server cannot start them.
    expect(newSession, findsNothing);
    expect(alsoSend, findsOneWidget);
    expect(c.offersThreadSessions('message-1'), isFalse);
    await tester.enterText(composer, 'Plain reply');
    await tester.pump();
    await tester.tap(send);
    await tester.pumpAndSettle();
    expect(lastCommand(server).containsKey('newSession'), isFalse);

    // The server is updated: the next changes read says so.
    server.state['threadSessions'] = true;
    server.revision++;
    await c.refresh();
    await tester.pumpAndSettle();
    expect(newSession, findsOneWidget);
    expect(box(tester, newSession).onChanged, isNotNull);
  });

  testSessions('a server rolled back to before New session hides it again', (
    tester,
  ) async {
    final server = buddyChat();
    final c = await show(tester, server);
    await openThread(tester, c, 'message-1');
    expect(newSession, findsOneWidget);
    server.state.remove('threadSessions');
    server.revision++;
    await c.refresh();
    await tester.pumpAndSettle();
    expect(newSession, findsNothing);
    expect(alsoSend, findsOneWidget);
  });

  testSessions('a New session reply the server refuses keeps its text in the '
      'box, says so plainly, and sends without it', (tester) async {
    final server = buddyChat();
    final c = await show(tester, server);
    await openThread(tester, c, 'message-1');
    refuseAsOlderServer(server);
    await tester.tap(newSession);
    await tester.pump();
    await tester.enterText(composer, 'Measure it now');
    await tester.pump();
    await tester.tap(send);
    await tester.pumpAndSettle();
    expect(lastCommand(server)['newSession'], isTrue);

    expect(
      tester.widget<TextField>(composer).controller!.text,
      'Measure it now',
    );
    expect(tester.widget<Text>(threadError).data, unavailable);
    expect(find.textContaining('Unrecognized key'), findsNothing);
    // Nothing waits as Not sent: the text is in the box, ready to go.
    expect(find.text('Not sent'), findsNothing);
    expect(c.outgoing('offline'), isEmpty);
    // New session is no longer offered, so Send goes without it.
    expect(newSession, findsNothing);

    server.refuse = null;
    await tester.tap(send);
    await tester.pumpAndSettle();
    final sent = lastCommand(server);
    expect(sent['text'], 'Measure it now');
    expect(sent['replyTo'], 'message-1');
    expect(sent.containsKey('newSession'), isFalse);
    expect(threadError, findsNothing);
    expect(tester.widget<TextField>(composer).controller!.text, isEmpty);
  });

  testSessions('after a refusal New session comes back a while later, if the '
      'server still says it takes it', (tester) async {
    final server = buddyChat();
    final c = await show(tester, server);
    await openThread(tester, c, 'message-1');
    refuseAsOlderServer(server);
    await tester.tap(newSession);
    await tester.enterText(composer, 'Measure it now');
    await tester.pump();
    await tester.tap(send);
    await tester.pumpAndSettle();
    expect(c.offersThreadSessions('message-1'), isFalse);
    final later = clock.now().add(const Duration(minutes: 11));
    expect(
      withClock(Clock.fixed(later), () => c.offersThreadSessions('message-1')),
      isTrue,
    );
  });

  testSessions('a refusal that lands after more was typed keeps the new text '
      'and the refused reply, whose Retry goes without New session', (
    tester,
  ) async {
    final server = buddyChat();
    final c = await show(tester, server);
    await openThread(tester, c, 'message-1');
    refuseAsOlderServer(server);
    final hold = server.holdCommands = Completer<void>();
    await tester.tap(newSession);
    await tester.enterText(composer, 'First');
    await tester.pump();
    await tester.tap(send);
    await tester.pump();
    await tester.enterText(composer, 'Second, typed meanwhile');
    await tester.pump();
    hold.complete();
    server.holdCommands = null;
    await tester.pumpAndSettle();

    expect(
      tester.widget<TextField>(composer).controller!.text,
      'Second, typed meanwhile',
    );
    expect(find.textContaining('Unrecognized key'), findsNothing);
    final refused = c.outgoing('offline').single;
    expect(refused.state, SuperTabOutgoingState.refused);
    expect(refused.text, 'First');
    expect(refused.error, unavailable);

    server.refuse = null;
    await c.retryOutgoing(refused);
    await tester.pumpAndSettle();
    final sent = lastCommand(server);
    expect(sent['text'], 'First');
    expect(sent.containsKey('newSession'), isFalse);
  });

  testSessions('a refusal that lands after another thread opened changes only '
      'its own thread', (tester) async {
    final server = buddyChat();
    final c = await show(tester, server);
    await openThread(tester, c, 'message-1');
    refuseAsOlderServer(server);
    final hold = server.holdCommands = Completer<void>();
    await tester.tap(newSession);
    await tester.enterText(composer, 'For the first thread');
    await tester.pump();
    await tester.tap(send);
    await tester.pump();
    await openThread(tester, c, 'message-2');
    hold.complete();
    server.holdCommands = null;
    await tester.pumpAndSettle();
    // The open thread's box is left as it was, and says nothing of another's.
    expect(tester.widget<TextField>(composer).controller!.text, isEmpty);
    expect(threadError, findsNothing);
    expect(c.threadDraft('message-2'), isEmpty);
    // Its own thread has the text back.
    await openThread(tester, c, 'message-1');
    expect(
      tester.widget<TextField>(composer).controller!.text,
      'For the first thread',
    );
  });

  testSessions('access lost while a New session reply is on its way leaves '
      'nothing behind', (tester) async {
    final server = buddyChat();
    final c = await show(tester, server);
    await openThread(tester, c, 'message-1');
    refuseAsOlderServer(server);
    final hold = server.holdCommands = Completer<void>();
    await tester.tap(newSession);
    await tester.enterText(composer, 'Private words');
    await tester.pump();
    await tester.tap(send);
    await tester.pump();
    c.revokeAccess('You no longer have access to this Swarm.');
    hold.complete();
    server.holdCommands = null;
    await tester.pumpAndSettle();
    expect(c.threadDraft('message-1'), isEmpty);
    expect(c.outgoing('offline'), isEmpty);
    expect(find.text('Private words'), findsNothing);
    expect(find.textContaining('Unrecognized key'), findsNothing);
  });

  testSessions('a message the server refuses for its form says so plainly '
      'under it, never in the server\'s own words', (tester) async {
    final server = buddyChat();
    final c = await show(tester, server);
    server
      ..refuse = {
        'code': 'VALIDATION_ERROR',
        'message': 'command: Unrecognized key: "agentOnly"',
      }
      ..refuseStatus = 400;
    c.setDraft('offline', 'In the main chat');
    await c.send();
    await tester.pumpAndSettle();
    expect(find.textContaining('Unrecognized key'), findsNothing);
    expect(find.text('Not sent'), findsOneWidget);
    expect(find.text("The server couldn't take this message."), findsOneWidget);
  });

  testSessions('a refusal saved with the server\'s own words before this '
      'version shows plainly', (tester) async {
    final server = buddyChat();
    final c = await show(
      tester,
      server,
      initial: {
        'tabId': 'tab',
        'accountId': 'owner',
        'refused': {
          'offline': [
            {
              'operationId': 'op-old',
              'command': {
                'type': 'message.send',
                'conversationId': 'offline',
                'text': 'Saved before',
                'replyTo': null,
                'recipientIds': <String>[],
              },
              'mentions': <String, String>{},
              'error': rawRefusal,
            },
          ],
        },
      },
    );
    await tester.pumpAndSettle();
    expect(c.outgoing('offline').single.text, 'Saved before');
    expect(find.text('Not sent'), findsOneWidget);
    expect(find.textContaining('Unrecognized key'), findsNothing);
    expect(find.text("The server couldn't take this message."), findsOneWidget);
  });

  testSessions('Ending… cannot be pressed again while its end is on its way', (
    tester,
  ) async {
    final server = buddyChat();
    addSession(server, 'message-1', agentId: 'session-1');
    final c = await show(tester, server);
    await openThread(tester, c, 'message-1');
    final hold = server.holdCommands = Completer<void>();
    await tester.tap(end);
    await tester.pump();
    final sent = server.posts.length;
    expect(find.text('Ending…'), findsOneWidget);
    final link = tester.widget<SuperTabLink>(end);
    expect(link.onTap, isNull);
    expect(
      tester.getSemantics(end),
      isSemantics(isButton: true, hasEnabledState: true, isEnabled: false),
    );
    await tester.tap(end, warnIfMissed: false);
    await tester.pump();
    expect(server.posts.length, sent);
    hold.complete();
    server.holdCommands = null;
    await tester.pumpAndSettle();
  });

  testSessions('a session start that failed never shows as the Buddy\'s own, '
      'nor as Starting…', (tester) async {
    final server = buddyChat();
    // The backend ended it (no entry left) after its start timed out.
    server.state['starts'] = [
      {
        'id': 'start-message-1',
        'request': {
          'conversationId': 'offline',
          'machineId': 'mac',
          'engine': 'claude',
          'buddyOf': {'personId': 'owner', 'generation': 'g1'},
          'buddySession': {'thread': 'message-1', 'from': 1},
        },
        'harnessId': null,
        'error': 'This start timed out.',
      },
    ];
    final c = await show(tester, server);
    await openThread(tester, c, 'message-1');
    expect(c.buddyStart('lead'), isNull);
    expect(find.textContaining("Couldn't start"), findsNothing);
    expect(state, findsNothing);
    expect(box(tester, newSession).onChanged, isNotNull);
  });

  test('unexpected types in session fields never break the read', () async {
    final server = buddyChat();
    final chat = chatOf(server);
    chat['buddySessions'] = {'thread': 'message-1'};
    (server.state['agents'] as List).add({
      'id': 'odd',
      'name': 'Odd',
      'machineId': 'mac',
      'harnessId': 'h-odd',
      'contributorId': 'owner',
      'buddyOf': {'personId': 'owner', 'generation': 'g1'},
      'buddySession': {'thread': 5, 'from': 'x'},
      'configuration': {'engine': 'claude'},
    });
    final c = server.controller();
    addTearDown(c.dispose);
    await c.refresh();
    expect(c.snapshot, isNotNull);
    expect(c.snapshot!.conversation('offline')!.buddySessions, isEmpty);
    expect(c.snapshot!.agent('odd')!.buddySession, isNull);
    chat['buddySessions'] = [
      {'thread': 'message-1', 'startId': 3, 'agentId': 7, 'at': 'soon'},
      'not a session',
    ];
    (server.state['agents'] as List).last['buddySession'] = {
      'thread': 'message-1',
      'from': 'x',
    };
    server.revision++;
    await c.refresh();
    final session = c.snapshot!.conversation('offline')!.buddySessions.single;
    expect(session.startId, '');
    expect(session.agentId, isNull);
    expect(session.at, 0);
    expect(c.snapshot!.agent('odd')!.buddySession!.from, 0);
  });
}
