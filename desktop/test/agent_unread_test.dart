// The marks that say which harnesses moved while you were not looking: what sets one, what the
// badge counts, and what takes one away.
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/notify/agent_alerts.dart';
import 'package:harness/notify/alert_sounds.dart';

void main() {
  late AgentUnread unread;

  setUp(() => unread = AgentUnread());
  tearDown(() => unread.dispose());

  test('nothing is unread to begin with', () {
    expect(unread.count, 0);
    expect(unread.isEmpty, isTrue);
    expect(unread.kindFor('m1', 'a1'), isNull);
  });

  test(
    'fresh same-kind events and app instances cannot reuse a read token',
    () {
      unread.mark('m1', 'a', AlertKind.done);
      final first = unread.readTokenFor('m1', 'a');
      unread.mark('m1', 'a', AlertKind.done);
      expect(unread.readTokenFor('m1', 'a'), first);
      unread.mark('m1', 'a', AlertKind.done, fresh: true);
      final second = unread.readTokenFor('m1', 'a')!;
      expect(second, isNot(first));
      expect(second.length, lessThan(64));
      expect(RegExp(r'^[A-Za-z0-9_-]+$').hasMatch(second), isTrue);
      final other = AgentUnread()..mark('m1', 'a', AlertKind.done);
      expect(other.readTokenFor('m1', 'a'), isNot(second));
      other.dispose();
      unread.clear('m1', 'a');
      expect(unread.readTokenFor('m1', 'a'), isNull);
    },
  );

  test('a mark says WHICH kind of news it is', () {
    unread.mark('m1', 'a1', AlertKind.done);
    expect(unread.kindFor('m1', 'a1'), AlertKind.done);
    expect(unread.count, 1);
  });

  test('preview and time belong to the unread receipt and leave with it', () {
    final first = DateTime(2026, 9, 30, 12);
    unread.mark('m1', 'a1', AlertKind.done, message: 'First result', at: first);
    unread.mark(
      'm1',
      'a1',
      AlertKind.done,
      message: 'Duplicate',
      at: first.add(const Duration(minutes: 1)),
    );
    expect(unread.messageFor('m1', 'a1'), 'First result');
    expect(unread.receivedAtFor('m1', 'a1'), first);
    unread.mark('m1', 'a1', AlertKind.done, fresh: true);
    expect(
      unread.messageFor('m1', 'a1'),
      isNull,
      reason: 'Never reuse a previous turn\'s message',
    );
    unread.clear('m1', 'a1');
    expect(unread.receivedAtFor('m1', 'a1'), isNull);
    unread.mark('m1', 'a1', AlertKind.done, message: 'New result');
    unread.clearAll();
    expect(unread.messageFor('m1', 'a1'), isNull);
    expect(unread.receivedAtFor('m1', 'a1'), isNull);
  });

  test('the newest kind wins — a finished agent that then asks is waiting', () {
    // Which is the mark worth showing: one of these is work you can read later, the other is work
    // that has stopped until somebody answers.
    unread.mark('m1', 'a1', AlertKind.done);
    unread.mark('m1', 'a1', AlertKind.needsYou);
    expect(unread.kindFor('m1', 'a1'), AlertKind.needsYou);
  });

  test('the count is AGENTS, not events', () {
    // "How many should I look at" — an agent that finished three turns is still one place to go.
    unread.mark('m1', 'a1', AlertKind.done);
    unread.mark('m1', 'a1', AlertKind.done);
    unread.mark('m1', 'a1', AlertKind.needsYou);
    expect(unread.count, 1);
  });

  test('the same agent id on two machines is two marks', () {
    unread.mark('m1', 'a1', AlertKind.done);
    unread.mark('m2', 'a1', AlertKind.done);
    expect(unread.count, 2);
  });

  test('going to a harness clears its mark and nobody else’s', () {
    unread.mark('m1', 'a1', AlertKind.done);
    unread.mark('m1', 'a2', AlertKind.needsYou);
    unread.clear('m1', 'a1');
    expect(unread.kindFor('m1', 'a1'), isNull);
    expect(unread.kindFor('m1', 'a2'), AlertKind.needsYou);
    expect(unread.count, 1);
  });

  test('a deleted agent stops being counted', () {
    // An agent that no longer exists cannot be gone to, so a mark it left would sit in the badge
    // forever with nowhere to send anybody.
    unread.mark('m1', 'a1', AlertKind.done);
    unread.forget('m1', 'a1');
    expect(unread.count, 0);
  });

  test('clearing nothing notifies nobody', () {
    // A pane being focused for any other reason must not rebuild the window.
    var rebuilds = 0;
    unread.addListener(() => rebuilds++);
    unread.clear('m1', 'nobody');
    expect(rebuilds, 0);
    unread.mark('m1', 'a1', AlertKind.done);
    expect(rebuilds, 1);
    // Re-marking the same agent with the same kind is not news either.
    unread.mark('m1', 'a1', AlertKind.done);
    expect(rebuilds, 1);
  });

  group('bounded desktop inbox', () {
    test('retains nine notifications without the dial drawer evicting one', () {
      for (var i = 0; i < 9; i++) {
        unread.mark('m1', 'a$i', AlertKind.done);
      }
      expect(unread.count, 9);
      expect(unread.kindFor('m1', 'a0'), AlertKind.done);
    });

    test('evicts the oldest entry only at the desktop capacity', () {
      for (var i = 0; i < AgentUnread.capacity + 3; i++) {
        unread.mark('m1', 'a$i', AlertKind.done, message: 'Result $i');
      }

      expect(unread.count, AgentUnread.capacity);
      expect(unread.kindFor('m1', 'a0'), isNull, reason: 'the oldest went');
      expect(unread.kindFor('m1', 'a2'), isNull);
      expect(unread.messageFor('m1', 'a2'), isNull);
      expect(unread.receivedAtFor('m1', 'a2'), isNull);
      expect(unread.messageFor('m1', 'a3'), 'Result 3');
      expect(unread.kindFor('m1', 'a3'), isNotNull, reason: 'the rest stayed');
    });

    test('a mark touched again is the newest, and outlives an older one', () {
      // `notif_push` lifts an existing row out and puts it back on top; without
      // that here, an agent that keeps working would be evicted before agents
      // that have said nothing for an hour.
      for (var i = 0; i < AgentUnread.capacity; i++) {
        unread.mark('m1', 'a$i', AlertKind.done);
      }
      unread.mark('m1', 'a0', AlertKind.needsYou); // the oldest speaks again
      unread.mark('m1', 'fresh', AlertKind.done); // …and one more arrives

      expect(
        unread.kindFor('m1', 'a0'),
        AlertKind.needsYou,
        reason: 'it was touched, so it is no longer the oldest',
      );
      expect(unread.kindFor('m1', 'a1'), isNull, reason: 'a1 was');
      expect(unread.count, AgentUnread.capacity);
    });
  });
}
