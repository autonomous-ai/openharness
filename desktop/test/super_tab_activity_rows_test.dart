import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/activity_rows.dart';
import 'package:harness/super_tabs/notifications.dart';

SuperTabMention mention(
  String id,
  String author, {
  String conversationId = 'c1',
  String? threadId,
  String? resolvedBy,
}) => SuperTabMention.fromJson({
  'id': id,
  'conversationId': conversationId,
  'messageId': 'm-$id',
  'leadName': author,
  'threadId': ?threadId,
  'resolvedBy': ?resolvedBy,
});

void main() {
  test('a row is unresolved while any of its mentions still waits', () {
    final rows = groupMentions([
      mention('1', 'dee', resolvedBy: 'done'),
      mention('2', 'dee'),
      mention('3', 'Plover', resolvedBy: 'reply'),
    ], (_) => false);
    expect([for (final r in rows) r.unresolved], [true, false]);
  });

  test('neighbours from one author in one chat fold', () {
    final rows = groupMentions([
      mention('1', 'dee'),
      mention('2', 'dee'),
      mention('3', 'dee'),
      mention('4', 'Plover'),
      mention('5', 'Plover'),
      mention('6', 'dee', conversationId: 'c2'),
    ], (m) => m.id == '5');
    expect([for (final r in rows) r.newest.leadName], ['dee', 'Plover', 'dee']);
    expect([for (final r in rows) r.all.length], [3, 2, 1]);
    expect([for (final r in rows) r.more], [2, 1, 0]);
    expect([for (final r in rows) r.unread], [false, true, false]);
  });

  test('a Title: line gives the subject', () {
    expect(
      threadSubject(
        'Please send this to the openharness PM as a proposal (priority '
        'normal). Title: Swarm: a member cannot close a lost or stopped task '
        '— details',
      ),
      'Swarm: a member cannot close a lost or stopped task',
    );
  });

  test('without a Title: the first line is the subject, whitespace folded', () {
    expect(threadSubject('Ship   it\n second line'), 'Ship it');
  });

  test('a long first line is cut at 90', () {
    expect(threadSubject('a' * 120), '${'a' * 89}…');
  });

  group('the PM takes over 24 hours after the ask', () {
    final now = DateTime(2026, 11, 4, 12);
    DateTime ago(Duration d) => now.subtract(d);

    test('pm in rounds up and says <1h in the last hour', () {
      expect(
        pmIn(ago(const Duration(hours: 18, minutes: 30)), now),
        'PM in 6h',
      );
      expect(
        pmIn(ago(const Duration(hours: 23, minutes: 30)), now),
        'PM in <1h',
      );
      expect(pmSoon(ago(const Duration(hours: 23, minutes: 30)), now), isTrue);
      expect(pmSoon(ago(const Duration(hours: 21)), now), isFalse);
    });
  });

  test('days split at local midnight', () {
    final now = DateTime(2026, 11, 4, 12);
    expect(dayOf(DateTime(2026, 11, 4, 0, 1), now), SuperTabDay.today);
    expect(dayOf(DateTime(2026, 11, 3, 23, 59), now), SuperTabDay.yesterday);
    expect(dayOf(DateTime(2026, 11, 1, 12), now), SuperTabDay.earlier);
  });
}
