/// The account's zoo as a PHONE holds it: read and written straight on the
/// backend (`GET /api/zoo`, `POST /api/zoo/ops`, see `ApiClient.zoo`), and read
/// again on `zoo_changed`, when the app comes back to the foreground, and when
/// the daemon sheet opens.
///
/// The desk's discipline (`state/phone_desk.dart`), on its own document: a
/// desk change never re-reads the zoo, and the other way round.
///
/// ⚠️ **`zoo_changed` arrives once per MACHINE the phone is connected to** —
/// it rides each machine's socket, as `desk_changed` does — so [noticeRevision]
/// fetches only for a revision the phone has not seen.
///
/// ⚠️ **No poll.** The desk polls in the foreground because a tab made on a
/// computer has to show up while the phone sits on one screen. Nothing in the
/// zoo is that urgent: an egg or a level-up can wait for the next push, the
/// next time the app comes to the front, or the sheet opening.
///
/// The server decides everything that is drawn or earned. The phone's own
/// writes are a pair switch, a name given at the hatch, a habit it saw, the
/// first-day consent answer, and opening an egg; all but the egg show at once
/// and are laid back over every answer until one acknowledges them, the way
/// the desktop's `ZooController` does. Pair and name address an individual by
/// its uid (`zoo.pair { uid }`, `zoo.nickname { uid, name }`); one read from
/// a zoo stored before individuals goes out as that server knows it, by
/// species id. The autonomy dial is read here, never written: it turns at a
/// computer, where each step up waits for the person's yes.
library;

import 'dart:async';
import 'dart:math' show max;

import 'package:flutter/foundation.dart';

import 'roster.dart';
import 'zoo.dart';

/// Something that arrived in the zoo since it was last shown, learned by
/// comparing what the zoo was with what it is. A first read is a baseline,
/// never news.
sealed class ZooEvent {
  const ZooEvent();
}

/// A new egg in the nest, from this phone's request or another client's.
class ZooEggArrived extends ZooEvent {
  const ZooEggArrived(this.egg);
  final ZooEgg egg;
}

/// A daemon's bond reached a new level (and maybe a new version).
class ZooDaemonGrew extends ZooEvent {
  const ZooDaemonGrew(this.daemon, {required this.versionChanged});
  final ZooDaemon daemon;
  final bool versionChanged;
}

/// An egg earned with 64 already held became xp for the paired daemon (a
/// grant of the `{kind, xp}` form). Only the client whose request earned it
/// hears this; every other one just sees the xp.
class ZooXpGranted extends ZooEvent {
  const ZooXpGranted(this.grant);
  final ZooGrant grant;
}

typedef ZooRead = Future<Map<String, dynamic>?> Function();
typedef ZooWrite = Future<Map<String, dynamic>?> Function(
  List<Map<String, dynamic>> ops,
);

class ZooClient extends ChangeNotifier {
  ZooClient({required this.read, required this.write, DaemonRoster? roster})
    : roster = roster ?? daemonRoster;

  /// `GET /api/zoo` — `{revision, zoo}`, or null where the backend has no zoo.
  final ZooRead read;

  /// `POST /api/zoo/ops` — `{revision, zoo, hatched, grants, levelUps}`.
  final ZooWrite write;
  final DaemonRoster roster;

  Zoo _zoo = Zoo.empty;
  int _revision = -1;
  bool _loaded = false;
  bool _disposed = false;
  Future<void>? _reading;
  Future<void> _queue = Future.value();
  final _unsent = <Map<String, dynamic>>[];
  String? _hatchingEgg;
  final _xpGrants = <ZooGrant>[];
  final _events = StreamController<ZooEvent>.broadcast(sync: true);

  /// Bumped by [reset]: whatever is in flight drops its answer if it moved.
  int _generation = 0;

  /// Whether the zoo has answered. Nothing daemon-shaped is drawn before: a
  /// boot never flashes an empty nest at somebody who owns six daemons.
  bool get loaded => _loaded;
  Zoo get zoo => _zoo;
  int get revision => _revision;

