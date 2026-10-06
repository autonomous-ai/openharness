// THE BADGE HERE AND THE PILL ON THE DIAL SHOW THE SAME NUMBER.
//
// Not a style rule — the two used to disagree in three separate places, and a
// person looking at both saw "2" on the dial and "6" in the window with no way
// to tell which was lying. Each group below pins one of the three.
//
// The daemon is the decider for all three: it already told the cable, and now
// it tells this window on the same events, so neither side re-derives a rule
// the other one owns (`isSubagentSession`, `alreadyOnScreen`, `deviceIsWatching`
// in cli/src/cli.ts).
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/notify/alert_sounds.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/notification_inbox.dart';
import 'package:harness/ws/ws_conn.dart';

import 'swarm_state_test.dart' show createApp;

/// Records the frames this window puts on a machine's socket.
class _Conn extends WsConn {
  _Conn()
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );

  final sent = <({String type, Map<String, dynamic> payload})>[];

  @override
  Future<bool> sendTerminalFrame(
    String type,
    Map<String, dynamic> payload,
  ) async {
    sent.add((type: type, payload: payload));
    return true;
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late AppNotifier app;

  setUp(() {
    app = createApp()
      // Nothing is on screen: `_visibleOnTab` reads the real lifecycle, and a
      // test with no window would otherwise have every agent count as watched.
      ..watchedAgents = () => const [];
  });
  tearDown(() => app.dispose());

  Future<void> readFromDial(
    String agentId,
    String token, {
    String machine = 'm',
  }) => app.handleEventForTest('m', {
    'type': 'dial_notification_read',
    'payload': {'machineId': machine, 'agentId': agentId, 'readToken': token},
  });

  Future<void> completed(
    String agentId, {
    bool? subagent,
    int turn = 0,
    String summary = 'A real final answer',
    String? recap,
    String? text,
    String machine = 'm',
  }) => app.handleEventForTest(machine, {
    'type': 'turn_summary',
    'agentId': agentId,
    'subagent': ?subagent,
    'payload': <String, dynamic>{
      'summary': summary,
      'recap': ?recap,
      'text': ?text,
      if (subagent != true)
        'notification': {'id': 'result-$agentId-$turn', 'kind': 'done'},
    },
  });

  test('retains the production summary-only completion words', () async {
    await completed('a1', summary: 'Done.\n\nThe exact supplied summary.');
    expect(
      app.agentUnread.messageFor('m', 'a1'),
      'Done.\n\nThe exact supplied summary.',
    );
    expect(app.agentUnread.readTokenFor('m', 'a1'), isNotNull);
  });

  test('prefers nonempty recap and text before the saved summary', () async {
    await completed(
      'a1',
      recap: 'Yes.',
      text: 'Detailed body.',
      summary: 'Saved summary.',
    );
    expect(app.agentUnread.messageFor('m', 'a1'), 'Yes.');
    await completed(
      'a1',
      turn: 1,
      recap: ' \u001b[0m ',
      text: 'Detailed body.',
      summary: 'Saved summary.',
    );
    expect(app.agentUnread.messageFor('m', 'a1'), 'Detailed body.');
    await completed(
      'a1',
      turn: 2,
      recap: ' ',
      text: '\u0000',
      summary: 'Saved summary.',
    );
    expect(app.agentUnread.messageFor('m', 'a1'), 'Saved summary.');
  });

  test(
    'duplicate delivery preserves words and a later occurrence replaces them',
    () async {
      await completed('a1', summary: 'First result.');
      final first = app.agentUnread.readTokenFor('m', 'a1')!;
      final receivedAt = app.agentUnread.receivedAtFor('m', 'a1');
      await completed('a1', summary: 'Different words on a duplicate.');
      expect(app.agentUnread.readTokenFor('m', 'a1'), first);
      expect(app.agentUnread.receivedAtFor('m', 'a1'), receivedAt);
      expect(app.agentUnread.messageFor('m', 'a1'), 'First result.');

      await completed('a1', turn: 1, summary: 'Second result.');
      final second = app.agentUnread.readTokenFor('m', 'a1')!;
      expect(second, isNot(first));
      expect(app.agentUnread.messageFor('m', 'a1'), 'Second result.');
      await readFromDial('a1', first);
      expect(app.agentUnread.readTokenFor('m', 'a1'), second);
      expect(app.agentUnread.messageFor('m', 'a1'), 'Second result.');

      await completed('a1', turn: 2, summary: 'Second result.');
      expect(app.agentUnread.readTokenFor('m', 'a1'), isNot(second));
      expect(app.agentUnread.messageFor('m', 'a1'), 'Second result.');
      await completed('a1', turn: 3, summary: '');
      expect(app.agentUnread.messageFor('m', 'a1'), isNull);
    },
  );

  test(
    'summary fallback keeps punctuation and strips terminal controls',
    () async {
      await completed(
        'a1',
        summary: '  \u001b[31mDone "quoted" at C:\\work\\notes.\u0000\u001b[0m\nSecond line.  ',
      );
      expect(
        app.agentUnread.messageFor('m', 'a1'),
        'Done "quoted" at C:\\work\\notes.\nSecond line.',
      );
    },
  );

  test(
    'the same agent and notification id on another machine keep separate words',
    () async {
      app.machineStates['other'] = MachineState(
        const Machine(
          machineId: 'other',
          name: 'Other computer',
          authMode: MachineAuthMode.remote,
        ),
      );
      await completed('a1', summary: 'This computer result.');
      await completed(
        'a1',
        machine: 'other',
        summary: 'Other computer result.',
      );
      final local = app.agentUnread.readTokenFor('m', 'a1');
      final other = app.agentUnread.readTokenFor('other', 'a1')!;
      expect(local, isNot(other));
      expect(app.agentUnread.messageFor('m', 'a1'), 'This computer result.');
      expect(
        app.agentUnread.messageFor('other', 'a1'),
        'Other computer result.',
      );
      await readFromDial('a1', other);
      expect(app.agentUnread.readTokenFor('m', 'a1'), local);
      expect(app.agentUnread.readTokenFor('other', 'a1'), other);
    },
  );

  for (final prefixLength in [598, 599]) {
    test(
      'summary preview preserves emoji boundaries after $prefixLength units',
      () async {
        final prefix = List.filled(prefixLength, 'a').join();
        await completed('a1', summary: '$prefix\u{1F680} More details.');
        final message = app.agentUnread.messageFor('m', 'a1')!;
        expect(message.length, lessThanOrEqualTo(600));
        expect(message, prefixLength == 598 ? '$prefix\u{1F680}' : prefix);
      },
    );
  }

  Future<void> question(String agentId) => app.handleEventForTest('m', {
    'type': 'commander_question',
    'agentId': agentId,
    'payload': <String, dynamic>{
      'requestId': 'req-$agentId',
      'questions': [
        {
          'key': 'k',
          'q': 'Which one?',
          'options': ['a', 'b'],
        },
      ],
    },
  });

  Future<void> answered(String agentId) => app.handleEventForTest('m', {
    'type': 'commander_question_close',
    'agentId': agentId,
    'payload': <String, dynamic>{'requestId': 'req-$agentId'},
  });

  test('device reads clear only their exact occurrence without changing the workspace', () async {
    await completed('a1');
    final old = app.agentUnread.readTokenFor('m', 'a1')!;
    await completed('a1', turn: 1);
    final current = app.agentUnread.readTokenFor('m', 'a1')!;
    expect(current, isNot(old));
    final tab = app.activeSwarmId;
    final panes = app.activeSwarm.panes.toList();
    await readFromDial('a1', old);
    await readFromDial('a1', current, machine: 'wrong');
    expect(app.agentUnread.count, 1);
    await readFromDial('a1', current);
    await readFromDial('a1', current);
    expect(app.agentUnread.count, 0);
    expect(app.activeSwarmId, tab);
    expect(app.activeSwarm.panes, panes);
  });

  test(
    'reading a question notification does not answer the pending question',
    () async {
      await question('a1');
      final pending = app.machineStates['m']!.blockedAgents['a1'];
      expect(pending, isNotNull);
      final token = app.agentUnread.readTokenFor('m', 'a1')!;
      await readFromDial('a1', token);
      expect(app.agentUnread.count, 0);
      expect(app.machineStates['m']!.blockedAgents['a1'], same(pending));
      expect(notificationInbox(app), isEmpty);
      await question('a1');
      expect(notificationInbox(app), isEmpty);
      app.machineStates['m']!.blockedAgents.clear(); // Reconnect restores it.
      await question('a1');
      expect(app.agentUnread.count, 0);
      expect(notificationInbox(app), isEmpty);
      await answered('a1');
      await question('a1'); // A later occurrence can ask the same words.
      expect(app.agentUnread.count, 1);
      expect(notificationInbox(app), hasLength(1));
      expect(app.agentUnread.readTokenFor('m', 'a1'), isNot(token));
    },
  );

  group('a sub-agent is not news on either screen', () {
    test('a verified final result is counted', () async {
      await completed('a1');
      expect(app.agentUnread.count, 1);
    });

    test('a sub-agent turn end is not', () async {
      await completed('a1', subagent: true);
      expect(app.agentUnread.count, 0);
      expect(app.agentUnread.kindFor('m', 'a1'), isNull);
    });

    test('an Orchestrator project rings once, not once per specialist', () async {
      // Four specialists and a Director that is still busy: the dial draws ONE
      // row, for the wrap-up. This used to be five marks here.
      for (final worker in ['w1', 'w2', 'w3', 'w4']) {
        await completed(worker, subagent: true);
      }
      await completed('director', subagent: true); // still busy
      expect(app.agentUnread.count, 0);

      await completed('director'); // the wrap-up
      expect(app.agentUnread.count, 1);
    });

    test('raw, failed, aborted and replayed turn ends are silent', () async {
      for (final payload in <Map<String, dynamic>>[
        {},
        {'aborted': true},
        {'error': 'Failed'},
      ]) {
        await app.handleEventForTest('m', {
          'type': 'turn_ended',
          'agentId': 'a1',
          'payload': payload,
        });
      }
      await app.handleEventForTest('m', {
        'type': 'turn_summary',
        'agentId': 'a1',
        'payload': {'summary': 'Historical recap'},
      });
      expect(app.agentUnread.count, 0);
    });

    test('redelivery after acknowledgement stays silent', () async {
      await completed('a1');
      app.markAgentSeen('m', 'a1');
      await completed('a1');
      expect(app.agentUnread.count, 0);
    });
  });

  group('a question is counted until it is answered', () {
    test('it counts, device or no device', () async {
      // A blocked agent is waiting on a person whatever else is on the desk.
      await question('a1');
      expect(app.agentUnread.count, 1);
      expect(app.agentUnread.kindFor('m', 'a1'), AlertKind.needsYou);
    });

    test('being looked at is not being answered', () async {
      // The mark for a finished turn goes when its tab comes to the front —
      // there is nothing left to do. A question is not like that: it is still
      // waiting however many times somebody glanced at it.
      await question('a1');
      app.watchedAgents = () => [(machineId: 'm', agentId: 'a1')];
      app.seeWatchedAgents();

      expect(app.agentUnread.count, 1, reason: 'still waiting on a person');
    });

    test('it counts even while its own agent is on screen', () async {
      // Showing a question asks the window to bring that agent forward, so "already
      // on screen" is true by construction — a skip here meant the mark was never
      // raised at all, and looking away later left nothing behind.
      app.watchedAgents = () => [(machineId: 'm', agentId: 'a1')];
      await question('a1');

      expect(app.agentUnread.count, 1);
      expect(app.agentUnread.kindFor('m', 'a1'), AlertKind.needsYou);
    });

    test('a finished turn on screen is still silent', () async {
      // The exception is the QUESTION, not the rule: news about a pane you are
      // looking at is still noise about the pane you are looking at.
      app.watchedAgents = () => [(machineId: 'm', agentId: 'a1')];
      await completed('a1');

      expect(app.agentUnread.count, 0);
    });

    test('answering it takes the mark away', () async {
      await question('a1');
      await answered('a1');

      expect(app.agentUnread.count, 0);
      expect(app.agentUnread.kindFor('m', 'a1'), isNull);
    });

    test('answering clears it even when the turn ended first', () async {
      // A raw turn end can beat the question close. Only the matching close
      // clears the question and its unread mark.
      await question('a1');
      expect(app.agentUnread.count, 1);

      await app.handleEventForTest('m', {
        'type': 'turn_ended',
        'agentId': 'a1',
      });
      await answered('a1'); // …and the close lands after

      expect(app.agentUnread.count, 0, reason: 'answered is answered');
    });

    test('answering clears it when the close arrives first', () async {
      await question('a1');
      await answered('a1');
      expect(app.agentUnread.count, 0);
    });

    test('a stale close does not wipe the question that replaced it', () async {
      // A dialog advancing to its next page closes one request and opens the
      // next; the close for the old one must not take the new one with it.
      await question('a1');
      await app.handleEventForTest('m', {
        'type': 'commander_question_close',
        'agentId': 'a1',
        'payload': <String, dynamic>{'requestId': 'some-older-request'},
      });

      expect(app.agentUnread.count, 1);
    });

    test(
      'redelivering an old question close cannot erase a newer result',
      () async {
        await question('a1');
        await answered('a1');
        await completed('a1');
        await answered('a1');
        expect(app.agentUnread.kindFor('m', 'a1'), AlertKind.done);
      },
    );

    test('the turn that ends WITH the answer is not news', () async {
      // Answering can also produce a raw stop. That stop is not fresh news.
      await question('a1');
      await app.handleEventForTest('m', {
        'type': 'turn_ended',
        'agentId': 'a1',
      });
      expect(app.agentUnread.kindFor('m', 'a1'), AlertKind.needsYou);

      await answered('a1');
      expect(app.agentUnread.count, 0);
    });
  });

  // The `foreground` flag on the roster is asserted where it is READ, in
  // cli/src/localWsServer.spec.ts: true, false and absent all have to mean
  // something, and the roster itself goes out through the pool rather than
  // through `_conn`, which a fake connection cannot stand in for.
  group('what this window tells the daemon', () {
    late _Conn conn;
    late AppNotifier wired;

    setUp(() {
      conn = _Conn();
      wired = createApp(connectionForTest: (_) => conn)
        ..watchedAgents = () => const [];
    });
    tearDown(() => wired.dispose());

    test(
      'looking at a marked harness is announced, so the dial drops its row',
      () async {
        await wired.handleEventForTest('m', {
          'type': 'turn_summary',
          'agentId': 'a1',
          'payload': <String, dynamic>{
            'notification': {'id': 'wired-result', 'kind': 'done'},
          },
        });
        expect(wired.agentUnread.count, 1);
        final token = wired.agentUnread.readTokenFor('m', 'a1');

        wired.markAgentSeen('m', 'a1');
        await Future<void>.delayed(Duration.zero);

        expect(wired.agentUnread.count, 0);
        expect(
          conn.sent.where((f) => f.type == 'agent_seen').map((f) => f.payload),
          [
            {'agentId': 'a1', 'readToken': token},
          ],
        );
      },
    );

    test('a harness with nothing unread is not announced', () async {
      // An ordinary tab switch must not put a frame on every socket.
      wired.markAgentSeen('m', 'a1');
      await Future<void>.delayed(Duration.zero);

      expect(conn.sent.where((f) => f.type == 'agent_seen'), isEmpty);
    });
  });
}
