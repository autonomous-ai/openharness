/// Daemons: the roster as Dart values, read once from the generated copy of
/// `daemons/roster.json` (see `daemons/README.md`, the contract).
///
/// Adapted from the desktop's `lib/daemons/roster.dart`: this package depends
/// on no other in the repo, so it keeps its own copy of the shapes, and
/// `daemons/tools/generate.mjs` writes its own `roster.g.dart`.
library;

import 'dart:convert';
import 'dart:ui' show Color;

import 'roster.g.dart';

/// The eight moods, in the roster's order. Names match the roster's keys.
enum DaemonMood { idle, work, need, done, fail, back, nap, boop }

DaemonMood? daemonMoodNamed(String? name) =>
    DaemonMood.values.where((m) => m.name == name).firstOrNull;

class DaemonPart {
  const DaemonPart({required this.rest, required this.work, required this.ms});
  final String rest;
  final List<String> work;
  final int ms;
}

class DaemonHabit {
  const DaemonHabit(this.key, this.label);
  final String key, label;
}

/// One kind of egg (`rules.eggs[kind]`, README "Eggs"): its mark in the
/// status line's one-line egg, the shell's colours top to bottom, a night
/// egg's stars, and what it may hold.
class DaemonEggKind {
  const DaemonEggKind({
    required this.kind,
    required this.mark,
    required this.gradient,
    required this.weights,
    this.stars,
    this.boost = const {},
  });
  final String kind;

  /// `{k}` in `rules.eggLine`: first a space, setup `$`, turn `.`, week `7`,
  /// marathon `@`, night `*`, easter `?`, history `#`.
  final String mark;

  /// The shell's colour, a row at a time, as a daemon's plate runs down its
  /// gradient.
  final DaemonGradient gradient;

  /// A star cell's colour (`s`), `#rrggbb`: the night egg's pale stars.
  final String? stars;
  final Map<String, num> weights;
  final Map<String, num> boost;
}

class DaemonRules {
  DaemonRules._(Map raw)
    : moods = [for (final m in raw['moods'] as List) m as String],
      eyes = Map<String, String>.from(raw['eyes'] as Map),
      blinks = {
        for (final e in (raw['blinks'] as Map).entries)
          e.key as String: [
            for (final step in e.value as List)
              ((step as List)[0] as String, (step[1] as num).toInt()),
          ],
      },
      noBlinkMoods = [for (final m in raw['noBlinkMoods'] as List) m as String],
      holdMs = {
        for (final e in (raw['holdMs'] as Map).entries)
          e.key as String: (e.value as num).toInt(),
      },
      backFrameMs = (raw['backFrameMs'] as num).toInt(),
      versions = [for (final v in raw['versions'] as List) v as String],
      bondForVersion = {
        for (final e in (raw['bondForVersion'] as Map).entries)
          e.key as String: (e.value as num).toInt(),
      },
      xpPerTurn = ((raw['bond'] as Map?)?['xpPerTurn'] as num? ?? 1).toInt(),
      xpPerDay = ((raw['bond'] as Map?)?['xpPerDay'] as num? ?? 5).toInt(),
      bondLevels = [
        for (final l in (raw['bond'] as Map?)?['levels'] as List? ?? const [0])
          (l as num).toInt(),
      ],
      earn = DaemonEarn._(raw['earn'] as Map? ?? const {}),
      historyDates = {
        for (final e in (raw['historyDates'] as Map? ?? const {}).entries)
          e.key as String: e.value as String?,
      },
      statusCells = (raw['statusCells'] as num).toInt(),
      portraitMaxCols = (raw['portraitMaxCols'] as num).toInt(),
      portraitMaxRows = (raw['portraitMaxRows'] as num).toInt(),
      rarities = [for (final r in raw['rarities'] as List) r as String],
      shinyOneIn = (raw['shinyOneIn'] as num).toInt(),
      pityPerMiss = raw['pityPerMiss'] as num,
      duplicateXp = (raw['duplicateXp'] as num? ?? 0).toInt(),
      overflowXp = (raw['overflowXp'] as num? ?? 0).toInt(),
      firstEggNeed = ((raw['firstEgg'] as Map)['need'] as num).toInt(),
      setupEggNeed = ((raw['setupEgg'] as Map?)?['need'] as num?)?.toInt(),
      firstEggRequire = [
        for (final k
            in (raw['firstEgg'] as Map)['require'] as List? ?? const [])
          k as String,
      ],
      habits = [
        for (final h in (raw['firstEgg'] as Map)['habits'] as List)
          DaemonHabit((h as Map)['key'] as String, h['label'] as String),
      ],
      eggs = {
        for (final e in (raw['eggs'] as Map).entries)
          e.key as String: DaemonEggKind(
            kind: e.key as String,
            mark: (e.value as Map)['mark'] as String? ?? ' ',
            gradient:
                DaemonGradient._maybe(e.value['gradient']) ??
                const DaemonGradient(top: '#ffffd7', bottom: '#d7d7af'),
            stars: (e.value['stars'] as Map?)?['hex'] as String?,
            weights: Map<String, num>.from(e.value['weights'] as Map),
            boost: Map<String, num>.from(e.value['boost'] as Map? ?? const {}),
          ),
      },
      easterHashes = [
        for (final h in raw['easterHashes'] as List? ?? const []) h as String,
      ],
      eggLine = {
        for (final e in (raw['eggLine'] as Map? ?? const {}).entries)
          e.key as String: e.value as String,
      },
      lineSlots = raw['lineSlots'] == null
          ? null
          : raw['lineSlots'] is Map
          ? [for (final k in (raw['lineSlots'] as Map).keys) k as String]
          : [for (final k in raw['lineSlots'] as List) k as String],
      plate = raw['plate'] == null
          ? null
          : DaemonPlateRules._(raw['plate'] as Map);

