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
      // Told at once, so each rule here is read on its own; the wait is
      // pinned under fake time below ('a question in front').
      questionGrace: Duration.zero,
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

  test('a finished turn sounds once until the person goes to the agent; '
      'the next only replaces it quietly (task #3248)', () {
    front = false;
    const other = (ref: (machineId: 'm', agentId: 'b'), name: 'Docs', machine: 'MacBook');
    announcer.turnEnded(agent, news, watching: () => false);
    announcer.turnEnded(agent, news, watching: () => false);
    announcer.turnEnded(other, news, watching: () => false);
    expect([for (final n in system.shown) (n.agent.agentId, n.quiet)], [('a', false), ('a', true), ('b', false)]);

    announcer.seen(ref);
    announcer.turnEnded(agent, news, watching: () => false);
    expect(system.shown.last.quiet, isFalse, reason: 'seen: the next is news again');
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
      // Heard again later it is open again, and posted again — but the person
      // was told of this very request already: no second buzz.
      expect(ask(), AgentNotice.quiet);
      expect(announcer.unread.kindFor(ref), NoticeKind.question);
      expect(system.shown.last.quiet, isTrue);
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

    test('the dialog moving to its next page is a new question, posted without a second buzz', () {
      ask();
      expect(ask(id: 'q2'), AgentNotice.quiet, reason: 'the agent buzzed a moment ago');
      expect(chimes, 1);
      expect(announcer.unread.kindFor(ref), NoticeKind.question);
      expect(system.shown.map((m) => m.quiet), [false, true]);
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
      expect(
        ask(),
        AgentNotice.quiet,
        reason: 'a new turn may ask it again: marked and posted, but this very dialog buzzed moments ago',
      );
      expect(announcer.unread.kindFor(ref), NoticeKind.question);
    });

    test('a deleted agent takes its mark and its notice with it', () {
      front = false;
      ask();
      announcer.forgetAgent(ref);
      expect(announcer.unread.contains(ref), isFalse);
      expect(system.cancelled, [ref]);
    });
  });

  // 2026-11-05: a Team machine's approvals ("Approve Bash command: …"), each
  // answered at its desk in seconds, and dialogs flickering off the pane and
  // on, buzzed a phone over and over. Three rules keep the first question that
  // really waits on the person, and drop the rest.
  group('a question in front: waits out its grace, buzzes once', () {
    const grace = Duration(seconds: 15);
    const cooldown = Duration(minutes: 5);
    const reopen = Duration(minutes: 10);
    final start = DateTime(2026, 11, 5, 12);
    const other = (machineId: 'm', agentId: 'b');
    const otherAgent = (ref: other, name: 'Other', machine: 'MacBook');

    /// The announcer under fake time and a clock that follows it, built
    /// inside [body]'s zone as its timers must be.
    void inFakeTime(void Function(FakeAsync time, AgentAnnouncer a) body) {
      fakeAsync((time) {
        final a = AgentAnnouncer(
          system: system,
          chime: () async => chimes++,
          inFront: () => front,
          questionGrace: grace,
          alertCooldown: cooldown,
          reopenWindow: reopen,
          now: () => start.add(time.elapsed),
        );
        body(time, a);
        a.dispose();
      });
    }

    AgentNotice ask(
      AgentAnnouncer a, {
      String id = 'q1',
      NoticeAgent who = agent,
      bool watching = false,
    }) => a.questionAsked(
      who,
      requestId: id,
      prompt: 'Approve Bash command: npm test',
      watching: () => watching,
    );

    List<bool> quietness() => [for (final m in system.shown) m.quiet];

    test('marked at once; it buzzes only once its grace runs out, still open', () {
      inFakeTime((time, a) {
        expect(ask(a), AgentNotice.filed);
        expect(a.unread.kindFor(ref), NoticeKind.question);
        expect(system.shown, isEmpty);
        expect(chimes, 0);
        time.elapse(grace - const Duration(milliseconds: 1));
        expect(system.shown, isEmpty);
        time.elapse(const Duration(milliseconds: 1));
        expect(quietness(), [false]);
        expect(system.shown.single.body, 'Approve Bash command: npm test');
        expect(chimes, 1);
      });
    });

    test('answered within its grace — at the desk, by an auto mode — it never buzzes', () {
      inFakeTime((time, a) {
        ask(a);
        time.elapse(const Duration(seconds: 3));
        a.questionClosed(ref, requestId: 'q1');
        time.elapse(grace * 2);
        expect(system.shown, isEmpty);
        expect(chimes, 0);
        expect(a.unread.contains(ref), isFalse);
      });
    });

    test('a run of approvals answered at the desk in seconds: nothing at all', () {
      inFakeTime((time, a) {
        for (var i = 0; i < 10; i++) {
          ask(a, id: 'q$i');
          time.elapse(const Duration(seconds: 2));
          a.questionClosed(ref, requestId: 'q$i');
        }
        time.elapse(grace * 2);
        expect(system.shown, isEmpty);
        expect(chimes, 0);
      });
    });

    test('a newer question replaces the one waiting, and is the one told, once', () {
      inFakeTime((time, a) {
        ask(a);
        time.elapse(const Duration(seconds: 5));
        expect(ask(a, id: 'q2'), AgentNotice.filed);
        time.elapse(const Duration(seconds: 10));
        expect(system.shown, isEmpty, reason: 'the first one\'s wait was dropped');
        time.elapse(const Duration(seconds: 5));
        expect(quietness(), [false]);
        time.elapse(grace * 2);
        expect(system.shown, hasLength(1));
      });
    });

    test('a dialog flickering off the pane buzzes once, then is only posted again quietly', () {
      inFakeTime((time, a) {
        ask(a);
        time.elapse(grace);
        expect(quietness(), [false]);
        for (var i = 0; i < 5; i++) {
          a.questionClosed(ref, requestId: 'q1');
          expect(a.unread.contains(ref), isFalse);
          time.elapse(const Duration(milliseconds: 1500));
          expect(ask(a), AgentNotice.quiet);
          expect(a.unread.kindFor(ref), NoticeKind.question, reason: 'it is open again');
          time.elapse(const Duration(seconds: 5));
        }
        expect(chimes, 1);
        expect(quietness(), [false, true, true, true, true, true]);
      });
    });

    test('a dialog flickering through its grace still buzzes, once, when the grace runs out', () {
      inFakeTime((time, a) {
        // Off the pane for 1.5 s every 4.5 s: each close drops the wait, and
        // each return resumes it rather than starting it over.
        ask(a);
        for (var i = 0; i < 3; i++) {
          time.elapse(const Duration(seconds: 3));
          a.questionClosed(ref, requestId: 'q1');
          time.elapse(const Duration(milliseconds: 1500));
          expect(ask(a), AgentNotice.filed);
        }
        expect(system.shown, isEmpty);
        time.elapse(const Duration(milliseconds: 1500));
        expect(quietness(), [false]);
        a.questionClosed(ref, requestId: 'q1');
        expect(ask(a), AgentNotice.quiet);
        expect(chimes, 1);
      });
    });

    test('one back after its grace ran out while off the pane is told at once', () {
      inFakeTime((time, a) {
        ask(a);
        time.elapse(const Duration(seconds: 3));
        a.questionClosed(ref, requestId: 'q1');
        time.elapse(grace);
        expect(ask(a), AgentNotice.alert);
        expect(quietness(), [false]);
      });
    });

    test('another question of the agent within the cooldown is posted quietly; after it, it buzzes again', () {
      inFakeTime((time, a) {
        ask(a);
        time.elapse(grace);
        a.questionClosed(ref, requestId: 'q1');
        ask(a, id: 'q2');
        time.elapse(grace);
        expect(quietness(), [false, true]);
        expect(chimes, 1);
        expect(a.unread.kindFor(ref), NoticeKind.question);
        time.elapse(cooldown);
        a.questionClosed(ref, requestId: 'q2');
        ask(a, id: 'q3');
        time.elapse(grace);
        expect(quietness(), [false, true, false]);
        expect(chimes, 2);
      });
    });

    test('going to the agent ends its cooldown: its next question buzzes', () {
      inFakeTime((time, a) {
        ask(a);
        time.elapse(grace);
        // The person opens the agent and answers there, then leaves its pane.
        a.seen(ref);
        a.questionClosed(ref, requestId: 'q1');
        ask(a, id: 'q2');
        time.elapse(grace);
        expect(quietness(), [false, false]);
        expect(chimes, 2);
      });
    });

    test('the cooldown is the agent\'s own: another agent still buzzes', () {
      inFakeTime((time, a) {
        ask(a);
        ask(a, who: otherAgent);
        time.elapse(grace);
        expect(quietness(), [false, false]);
        expect(system.shown.map((m) => m.agent), [ref, other]);
        expect(chimes, 2);
      });
    });

    test('the same dialog asked again after the reopen window is news again', () {
      inFakeTime((time, a) {
        ask(a);
        time.elapse(grace);
        a.questionClosed(ref, requestId: 'q1');
        time.elapse(reopen + const Duration(seconds: 1));
        expect(ask(a), AgentNotice.filed);
        time.elapse(grace);
        expect(quietness(), [false, false]);
        expect(chimes, 2);
      });
    });

    test('a question open longer than the window is still the same one when it flickers', () {
      inFakeTime((time, a) {
        ask(a);
        time.elapse(grace);
        time.elapse(reopen * 2);
        // Another agent's question is what forgets old ones.
        ask(a, who: otherAgent);
        a.questionClosed(ref, requestId: 'q1');
        expect(ask(a), AgentNotice.quiet);
      });
    });

    test('going to the agent within its grace: no buzz after, and it counts as told', () {
      inFakeTime((time, a) {
        ask(a);
        time.elapse(const Duration(seconds: 5));
        a.seen(ref);
        time.elapse(grace * 2);
        expect(system.shown, isEmpty);
        expect(chimes, 0);
        expect(a.unread.contains(ref), isFalse);
        // Its dialog flickers afterwards: never a buzz for what was seen.
        a.questionClosed(ref, requestId: 'q1');
        expect(ask(a), AgentNotice.quiet);
        expect(chimes, 0);
      });
    });

    test('going away within its grace: told at once, while there is time to post it', () {
      inFakeTime((time, a) {
        ask(a);
        time.elapse(const Duration(seconds: 2));
        front = false;
        a.wentAway();
        expect(quietness(), [false]);
        expect(system.shown.single.kind, NoticeKind.question);
        time.elapse(grace * 2);
        expect(system.shown, hasLength(1), reason: 'told once');
      });
    });

    test('going away with nothing waiting does nothing', () {
      inFakeTime((time, a) {
        front = false;
        a.wentAway();
        expect(system.shown, isEmpty);
      });
    });

    test('away: no wait at all', () {
      inFakeTime((time, a) {
        front = false;
        expect(ask(a), AgentNotice.alert);
        expect(quietness(), [false]);
        time.elapse(grace * 2);
        expect(system.shown, hasLength(1));
      });
    });

    test('away, a run of approvals: one buzz, then quiet updates of the same notice', () {
      inFakeTime((time, a) {
        front = false;
        for (var i = 0; i < 4; i++) {
          ask(a, id: 'q$i');
          a.questionClosed(ref, requestId: 'q$i');
          time.elapse(const Duration(seconds: 20));
        }
        expect(quietness(), [false, true, true, true]);
      });
    });

    test('on the agent: a chime at once, with no wait and no notice', () {
      inFakeTime((time, a) {
        expect(ask(a, watching: true), AgentNotice.chime);
        expect(chimes, 1);
        time.elapse(grace * 2);
        expect(system.shown, isEmpty);
        expect(a.unread.count, 0);
      });
    });

    test('a deleted agent forgets what it was told: its next question buzzes', () {
      inFakeTime((time, a) {
        ask(a);
        time.elapse(grace);
        a.forgetAgent(ref);
        expect(ask(a), AgentNotice.filed);
        time.elapse(grace);
        expect(quietness(), [false, false]);
      });
    });

    test('signing out drops a question still waiting, and what was told', () {
      inFakeTime((time, a) {
        ask(a);
        a.reset();
        time.elapse(grace * 2);
        expect(system.shown, isEmpty);
        expect(a.unread.count, 0);
      });
    });

    test('disposing leaves no timer behind', () {
      fakeAsync((time) {
        final a = AgentAnnouncer(
          system: system,
          inFront: () => true,
          now: () => start.add(time.elapsed),
        );
        a.questionAsked(agent, requestId: 'q1', prompt: 'x', watching: () => false);
        expect(time.pendingTimers, hasLength(1));
        a.dispose();
        expect(time.pendingTimers, isEmpty);
      });
    });
  });

  group('a Harness Team account\'s agents (2026-11-05: Dee\'s phone buzzed for a teammate\'s tester)', () {
    const teamRef = (machineId: 'team-mac', agentId: 't');
    const teamAgent = (ref: teamRef, name: 'Tester 3256', machine: 'Macs-Mac-Studio-2.local · Team');

    late AgentAnnouncer withTeam;

    setUp(() {
      withTeam = AgentAnnouncer(
        system: system,
        chime: () async => chimes++,
        inFront: () => front,
        questionGrace: Duration.zero,
        inTeamAccount: (ref) => ref.machineId == 'team-mac',
      );
      addTearDown(withTeam.dispose);
    });

    test('a turn end says nothing: no chime, no mark, no notice', () {
      front = false;
      final notice = withTeam.turnEnded(teamAgent, news, watching: () => false);

      expect(notice, AgentNotice.none);
      expect(chimes, 0);
      expect(withTeam.unread.count, 0);
      expect(system.shown, isEmpty);
    });

    test('a turn end waiting for its tier says nothing either', () {
      front = false;
      withTeam.turnEndedAwaitingTier(teamAgent, news, watching: () => false);
      final notice = withTeam.tierDecided(teamRef, NoticeTier.alert);

      expect(notice, isNull);
      expect(withTeam.unread.count, 0);
      expect(system.shown, isEmpty);
    });

    test('a question says nothing, in front or away', () {
      for (final away in [true, false]) {
        front = !away;
        final notice = withTeam.questionAsked(
          teamAgent,
          requestId: 'q${away ? 1 : 2}',
          prompt: 'Approve Bash command: git push',
          watching: () => false,
        );
        expect(notice, AgentNotice.none);
      }
      expect(chimes, 0);
      expect(withTeam.unread.count, 0);
      expect(system.shown, isEmpty);
    });

    test('the owner\'s own agent still tells, beside it', () {
      front = false;
      withTeam.turnEnded(teamAgent, news, watching: () => false);
      final notice = withTeam.turnEnded(agent, news, watching: () => false);

      expect(notice, AgentNotice.alert);
      expect(system.shown.map((m) => m.agent), [ref]);
      expect(withTeam.unread.contains(ref), isTrue);
      expect(withTeam.unread.contains(teamRef), isFalse);
    });

    test('with no rule given every agent tells, as before', () {
      front = false;
      final notice = announcer.turnEnded(teamAgent, news, watching: () => false);
      expect(notice, AgentNotice.alert);
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
