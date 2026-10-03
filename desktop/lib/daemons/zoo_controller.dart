/// The window's half of the zoo. An account's zoo lives on the server and is
/// reached the way the desk is: `GET /api/zoo` and `POST /api/zoo/ops` through
/// the local harnessd (its Unix socket, or loopback TCP), refreshed on the
/// `zoo_changed` local frame. A guest keeps a local zoo with the same shape and
/// rules, drawn here, and it is sent once with `zoo.seed` on first sign-in.
///
/// Nothing is shown until the zoo has loaded: [loaded] stays false while the
/// scope is unknown (a signed-in window before its profile arrives) and while
/// the first read is in flight, so a boot never flashes a stranger's nest.
///
/// Daemons ship dark (daemons/README.md, "Off switches"). A signed-in window
/// shows them only once `GET /api/zoo` answers 200; a 404 (or a 401, or no way
/// to ask) is [DaemonsSwitch.off]: nothing is shown, read, kept or sent, and
/// the window behaves exactly as it did before daemons existed. A failed read
/// is not an answer: whatever was known stands, and it is asked again. A
/// guest's durable local zoo stays off. Settings → Experimental opens the
/// account collection. The window-only preview is reserved for render fixtures.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter/foundation.dart';

import '../api/api_client.dart';
import '../core/local_key_value_store.dart';
import 'individuals.dart';
import 'render.dart' show habitProgress;
import 'roster.dart';
import 'zoo.dart';
import 'zoo.dart' as zoo_rules show eggsBeingEarned, nearestEgg;

abstract interface class ZooTransport {
  /// `{revision, zoo}`, or null when daemons are off: a 404 (switched off on
  /// the server or in harnessd, or a harnessd that predates the zoo) or a
  /// 401. A failure to answer throws: that is not off.
  Future<Map<String, dynamic>?> fetch();

  /// `{revision, zoo, hatched}`, or null under the same conditions.
  Future<Map<String, dynamic>?> apply(List<Map<String, dynamic>> ops);
}

class ApiZooTransport implements ZooTransport {
  ApiZooTransport(this.api);
  final ApiClient api;
  @override
  Future<Map<String, dynamic>?> fetch() => api.zoo();
  @override
  Future<Map<String, dynamic>?> apply(List<Map<String, dynamic>> ops) =>
      api.zooOps(ops);
}

/// Something that arrived in the zoo since it was last shown: learned from
/// this window's own answers and from other windows' changes alike, by
/// comparing what the zoo was with what it is (a first read and a seed are
/// baselines, never news).
sealed class ZooEvent {
  const ZooEvent();
}

/// A new egg in the nest: earned from work, a first or easter egg, or one
/// that was held until there was room.
class ZooEggArrived extends ZooEvent {
  const ZooEggArrived(this.egg);
  final ZooEgg egg;
}

/// An individual's bond reached a new level (and maybe a new version).
class ZooDaemonGrew extends ZooEvent {
  const ZooDaemonGrew(this.daemon, {required this.versionChanged});
  final ZooDaemon daemon;
  final bool versionChanged;
}

/// A fresh hatch after the initial collection read.
class ZooDaemonHatched extends ZooEvent {
  const ZooDaemonHatched(this.daemon);
  final ZooDaemon daemon;
}

/// Whether this window has daemons at all.
enum DaemonsSwitch {
  /// Not decided yet: no profile, or the first read has no answer. Nothing
  /// shows and nothing is sent; no space is kept for the slot.
  unknown,

  /// The server has no zoo for this account (404), harnessd is switched off
  /// (`DAEMONS_OFF`), or the account has not opted in. Everything daemon-related
  /// stays hidden and silent.
  off,

  /// `GET /api/zoo` answered 200, or a test fixture enabled a local collection.
  on,
}

enum ZooSource {
  /// Not loaded yet, or no scope.
  none,

  /// The account's zoo on the server.
  account,

  /// This installation's local zoo: a guest, or a harnessd without a zoo.
  local,

  /// A window-only test collection. Never stored, seeded or sent to an account.
  preview,
}

class ZooController extends ChangeNotifier {
  ZooController({
    this.storage,
    DaemonRoster? roster,
    Random? random,
    DateTime Function()? now,
  }) : roster = roster ?? daemonRoster,
       _random = random ?? Random.secure(),
       _now = now ?? DateTime.now;

