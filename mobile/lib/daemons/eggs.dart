/// Eggs as the phone shows them (`daemons/README.md`, "Eggs"): every egg
/// waiting in the nest, ready to open, and every egg still being earned, each
/// at its stage (`eggStage` in `render.dart`), and the one egg nearest to
/// hatching, which is the one the chip shows before any daemon.
///
/// What counts toward each kind:
///
/// | egg      | done / need                                                    |
/// |----------|----------------------------------------------------------------|
/// | first    | habits (`habitProgress`) / `firstEgg.need`, until it is granted |
/// | setup    | habits / `setupEgg.need`, after the first, until it is granted  |
/// | turn     | `progress.turns % earn.turn.every` / `earn.turn.every`          |
/// | week     | local days of this ISO week with a counted turn / `week.days`   |
/// | night    | `progress.nights` / `earn.night.nights`                         |
/// | marathon | `progress.turns` / `earn.marathon.turns`, until it is earned    |
///
/// Easter and history eggs arrive earned. The eggs earned from work need the
/// server's `progress`: from a server without it only the habit eggs show.
library;

import 'package:flutter/foundation.dart' show immutable;

import 'render.dart';
import 'roster.dart';
import 'zoo.dart';

/// One egg on its way, or waiting to be opened.
@immutable
class EggProgress {
  const EggProgress({
    required this.kind,
    required this.done,
    required this.need,
    this.egg,
  });

  /// A key of `rules.eggs`.
  final String kind;
  final int done, need;

  /// The egg itself once it is earned and waits in the nest; null while it
  /// is being earned.
  final ZooEgg? egg;

  bool get ready => egg != null;

  /// How far along, 0 to 1 (1 once ready).
  double get fraction => ready
      ? 1
      : need > 0
      ? (done / need).clamp(0, 1).toDouble()
      : 0;

  /// Its stage: `p4` once ready, else `p0` to `p3` by [done] / [need].
  String get stage => eggStage(done, need, ready: ready);
}

/// The eggs waiting in the nest, in the zoo's order, each ready (`p4`).
List<EggProgress> waitingEggs(Zoo zoo) => [
  for (final egg in zoo.eggs)
    EggProgress(kind: egg.kind, done: 1, need: 1, egg: egg),
];

/// Every egg still being earned, in the order of the table above.
List<EggProgress> earningEggs(DaemonRoster roster, Zoo zoo, DateTime now) {
  final rules = roster.rules;
  final out = <EggProgress>[];
  void add(String kind, int done, int need) {
    if (rules.eggs.containsKey(kind) && need > 0) {
      out.add(EggProgress(kind: kind, done: done.clamp(0, need), need: need));
    }
  }

  if (!zoo.firstEgg) {
    final p = habitProgress(roster, zoo.habits);
    add('first', p.done, p.need);
  } else if (!zoo.setupEgg && rules.setupEggNeed != null) {
    final p = habitProgress(roster, zoo.habits, kind: 'setup');
    add('setup', p.done, p.need);
  }
  final progress = zoo.progress;
  if (progress == null) return out;
  final earn = rules.earn;
  add('turn', progress.turns % earn.turnEvery, earn.turnEvery);
  final week = isoWeek(now);
  if (!progress.weeks.contains(week)) {
    final days = progress.days.entries
        .where((e) => e.value > 0 && _weekOf(e.key) == week)
        .length;
    add('week', days, earn.weekDays);
  }
  add('night', progress.nights.length, earn.nights);
  if (!progress.marathon.contains('turns')) {
    add('marathon', progress.turns, earn.marathonTurns);
  }
  return out;
}

/// The one egg nearest to hatching: a waiting egg if there is one, else the
/// egg being earned with the highest done / need (the first of them on a
/// tie). Null when there is neither.
EggProgress? nearestEgg(DaemonRoster roster, Zoo zoo, DateTime now) {
  final waiting = waitingEggs(zoo);
  if (waiting.isNotEmpty) return waiting.first;
  EggProgress? best;
  for (final egg in earningEggs(roster, zoo, now)) {
    if (best == null || egg.fraction > best.fraction) best = egg;
  }
  return best;
}

/// The ISO week of [day] (Monday start), `YYYY-Www`: 2027-01-01 is in
/// 2026-W53.
String isoWeek(DateTime day) {
  final date = DateTime.utc(day.year, day.month, day.day);
  // The Thursday of this week decides its year.
  final thursday = date.add(Duration(days: 4 - date.weekday));
  final first = DateTime.utc(thursday.year);
  final week = thursday.difference(first).inDays ~/ 7 + 1;
  return '${thursday.year.toString().padLeft(4, '0')}-W'
      '${week.toString().padLeft(2, '0')}';
}

String? _weekOf(String day) {
  final at = DateTime.tryParse(day);
  return at == null ? null : isoWeek(at);
}
