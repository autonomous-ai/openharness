import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/agent_notice.dart';
import 'package:harness_mobile/notify/agent_unread.dart';

/// The unread marks: which agents have news the person has not gone to yet.
///
/// Every row, tab pill and count on the phone reads these, and each redraws on
/// a notification — so a mark that did not change must not notify, or one
/// agent's news would redraw every row for nothing.
void main() {
  const a = (machineId: 'm', agentId: 'a');
  const b = (machineId: 'm', agentId: 'b');
  const c = (machineId: 'other', agentId: 'a');

  late AgentUnread unread;
  late int notified;

  setUp(() {
    unread = AgentUnread();
    notified = 0;
    unread.addListener(() => notified++);
  });

  tearDown(() => unread.dispose());

  test('an agent is told apart by its machine too', () {
    unread.mark(a, NoticeKind.done);
    expect(unread.contains(a), isTrue);
    expect(unread.contains(c), isFalse);
  });

  test('the same news twice is one notification', () {
    unread
      ..mark(a, NoticeKind.done)
      ..mark(a, NoticeKind.done);
    expect(notified, 1);
    unread.mark(a, NoticeKind.question);
    expect(notified, 2);
    expect(unread.anyQuestion, isTrue);
  });

  group('the most urgent news among a tab\'s agents', () {
    test('a question over a finished turn, wherever it sits', () {
      unread
        ..mark(a, NoticeKind.done)
        ..mark(b, NoticeKind.question);
      expect(unread.mostUrgentOf([a, b]), NoticeKind.question);
      expect(unread.mostUrgentOf([b, a]), NoticeKind.question);
    });

    test('a finished turn when that is all there is', () {
      unread.mark(b, NoticeKind.done);
      expect(unread.mostUrgentOf([a, b, c]), NoticeKind.done);
    });

    test('nothing when none of them carries news', () {
      unread.mark(c, NoticeKind.question);
      expect(unread.mostUrgentOf([a, b]), isNull);
      expect(unread.mostUrgentOf(const []), isNull);
    });
  });

  group('clearing', () {
    test('a clear of one kind leaves the other kind standing', () {
      unread.mark(a, NoticeKind.done);
      unread.clear(a, kind: NoticeKind.question);
      expect(unread.kindFor(a), NoticeKind.done);
      expect(notified, 1);
    });

    test('nothing to clear is silent', () {
      unread
        ..clear(a)
        ..clearAll();
      expect(notified, 0);
    });

    test('clearing everything takes every mark down at once', () {
      unread
        ..mark(a, NoticeKind.done)
        ..mark(b, NoticeKind.question);
      notified = 0;
      unread.clearAll();
      expect(unread.count, 0);
      expect(unread.anyQuestion, isFalse);
      expect(notified, 1);
    });
  });
}
