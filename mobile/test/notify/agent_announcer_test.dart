import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:harness_mobile/core/last_opened_agent.dart';
import 'package:harness_mobile/notify/agent_announcer.dart';
import 'package:harness_mobile/notify/agent_notice.dart';
import 'package:harness_mobile/notify/system_notices.dart';

class _RecordingNotices implements SystemNotices {
  final shown = <AgentNoticeMessage>[];
  final cancelled = <AgentRef>[];

  @override
  final opened = ValueNotifier<AgentRef?>(null);

  @override
  Future<void> requestPermission() async {}

  @override
  Future<void> show(AgentNoticeMessage message) async => shown.add(message);

  @override
  Future<void> cancel(AgentRef agent) async => cancelled.add(agent);
}

void main() {
  const ref = (machineId: 'm', agentId: 'a');
  const agent = (ref: ref, name: 'Fix login', machine: 'MacBook');
  const news = (
    aborted: false,
    replay: false,
    subagent: false,
    reply: 'Looked at the form.\n\nFixed the login screen and pushed.',
  );

  late _RecordingNotices system;
  late int chimes;
  late bool front;
  late AgentAnnouncer announcer;

  setUp(() {
    system = _RecordingNotices();
    chimes = 0;
    front = true;
    announcer = AgentAnnouncer(
      system: system,
      chime: () async => chimes++,
      inFront: () => front,
    );
    addTearDown(announcer.dispose);
  });

  test('watching: a chime, no mark, no notice', () {
    final notice = announcer.turnEnded(agent, news, watching: () => true);

    expect(notice, AgentNotice.chime);
    expect(chimes, 1);
    expect(announcer.unread.count, 0);
    expect(system.shown, isEmpty);
  });

  test('elsewhere in the app: a chime and a mark, no notice', () {
    announcer.turnEnded(agent, news, watching: () => false);

    expect(chimes, 1);
    expect(announcer.unread.contains(ref), isTrue);
    expect(system.shown, isEmpty);
  });

  test(
    'away: a mark and one notice naming the agent, its machine, its news',
    () {
      front = false;
      announcer.turnEnded(agent, news, watching: () => true);

      expect(chimes, 0, reason: 'nobody is holding a backgrounded app');
      expect(announcer.unread.contains(ref), isTrue);
      expect(system.shown, hasLength(1));
      final shown = system.shown.single;
      expect(shown.agent, ref);
      expect(shown.title, 'Fix login');
      expect(shown.machine, 'MacBook');
      expect(shown.body, 'Fixed the login screen and pushed.');
    },
  );

  test('a sub-agent turn does nothing at all, even away', () {
    front = false;
    announcer.turnEnded(agent, (
      aborted: false,
      replay: false,
      subagent: true,
      reply: 'x',
    ), watching: () => false);

    expect(chimes, 0);
    expect(announcer.unread.count, 0);
    expect(system.shown, isEmpty);
  });

  test('an agent is one mark however many turns it finished', () {
    announcer.turnEnded(agent, news, watching: () => false);
    announcer.turnEnded(agent, news, watching: () => false);

    expect(announcer.unread.count, 1);
    announcer.unread.clear(ref);
    expect(announcer.unread.count, 0);
  });

  group('questions', () {
    AgentNotice ask({String id = 'q1', bool watching = false}) =>
        announcer.questionAsked(
          agent,
          requestId: id,
          prompt: 'Which database?',
          watching: () => watching,
        );

    test('a new question elsewhere: a chime and a question mark', () {
      expect(ask(), AgentNotice.mark);
      expect(chimes, 1);
      expect(announcer.unread.kindFor(ref), NoticeKind.question);
      expect(announcer.unread.anyQuestion, isTrue);
    });

    test('the same question heard again is not news', () {
      ask();
      expect(ask(), AgentNotice.none);
      expect(chimes, 1);
    });

    test('the dialog moving to its next page is a new question', () {
      ask();
      expect(ask(id: 'q2'), AgentNotice.mark);
    });

    test('away: one notice, of the question kind, saying the question', () {
      front = false;
      ask();
      final shown = system.shown.single;
      expect(shown.kind, NoticeKind.question);
      expect(shown.body, 'Which database?');
    });

    test('answered elsewhere: its mark and its notice come down', () {
      front = false;
      ask();
      announcer.questionClosed(ref, requestId: 'q1');
      expect(announcer.unread.contains(ref), isFalse);
      expect(system.cancelled, [ref]);
    });

    test('a stale close leaves the question that replaced it', () {
      ask();
      ask(id: 'q2');
      announcer.questionClosed(ref, requestId: 'q1');
      expect(announcer.unread.kindFor(ref), NoticeKind.question);
      expect(system.cancelled, isEmpty);
    });

    test('a close never takes down a finished turn\'s mark', () {
      announcer.turnEnded(agent, news, watching: () => false);
      announcer.questionClosed(ref);
      expect(announcer.unread.kindFor(ref), NoticeKind.done);
    });

    test('the question after a finish is the mark that stands', () {
      announcer.turnEnded(agent, news, watching: () => false);
      ask();
      expect(announcer.unread.kindFor(ref), NoticeKind.question);
    });

    test('its turn ending with nothing to say takes the question down', () {
      ask();
      announcer.turnEnded(agent, (
        aborted: false,
        replay: false,
        subagent: false,
        reply: null,
      ), watching: () => false);
      expect(announcer.unread.contains(ref), isFalse);
      expect(ask(), AgentNotice.mark, reason: 'a new turn may ask it again');
    });

    test('a deleted agent takes its mark and its notice with it', () {
      front = false;
      ask();
      announcer.forgetAgent(ref);
      expect(announcer.unread.contains(ref), isFalse);
      expect(system.cancelled, [ref]);
    });
  });

  group('noticeBody', () {
    test('keeps the last paragraph, on one line', () {
      expect(noticeBody('a\n\nb  c\nd'), 'b c d');
    });

    test('cuts a long reply with an ellipsis', () {
      final body = noticeBody('x' * 400, limit: 20);
      expect(body.length, 20);
      expect(body.endsWith('…'), isTrue);
    });
  });
}