  /// New eggs and level-ups, for the face.
  Stream<ZooEvent> get events => _events.stream;

  /// The egg being opened right now, if any.
  String? get hatchingEgg => _hatchingEgg;

  /// Eggs that became xp in an answer to this phone, not yet seen: the sheet
  /// shows them as `+50 xp` and forgets them when it closes ([seenXp]).
  List<ZooGrant> get xpGrants => List.unmodifiable(_xpGrants);

  void seenXp() {
    if (_xpGrants.isEmpty || _disposed) return;
    _xpGrants.clear();
    notifyListeners();
  }

  ZooDaemon? get paired => _zoo.paired;
  DaemonDef? get pairedDef => roster.byId(paired?.id);

  /// The first egg waiting to be hatched.
  ZooEgg? get readyEgg => _zoo.eggs.firstOrNull;
  int get habitsDone => _zoo.habits.length;
  List<String> get habits => _zoo.habits;
  int get habitsNeeded => roster.rules.firstEggNeed;

  /// Habits that bring the setup egg, or null on a roster without one.
  int? get setupHabitsNeeded => roster.rules.setupEggNeed;

  // ── reading ────────────────────────────────────────────────────────────────

  /// Read the zoo unless it has answered, or a read is on its way. Called from
  /// every path that finishes a sign-in.
  void ensure() {
    if (_loaded || _reading != null || _disposed) return;
    unawaited(refresh());
  }

  /// Read again: a push, the app back in front, the sheet opening. Anything
  /// this phone could not send before goes out first.
  Future<void> refresh() {
    if (_disposed) return Future.value();
    if (_unsent.isNotEmpty && _loaded) _flush();
    final running = _reading;
    if (running != null) return running;
    final run = _read();
    _reading = run;
    return run.whenComplete(() {
      if (identical(_reading, run)) _reading = null;
    });
  }

  /// `zoo_changed { revision }`: fetch only when it is news.
  void noticeRevision(Object? revision) {
    if (_disposed) return;
    if (_loaded && revision is int && revision <= _revision) return;
    unawaited(refresh());
  }

  Future<void> _read() async {
    final generation = _generation;
    Map<String, dynamic>? raw;
    try {
      raw = await read();
    } catch (error) {
      debugPrint('zoo: read failed: $error');
      return;
    }
    if (!_current(generation) || raw == null) return;
    _adopt(raw, baseline: !_loaded);
  }

  bool _current(int generation) => !_disposed && generation == _generation;

  /// An answer to this phone's own write: the zoo, and the grants only the
  /// sender hears. An egg granted shows by being in the zoo; an egg that
  /// became xp is kept for the sheet, never shown as an egg.
  void _adoptAnswer(Map<String, dynamic> answer) {
    _adopt(answer);
    final grants = [
      for (final g in answer['grants'] as List? ?? const [])
        ?ZooGrant.fromJson(g),
    ];
    final xp = grants.where((g) => g.isXp).toList();
    if (xp.isEmpty || _disposed) return;
    _xpGrants.addAll(xp);
    notifyListeners();
    for (final grant in xp) {
      _events.add(ZooXpGranted(grant));
    }
  }

  /// Take the server's answer when it is not older than what is shown.
  void _adopt(Map<String, dynamic> raw, {bool baseline = false}) {
    final revision = raw['revision'];
    if (revision is! int) return;
    if (_loaded && revision < _revision) return;
    _revision = revision;
    _loaded = true;
    _show(_overlayUnsent(Zoo.fromJson(raw['zoo'], roster)), baseline: baseline);
  }

  void _show(Zoo next, {bool baseline = false}) {
    final before = _zoo;
    _zoo = next;
    notifyListeners();
    if (baseline || _disposed) return;
    for (final egg in next.eggs) {
      if (!before.eggs.any((e) => e.id == egg.id)) {
        _events.add(ZooEggArrived(egg));
      }
    }
    final seen = <String>{};
    for (final daemon in next.daemons) {
      if (!seen.add(daemon.uid)) continue;
      final was = before.individual(daemon.uid);
      if (was != null && daemon.bond > was.bond) {
        _events.add(
          ZooDaemonGrew(daemon, versionChanged: daemon.version != was.version),
        );
      }
    }
  }