  static const localZooKey = 'daemons.zoo.v1.local';

  /// Daemons are asked about again once the last answer is this old (on or
  /// off), besides on `zoo_changed` and a reconnect; a failed read is retried
  /// no less often than this.
  static const recheckEvery = Duration(hours: 6);
  static String prefsKey(String scope) =>
      'daemons.prefs.v1.${base64Url.encode(utf8.encode(scope))}';

  final LocalKeyValueStore? storage;
  final DaemonRoster roster;
  final Random _random;
  final DateTime Function() _now;

  String? _scope;
  ZooTransport? _remote;
  bool _enabled = true;
  bool _off = false;
  bool _prefsRead = false;
  DateTime? _answeredAt;
  bool _fetching = false;
  ZooSource _source = ZooSource.none;
  Zoo _zoo = Zoo.empty;
  int _revision = 0;
  int _generation = 0;
  bool _disposed = false;
  bool _seeded = false;
  Zoo _local = Zoo.empty;
  Zoo? _previewZoo;
  static const _previewScope = 'preview';
  final _days = <String>{};
  final _easterAsked = <String>{};
  bool _hintSeen = false;
  String? _hatchingEgg;
  Future<void> _queue = Future.value();
  Future<void> _saving = Future.value();
  final _events = StreamController<ZooEvent>.broadcast(sync: true);
  final _unsent = <Map<String, dynamic>>[];
  Timer? _retry;
  int _failures = 0;

  String? get scope => _scope;
  ZooSource get source => _source;

  /// Whether this window has daemons: [DaemonsSwitch.on] exactly when the zoo
  /// has [loaded].
  DaemonsSwitch get daemons => loaded
      ? DaemonsSwitch.on
      : _off
      ? DaemonsSwitch.off
      : DaemonsSwitch.unknown;

  /// New eggs and level-ups, for the face and the notices.
  Stream<ZooEvent> get events => _events.stream;
  bool get loaded => _source != ZooSource.none;
  bool get isAccount => _source == ZooSource.account;
  bool get isPreview => _scope == _previewScope;
  Zoo get zoo => _zoo;
  int get revision => _revision;
  String? get hatchingEgg => _hatchingEgg;
  int get habitsDone => _zoo.habits.length;
  int get habitsNeeded => roster.rules.firstEggNeed;

  /// Habits that count toward the first egg now (render.mjs
  /// `habitProgress`): up to [habitsNeeded], and one short of it until every
  /// required habit (a finished turn) is among them.
  int get habitsCounted => habitProgress(roster, _zoo.habits).$1;

  /// The habits the first egg cannot come without, still to do.
  List<DaemonHabit> get habitsRequiredLeft => [
    for (final h in roster.rules.habits)
      if (roster.rules.firstEggRequire.contains(h.key) &&
          !_zoo.habits.contains(h.key))
        h,
  ];

  /// The first egg's rule in words, from the roster: `finish a turn in a
  /// harness, and any 2 more`.
  String get firstEggRule {
    final rules = roster.rules;
    final required = [
      for (final h in rules.habits)
        if (rules.firstEggRequire.contains(h.key)) _lower(h.label),
    ];
    final more = rules.firstEggNeed - required.length;
    if (required.isEmpty) return 'any ${rules.firstEggNeed}';
    return '${required.join(', ')}${more > 0 ? ', and any $more more' : ''}';
  }

  /// Habits done toward the setup egg (the second habit egg), and how many
  /// it takes; null once it has come or when the roster has none.
  (int, int)? get setupProgress {
    if (roster.rules.setupEggNeed == null || _zoo.setupEgg) return null;
    return habitProgress(roster, _zoo.habits, kind: 'setup');
  }

  /// Every egg being earned now, each at its stage (README, "Eggs").
  List<ZooEggProgress> get eggsBeingEarned =>
      zoo_rules.eggsBeingEarned(roster, _zoo, now: _now());

  /// The egg nearest to hatching: a waiting one (`p4`), else the one being
  /// earned furthest along. What the status line shows as an egg.
  ZooEggProgress? get nearestEgg =>
      zoo_rules.nearestEgg(roster, _zoo, now: _now());