  final List<String> moods;
  final Map<String, String> eyes;
  final Map<String, List<(String, int)>> blinks;
  final List<String> noBlinkMoods;
  final Map<String, int> holdMs;
  final int backFrameMs;
  final List<String> versions;
  final Map<String, int> bondForVersion;

  /// Bond (README, "Earning eggs and growing"): xp per counted turn, per
  /// first counted turn of a day, and the xp each level starts at.
  final int xpPerTurn, xpPerDay;
  final List<int> bondLevels;
  final DaemonEarn earn;

  /// `MM-DD` → the daemon that date's history egg gives, or null.
  final Map<String, String?> historyDates;
  final int statusCells, portraitMaxCols, portraitMaxRows;
  final List<String> rarities;
  final int shinyOneIn;
  final num pityPerMiss;

  /// xp a duplicate hatch gives the daemon it merges into, and xp an egg
  /// earned past a full queue of held eggs becomes (README, "Serials and
  /// duplicates", "A full nest").
  final int duplicateXp, overflowXp;
  final int firstEggNeed;

  /// Habits that bring the setup egg, the second habit egg (after the first);
  /// null on a roster without one.
  final int? setupEggNeed;

  /// Habits the first egg cannot come without (a finished turn).
  final List<String> firstEggRequire;
  final List<DaemonHabit> habits;
  final Map<String, DaemonEggKind> eggs;

  /// sha256 of each lowercased easter word: the words themselves never ship.
  final List<String> easterHashes;

  /// An egg in the status line, one line of at most eight cells per stage
  /// (`p0` to `p4`, `rock`, `burst`, `tumble`, `open`) and the ready egg's
  /// `blink`; `{k}` is the kind's [DaemonEggKind.mark]. See `eggLine` in
  /// `render.dart`.
  final Map<String, String> eggLine;

  /// The slots a line may carry (`{who}`, `{q}`, `{recap}`, `{n}`,
  /// `{summary}`), when the roster's lines are templates. Null for a roster
  /// whose lines are still written-out examples: those are never shown as if
  /// they were facts (see `daemon_lines.dart`).
  final List<String>? lineSlots;

  /// How a filled daemon is drawn (`rules.plate`); null on a roster without
  /// plates.
  final DaemonPlateRules? plate;

  Duration hold(DaemonMood mood) =>
      Duration(milliseconds: holdMs[mood.name] ?? 0);
}

/// How work earns eggs (`rules.earn`).
class DaemonEarn {
  DaemonEarn._(Map raw)
    : turnEvery = _int(raw, 'turn', 'every', 40),
      dailyCap = _int(raw, 'turn', 'dailyCap', 20),
      weekDays = _int(raw, 'week', 'days', 3),
      marathonTurns = _int(raw, 'marathon', 'turns', 500),
      marathonMachines = _int(raw, 'marathon', 'machines', 2),
      nights = _int(raw, 'night', 'nights', 3),
      nightFrom = _int(raw, 'night', 'fromHour', 0),
      nightTo = _int(raw, 'night', 'toHour', 4);

  static int _int(Map raw, String group, String key, int fallback) =>
      ((raw[group] as Map?)?[key] as num?)?.toInt() ?? fallback;

