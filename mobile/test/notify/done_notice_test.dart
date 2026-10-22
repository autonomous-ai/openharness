import 'package:flutter_test/flutter_test.dart';

import 'package:harness_mobile/notify/agent_notice.dart';
import 'package:harness_mobile/notify/done_notice.dart';

/// The dial's rule for a finished turn — `firmware/main/cable_client.c`,
/// `summary` — as the phone reads it off `turn_ended`.
void main() {
  TurnEnd end({
    bool aborted = false,
    bool replay = false,
    bool subagent = false,
    String? reply = 'Fixed the login screen.',
    NoticeTier? tier,
  }) => (
    aborted: aborted,
    replay: replay,
    subagent: subagent,
    reply: reply,
    tier: tier,
  );

  AgentNotice decide(TurnEnd e, {bool inFront = true, bool watching = false}) =>
      decideDoneNotice(e, inFront: inFront, watching: watching);

  test('a turn that is not news is silent wherever the phone is', () {
    for (final e in [
      end(aborted: true),
      end(replay: true),
      end(subagent: true),
      end(reply: null),
      end(reply: '  \n '),
    ]) {
      for (final inFront in [true, false]) {
        expect(decide(e, inFront: inFront), AgentNotice.none, reason: '$e');
      }
    }
  });

  test('watching the agent: the chime still comes, nothing is filed', () {
    final notice = decide(end(), watching: true);
    expect(notice, AgentNotice.chime);
    expect(notice.marks, isFalse);
    expect(notice.alerts, isFalse);
  });

  test('in front on another agent: marked and noticed, the banner over the app', () {
    final notice = decide(end());
    expect(notice, AgentNotice.alert);
    expect(notice.chimes, isTrue);
    expect(notice.marks, isTrue);
    expect(notice.alerts, isTrue);
  });

  test('away: marked and noticed, whatever was on screen', () {
    for (final watching in [true, false]) {
      final notice = decide(end(), inFront: false, watching: watching);
      expect(notice, AgentNotice.alert);
      expect(notice.marks, isTrue);
    }
  });

  test('an older daemon says none of the flags, and every end is news', () {
    final e = turnEndFrom(
      {'type': 'turn_ended', 'agentId': 'a'},
      <String, dynamic>{},
      reply: 'done',
    );
    expect(e, (
      aborted: false,
      replay: false,
      subagent: false,
      reply: 'done',
      tier: null,
    ));
  });

  test('the flags are read where the daemon puts them', () {
    final e = turnEndFrom(
      {'type': 'turn_ended', 'replay': true, 'subagent': true},
      {'aborted': true},
      reply: null,
    );
    expect(e, (
      aborted: true,
      replay: true,
      subagent: true,
      reply: null,
      tier: null,
    ));
  });

  group('the daemon\'s tier', () {
    test('is never read off turn_ended: the turn_summary after it says it', () {
      final e = turnEndFrom(
        {'type': 'turn_ended', 'agentId': 'a', 'tier': 'alert'},
        {'tier': 'alert'},
        reply: 'done',
      );
      expect(e.tier, isNull);
    });

    test('reads the wire\'s three words', () {
      expect(noticeTierFrom('alert'), NoticeTier.alert);
      expect(noticeTierFrom('list'), NoticeTier.list);
      expect(noticeTierFrom('silent'), NoticeTier.silent);
    });

    test('a word this build does not know reads as no tier at all', () {
      for (final raw in [null, '', 'loud', 'ALERT', 2, true]) {
        expect(noticeTierFrom(raw), isNull, reason: '$raw');
      }
    });

    test('news is what no tier can change: alive, live, the main agent\'s, said something', () {
      expect(isNewsEnd(end()), isTrue);
      for (final e in [
        end(aborted: true),
        end(replay: true),
        end(subagent: true),
        end(reply: null),
        end(reply: ' \n'),
      ]) {
        expect(isNewsEnd(e), isFalse, reason: '$e');
      }
    });

    test('never makes news of a turn the flags say is not news', () {
      for (final tier in NoticeTier.values) {
        for (final e in [
          end(aborted: true, tier: tier),
          end(replay: true, tier: tier),
          end(subagent: true, tier: tier),
          end(reply: null, tier: tier),
          end(reply: '  ', tier: tier),
        ]) {
          for (final inFront in [true, false]) {
            expect(
              decide(e, inFront: inFront),
              AgentNotice.none,
              reason: '$e',
            );
          }
        }
      }
    });

    test('silent: nothing, wherever the phone is', () {
      for (final (inFront, watching) in [
        (true, true),
        (true, false),
        (false, false),
      ]) {
        expect(
          decide(
            end(tier: NoticeTier.silent),
            inFront: inFront,
            watching: watching,
          ),
          AgentNotice.none,
        );
      }
    });

    test('list: a mark with no tap and no notice, even away', () {
      for (final inFront in [true, false]) {
        final notice = decide(end(tier: NoticeTier.list), inFront: inFront);
        expect(notice, AgentNotice.filed);
        expect(notice.marks, isTrue);
        expect(notice.chimes, isFalse);
        expect(notice.alerts, isFalse);
      }
    });

    test('alert: as far as the phone\'s place allows', () {
      expect(decide(end(tier: NoticeTier.alert)), AgentNotice.alert);
      expect(
        decide(end(tier: NoticeTier.alert), inFront: false),
        AgentNotice.alert,
      );
    });

    test('the agent on screen gets nothing — not even the tap', () {
      for (final tier in NoticeTier.values) {
        expect(
          decide(end(tier: tier), watching: true),
          AgentNotice.none,
          reason: '$tier',
        );
      }
    });

    test('watching only counts in front', () {
      expect(
        decide(end(tier: NoticeTier.alert), inFront: false, watching: true),
        AgentNotice.alert,
      );
      expect(
        decide(end(tier: NoticeTier.list), inFront: false, watching: true),
        AgentNotice.filed,
      );
    });
  });
}