  static String _lower(String label) =>
      label.isEmpty ? label : '${label[0].toLowerCase()}${label.substring(1)}';

  /// The individual in the status line, with its species' roster entry.
  ZooDaemon? get paired => _zoo.paired;
  DaemonDef? get pairedDef => roster.byId(paired?.id);

  /// An individual's traits, rolled once per species and seed.
  DaemonTraits? traitsOf(ZooDaemon? daemon) {
    if (daemon == null) return null;
    return _traits['${daemon.id} ${daemon.seed}'] ??= rollTraits(
      roster,
      daemon.id,
      daemon.seed,
    );
  }

  final _traits = <String, DaemonTraits?>{};

  /// The first egg waiting to be hatched.
  ZooEgg? get readyEgg => _zoo.eggs.firstOrNull;

  bool get needsHint => loaded && _zoo.daemons.isEmpty && !_hintSeen;

  /// Choose whose zoo this window shows: `guest`, `account:<id>`, or null
  /// while that is not known yet. A new scope forgets everything. An account
  /// is asked through [remote] (none: off); a guest's local zoo shows only
  /// when [enabled] and is otherwise off
  /// without reading anything.
  void bind(String? scope, {ZooTransport? remote, bool enabled = true}) {
    if (_disposed ||
        (scope == _scope && remote == _remote && enabled == _enabled)) {
      return;
    }
    _scope = scope;
    _remote = remote;
    _enabled = enabled;
    _source = ZooSource.none;
    _zoo = Zoo.empty;
    _local = Zoo.empty;
    _prefsRead = false;
    _off = false;
    _revision = 0;
    _hatchingEgg = null;
    _unsent.clear();
    _retry?.cancel();
    _retry = null;
    _answeredAt = null;
    _fetching = false;
    _failures = 0;
    _days.clear();
    _easterAsked.clear();
    _hintSeen = false;
    final generation = ++_generation;
    if (scope != null &&
        (!enabled || (remote == null && scope != 'guest' && !isPreview))) {
      // Nothing to ask, nothing to read: off from the start.
      _off = true;
    }
    notifyListeners();
    if (scope != null && !_off) unawaited(_load(generation));
  }

  /// A render fixture can preview a creature with the server feature off.
  /// Keep its collection in this controller only, across hide/show, and never
  /// use the guest's persisted zoo (which can later be seeded to an account).
  void showPreview() => bind(_previewScope);

  /// Daemons are off: `DAEMONS_OFF` from harnessd, or a 404 on a write. All
  /// of it goes, at once; an account is asked again later ([recheckIfDue],
  /// `zoo_changed`, a reconnect).
  void switchOff() {
    if (_disposed || _scope == null || _off) return;
    _goOff(_generation);
  }

  void _goOff(int generation) {
    final was = loaded;
    _off = true;
    _source = ZooSource.none;
    _zoo = Zoo.empty;
    _revision = 0;
    _hatchingEgg = null;
    _unsent.clear();
    _retry?.cancel();
    _retry = null;
    _failures = 0;
    _answeredAt = _now();
    if (was) debugPrint('zoo: daemons are off');
    notifyListeners();
  }

  /// Ask again when the last answer is [recheckEvery] old: no timer is kept
  /// for it; the window calls this as it syncs.
  void recheckIfDue() {
    final at = _answeredAt;
    if (_disposed ||
        _scope == null ||
        _remote == null ||
        _fetching ||
        at == null ||
        _now().difference(at) < recheckEvery) {
      return;
    }
    unawaited(_fetch(_generation));
  }

  bool _current(int generation) => !_disposed && generation == _generation;

  Future<void> _load(int generation) async {
    if (isPreview) {
      _source = ZooSource.preview;
      _hintSeen = true;
      // Start with the same unhatched egg as a new collection. The preview
      // earns its first hatch through habits; it never preselects a creature.
      _show(_previewZoo ??= Zoo.empty, baseline: true);
      return;
    }
    if (_remote == null) {
      // The durable guest zoo, retained for compatibility and test fixtures.
      await _readPrefs();
      if (!_current(generation)) return;
      _adoptLocal();
      return;
    }
    await _fetch(generation);
  }

