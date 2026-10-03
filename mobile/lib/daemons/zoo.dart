/// The zoo as the phone reads it: your daemons and eggs, account state the same
/// on every client (`daemons/README.md`, "The zoo"). The server is the
/// authority (`backend/src/lib/zoo.ts`); the phone is always signed in, so it
/// never draws, grants or levels anything itself.
///
/// ⚠️ **No guest zoo on the phone.** The README's guests ("a local zoo with
/// the same shape and rules, drawn on the client", sent once with `zoo.seed`)
/// are clients that run without a Harness account. The phone has no such
/// mode: it shows nothing before sign-in, so it never draws, never seeds, and
/// has no local rules to keep in step. It only reads what a guest seeded: a
/// daemon marked `origin: 'local'`, which has no serial.
///
/// This is the wire shape, read the way the desktop's `lib/daemons/zoo.dart`
/// reads it: anything this roster does not know is dropped, never an error.
///
/// **Individuals** (README "Individuals", "In the zoo"): the zoo holds one
/// record per hatch, `{ uid, id, seed, serial?, name?, shiny, xp, bond,
/// version, hatched, egg }`, and `paired` names a uid. A species (`id`, tim)
/// is a type; its individuals differ by `seed`, from which their traits are
/// rolled on every client alike (`rollTraits`, never stored). A zoo from
/// before individuals — records by species id, with `dupes` — reads as one
/// individual per record at seed 0, the species' own look, named by its
/// species id ([ZooDaemon.legacy]): ops about it go out in that zoo's shape.
library;

import 'package:flutter/foundation.dart' show immutable;

import 'render.dart' show DaemonTraits, rollTraits;
import 'roster.dart';

final _printable = RegExp(r'^[\x20-\x7e]*$');

/// A nickname: 1–24 printable ASCII characters.
bool validNickname(String? value) =>
    value != null &&
    value.trim().isNotEmpty &&
    value.trim().length <= 24 &&
    _printable.hasMatch(value);

/// Bond level for [xp]: the highest threshold of `rules.bond.levels` reached.
int levelFor(DaemonRoster roster, int xp) {
  var level = 0;
  for (var i = 0; i < roster.rules.bondLevels.length; i++) {
    if (xp >= roster.rules.bondLevels[i]) level = i;
  }
  return level;
}

/// The version a bond level has grown into (`rules.bondForVersion`).
String versionFor(DaemonRoster roster, int level) {
  var version = roster.rules.versions.first;
  for (final v in roster.rules.versions) {
    if (level >= (roster.rules.bondForVersion[v] ?? 0)) version = v;
  }
  return version;
}

class ZooDaemon {
  const ZooDaemon({
    required this.id,
    required this.hatchedAt,
    required this.egg,
    String? uid,
    this.seed = 0,
    this.shiny = false,
    this.name,
    this.bond = 0,
    this.xp = 0,
    this.version = '0.1',
    this.dupes = 0,
    this.serial,
    this.origin,
    this.legacy = false,
  }) : uid = uid ?? id;

  /// The individual: a server-made id (24 hex). A record from before
  /// individuals has none, and is named by its species [id].
  final String uid;

  /// Its species: a roster id.
  final String id;

  /// What its traits are rolled from: 1 to 4294967295, or 0 for the
  /// species as it was drawn before individuals.
  final int seed;
  final String hatchedAt;

  /// The kind of egg it came from (the card's "first egg").
  final String egg;
  final bool shiny;

  /// The name it was given at the hatch (`pip`), or null.
  final String? name;
  final int bond, xp;
  final String version;

  /// Duplicates merged into it, in a zoo from before individuals: the
  /// shelf's `x2` is one. Always 0 for an individual.
  final int dupes;

  /// Its mint number, the nth of its kind the server hatched (`#0042` on the
  /// card). Null on a guest's daemon and on one hatched before serials.
  final int? serial;

  /// `local`: hatched in a guest's zoo and brought in by `zoo.seed`.
  final String? origin;

  /// Read from a zoo stored before individuals (no `uid` on the wire): the
  /// server that sent it names it by species id, so ops do too.
  final bool legacy;

  /// How many of it you have had, before individuals: the shelf's `xN`.
  int get count => dupes + 1;

