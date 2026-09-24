import 'package:flutter_test/flutter_test.dart';

import 'package:harness_mobile/notify/done_notice.dart';

/// The dial's rule for a finished turn — `firmware/main/cable_client.c`,
/// `summary` — as the phone reads it off `turn_ended`.
void main() {
  TurnEnd end({
    bool aborted = false,
    bool replay = false,
    bool subagent = false,
    String? reply = 'Fixed the login screen.',
  }) => (aborted: aborted, replay: replay, subagent: subagent, reply: reply);

  DoneNotice decide(TurnEnd e, {bool inFront = true, bool watching = false}) =>
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
        expect(decide(e, inFront: inFront), DoneNotice.none, reason: '$e');
      }
    }
  });

  test('watching the agent: the chime still comes, nothing is filed', () {
    final notice = decide(end(), watching: true);
    expect(notice, DoneNotice.chime);
    expect(notice.marks, isFalse);
    expect(notice.alerts, isFalse);
  });

  test('in front on another agent: a mark, never a notice', () {
    final notice = decide(end());
    expect(notice, DoneNotice.mark);
    expect(notice.chimes, isTrue);
    expect(notice.alerts, isFalse);
  });

  test('away: marked and noticed, whatever was on screen', () {
    for (final watching in [true, false]) {
      final notice = decide(end(), inFront: false, watching: watching);
      expect(notice, DoneNotice.alert);
      expect(notice.marks, isTrue);
    }
  });

  test('an older daemon says none of the flags, and every end is news', () {
    final e = turnEndFrom(
      {'type': 'turn_ended', 'agentId': 'a'},
      <String, dynamic>{},
      reply: 'done',
    );
    expect(e, (aborted: false, replay: false, subagent: false, reply: 'done'));
  });

  test('the flags are read where the daemon puts them', () {
    final e = turnEndFrom(
      {'type': 'turn_ended', 'replay': true, 'subagent': true},
      {'aborted': true},
      reply: null,
    );
    expect(e, (aborted: true, replay: true, subagent: true, reply: null));
  });
}