  final int turnEvery, dailyCap, weekDays, marathonTurns, marathonMachines;
  final int nights, nightFrom, nightTo;
}

/// How a filled daemon is drawn (`rules.plate`, README "Plates" and "Plate
/// colour"): its two baked widths, a frame every [frameMs], and the brightness
/// of each glyph of the ink.
class DaemonPlateRules {
  DaemonPlateRules._(Map raw)
    : cols = {
        for (final e in (raw['cols'] as Map).entries)
          e.key as String: (e.value as num).toInt(),
      },
      maxRows = {
        for (final e in (raw['maxRows'] as Map? ?? const {}).entries)
          e.key as String: (e.value as num).toInt(),
      },
      frameMs = (raw['frameMs'] as num).toInt(),
      idleFrames = ((raw['frames'] as Map?)?['idle'] as num? ?? 8).toInt(),
      otherFrames = ((raw['frames'] as Map?)?['other'] as num? ?? 4).toInt(),
      ink = {
        for (final e in (raw['ink'] as Map).entries)
          e.key as String: (e.value as num).toDouble(),
      },
      room = (raw['room'] as num? ?? 0).toInt(),
      light = {
        for (final e in (raw['light'] as Map? ?? const {}).entries)
          e.key as String: ((e.value as Map)['hex'] as String),
      },
      oddEye = (raw['oddEye'] as Map?)?['hex'] as String? ?? '#5fffd7',
      eggMs = DaemonEggMs._(raw['eggMs'] as Map? ?? const {});

  /// Columns of each baked width: `portrait` 28, `reveal` 56.
  final Map<String, int> cols;

  /// Rows each width may take at most: `portrait` 12, `reveal` 24.
  final Map<String, int> maxRows;
  final int frameMs, idleFrames, otherFrames;

  /// Each glyph's brightness: at most 1 mixes from the ground toward the
  /// row's colour, above 1 on toward white. A space is not drawn.
  final Map<String, double> ink;

  /// Whole portrait rows an individual's canvas may add above its species'
  /// (a hat, long tufts): its plates stay within [maxRows] plus this.
  final int room;

  /// The light inside an egg (`#rrggbb`): `plain` while it is earned, the
  /// rarity's (`common`, `rare`, `legendary`, `secret`) once it is opened,
  /// and `peek`, the eyes in a ready egg's chip.
  final Map<String, String> light;

  /// The odd eye's colour, `#rrggbb` (an individual's `e` cells).
  final String oddEye;

  /// How an egg moves (README "Eggs", Opening).
  final DaemonEggMs eggMs;
}

/// The egg's timings (`rules.plate.eggMs`): `p0` and `p4` loop a frame every
/// [loop] while they wait; opening, `rock` a frame every [rock], `burst`'s
/// first frame holds [burstHold] and the rest [burst] each, `tumble` [tumble]
/// a frame, and `open` holds [open].
class DaemonEggMs {
  DaemonEggMs._(Map raw)
    : loop = _ms(raw, 'loop', 190),
      rock = _ms(raw, 'rock', 65),
      burstHold = _ms(raw, 'burstHold', 420),
      burst = _ms(raw, 'burst', 150),
      tumble = _ms(raw, 'tumble', 75),
      open = _ms(raw, 'open', 380);

  static int _ms(Map raw, String key, int fallback) =>
      (raw[key] as num?)?.toInt() ?? fallback;

  final int loop, rock, burstHold, burst, tumble, open;
}

/// Where a drop stands on a day (card.mjs `dropState`): `released` (its
/// daemons hatch), `announced` (shelves show them as silhouettes), `hidden`
/// (not announced yet, or on hold: shown nowhere).
enum DropState { released, announced, hidden }

class DaemonDrop {
  const DaemonDrop(
    this.id,
    this.n,
    this.name, {
    this.announce,
    this.release,
    this.hold = false,
  });
  final String id;
  final int n;
  final String name;

  /// UTC days, `YYYY-MM-DD`; a drop without a release date is out. A drop on
  /// hold has none.
  final String? announce, release;

  /// Kept in the roster and never drawn, seeded, hatched or shown anywhere —
  /// no shelf, no silhouettes, no count — until it gets dates (`unix`, `tty`).
  final bool hold;

