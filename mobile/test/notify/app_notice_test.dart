import 'package:flutter_test/flutter_test.dart';

import 'package:harness_mobile/notify/agent_notice.dart';
import 'package:harness_mobile/state/app_state.dart';

import '../agent_pager_fixture.dart';

/// The dial's rule, end to end: frames off the machine socket into the marks
/// the phone draws.
void main() {
  /// One whole turn of [agentId], as the machine streams it: its end, then
  /// the recap the daemon always sends after it, with [summary] as its
  /// payload (a `tier` from a daemon that decides one). Null: no recap.
  Future<void> turn(
    AppNotifier app,
    String agentId, {
    String? reply = 'Fixed the login screen.',
    Map<String, dynamic> end = const {},
    Map<String, dynamic> endPayload = const {},
    Map<String, dynamic>? summary = const {},
  }) async {
    Future<void> send(String type, [Map<String, dynamic> payload = const {}]) =>
        app.handleEventForTest('m', {
          'type': type,
          'agentId': agentId,
          ...(type == 'turn_ended' ? end : const {}),
          'payload': {...payload},
        });
    await send('turn_started', {'userMessage': 'fix it'});
    if (reply != null) await send('text_delta', {'content': reply});
    await send('turn_ended', endPayload);
    if (summary != null) await send('turn_summary', summary);
  }

  Future<void> ask(AppNotifier app, String agentId, {String id = 'q1'}) =>
      app.handleEventForTest('m', {
        'type': 'commander_question',
        'agentId': agentId,
        'payload': {
          'requestId': id,
          'questions': [
            {
              'q': 'Which database?',
              'options': ['Postgres', 'SQLite'],
            },
          ],
        },
      });

  Future<void> closeQuestion(AppNotifier app, String agentId, String id) =>
      app.handleEventForTest('m', {
        'type': 'commander_question_close',
        'agentId': agentId,
        'payload': {'requestId': id},
      });

  NoticeKind? kindOf(AppNotifier app, String agentId) =>
      app.agentNotices.unread.kindFor((machineId: 'm', agentId: agentId));

  bool unread(AppNotifier app, String agentId) =>
      app.agentNotices.unread.contains((machineId: 'm', agentId: agentId));

  late AppNotifier app;

  setUp(() async {
    app = pagerApp(PagerConn());
    addTearDown(app.dispose);
    await liveAgent(app, 'a');
  });

  test('an agent finishing elsewhere is marked', () async {
    await turn(app, 'b');
    expect(unread(app, 'b'), isTrue);
    expect(app.agentNotices.unread.count, 1);
  });

  test('the agent on screen is never marked', () async {
    await turn(app, 'a');
    expect(unread(app, 'a'), isFalse);
  });

  test('what the dial stays quiet about, the phone does too', () async {
    await turn(app, 'b', reply: null);
    await turn(app, 'b', endPayload: {'aborted': true});
    await turn(app, 'b', end: {'subagent': true});
    await turn(app, 'b', end: {'replay': true});
    expect(app.agentNotices.unread.count, 0);
  });

  test('the daemon\'s tier on the recap after a turn decides the mark', () async {
    await turn(app, 'b', summary: {'tier': 'silent'});
    expect(unread(app, 'b'), isFalse);
    await turn(app, 'b', summary: {'tier': 'list'});
    expect(kindOf(app, 'b'), NoticeKind.done);
  });

  test('the agent on screen is not marked whatever the tier', () async {
    await turn(app, 'a', summary: {'tier': 'alert'});
    await turn(app, 'a', summary: {'tier': 'list'});
    expect(unread(app, 'a'), isFalse);
  });

  test('a turn\'s mark waits for its recap, and a recap with no turn waiting marks nothing', () async {
    await turn(app, 'b', summary: null);
    expect(unread(app, 'b'), isFalse);
    await app.handleEventForTest('m', {
      'type': 'turn_summary',
      'agentId': 'b',
      'payload': {'tier': 'list'},
    });
    expect(unread(app, 'b'), isTrue);
    app.agentNotices.unread.clearAll();
    await app.handleEventForTest('m', {
      'type': 'turn_summary',
      'agentId': 'b',
      'payload': {'tier': 'alert'},
    });
    await app.handleEventForTest('m', {
      'type': 'turn_summary',
      'payload': {'tier': 'alert'},
    });
    expect(app.agentNotices.unread.count, 0);
  });

  test('a turn with nothing to say does not borrow the last one', () async {
    await turn(app, 'b');
    app.agentNotices.unread.clearAll();
    await turn(app, 'b', reply: null);
    expect(unread(app, 'b'), isFalse);
  });

  test('going to the agent reads its news', () async {
    await turn(app, 'b');
    await liveAgent(app, 'b');
    expect(unread(app, 'b'), isFalse);
  });

  test('opening an agent that has no pane yet reads its news', () async {
    // The phone's ordinary road: a row tapped, a notice tapped — a NEW pane,
    // focused on its swarm directly rather than through `focusPane`.
    await turn(app, 'c');
    expect(app.paneOfAgent('m', 'c'), isNull);
    await app.selectAgent('m', 'c');
    expect(unread(app, 'c'), isFalse);
  });

  test('coming back to an agent already open reads its news', () async {
    await app.selectAgent('m', 'b');
    await app.selectAgent('m', 'a');
    await turn(app, 'b');
    await app.selectAgent('m', 'b');
    expect(unread(app, 'b'), isFalse);
  });

  test('a deleted agent takes its mark with it', () async {
    await turn(app, 'b');
    await app.handleEventForTest('m', {
      'type': 'agent_deleted',
      'agentId': 'b',
      'payload': <String, dynamic>{},
    });
    expect(unread(app, 'b'), isFalse);
  });

  group('questions', () {
    test('a question elsewhere is marked as one', () async {
      await ask(app, 'b');
      expect(kindOf(app, 'b'), NoticeKind.question);
    });

    test('the agent on screen asking is never marked', () async {
      await ask(app, 'a');
      expect(unread(app, 'a'), isFalse);
    });

    test('answered elsewhere, the mark goes', () async {
      await ask(app, 'b');
      await closeQuestion(app, 'b', 'q1');
      expect(unread(app, 'b'), isFalse);
    });

    Future<void> openOnes(AppNotifier app, Object? requestIds) =>
        app.handleEventForTest('m', {
          'type': 'commander_questions_open',
          'payload': {'requestIds': requestIds},
        });

    test('the machine\'s open list takes down one answered while away, and keeps the rest', () async {
      await ask(app, 'b');
      await ask(app, 'c', id: 'q2');
      await openOnes(app, ['q2', 7]);
      expect(unread(app, 'b'), isFalse);
      expect(app.stateOf('m')!.blockedAgents.containsKey('b'), isFalse);
      expect(kindOf(app, 'c'), NoticeKind.question);
      expect(app.stateOf('m')!.blockedAgents['c']?.requestId, 'q2');
    });

    test('an open list that is not a list changes nothing', () async {
      await ask(app, 'b');
      await openOnes(app, 'q1');
      await app.handleEventForTest('m', {
        'type': 'commander_questions_open',
        'payload': <String, dynamic>{},
      });
      expect(kindOf(app, 'b'), NoticeKind.question);
      expect(app.stateOf('m')!.blockedAgents.containsKey('b'), isTrue);
    });

    test('a reconnect re-announcing it does not make it new', () async {
      await ask(app, 'b');
      app.agentNotices.unread.clearAll();
      // The disconnect sweep empties `blockedAgents`; the daemon re-announces.
      app.stateOf('m')!.blockedAgents.clear();
      await ask(app, 'b');
      expect(unread(app, 'b'), isFalse);
    });
  });
}