  /// This installation's local zoo and this scope's preferences, read once,
  /// and only once daemons are on.
  Future<void> _readPrefs() async {
    if (_prefsRead) return;
    final scope = _scope!;
    final generation = _generation;
    await _saving;
    final local = await _readJson(localZooKey);
    final prefs = await _readJson(prefsKey(scope));
    if (!_current(generation) || _prefsRead) return;
    _prefsRead = true;
    _local = Zoo.fromJson(local?['zoo'], roster);
    _seeded = local?['seeded'] == true;
    for (final day in prefs?['days'] as List? ?? const []) {
      if (day is String) _days.add(day);
    }
    _hintSeen = prefs?['hintSeen'] == true;
  }

  void _adoptLocal() {
    _source = ZooSource.local;
    _revision = 0;
    _show(_local, baseline: true);
  }

  /// Show [next]. Unless it is a baseline (a first read, a seed), whatever
  /// arrived since the zoo was last shown is told to [events].
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
    for (final daemon in next.daemons) {
      final was = before.byUid(daemon.uid);
      final age = _now().difference(daemon.hatchedDate);
      if (was == null &&
          !age.isNegative &&
          age <= const Duration(seconds: 15)) {
        _events.add(ZooDaemonHatched(daemon));
      }
      if (was != null &&
          (daemon.bond > was.bond ||
              roster.versionIndex(daemon.version) >
                  roster.versionIndex(was.version))) {
        _events.add(
          ZooDaemonGrew(daemon, versionChanged: daemon.version != was.version),
        );
      }
    }
  }

  Future<void> _fetch(int generation) async {
    final remote = _remote;
    if (remote == null || !_enabled || !_current(generation)) return;
    Map<String, dynamic>? raw;
    _fetching = true;
    try {
      raw = await remote.fetch();
    } catch (error) {
      if (_current(generation)) _fetching = false;
      if (!_current(generation)) return;
      // Not an answer: whatever was known stands (on stays on, off stays
      // off), and it is asked again.
      debugPrint('zoo: read failed: $error');
      if (!loaded) _scheduleRetry(generation);
      return;
    }
    if (!_current(generation)) return;
    _fetching = false;
    if (raw == null) {
      // 404 (the server's zoo is switched off, or harnessd's is) or 401:
      // daemons are off. Nothing shows, nothing is sent.
      _goOff(generation);
      return;
    }
    await _readPrefs();
    if (!_current(generation)) return;
    _off = false;
    _answeredAt = _now();
    final wasAccount = isAccount;
    if (!wasAccount) {
      // At sign-in the guest's zoo goes first, ahead of any habit this window
      // is about to report: the server refuses a seed once the account holds
      // any daemon, egg or habit.
      if (!_seeded &&
          !_local.isEmpty &&
          !Zoo.fromJson(raw['zoo'], roster).holdsAnything) {
        _enqueueSeed(generation);
      }
      _failures = 0;
    }
    _adopt(raw, force: !wasAccount, baseline: !wasAccount);
    if (!wasAccount && _unsent.isNotEmpty) _flushUnsent(generation);
  }

  /// A failed read is asked again after 5 s, doubling up to [recheckEvery];
  /// a failed write (daemons on) after 5 s, doubling up to a minute.
  void _scheduleRetry(int generation) {
    _failures++;
    final seconds = 5 * (1 << (_failures - 1).clamp(0, 12));
    final wait = Duration(
      seconds: loaded
          ? seconds.clamp(5, 60)
          : min(seconds, recheckEvery.inSeconds),
    );
    _retry?.cancel();
    _retry = Timer(wait, () {
      if (!_current(generation)) return;
      if (!loaded) {
        unawaited(_fetch(generation));
      } else {
        _flushUnsent(generation);
      }
    });
  }

  /// Take the server's answer when it is not older than what is shown.
  bool _adopt(
    Map<String, dynamic> raw, {
    bool force = false,
    bool baseline = false,
  }) {
    final revision = raw['revision'];
    if (revision is! int) return false;
    if (!force && isAccount && revision < _revision) return false;
    _source = ZooSource.account;
    _revision = revision;
    _show(_overlayUnsent(Zoo.fromJson(raw['zoo'], roster)), baseline: baseline);
    return true;
  }

  /// This window's unacknowledged ops laid back over the server's answer, so a
  /// reply to an earlier batch does not briefly undo a later one. Eggs are
  /// never granted here: that is the server's decision.
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
          if (next.byUid(op['uid'] as String?) != null) {
            next = next.copyWith(pair: op['uid'] as String);
          }
        case 'zoo.nickname' || 'zoo.autonomy' || 'zoo.consent':
          next = applyZooOps(
            roster,
            next,
            [op],
            random: _random,
            now: _now(),
          ).zoo;
      }
    }
    return next;
  }

  /// A guest's zoo goes to the account once, first in the queue. The server
  /// applies it only while the account holds no daemon, egg or habit; its
  /// answer is a baseline (the guest's eggs come back under server ids).
  void _enqueueSeed(int generation) {
    final seed = _local.toJson();
    _enqueue(() async {
      if (!_current(generation) || _seeded) return;
      try {
        final answer = await _remote!.apply([
          {'op': 'zoo.seed', 'zoo': seed},
        ]);
        if (!_current(generation)) return;
        if (answer == null) {
          _goOff(generation);
          return;
        }
        _seeded = true;
        _saveLocal();
        _adopt(answer, baseline: true);
      } catch (error) {
        debugPrint('zoo: seed failed: $error');
      }
    });
  }

  /// `zoo_changed { revision }`: fetch only when the push is news.
  void pushed(int? revision) {
    if (_disposed || _scope == null || _remote == null) return;
    if (isAccount && revision != null && revision <= _revision) return;
    unawaited(_fetch(_generation));
  }

  /// Read again, e.g. when harnessd's backend link comes back.
  void refresh() {
    if (_disposed || _scope == null || _remote == null) return;
    unawaited(_fetch(_generation));
  }

  // ── ops ────────────────────────────────────────────────────────────────────

  /// Record a first-egg habit. Sent once; the server grants the egg.
  void habit(String key) {
    if (!loaded ||
        _zoo.habits.contains(key) ||
        !roster.rules.habits.any((h) => h.key == key)) {
      return;
    }
    final op = {'op': 'zoo.habit', 'key': key};
    if (!isAccount) {
      _applyLocal([op]);
      return;
    }
    // Optimistic for the habit only: the egg is the server's to grant.
    _show(_zoo.copyWith(habits: [..._zoo.habits, key]));
    _sendLater(op);
  }

  /// Pair the individual [uid] (`zoo.pair { uid }`).
  void pair(String uid) {
    final daemon = _zoo.byUid(uid);
    if (!loaded || daemon == null || _zoo.pair == uid) return;
    final op = {'op': 'zoo.pair', 'uid': uid};
    if (!isAccount) {
      _applyLocal([op]);
      return;
    }
    _show(_zoo.copyWith(pair: uid));
    _sendLater(op);
  }

  /// Turn the pair's autonomy dial (`zoo.autonomy`). A guest's is kept in
  /// its local zoo, and the brain hears it in `daemon_presence`.
  void autonomy(String level) {
    if (!loaded || !isZooAutonomy(level) || _zoo.autonomy == level) return;
    final op = {'op': 'zoo.autonomy', 'level': level};
    if (!isAccount) {
      _applyLocal([op]);
      return;
    }
    _show(_zoo.copyWith(autonomy: level));
    _sendLater(op);
  }

  /// The first-day answer (`zoo.consent`): whether the daemon may watch at
  /// all. Yes starts the dial at `watch`; `suggest` is a second, separate
  /// step. A guest's is kept locally and heard in `daemon_presence`.
  void consent({required bool watching}) {
    if (!loaded || _zoo.consent?.watching == watching) return;
    final op = {'op': 'zoo.consent', 'watching': watching};
    if (!isAccount) {
      _applyLocal([op]);
      return;
    }
    _show(applyZooOps(roster, _zoo, [op], random: _random, now: _now()).zoo);
    _sendLater(op);
  }

  /// Name the individual [uid] (`zoo.nickname { uid, name }`: 1-24
  /// printable characters, trimmed), or clear it with null. Answers false for
  /// a name the rules refuse.
  bool nickname(String uid, String? name) {
    final daemon = _zoo.byUid(uid);
    if (!loaded || daemon == null) return false;
    final value = name?.trim();
    if (value != null && value.isNotEmpty && !validNickname(value)) {
      return false;
    }
    final named = value == null || value.isEmpty ? null : value;
    final op = {'op': 'zoo.nickname', 'uid': uid, 'name': named};
    if (!isAccount) {
      _applyLocal([op]);
      return true;
    }
    _show(applyZooOps(roster, _zoo, [op], random: _random, now: _now()).zoo);
    _sendLater(op);
    return true;
  }

  /// Whether [word] is one of the roster's easter words (by its hash: the
  /// words themselves never ship).
  bool isEasterWord(String word) {
    final w = word.trim().toLowerCase();
    return w.isNotEmpty &&
        w.length <= 64 &&
        roster.rules.easterHashes.contains(easterHash(w));
  }

  /// An easter word typed (`xyzzy` in Cmd-O). Sent once: a word already
  /// used, or already asked for from this window, is not sent again.
  bool easter(String word) {
    final w = word.trim().toLowerCase();
    if (!loaded || !isEasterWord(w)) return false;
    final hash = easterHash(w);
    if (_zoo.easter.contains(hash) || !_easterAsked.add(hash)) return false;
    word = w;
    final op = {'op': 'zoo.easter', 'word': word};
    if (!isAccount) {
      _applyLocal([op]);
      return true;
    }
    _sendLater(op);
    return true;
  }

  /// Open an egg. The draw happens on the server for an account (here only
  /// for a local zoo); null when the egg is gone or harnessd cannot be reached.
  Future<ZooHatch?> hatch(String eggId) async {
    if (!loaded || _hatchingEgg != null) return null;
    if (!_zoo.eggs.any((e) => e.id == eggId)) return null;
    _hatchingEgg = eggId;
    notifyListeners();
    final generation = _generation;
    try {
      final op = {'op': 'zoo.hatch', 'eggId': eggId};
      if (!isAccount) {
        return _applyLocal([op]).where((h) => h.eggId == eggId).firstOrNull;
      }
      final completer = Completer<Map<String, dynamic>?>();
      _enqueue(() async {
        try {
          completer.complete(await _remote!.apply([op]));
        } catch (error) {
          completer.completeError(error);
        }
      });
      final answer = await completer.future;
      if (!_current(generation)) return null;
      if (answer == null) {
        _goOff(generation);
        return null;
      }
      final before = _zoo;
      _adopt(answer);
      final hatch = [
        for (final h in answer['hatched'] as List? ?? const [])
          ?ZooHatch.fromJson(h),
      ].where((h) => h.eggId == eggId).firstOrNull;
      return hatch == null ? null : _withIndividual(hatch, before);
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

  /// A hatch answered without the new individual's uid or seed (a server
  /// from before individuals): the individual of its species that was not
  /// there before, else the species' first.
  ZooHatch _withIndividual(ZooHatch hatch, Zoo before) {
    final own = _zoo.byUid(hatch.uid);
    if (own != null) {
      return hatch.uid != null && hatch.seed == own.seed
          ? hatch
          : ZooHatch(
              eggId: hatch.eggId,
              daemonId: hatch.daemonId,
              uid: own.uid,
              seed: own.seed,
              shiny: hatch.shiny,
              duplicate: hatch.duplicate,
              xp: hatch.xp,
              serial: hatch.serial ?? own.serial,
            );
    }
    final species = _zoo.ofSpecies(hatch.daemonId);
    final found =
        species.where((d) => before.byUid(d.uid) == null).lastOrNull ??
        species.firstOrNull;
    if (found == null) return hatch;
    return ZooHatch(
      eggId: hatch.eggId,
      daemonId: hatch.daemonId,
      uid: found.uid,
      seed: found.seed,
      shiny: hatch.shiny,
      duplicate: hatch.duplicate,
      xp: hatch.xp,
      serial: hatch.serial ?? found.serial,
    );
  }

  List<ZooHatch> _applyLocal(List<Map<String, dynamic>> ops) {
    final result = applyZooOps(roster, _zoo, ops, random: _random, now: _now());
    if (isPreview) {
      _previewZoo = result.zoo;
    } else {
      _local = result.zoo;
      _saveLocal();
    }
    _show(result.zoo);
    return result.hatched;
  }

  static final _unsafe = RegExp(r'[^A-Za-z0-9_-]');

  /// A guest's finished turns, counted here with the server's rules
  /// (`zoo.turn`: the daily cap, earned eggs, the pair's xp), [away] of them
  /// finished while the person was away. Never for an account zoo: harnessd
  /// reports those turns, and they would count twice. A preview counts them
  /// only in memory, even while its window is signed in.
  void recordTurns(int n, {required String machineId, int away = 0}) {
    if (!loaded || isAccount || (_scope != 'guest' && !isPreview) || n <= 0) {
      return;
    }
    final now = _now();
    var machine = machineId.replaceAll(_unsafe, '-');
    if (machine.isEmpty) machine = 'local';
    if (machine.length > 64) machine = machine.substring(0, 64);
    final ops = <Map<String, dynamic>>[];
    // Turns that finished while you were away (what a night egg counts).
    var awayLeft = away.clamp(0, n);
    for (var left = n; left > 0; left -= 50) {
      final chunk = min(left, 50);
      final chunkAway = min(awayLeft, chunk);
      awayLeft -= chunkAway;
      ops.add({
        'op': 'zoo.turn',
        'batchId': List.generate(
          16,
          (_) => _random.nextInt(16).toRadixString(16),
        ).join(),
        'n': chunk,
        if (chunkAway > 0) 'away': chunkAway,
        'day': localDayOf(now),
        'hour': now.hour,
        'machineId': machine,
      });
    }
    _applyLocal(ops);
  }

  void _enqueue(Future<void> Function() work) {
    _queue = _queue.then((_) => work()).catchError((_) {});
  }

  void _sendLater(Map<String, dynamic> op) {
    _unsent.add(op);
    _flushUnsent(_generation);
  }

  void _flushUnsent(int generation) {
    _enqueue(() async {
      if (!_current(generation) || _unsent.isEmpty || !isAccount) return;
      final batch = List<Map<String, dynamic>>.of(_unsent);
      Map<String, dynamic>? answer;
      try {
        answer = await _remote!.apply(batch);
      } catch (error) {
        if (!_current(generation)) return;
        debugPrint('zoo: write failed (${batch.length} ops): $error');
        // Kept, not dropped: every op is idempotent, so a retry is safe.
        _scheduleRetry(generation);
        return;
      }
      if (!_current(generation)) return;
      _failures = 0;
      if (answer == null) {
        // A 404 on a write: daemons were switched off since the read.
        _goOff(generation);
        return;
      }
      _unsent.removeRange(0, batch.length.clamp(0, _unsent.length));
      _adopt(answer);
    });
  }

  // ── local preferences: days used, the arrival hint ──────────────────────────

  /// The `days` habit: Harness used on three different local days.
  void noteDay() {
    if (!loaded) return;
    final now = _now();
    final day =
        '${now.year.toString().padLeft(4, '0')}-'
        '${now.month.toString().padLeft(2, '0')}-'
        '${now.day.toString().padLeft(2, '0')}';
    if (_days.add(day)) {
      while (_days.length > 7) {
        _days.remove((_days.toList()..sort()).first);
      }
      _savePrefs();
    }
    if (_days.length >= 3) habit('days');
  }

  int get daysUsed => _days.length;

  bool acknowledgeHint() {
    if (!needsHint) return false;
    _hintSeen = true;
    _savePrefs();
    notifyListeners();
    return true;
  }

  Future<Map?> _readJson(String key) async {
    try {
      final raw = await storage?.read(key);
      final decoded = raw == null ? null : jsonDecode(raw);
      return decoded is Map ? decoded : null;
    } catch (_) {
      // A missing or corrupt preference cannot block getting to work.
      return null;
    }
  }

  void _write(String key, Map<String, dynamic> value) {
    final data = jsonEncode(value);
    _saving = _saving.then((_) async {
      try {
        await storage?.write(key, data);
      } catch (_) {}
    });
  }

  void _saveLocal() =>
      _write(localZooKey, {'zoo': _local.toJson(), 'seeded': _seeded});

  void _savePrefs() {
    final scope = _scope;
    if (scope == null || isPreview) return;
    _write(prefsKey(scope), {
      'days': (_days.toList()..sort()),
      'hintSeen': _hintSeen,
    });
  }

  Future<void> flush() async {
    await _queue;
    await _saving;
  }

  @override
  void dispose() {
    _disposed = true;
    _retry?.cancel();
    unawaited(_events.close());
    super.dispose();
  }
}