  /// Its state at [now]. Dates are UTC days that begin at 00:00 UTC. A drop
  /// on hold is hidden whatever its dates say, before they are looked at.
  DropState stateAt(DateTime now) {
    if (hold) return DropState.hidden;
    DateTime? at(String? day) =>
        day == null ? null : DateTime.tryParse('${day}T00:00:00.000Z');
    final out = at(release);
    if (out == null || !out.isAfter(now)) return DropState.released;
    final shown = at(announce);
    return shown != null && !shown.isAfter(now)
        ? DropState.announced
        : DropState.hidden;
  }
}

/// Two stops of a plate's colour, each an xterm index with its hex: row 0
/// takes [top], the last row [bottom], the rows between a mix of the two.
class DaemonGradient {
  const DaemonGradient({
    required this.top,
    required this.bottom,
    this.topXterm,
    this.bottomXterm,
  });

  static DaemonGradient? _maybe(Object? raw) {
    if (raw is! Map) return null;
    final top = raw['top'] as Map, bottom = raw['bottom'] as Map;
    return DaemonGradient(
      top: top['hex'] as String,
      bottom: bottom['hex'] as String,
      topXterm: (top['xterm'] as num?)?.toInt(),
      bottomXterm: (bottom['xterm'] as num?)?.toInt(),
    );
  }

  /// `#rrggbb`.
  final String top, bottom;
  final int? topXterm, bottomXterm;

  Color get bottomColor =>
      Color(0xff000000 | int.parse(bottom.substring(1), radix: 16));
}

/// A colour family an individual may be (`traits.colours`): its name as a
/// flag (`-c coral`), how often it is rolled, and the two stops its body runs
/// down, `#rrggbb`. The first is the species' own gradient.
class DaemonColourFamily {
  const DaemonColourFamily(this.name, this.weight, this.top, this.bottom);
  final String name;
  final num weight;
  final String top, bottom;
}

/// A rare extra (`traits.extras`): its name as a flag (`--beanie`), how often
/// it is rolled, the colour its cells are painted in, and its status-line
/// variant in the species' sprite contract ([sprites] by version, [work]
/// frames). The entry with no [name] is none.
class DaemonExtra {
  const DaemonExtra(
    this.name,
    this.weight, {
    this.hex,
    this.sprites,
    this.work,
  });
  final String? name;
  final num weight;
  final String? hex;
  final Map<String, String>? sprites;
  final List<String>? work;
}

/// A proportion (`traits.props`): its key, its range around 1, and the flag
/// it earns near an end of it (`traits.flags`).
class DaemonProportion {
  const DaemonProportion(this.key, this.lo, this.hi, {this.high, this.low});
  final String key;
  final double lo, hi;
  final String? high, low;
}

/// A plate species' trait catalogue (roster `daemons[].traits`, README
/// "Individuals"): what every individual of it is rolled from. Lists keep the
/// roster's order, which the roll depends on.
class DaemonTraitCatalogue {
  DaemonTraitCatalogue._(Map raw)
    : colours = [
        for (final c in raw['colours'] as List)
          DaemonColourFamily(
            (c as List)[0] as String,
            c[1] as num,
            c[2] as String,
            c[3] as String,
          ),
      ],
      marks = [
        for (final m in raw['marks'] as List)
          ((m as List)[0] as String?, m[1] as num),
      ],
      extras = [
        for (final e in raw['extras'] as List)
          DaemonExtra(
            (e as List)[0] as String?,
            e[1] as num,
            hex: e.length > 2 ? e[2] as String? : null,
            sprites: e.length > 3 && e[3] is Map
                ? Map<String, String>.from((e[3] as Map)['sprites'] as Map)
                : null,
            work: e.length > 3 && e[3] is Map
                ? [for (final w in (e[3] as Map)['work'] as List) w as String]
                : null,
          ),
      ],
      props = [
        for (final e in (raw['props'] as Map? ?? const {}).entries)
          DaemonProportion(
            e.key as String,
            ((e.value as List)[0] as num).toDouble(),
            (e.value[1] as num).toDouble(),
            high: ((raw['flags'] as Map?)?[e.key] as Map?)?['high'] as String?,
            low: ((raw['flags'] as Map?)?[e.key] as Map?)?['low'] as String?,
          ),
      ],
      accents = [for (final a in raw['accents'] as List) a as String],
      oddEye = (raw['oddEye'] as num).toDouble(),
      fidgety = (raw['fidgety'] as num).toDouble();

  static DaemonTraitCatalogue? _maybe(Object? raw) =>
      raw is Map ? DaemonTraitCatalogue._(raw) : null;

  final List<DaemonColourFamily> colours;

