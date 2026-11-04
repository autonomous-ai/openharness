import 'notifications.dart';

/// Mentions from one author in one chat or thread, folded into the row of the
/// newest: `+{more} more from {author}`.
class SuperTabMentionRow {
  const SuperTabMentionRow({required this.newest, required this.all});
  final SuperTabMention newest;

  /// Every mention in the row, in the order given.
  final List<SuperTabMention> all;
  int get more => all.length - 1;
}

/// Folds neighbours with the same author, chat and thread into one row each.
/// Only neighbours: a later mention from the same author after someone else's
/// stays its own row, so the list keeps its order.
List<SuperTabMentionRow> groupMentions(List<SuperTabMention> mentions) {
  bool sameRow(SuperTabMention a, SuperTabMention b) =>
      (a.leadId ?? a.leadName) == (b.leadId ?? b.leadName) &&
      a.conversationId == b.conversationId &&
      a.threadId == b.threadId;
  final groups = <List<SuperTabMention>>[];
  for (final m in mentions) {
    if (groups.isNotEmpty && sameRow(groups.last.first, m)) {
      groups.last.add(m);
    } else {
      groups.add([m]);
    }
  }
  return [
    for (final g in groups)
      SuperTabMentionRow(newest: g.first, all: List.unmodifiable(g)),
  ];
}

const _subjectLength = 90;

/// What a thread is about, from its root's text: the title when the root
/// carries one (`Title: ...`, up to ` — `, `. ` or the end of the line), else
/// its first line; whitespace collapsed, cut at 90 characters with `…` as the
/// 90th. A root is often a long request, so the whole text would fill the row.
String threadSubject(String rootText) {
  var subject = rootText.split('\n').first;
  final at = rootText.indexOf('Title: ');
  if (at >= 0) {
    final rest = rootText.substring(at + 'Title: '.length).split('\n').first;
    final end = [
      rest.indexOf(' — '),
      rest.indexOf('. '),
    ].where((i) => i >= 0).fold<int>(rest.length, (a, b) => a < b ? a : b);
    subject = rest.substring(0, end);
  }
  subject = subject.trim().replaceAll(RegExp(r'\s+'), ' ');
  return subject.length <= _subjectLength
      ? subject
      : '${subject.substring(0, _subjectLength - 1)}…';
}

/// How long a decision waits before the PM takes it over (the backend sweep).
const _pmTakesOver = Duration(hours: 24);

Duration _left(DateTime createdAt, DateTime now) =>
    createdAt.add(_pmTakesOver).difference(now);

/// When the PM takes the decision over: `PM in {h}h`, hours rounded up, or
/// `PM in <1h` in the last hour.
String pmIn(DateTime createdAt, DateTime now) {
  final left = _left(createdAt, now);
  if (left < const Duration(hours: 1)) return 'PM in <1h';
  return 'PM in ${(left.inMinutes / 60).ceil()}h';
}

/// Whether the PM takes the decision over in under two hours.
bool pmSoon(DateTime createdAt, DateTime now) =>
    _left(createdAt, now) < const Duration(hours: 2);

enum SuperTabDay { today, yesterday, earlier }

/// The reader's day [at] falls on, by local midnight.
SuperTabDay dayOf(DateTime at, DateTime now) {
  final day = DateTime(at.year, at.month, at.day);
  final today = DateTime(now.year, now.month, now.day);
  final days = DateTime.utc(
    today.year,
    today.month,
    today.day,
  ).difference(DateTime.utc(day.year, day.month, day.day)).inDays;
  if (days <= 0) return SuperTabDay.today;
  if (days == 1) return SuperTabDay.yesterday;
  return SuperTabDay.earlier;
}