  /// Its traits (render.mjs `rollTraits`), the same on every client; null for
  /// a species without a trait catalogue.
  DaemonTraits? traits(DaemonRoster roster) => rollTraits(roster, id, seed);

  /// What it is called in a sentence: its name, else its species.
  String get called => name ?? id;

  /// What it is called where it is listed: `pip the tim`, or unnamed `tim
  /// #0042` (`tim` without a serial).
  String get title => name != null
      ? '$name the $id'
      : serial != null && origin != 'local'
      ? '$id #${serial.toString().padLeft(4, '0')}'
      : id;

  /// `2026-09-26`, or null when the server sent no usable date.
  String? get hatchedDay {
    final at = DateTime.tryParse(hatchedAt);
    if (at == null) return null;
    final local = at.toLocal();
    return '${local.year.toString().padLeft(4, '0')}-'
        '${local.month.toString().padLeft(2, '0')}-'
        '${local.day.toString().padLeft(2, '0')}';
  }

  /// Bond and version always follow xp; a daemon stored before xp reads the
  /// least xp its stored bond needs, so reading never lowers a level.
  static ZooDaemon? fromJson(Object? raw, DaemonRoster roster) {
    if (raw is! Map) return null;
    final id = raw['id'];
    if (id is! String || roster.byId(id) == null) return null;
    final uid = raw['uid'];
    final legacy = uid is! String || uid.isEmpty;
    final name = raw['name'] ?? raw['nickname'];
    final levels = roster.rules.bondLevels;
    final storedBond = raw['bond'] is int ? raw['bond'] as int : 0;
    final xp = raw['xp'] is int && (raw['xp'] as int) >= 0
        ? raw['xp'] as int
        : levels[storedBond.clamp(0, levels.length - 1)];
    final bond = levelFor(roster, xp);
    final dupes = raw['dupes'], serial = raw['serial'], origin = raw['origin'];
    final seed = raw['seed'];
    final hatched = raw['hatched'] ?? raw['hatchedAt'];
    final local = origin == 'local';
    return ZooDaemon(
      uid: legacy ? id : uid,
      id: id,
      seed: seed is int && seed > 0 && seed <= 0xffffffff ? seed : 0,
      hatchedAt: hatched is String ? hatched : '',
      egg: raw['egg'] is String ? raw['egg'] as String : 'first',
      shiny: raw['shiny'] == true,
      name: name is String && validNickname(name) ? name.trim() : null,
      bond: bond,
      xp: xp,
      version: versionFor(roster, bond),
      dupes: legacy && dupes is int && dupes > 0 ? dupes : 0,
      // Only the server mints, and never for a guest's daemon.
      serial: !local && serial is int && serial > 0 ? serial : null,
      origin: local ? 'local' : null,
      legacy: legacy,
    );
  }

  /// This one with the name [name] (null clears it).
  ZooDaemon named(String? name) => ZooDaemon(
    uid: uid,
    id: id,
    seed: seed,
    hatchedAt: hatchedAt,
    egg: egg,
    shiny: shiny,
    name: name,
    bond: bond,
    xp: xp,
    version: version,
    dupes: dupes,
    serial: serial,
    origin: origin,
    legacy: legacy,
  );

  /// A second record of one id in a zoo from before individuals (and before
  /// duplicates merged), folded into this one as that server read it:
  /// counted in [dupes], shiny if either was, no xp.
  ZooDaemon fold(ZooDaemon other) => ZooDaemon(
    uid: uid,
    id: id,
    seed: seed,
    hatchedAt: hatchedAt,
    egg: egg,
    shiny: shiny || other.shiny,
    name: name,
    bond: bond,
    xp: xp,
    version: version,
    dupes: dupes + 1 + other.dupes,
    serial: serial,
    origin: origin,
    legacy: legacy,
  );
}

/// What counts toward the eggs earned from work (`zoo.progress`, written by
/// the server): the phone only reads it, to show each egg's stage.
@immutable
class ZooProgress {
  const ZooProgress({
    this.turns = 0,
    this.days = const {},
    this.weeks = const [],
    this.nights = const [],
    this.marathon = const [],
  });

  /// Counted turns, all time.
  final int turns;

  /// Counted turns per local day (`YYYY-MM-DD`), the last 14 days.
  final Map<String, int> days;