  /// Markings, a name or null (none), and a weight.
  final List<(String?, num)> marks;
  final List<DaemonExtra> extras;
  final List<DaemonProportion> props;

  /// The colours markings are painted in, `#rrggbb`.
  final List<String> accents;

  /// The chance of an odd eye, and of a fidgety temper.
  final double oddEye, fidgety;

  DaemonColourFamily? colour(String? name) =>
      colours.where((c) => c.name == name).firstOrNull;
  DaemonExtra? extra(String? name) =>
      name == null ? null : extras.where((e) => e.name == name).firstOrNull;
}

class DaemonDef {
  DaemonDef._(Map raw)
    : id = raw['id'] as String,
      n = (raw['n'] as num).toInt(),
      drop = raw['drop'] as String,
      rarity = raw['rarity'] as String,
      xterm = ((raw['color'] as Map)['xterm'] as num).toInt(),
      hex = (raw['color'] as Map)['hex'] as String,
      shinyHex = (raw['shiny'] as Map?)?['hex'] as String?,
      plate = raw['plate'] == true,
      gradient = DaemonGradient._maybe(raw['gradient']),
      shinyGradient = DaemonGradient._maybe(raw['shinyGradient']),
      family = [
        for (final f in raw['family'] as List)
          ((f as List)[0] as String, (f[1] as num?)?.toInt()),
      ],
      lore = raw['lore'] as String,
      first = raw['first'] as String,
      lines = Map<String, String>.from(raw['lines'] as Map),
      suggest = Map<String, String>.from(raw['suggest'] as Map? ?? const {}),
      eyes = raw['eyes'] == null
          ? null
          : Map<String, String>.from(raw['eyes'] as Map),
      lid = raw['lid'] as String?,
      darkOnly = raw['darkOnly'] == true,
      sprites = Map<String, String>.from(raw['sprites'] as Map),
      work = [for (final w in raw['work'] as List) w as String],
      workMs = (raw['workMs'] as num).toInt(),
      portraits = {
        for (final e in (raw['portraits'] as Map? ?? const {}).entries)
          e.key as String: [for (final l in e.value as List) l as String],
      },
      parts = {
        for (final e in (raw['parts'] as Map? ?? const {}).entries)
          e.key as String: DaemonPart(
            rest: (e.value as Map)['rest'] as String,
            work: [for (final w in e.value['work'] as List) w as String],
            ms: (e.value['ms'] as num).toInt(),
          ),
      },
      moodParts = {
        for (final e in (raw['moodParts'] as Map? ?? const {}).entries)
          e.key as String: Map<String, String>.from(e.value as Map),
      },
      turn = raw['turn'] as String? ?? '',
      examples = {
        for (final e in (raw['examples'] as Map? ?? const {}).entries)
          if (e.value is String) e.key as String: e.value as String,
      },
      traits = DaemonTraitCatalogue._maybe(raw['traits']);

  /// [base] as one individual shows it in the status line (render.mjs
  /// `individualDaemon`): a rare extra's own [sprites] and [work] frames, and
  /// a fidgety temper's [workMs]. Everything else is the species'.
  DaemonDef._individual(
    DaemonDef base, {
    Map<String, String>? sprites,
    List<String>? work,
    int? workMs,
  }) : id = base.id,
       n = base.n,
       drop = base.drop,
       rarity = base.rarity,
       xterm = base.xterm,
       hex = base.hex,
       shinyHex = base.shinyHex,
       plate = base.plate,
       gradient = base.gradient,
       shinyGradient = base.shinyGradient,
       family = base.family,
       lore = base.lore,
       first = base.first,
       lines = base.lines,
       suggest = base.suggest,
       eyes = base.eyes,
       lid = base.lid,
       darkOnly = base.darkOnly,
       sprites = sprites ?? base.sprites,
       work = work ?? base.work,
       workMs = workMs ?? base.workMs,
       portraits = base.portraits,
       parts = base.parts,
       moodParts = base.moodParts,
       turn = base.turn,
       examples = base.examples,
       traits = base.traits;

  /// This species drawn as an individual's status line shows it: see
  /// `individualDaemon` in `render.dart`, which decides what changes.
  DaemonDef asIndividual({
    Map<String, String>? sprites,
    List<String>? work,
    int? workMs,
  }) => DaemonDef._individual(
    this,
    sprites: sprites,
    work: work,
    workMs: workMs,
  );

  final String id;
  final int n;
  final String drop, rarity;
  final int xterm;
  final String hex;

