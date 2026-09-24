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
import 'package:harness/notify/alert_sounds.dart';
import 'package:harness/state/app_state.dart';
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

  Future<void> turnEnded(String agentId, {bool? subagent}) =>
      app.handleEventForTest('m', {
        'type': 'turn_ended',
        'agentId': agentId,
        if (subagent != null) 'subagent': subagent,
        'payload': <String, dynamic>{},
      });

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

  group('a sub-agent is not news on either screen', () {
    test('an ordinary turn end is counted', () async {
      await turnEnded('a1');
      expect(app.agentUnread.count, 1);
    });

    test('a sub-agent turn end is not', () async {
      await turnEnded('a1', subagent: true);
      expect(app.agentUnread.count, 0);
      expect(app.agentUnread.kindFor('m', 'a1'), isNull);
    });

    test('an Orchestrator project rings once, not once per specialist', () async {
      // Four specialists and a Director that is still busy: the dial draws ONE
      // row, for the wrap-up. This used to be five marks here.
      for (final worker in ['w1', 'w2', 'w3', 'w4']) {
        await turnEnded(worker, subagent: true);
      }
      await turnEnded('director', subagent: true); // still busy
      expect(app.agentUnread.count, 0);

      await turnEnded('director'); // the wrap-up
      expect(app.agentUnread.count, 1);
    });

    test('a daemon that does not say is a daemon that did not know', () async {
      // Absent field, not false: every build before this one sent nothing, and
      // reading absence as "sub-agent" would swallow every turn they report.
      await turnEnded('a1');
      expect(app.agentUnread.count, 1);
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
      await turnEnded('a1');

      expect(app.agentUnread.count, 0);
    });

    test('answering it takes the mark away', () async {
      await question('a1');
      await answered('a1');

      expect(app.agentUnread.count, 0);
      expect(app.agentUnread.kindFor('m', 'a1'), isNull);
    });

    test('answering clears it even when the turn ended first', () async {
      // Answering makes the turn end too, and the two frames race. `turn_ended`
      // runs `_cancelTurnActivity`, which clears `blockedAgents` on the way
      // past — so a close that arrives second finds no open dialog. The mark is
      // the close's to take either way; hanging it off the dialog bookkeeping
      // left it stranded whenever that order came up.
      await question('a1');
      expect(app.agentUnread.count, 1);

      await turnEnded('a1'); // the turn closes first…
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

    test('the turn that ends WITH the answer is not news', () async {
      // Measured on the real thing: answering ends the turn, and the two frames
      // land a millisecond apart with the turn first. So `done` overwrites the
      // question mark and the badge never goes down — while the person is
      // standing right over that agent, having just answered it.
      await question('a1');
      await turnEnded('a1');
      expect(app.agentUnread.kindFor('m', 'a1'), AlertKind.done);

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
          'type': 'turn_ended',
          'agentId': 'a1',
          'payload': <String, dynamic>{},
        });
        expect(wired.agentUnread.count, 1);

        wired.markAgentSeen('m', 'a1');
        await Future<void>.delayed(Duration.zero);

        expect(wired.agentUnread.count, 0);
        expect(
          conn.sent.where((f) => f.type == 'agent_seen').map((f) => f.payload),
          [
            {'agentId': 'a1'},
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