  /// ISO weeks (`YYYY-Www`) whose week egg was earned.
  final List<String> weeks;

  /// Nights counted since the last night egg.
  final List<String> nights;

  /// Marathon eggs earned: `turns`, `machines`.
  final List<String> marathon;

  static ZooProgress? fromJson(Object? raw) {
    if (raw is! Map) return null;
    List<String> strings(Object? list) => [
      for (final v in list is List ? list : const []) ?(v is String ? v : null),
    ];
    final turns = raw['turns'], days = raw['days'];
    return ZooProgress(
      turns: turns is int && turns > 0 ? turns : 0,
      days: {
        if (days is Map)
          for (final e in days.entries)
            if (e.key is String && e.value is int) e.key as String: e.value as int,
      },
      weeks: strings(raw['weeks']),
      nights: strings(raw['nights']),
      marathon: strings(raw['marathon']),
    );
  }
}

class ZooEgg {
  const ZooEgg({
    required this.id,
    required this.kind,
    required this.grantedAt,
    this.date,
  });
  final String id, kind, grantedAt;

  /// The local day a history egg was earned on.
  final String? date;

  static ZooEgg? fromJson(Object? raw, DaemonRoster roster) {
    if (raw is! Map) return null;
    final id = raw['id'], kind = raw['kind'], date = raw['date'];
    if (id is! String || id.isEmpty || kind is! String) return null;
    if (!roster.rules.eggs.containsKey(kind)) return null;
    return ZooEgg(
      id: id,
      kind: kind,
      grantedAt: raw['grantedAt'] is String ? raw['grantedAt'] as String : '',
      date: date is String ? date : null,
    );
  }
}

/// The first-day answer (`zoo.consent`): may the daemon watch at all, and
/// when that was said. Until [watching] is true no computer senses anything
/// (`daemons/README.md`, "What your daemon sees").
@immutable
class ZooConsent {
  const ZooConsent({required this.watching, required this.at});
  final bool watching;

  /// When it was said, as the server wrote it (ISO 8601).
  final String at;

  /// `2026-09-26`, the local day it was said, or null when [at] is unreadable.
  String? get day {
    final when = DateTime.tryParse(at);
    if (when == null) return null;
    final local = when.toLocal();
    return '${local.year.toString().padLeft(4, '0')}-'
        '${local.month.toString().padLeft(2, '0')}-'
        '${local.day.toString().padLeft(2, '0')}';
  }

  /// Null unless it is a whole answer: a bool and a readable time.
  static ZooConsent? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final watching = raw['watching'], at = raw['at'];
    if (watching is! bool || at is! String || DateTime.tryParse(at) == null) {
      return null;
    }
    return ZooConsent(watching: watching, at: at);
  }
}

class Zoo {
  const Zoo({
    this.daemons = const [],
    this.eggs = const [],
    this.pair,
    this.autonomy = defaultAutonomy,
    this.consent,
    this.habits = const [],
    this.firstEgg = false,
    this.setupEgg = false,
    this.progress,
  });
  static const empty = Zoo();
  static const maxEggs = 12, maxDaemons = 256;

  /// The pair's dial, lowest first (`ZOO_AUTONOMY_LEVELS`, daemons/BRAIN.md
  /// "Autonomy dial"). The phone only reads it: the dial turns at a computer.
  static const autonomyLevels = [
    'watch',
    'suggest',
    'act-on-key',
    'act-within-rules',
  ];
  static const defaultAutonomy = 'watch';

  /// Every individual, first hatched first.
  final List<ZooDaemon> daemons;
  final List<ZooEgg> eggs;

  /// The paired individual's uid.
  final String? pair;

  /// How much the paired daemon may do on its own: one of [autonomyLevels].
  final String autonomy;

  /// The first-day answer, or null when nobody has asked yet.
  final ZooConsent? consent;

  /// The person said yes to being watched.
  bool get watching => consent?.watching == true;

  /// First-egg habits done (`rules.firstEgg.habits`).
  final List<String> habits;

  /// The first egg has been granted.
  final bool firstEgg;

  /// The setup egg (the second habit egg) has been granted.
  final bool setupEgg;

  /// What counts toward eggs earned from work; null from a server that does
  /// not send it.
  final ZooProgress? progress;