  /// This phone's unacknowledged ops laid back over an answer, so a reply to
  /// an earlier write does not briefly undo a later one. Never an egg: those
  /// are the server's to grant.
  Zoo _overlayUnsent(Zoo zoo) {
    var next = zoo;
    for (final op in _unsent) {
      switch (op['op']) {
        case 'zoo.habit':
          final key = op['key'] as String;
          if (!next.habits.contains(key)) {
            next = next.copyWith(habits: [...next.habits, key]);
          }
        case 'zoo.pair':
          final uid = (op['uid'] ?? op['id']) as String;
          if (next.individual(uid) != null) next = next.copyWith(pair: uid);
        case 'zoo.nickname':
          final uid = (op['uid'] ?? op['id']) as String;
          final name = (op['name'] ?? op['nickname']) as String?;
          if (next.individual(uid) != null) next = next.withName(uid, name);
        case 'zoo.consent':
          next = _consented(next, op['watching'] as bool);
      }
    }
    return next;
  }

  /// [zoo] with the answer [watching], as the server applies `zoo.consent`:
  /// the time is this phone's until the server's answer brings its own, and a
  /// yes starts the dial at `watch`.
  static Zoo _consented(Zoo zoo, bool watching) {
    if (zoo.consent?.watching == watching) return zoo;
    return zoo.copyWith(
      consent: ZooConsent(
        watching: watching,
        at: DateTime.now().toUtc().toIso8601String(),
      ),
      autonomy: watching ? Zoo.defaultAutonomy : null,
    );
  }

  /// Signed out, or another account: everything goes, writes never sent
  /// included.
  void reset() {
    _generation++;
    _zoo = Zoo.empty;
    _revision = -1;
    _loaded = false;
    _reading = null;
    _unsent.clear();
    _hatchingEgg = null;
    _xpGrants.clear();
    if (!_disposed) notifyListeners();
  }

  // ── writing ────────────────────────────────────────────────────────────────

  /// A first-egg habit this phone saw. Sent once; the server grants the egg.
  void habit(String key) {
    if (!_loaded ||
        _zoo.habits.contains(key) ||
        _unsent.any((op) => op['op'] == 'zoo.habit' && op['key'] == key) ||
        !roster.rules.habits.any((h) => h.key == key)) {
      return;
    }
    _send({'op': 'zoo.habit', 'key': key});
    _show(_zoo.copyWith(habits: [..._zoo.habits, key]));
  }

  /// The individual on the chip, on every client.
  void pair(String uid) {
    final daemon = _zoo.individual(uid);
    if (!_loaded || daemon == null || _zoo.pair == uid) return;
    _send(
      daemon.legacy
          ? {'op': 'zoo.pair', 'id': daemon.id}
          : {'op': 'zoo.pair', 'uid': uid},
    );
    _show(_zoo.copyWith(pair: uid));
  }

  /// The name individual [uid] was given (at its hatch, or later): 1–24
  /// printable ASCII characters, trimmed. Anything else, or the name it
  /// already has, sends nothing.
  void name(String uid, String name) {
    final daemon = _zoo.individual(uid);
    final trimmed = name.trim();
    if (!_loaded ||
        daemon == null ||
        !validNickname(trimmed) ||
        daemon.name == trimmed) {
      return;
    }
    _send(
      daemon.legacy
          ? {'op': 'zoo.nickname', 'id': daemon.id, 'nickname': trimmed}
          : {'op': 'zoo.nickname', 'uid': uid, 'name': trimmed},
    );
    _show(_zoo.withName(uid, trimmed));
  }

