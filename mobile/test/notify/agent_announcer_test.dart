import 'package:fake_async/fake_async.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:harness_mobile/core/last_opened_agent.dart';
import 'package:harness_mobile/notify/agent_announcer.dart';
import 'package:harness_mobile/notify/agent_notice.dart';
import 'package:harness_mobile/notify/done_notice.dart';
import 'package:harness_mobile/notify/system_notices.dart';

class _RecordingNotices implements SystemNotices {
  final shown = <AgentNoticeMessage>[];
  final cancelled = <AgentRef>[];

  @override
  final opened = ValueNotifier<AgentRef?>(null);

  @override
  final openedDevice = ValueNotifier<String?>(null);

  @override
  Future<bool?> requestPermission() async => null;

  @override
  Future<void> show(AgentNoticeMessage message) async => shown.add(message);

  @override
  Future<void> cancel(AgentRef agent) async => cancelled.add(agent);

  @override
  Future<void> showAccountNotice({required String key, required String title, required String body}) async {}
}

void main() {
  const ref = (machineId: 'm', agentId: 'a');
  const agent = (ref: ref, name: 'Fix login', machine: 'MacBook');
  const news = (
    aborted: false,
    replay: false,
    subagent: false,
    reply: 'Looked at the form.\n\nFixed the login screen and pushed.',
    tier: null,
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

  test('elsewhere in the app: a chime, a mark and the notice, the banner over the app', () {
    announcer.turnEnded(agent, news, watching: () => false);

    expect(chimes, 1);
    expect(announcer.unread.contains(ref), isTrue);
    expect(system.shown, hasLength(1));
    expect(system.shown.single.agent, ref);
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
      tier: null,
    ), watching: () => false);

    expect(chimes, 0);
    expect(announcer.unread.count, 0);
    expect(system.shown, isEmpty);
  });

  group('with the daemon\'s tier', () {
    TurnEnd tiered(NoticeTier tier) => (
      aborted: news.aborted,
      replay: news.replay,
      subagent: news.subagent,
      reply: news.reply,
      tier: tier,
    );

    test('list, away: the agent is marked, no notice is posted', () {
      front = false;
      final notice = announcer.turnEnded(
        agent,
        tiered(NoticeTier.list),
        watching: () => false,
      );

      expect(notice, AgentNotice.filed);
      expect(chimes, 0);
      expect(announcer.unread.kindFor(ref), NoticeKind.done);
      expect(system.shown, isEmpty);
    });

    test('list, elsewhere in the app: a mark with no tap', () {
      announcer.turnEnded(agent, tiered(NoticeTier.list), watching: () => false);

      expect(chimes, 0);
      expect(announcer.unread.contains(ref), isTrue);
      expect(system.shown, isEmpty);
    });

    test('alert, away: a mark and the notice', () {
      front = false;
      announcer.turnEnded(agent, tiered(NoticeTier.alert), watching: () => false);

      expect(announcer.unread.contains(ref), isTrue);
      expect(system.shown, hasLength(1));
      expect(system.shown.single.body, 'Fixed the login screen and pushed.');
    });

    test('alert, on the agent being watched: nothing at all', () {
      announcer.turnEnded(agent, tiered(NoticeTier.alert), watching: () => true);

      expect(chimes, 0);
      expect(announcer.unread.count, 0);
      expect(system.shown, isEmpty);
    });

    test('silent, away: nothing at all', () {
      front = false;
      announcer.turnEnded(agent, tiered(NoticeTier.silent), watching: () => false);

      expect(chimes, 0);
      expect(announcer.unread.count, 0);
      expect(system.shown, isEmpty);
    });

    test('a list turn still takes down the question its turn asked', () {
      announcer.questionAsked(
        agent,
        requestId: 'q1',
        prompt: 'Which branch?',
        watching: () => false,
      );
      announcer.turnEnded(agent, tiered(NoticeTier.list), watching: () => false);

      expect(announcer.unread.kindFor(ref), NoticeKind.done);
    });
  });

  group('waiting for the daemon\'s tier', () {
    const wait = Duration(seconds: 4);

    /// The announcer under fake time, so the wait for a tier runs out on
    /// command. Built inside [body]'s zone, as its timer must be.
    void inFakeTime(void Function(FakeAsync time, AgentAnnouncer a) body) {
      fakeAsync((time) {
        final a = AgentAnnouncer(
          system: system,
          chime: () async => chimes++,
          inFront: () => front,
          tierWait: wait,
        );
        body(time, a);
        a.dispose();
      });
    }

    test('a turn\'s end waits for its tier, and goes by it', () {
      inFakeTime((time, a) {
        front = false;
        a.turnEndedAwaitingTier(agent, news, watching: () => false);
        expect(a.unread.count, 0);
        expect(system.shown, isEmpty);
        expect(a.tierDecided(ref, NoticeTier.list), AgentNotice.filed);
        expect(a.unread.kindFor(ref), NoticeKind.done);
        expect(system.shown, isEmpty, reason: 'a list entry is no notice');
        time.elapse(wait * 2);
        expect(system.shown, isEmpty, reason: 'told once');
      });
    });

    test('an older daemon\'s recap, with no tier, goes by the old rule at once', () {
      inFakeTime((time, a) {
        front = false;
        a.turnEndedAwaitingTier(agent, news, watching: () => false);
        expect(a.tierDecided(ref, null), AgentNotice.alert);
        expect(system.shown, hasLength(1));
      });
    });

    test('a tier that never comes: the old rule once the wait runs out', () {
      inFakeTime((time, a) {
        front = false;
        a.turnEndedAwaitingTier(agent, news, watching: () => false);
        time.elapse(wait - const Duration(milliseconds: 1));
        expect(system.shown, isEmpty);
        time.elapse(const Duration(milliseconds: 1));
        expect(system.shown, hasLength(1));
        expect(a.tierDecided(ref, NoticeTier.alert), isNull, reason: 'nothing waits any more');
      });
    });

    test('reads where the person is when it goes, not when the turn ended', () {
      inFakeTime((time, a) {
        front = false;
        a.turnEndedAwaitingTier(agent, news, watching: () => true);
        front = true;
        expect(a.tierDecided(ref, NoticeTier.alert), AgentNotice.none);
        expect(chimes, 0);
        expect(system.shown, isEmpty);
      });
    });

    test('an end that is not news waits for nothing, and a recap for it does nothing', () {
      inFakeTime((time, a) {
        front = false;
        a.turnEndedAwaitingTier(agent, (
          aborted: false,
          replay: false,
          subagent: true,
          reply: 'x',
          tier: null,
        ), watching: () => false);
        expect(a.tierDecided(ref, NoticeTier.alert), isNull);
        time.elapse(wait * 2);
        expect(a.unread.count, 0);
        expect(system.shown, isEmpty);
      });
    });

    test('a question asked while it waits is what stands: no "done" over it', () {
      inFakeTime((time, a) {
        front = false;
        a.turnEndedAwaitingTier(agent, news, watching: () => false);
        a.questionAsked(
          agent,
          requestId: 'q1',
          prompt: 'Which branch?',
          watching: () => false,
        );
        expect(a.tierDecided(ref, NoticeTier.alert), AgentNotice.none);
        expect(a.unread.kindFor(ref), NoticeKind.question);
        expect(system.shown.map((m) => m.kind), [NoticeKind.question]);
      });
    });

    test('the turn\'s end takes down the question it asked in, at once', () {
      inFakeTime((time, a) {
        a.questionAsked(
          agent,
          requestId: 'q1',
          prompt: 'Which branch?',
          watching: () => false,
        );
        a.turnEndedAwaitingTier(agent, news, watching: () => false);
        expect(a.unread.contains(ref), isFalse);
      });
    });

    test('going to the agent while it waits: nothing is announced after', () {
      inFakeTime((time, a) {
        front = false;
        a.turnEndedAwaitingTier(agent, news, watching: () => false);
        a.seen(ref);
        time.elapse(wait * 2);
        expect(a.tierDecided(ref, NoticeTier.alert), isNull);
        expect(system.shown, isEmpty);
      });
    });

    test('a newer end replaces the one waiting, and is told once', () {
      inFakeTime((time, a) {
        front = false;
        a.turnEndedAwaitingTier(agent, news, watching: () => false);
        time.elapse(wait ~/ 2);
        a.turnEndedAwaitingTier(agent, (
          aborted: false,
          replay: false,
          subagent: false,
          reply: 'Second answer.',
          tier: null,
        ), watching: () => false);
        time.elapse(wait ~/ 2);
        expect(system.shown, isEmpty, reason: 'the first one\'s wait was dropped');
        time.elapse(wait);
        expect(system.shown.map((m) => m.body), ['Second answer.']);
      });
    });

    test('signing out or going away drops every turn still waiting', () {
      inFakeTime((time, a) {
        front = false;
        a.turnEndedAwaitingTier(agent, news, watching: () => false);
        a.reset();
        time.elapse(wait * 2);
        expect(system.shown, isEmpty);
        a.turnEndedAwaitingTier(agent, news, watching: () => false);
      });
      // [inFakeTime] disposed it with that turn still waiting: no timer outlives it.
      expect(system.shown, isEmpty);
    });
  });

  test('an agent is one mark however many turns it finished', () {
    announcer.turnEnded(agent, news, watching: () => false);
    announcer.turnEnded(agent, news, watching: () => false);

    expect(announcer.unread.count, 1);
    announcer.unread.clear(ref);
    expect(announcer.unread.count, 0);
  });

  group('going to the agent', () {
    test('takes down its mark and the notice still in the OS centre', () {
      front = false;
      announcer.turnEnded(agent, news, watching: () => false);
      front = true;
      announcer.seen(ref);
      expect(announcer.unread.contains(ref), isFalse);
      expect(system.cancelled, [ref]);
    });

    test('never asks the OS to cancel a notice it did not post', () {
      // A `list` turn: marked, and no notice posted.
      announcer.turnEnded(agent, (
        aborted: false,
        replay: false,
        subagent: false,
        reply: news.reply,
        tier: NoticeTier.list,
      ), watching: () => false);
      expect(system.shown, isEmpty);
      announcer.seen(ref);
      expect(announcer.unread.contains(ref), isFalse);
      expect(system.cancelled, isEmpty);
    });

    test('a notice is taken down once, not every time the agent is seen', () {
      front = false;
      announcer.turnEnded(agent, news, watching: () => false);
      announcer
        ..seen(ref)
        ..seen(ref);
      expect(system.cancelled, [ref]);
    });

    test('signing out takes every posted notice down', () {
      front = false;
      announcer.turnEnded(agent, news, watching: () => false);
      announcer.reset();
      expect(system.cancelled, [ref]);
      expect(announcer.unread.count, 0);
    });
  });

  group('questions', () {
    AgentNotice ask({String id = 'q1', bool watching = false}) =>
        announcer.questionAsked(
          agent,
          requestId: id,
          prompt: 'Which database?',
          watching: () => watching,
        );

    test('one answered while the phone was away goes, mark and notice; one still open stays', () {
      const other = (machineId: 'm', agentId: 'b');
      const elsewhere = (machineId: 'm2', agentId: 'a');
      front = false;
      ask();
      announcer.questionAsked(
        (ref: other, name: 'Other', machine: 'MacBook'),
        requestId: 'q2',
        prompt: 'Which branch?',
        watching: () => false,
      );
      announcer.questionAsked(
        (ref: elsewhere, name: 'Far', machine: 'Mini'),
        requestId: 'q3',
        prompt: 'Merge?',
        watching: () => false,
      );
      announcer.questionsOpen('m', {'q2'});
      expect(announcer.unread.contains(ref), isFalse);
      expect(system.cancelled, [ref]);
      expect(announcer.unread.kindFor(other), NoticeKind.question);
      expect(announcer.unread.kindFor(elsewhere), NoticeKind.question, reason: 'another machine said nothing of it');
      // Heard again later, it is news again: it is a question asked anew.
      expect(ask(), AgentNotice.alert);
    });

    test('an open list leaves a finished turn\'s mark alone', () {
      announcer.turnEnded(agent, news, watching: () => false);
      announcer.questionsOpen('m', {});
      expect(announcer.unread.kindFor(ref), NoticeKind.done);
    });

    test('a new question elsewhere: a chime, a question mark and the banner over the app', () {
      expect(ask(), AgentNotice.alert);
      expect(chimes, 1);
      expect(announcer.unread.kindFor(ref), NoticeKind.question);
      expect(announcer.unread.anyQuestion, isTrue);
      expect(system.shown.single.kind, NoticeKind.question);
    });

    test('the same question heard again is not news', () {
      ask();
      expect(ask(), AgentNotice.none);
      expect(chimes, 1);
    });

    test('the dialog moving to its next page is a new question', () {
      ask();
      expect(ask(id: 'q2'), AgentNotice.alert);
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
        tier: null,
      ), watching: () => false);
      expect(announcer.unread.contains(ref), isFalse);
      expect(ask(), AgentNotice.alert, reason: 'a new turn may ask it again');
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

    test('never cuts an emoji in half', () {
      // 🎉 is two UTF-16 units. Cut between them, the lock screen got a lone
      // surrogate — which the platform channel's UTF-8 encoding turns into
      // U+FFFD, a `�` in front of the ellipsis.
      final body = noticeBody('${'x' * 18}🎉 and the rest', limit: 20);
      expect(body, '${'x' * 18}…');
      expect(
        body.codeUnits.any((unit) => unit >= 0xD800 && unit <= 0xDFFF),
        isFalse,
      );
      // An emoji that fits whole is kept whole.
      expect(noticeBody('${'x' * 17}🎉 and more', limit: 20), '${'x' * 17}🎉…');
    });

    test('a reply that is only whitespace says nothing', () {
      expect(noticeBody(' \n\n  \t'), '');
    });

    test('a question is one line already, and is said as asked', () {
      expect(
        noticeBody('Approve Bash command: psql -f migrate.sql'),
        'Approve Bash command: psql -f migrate.sql',
      );
    });
  });
}