  /// Whether any individual of species [id] is yours.
  bool owns(String id) => daemons.any((d) => d.id == id);

  /// The individual [uid], or null.
  ZooDaemon? individual(String? uid) =>
      uid == null ? null : daemons.where((d) => d.uid == uid).firstOrNull;

  /// The first individual of species [id] you hatched, or null.
  ZooDaemon? daemon(String? id) => daemons.where((d) => d.id == id).firstOrNull;

  /// Every individual of species [id], first hatched first.
  List<ZooDaemon> ofSpecies(String id) => [
    for (final d in daemons)
      if (d.id == id) d,
  ];

  /// The individual on the phone's chip: the pair, else, defensively, the
  /// first.
  ZooDaemon? get paired => individual(pair) ?? daemons.firstOrNull;

  /// Each species once, first hatched first: what the shelf shows.
  List<String> get ownedIds => <String>{for (final d in daemons) d.id}.toList();

  Zoo copyWith({
    List<ZooDaemon>? daemons,
    List<String>? habits,
    String? pair,
    String? autonomy,
    ZooConsent? consent,
  }) => Zoo(
    daemons: daemons ?? this.daemons,
    eggs: eggs,
    pair: pair ?? this.pair,
    autonomy: autonomy ?? this.autonomy,
    consent: consent ?? this.consent,
    habits: habits ?? this.habits,
    firstEgg: firstEgg,
    setupEgg: setupEgg,
    progress: progress,
  );

  /// This zoo with individual [uid] named [name].
  Zoo withName(String uid, String? name) => copyWith(
    daemons: [for (final d in daemons) d.uid == uid ? d.named(name) : d],
  );

  static Zoo fromJson(Object? raw, DaemonRoster roster) {
    if (raw is! Map) return empty;
    final daemons = <ZooDaemon>[];
    for (final d in raw['daemons'] as List? ?? const []) {
      final daemon = ZooDaemon.fromJson(d, roster);
      if (daemon == null) continue;
      final at = daemons.indexWhere((x) => x.uid == daemon.uid);
      if (at >= 0) {
        // A zoo from before duplicates merged: one record per id, the
        // others counted in its dupes. An individual's uid is its own.
        if (daemon.legacy) daemons[at] = daemons[at].fold(daemon);
      } else if (daemons.length < maxDaemons) {
        daemons.add(daemon);
      }
    }
    final eggs = <ZooEgg>[];
    for (final e in raw['eggs'] as List? ?? const []) {
      final egg = ZooEgg.fromJson(e, roster);
      if (egg != null && !eggs.any((x) => x.id == egg.id)) eggs.add(egg);
    }
    final habitKeys = roster.rules.habits.map((h) => h.key).toSet();
    final autonomy = raw['autonomy'];
    // `paired` names a uid; a zoo from before names the species in `pair`,
    // which is that record's uid here.
    String? pair;
    for (final named in [raw['paired'], raw['pair']]) {
      if (named is String && daemons.any((d) => d.uid == named)) {
        pair = named;
        break;
      }
    }
    return Zoo(
      daemons: daemons,
      eggs: eggs.take(maxEggs).toList(),
      pair: pair,
      // A level this phone does not know reads as the default, as the
      // server reads one.
      autonomy: autonomy is String && autonomyLevels.contains(autonomy)
          ? autonomy
          : defaultAutonomy,
      consent: ZooConsent.fromJson(raw['consent']),
      habits: <String>{
        for (final h in raw['habits'] as List? ?? const [])
          if (h is String && habitKeys.contains(h)) h,
      }.toList(),
      firstEgg: raw['firstEgg'] == true,
      setupEgg: raw['setupEgg'] == true,
      progress: ZooProgress.fromJson(raw['progress']),
    );
  }
}

/// A daemon whose bond reached a new level in one request (`levelUps`).
@immutable
class ZooLevelUp {
  const ZooLevelUp({
    required this.id,
    required this.level,
    required this.version,
    this.uid,
  });

  /// The species, and the individual when the server names it.
  final String id;
  final String? uid;
  final int level;
  final String version;

  static ZooLevelUp? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final id = raw['id'], level = raw['level'], version = raw['version'];
    final uid = raw['uid'];
    if (id is! String || level is! int || version is! String) return null;
    return ZooLevelUp(
      id: id,
      level: level,
      version: version,
      uid: uid is String && uid.isNotEmpty ? uid : null,
    );
  }
}