  /// The colour a shiny one wears on the terminal background instead; null
  /// on a roster without one (it then wears its usual colour).
  final String? shinyHex;

  /// Drawn filled, from baked plates (`plates.g.dart`), in place of a line
  /// portrait: drop `init`. Its one-line sprite follows the line-art rules.
  final bool plate;

  /// A plate's colours, top row to bottom (README "Plate colour"), and the
  /// shiny one's; null on a line-art daemon.
  final DaemonGradient? gradient, shinyGradient;
  final List<(String, int?)> family;
  final String lore, first;
  final Map<String, String> lines, suggest;
  final Map<String, String>? eyes;
  final String? lid;
  final bool darkOnly;
  final Map<String, String> sprites;
  final List<String> work;
  final int workMs;

  /// Line portraits by version; none on a plate daemon.
  final Map<String, List<String>> portraits;
  final Map<String, DaemonPart> parts;
  final Map<String, Map<String, String>> moodParts;
  final String turn;

  /// A filled-in line per mood, for previews only (`examples[mood]`).
  final Map<String, String> examples;

  /// What an individual of this species is rolled from; null for a species
  /// without one (line art, and every daemon of a held drop).
  final DaemonTraitCatalogue? traits;

  bool get secret => rarity == 'secret';
  Color get color => _colour(hex);

  /// Its colour on the terminal background: the shiny one when [shiny].
  Color colorFor({required bool shiny}) =>
      shiny && shinyHex != null ? _colour(shinyHex!) : color;

  /// A plate's gradient: the shiny one when [shiny] and it has one.
  DaemonGradient? gradientFor({required bool shiny}) =>
      shiny && shinyGradient != null ? shinyGradient : gradient;

  static Color _colour(String hex) =>
      Color(0xff000000 | int.parse(hex.substring(1), radix: 16));
  String line(DaemonMood mood) => lines[mood.name] ?? '';

  /// `screen -> tmux -> tim`
  String get familyLine => family.map((f) => f.$1).join(' -> ');

  /// `1987 -> 2007 -> 2026`, only the years that are known.
  String get familyYears =>
      family.map((f) => f.$2).whereType<int>().join(' -> ');
}

class DaemonRoster {
  DaemonRoster._(Map raw)
    : version = (raw['version'] as num).toInt(),
      rules = DaemonRules._(raw['rules'] as Map),
      drops = [
        for (final d in raw['drops'] as List)
          DaemonDrop(
            (d as Map)['id'] as String,
            (d['n'] as num).toInt(),
            d['name'] as String,
            announce: d['announce'] as String?,
            release: d['release'] as String?,
            hold: d['hold'] == true,
          ),
      ],
      daemons = [for (final d in raw['daemons'] as List) DaemonDef._(d as Map)];

  factory DaemonRoster.parse(String json) =>
      DaemonRoster._(jsonDecode(json) as Map);

  final int version;
  final DaemonRules rules;
  final List<DaemonDrop> drops;
  final List<DaemonDef> daemons;
  late final Map<String, DaemonDef> _byId = {for (final d in daemons) d.id: d};

  DaemonDef? byId(String? id) => id == null ? null : _byId[id];
  DaemonDrop? drop(String id) => drops.where((d) => d.id == id).firstOrNull;
  int dropSize(String id) => daemons.where((d) => d.drop == id).length;

  /// 0, 1 or 2 for `0.1`, `1.0`, `2.0`; unknown versions draw as the first.
  int versionIndex(String? version) {
    final at = rules.versions.indexOf(version ?? '');
    return at < 0 ? 0 : at;
  }
}

/// The roster every surface draws from.
final daemonRoster = DaemonRoster.parse(daemonRosterJson);

/// The banner face a daemon's name is drawn in on the hatch reveal
/// (`daemons/banner.json`): [rows] rows per glyph, [gap] columns between
/// letters. See `renderBanner` in `render.dart`.
class DaemonBanner {
  DaemonBanner._(Map raw)
    : rows = (raw['rows'] as num).toInt(),
      gap = (raw['gap'] as num).toInt(),
      glyphs = {
        for (final e in (raw['glyphs'] as Map).entries)
          e.key as String: [for (final r in e.value as List) r as String],
      };

  factory DaemonBanner.parse(String json) =>
      DaemonBanner._(jsonDecode(json) as Map);

  final int rows, gap;
  final Map<String, List<String>> glyphs;
}

/// The banner face every surface draws names in.
final daemonBanner = DaemonBanner.parse(daemonBannerJson);
