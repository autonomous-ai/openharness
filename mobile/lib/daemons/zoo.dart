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
library;

import 'package:flutter/foundation.dart' show immutable;

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
    this.shiny = false,
    this.nickname,
    this.bond = 0,
    this.xp = 0,
    this.version = '0.1',
    this.dupes = 0,
    this.serial,
    this.origin,
  });
  final String id;
  final String hatchedAt;

  /// The kind of egg it came from (the card's "first egg").
  final String egg;
  final bool shiny;
  final String? nickname;
  final int bond, xp;
  final String version;

  /// Duplicates merged into it: the shelf's `x2` is one.
  final int dupes;

  /// Its mint number, the nth of its kind the server hatched (`#0042` on the
  /// card). Null on a guest's daemon and on one hatched before serials.
  final int? serial;

  /// `local`: hatched in a guest's zoo and brought in by `zoo.seed`.
  final String? origin;

  /// How many of it you have had: the shelf's `xN`.
  int get count => dupes + 1;

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
    final nickname = raw['nickname'];
    final levels = roster.rules.bondLevels;
    final storedBond = raw['bond'] is int ? raw['bond'] as int : 0;
    final xp = raw['xp'] is int && (raw['xp'] as int) >= 0
        ? raw['xp'] as int
        : levels[storedBond.clamp(0, levels.length - 1)];
    final bond = levelFor(roster, xp);
    final dupes = raw['dupes'], serial = raw['serial'], origin = raw['origin'];
    final local = origin == 'local';
    return ZooDaemon(
      id: id,
      hatchedAt: raw['hatchedAt'] is String ? raw['hatchedAt'] as String : '',
      egg: raw['egg'] is String ? raw['egg'] as String : 'first',
      shiny: raw['shiny'] == true,
      nickname: nickname is String && validNickname(nickname)
          ? nickname.trim()
          : null,
      bond: bond,
      xp: xp,
      version: versionFor(roster, bond),
      dupes: dupes is int && dupes > 0 ? dupes : 0,
      // Only the server mints, and never for a guest's daemon.
      serial: !local && serial is int && serial > 0 ? serial : null,
      origin: local ? 'local' : null,
    );
  }

  /// A second record of one id (a zoo from before duplicates merged) folded
  /// into this one, as the server reads it: counted in [dupes], shiny if
  /// either was, no xp.
  ZooDaemon fold(ZooDaemon other) => ZooDaemon(
    id: id,
    hatchedAt: hatchedAt,
    egg: egg,
    shiny: shiny || other.shiny,
    nickname: nickname,
    bond: bond,
    xp: xp,
    version: version,
    dupes: dupes + 1 + other.dupes,
    serial: serial,
    origin: origin,
  );
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
  });
  static const empty = Zoo();
  static const maxEggs = 12, maxDaemons = 64;

  /// The pair's dial, lowest first (`ZOO_AUTONOMY_LEVELS`, daemons/BRAIN.md
  /// "Autonomy dial"). The phone only reads it: the dial turns at a computer.
  static const autonomyLevels = [
    'watch',
    'suggest',
    'act-on-key',
    'act-within-rules',
  ];
  static const defaultAutonomy = 'watch';

  final List<ZooDaemon> daemons;
  final List<ZooEgg> eggs;
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

  bool owns(String id) => daemons.any((d) => d.id == id);

  /// The one record of a roster id you own, or null.
  ZooDaemon? daemon(String? id) => daemons.where((d) => d.id == id).firstOrNull;

  /// The daemon on the phone's chip: the pair, else, defensively, the first.
  ZooDaemon? get paired => daemon(pair) ?? daemons.firstOrNull;

  /// Each roster id once, first hatched first: what the shelf shows.
  List<String> get ownedIds => [for (final d in daemons) d.id];

  Zoo copyWith({
    List<String>? habits,
    String? pair,
    String? autonomy,
    ZooConsent? consent,
  }) => Zoo(
    daemons: daemons,
    eggs: eggs,
    pair: pair ?? this.pair,
    autonomy: autonomy ?? this.autonomy,
    consent: consent ?? this.consent,
    habits: habits ?? this.habits,
    firstEgg: firstEgg,
    setupEgg: setupEgg,
  );

  static Zoo fromJson(Object? raw, DaemonRoster roster) {
    if (raw is! Map) return empty;
    // One record per roster id: a zoo stored before duplicates merged reads
    // as one, the first, with the others counted in its dupes.
    final daemons = <ZooDaemon>[];
    for (final d in raw['daemons'] as List? ?? const []) {
      final daemon = ZooDaemon.fromJson(d, roster);
      if (daemon == null) continue;
      final at = daemons.indexWhere((x) => x.id == daemon.id);
      if (at >= 0) {
        daemons[at] = daemons[at].fold(daemon);
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
    final pair = raw['pair'], autonomy = raw['autonomy'];
    return Zoo(
      daemons: daemons,
      eggs: eggs.take(maxEggs).toList(),
      pair: pair is String && daemons.any((d) => d.id == pair) ? pair : null,
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
  });
  final String id;
  final int level;
  final String version;

  static ZooLevelUp? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final id = raw['id'], level = raw['level'], version = raw['version'];
    if (id is! String || level is! int || version is! String) return null;
    return ZooLevelUp(id: id, level: level, version: version);
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

/// One egg opened by `zoo.hatch`: who came out, drawn on the server. A
/// [duplicate] merged into the one you have and gave it [xp]; a new daemon
/// may carry its [serial].
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
    this.duplicate = false,
    this.xp = 0,
    this.serial,
    this.count = 1,
    this.becameShiny = false,
    this.levelUp,
    this.versionBefore,
  });
  final String eggId, daemonId;

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

  static ZooHatch? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final eggId = raw['eggId'], daemonId = raw['daemonId'];
    if (eggId is! String || daemonId is! String) return null;
    final xp = raw['xp'], serial = raw['serial'];
    return ZooHatch(
      eggId: eggId,
      daemonId: daemonId,
      shiny: raw['shiny'] == true,
      duplicate: raw['duplicate'] == true,
      xp: xp is int && xp > 0 ? xp : 0,
      serial: serial is int && serial > 0 ? serial : null,
    );
  }

  /// This hatch with what the rest of its answer said.
  ZooHatch learned({
    required int count,
    required bool becameShiny,
    int? serial,
    ZooLevelUp? levelUp,
    String? versionBefore,
  }) => ZooHatch(
    eggId: eggId,
    daemonId: daemonId,
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