/// Something that arrived during one request (`grants`): an egg in the nest
/// (`{kind, eggId}`), or, earned with 64 eggs already held, xp for the paired
/// daemon instead (`{kind, xp}`) — never an egg.
@immutable
class ZooGrant {
  const ZooGrant({required this.kind, this.eggId, this.xp});
  final String kind;
  final String? eggId;
  final int? xp;

  /// The overflow form: xp, not an egg.
  bool get isXp => eggId == null && xp != null;

  static ZooGrant? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final kind = raw['kind'], eggId = raw['eggId'], xp = raw['xp'];
    if (kind is! String) return null;
    if (eggId is String && eggId.isNotEmpty) {
      return ZooGrant(kind: kind, eggId: eggId);
    }
    if (xp is int && xp > 0) return ZooGrant(kind: kind, xp: xp);
    return null;
  }
}

/// One egg opened by `zoo.hatch`: who came out, drawn on the server — a new
/// individual ([uid], its species [daemonId], its [seed] and [serial]). From
/// a server before individuals a [duplicate] merged into the one you have and
/// gave it [xp] instead.
///
/// The rest is what the phone learned from the same answer: how many of it
/// you now have ([count]), whether a shiny duplicate made yours shiny
/// ([becameShiny]), and the level it reached ([levelUp]).
@immutable
class ZooHatch {
  const ZooHatch({
    required this.eggId,
    required this.daemonId,
    required this.shiny,
    this.uid,
    this.seed = 0,
    this.duplicate = false,
    this.xp = 0,
    this.serial,
    this.count = 1,
    this.becameShiny = false,
    this.levelUp,
    this.versionBefore,
  });
  final String eggId, daemonId;

  /// The new individual; null from a server before individuals (or until the
  /// answer's zoo names it).
  final String? uid;

  /// What its traits are rolled from.
  final int seed;

  /// This hatch's own roll.
  final bool shiny;
  final bool duplicate;
  final int xp;
  final int? serial;
  final int count;
  final bool becameShiny;
  final ZooLevelUp? levelUp;

  /// The version it was before a [levelUp], to tell a new version.
  final String? versionBefore;

  bool get grewVersion =>
      levelUp != null &&
      versionBefore != null &&
      levelUp!.version != versionBefore;

  /// `hatched[i]`: `{ eggId, uid, id | daemonId, seed, shiny, serial? }`, or
  /// the individual under `daemon`; before individuals `{ eggId, daemonId,
  /// shiny, duplicate?, xp?, serial? }`.
  static ZooHatch? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final nested = raw['daemon'] is Map
        ? raw['daemon'] as Map
        : raw['individual'] is Map
        ? raw['individual'] as Map
        : const {};
    Object? field(String key) => raw[key] ?? nested[key];
    final eggId = raw['eggId'];
    final daemonId = raw['daemonId'] ?? field('id');
    if (eggId is! String || daemonId is! String) return null;
    final xp = raw['xp'], serial = field('serial');
    final uid = field('uid'), seed = field('seed');
    return ZooHatch(
      eggId: eggId,
      daemonId: daemonId,
      uid: uid is String && uid.isNotEmpty ? uid : null,
      seed: seed is int && seed > 0 && seed <= 0xffffffff ? seed : 0,
      shiny: field('shiny') == true,
      duplicate: raw['duplicate'] == true,
      xp: xp is int && xp > 0 ? xp : 0,
      serial: serial is int && serial > 0 ? serial : null,
    );
  }

  /// This hatch with what the rest of its answer said.
  ZooHatch learned({
    required int count,
    required bool becameShiny,
    String? uid,
    int? seed,
    int? serial,
    ZooLevelUp? levelUp,
    String? versionBefore,
  }) => ZooHatch(
    eggId: eggId,
    daemonId: daemonId,
    uid: this.uid ?? uid,
    seed: this.seed != 0 ? this.seed : seed ?? 0,
    shiny: shiny,
    duplicate: duplicate,
    xp: xp,
    serial: this.serial ?? serial,
    count: count,
    becameShiny: becameShiny,
    levelUp: levelUp,
    versionBefore: versionBefore,
  );
}