  /// The first-day answer: may the daemon watch at all (`zoo.consent`). A yes
  /// starts the dial at `watch`; a no (or withdrawing it) leaves every
  /// computer sensing nothing. Sent once per change.
  void consent({required bool watching}) {
    // What is shown already carries any answer not yet acknowledged.
    if (!_loaded || _zoo.consent?.watching == watching) return;
    _send({'op': 'zoo.consent', 'watching': watching});
    _show(_consented(_zoo, watching));
  }

  /// Open an egg. The draw happens on the server; null when the egg is gone or
  /// the backend cannot be reached — the egg then stays in the nest. A
  /// duplicate answers what it merged into: the count, the shine, the level.
  Future<ZooHatch?> hatch(String eggId) async {
    if (!_loaded || _hatchingEgg != null) return null;
    if (!_zoo.eggs.any((e) => e.id == eggId)) return null;
    _hatchingEgg = eggId;
    notifyListeners();
    final generation = _generation;
    final done = Completer<Map<String, dynamic>?>();
    _enqueue(() async {
      try {
        done.complete(
          await write([
            {'op': 'zoo.hatch', 'eggId': eggId},
          ]),
        );
      } catch (error) {
        done.completeError(error);
      }
    });
    try {
      final answer = await done.future;
      if (!_current(generation) || answer == null) return null;
      final before = _zoo;
      _adoptAnswer(answer);
      final hatch = [
        for (final h in answer['hatched'] as List? ?? const [])
          ?ZooHatch.fromJson(h),
      ].where((h) => h.eggId == eggId).firstOrNull;
      if (hatch == null) return null;
      if (hatch.duplicate) {
        // A server before individuals merged it into the one you have.
        final had = before.daemon(hatch.daemonId);
        final has = _zoo.daemon(hatch.daemonId);
        final levelUp = [
          for (final l in answer['levelUps'] as List? ?? const [])
            ?ZooLevelUp.fromJson(l),
        ].where((l) => l.id == hatch.daemonId).lastOrNull;
        // One more of it; an answer older than what is shown (a later read
        // got here first) still counts it once.
        return hatch.learned(
          count: max(has?.count ?? 0, (had?.count ?? 0) + 1),
          becameShiny: hatch.shiny && had?.shiny != true,
          uid: has?.uid,
          levelUp: levelUp,
          versionBefore: had?.version,
        );
      }
      // The new individual: named by the answer, else the one of its
      // species that was not there before.
      final born =
          _zoo.individual(hatch.uid) ??
          _zoo.daemons
              .where(
                (d) =>
                    d.id == hatch.daemonId && before.individual(d.uid) == null,
              )
              .lastOrNull;
      return hatch.learned(
        count: _zoo.ofSpecies(hatch.daemonId).length,
        becameShiny: false,
        uid: born?.uid,
        seed: born?.seed,
        serial: born?.serial,
      );
    } catch (error) {
      debugPrint('zoo: hatch failed: $error');
      return null;
    } finally {
      if (_current(generation)) {
        _hatchingEgg = null;
        notifyListeners();
      }
    }
  }

  void _send(Map<String, dynamic> op) {
    _unsent.add(op);
    _flush();
  }

  void _enqueue(Future<void> Function() work) {
    _queue = _queue.then((_) => work()).catchError((_) {});
  }

  /// Every op is idempotent, so a batch that failed is kept and goes again
  /// with the next [refresh] — a push, the app back in front, the sheet.
  void _flush() {
    final generation = _generation;
    _enqueue(() async {
      if (!_current(generation) || _unsent.isEmpty) return;
      final batch = List<Map<String, dynamic>>.of(_unsent);
      Map<String, dynamic>? answer;
      try {
        answer = await write(batch);
      } catch (error) {
        debugPrint('zoo: write failed (${batch.length} ops): $error');
        return;
      }
      if (!_current(generation)) return;
      _unsent.removeRange(0, batch.length.clamp(0, _unsent.length));
      if (answer != null) _adoptAnswer(answer);
    });
  }

  /// Wait for every write in the air (tests).
  @visibleForTesting
  Future<void> settle() => _queue;

  @override
  void dispose() {
    _disposed = true;
    unawaited(_events.close());
    super.dispose();
  }
}
