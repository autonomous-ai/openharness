/// Daemons: the roster as Dart values, read once from the generated copy of
/// `daemons/roster.json` (see `daemons/README.md`, the contract).
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

/// An egg kind (`rules.eggs[kind]`, README "Eggs"): its one-line mark, the
/// gradient its shell runs down (a night egg's pale stars too), and the
/// weights and boosts a hatch draws with.
class DaemonEggKind {
  const DaemonEggKind({
    required this.kind,
    required this.mark,
    required this.weights,
    this.gradient,
    this.stars,
    this.boost = const {},
  });
  final String kind;

  /// `{k}` in `rules.eggLine`: first a space, setup `$`, turn `.`, ...
  final String mark;
  final Map<String, num> weights;
  final Map<String, num> boost;

  /// The shell's colour, top row to bottom; null in a roster without it.
  final DaemonGradient? gradient;

  /// The stars a night egg carries (`s` cells).
  final Color? stars;
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
      secretGuaranteeAt = (raw['secretGuaranteeAt'] as num? ?? 0).toInt(),
      duplicateXp = (raw['duplicateXp'] as num? ?? 0).toInt(),
      overflowXp = (raw['overflowXp'] as num? ?? 0).toInt(),
      firstEggNeed = ((raw['firstEgg'] as Map)['need'] as num).toInt(),
      firstEggRequire = [
        for (final k in (raw['firstEgg'] as Map)['require'] as List? ?? const [])
          k as String,
      ],
      setupEggNeed = ((raw['setupEgg'] as Map?)?['need'] as num?)?.toInt(),
      habits = [
        for (final h in (raw['firstEgg'] as Map)['habits'] as List)
          DaemonHabit((h as Map)['key'] as String, h['label'] as String),
      ],
      eggs = {
        for (final e in (raw['eggs'] as Map).entries)
          e.key as String: DaemonEggKind(
            kind: e.key as String,
            mark: (e.value as Map)['mark'] as String? ?? ' ',
            gradient: DaemonGradient._parse(e.value['gradient']),
            stars: DaemonDef._color(
              DaemonDef._hex((e.value['stars'] as Map?)?['hex']),
            ),
            weights: Map<String, num>.from(e.value['weights'] as Map),
            boost: Map<String, num>.from(e.value['boost'] as Map? ?? const {}),
          ),
      },
      easterHashes = [
        for (final h in raw['easterHashes'] as List? ?? const []) h as String,
      ],
      lineSlots = [
        for (final slot in raw['lineSlots'] as List? ?? defaultLineSlots)
          slot as String,
      ],
      lineExample = {
        for (final e in (raw['lineExample'] is Map
                ? raw['lineExample'] as Map
                : const {})
            .entries)
          if (e.value is String || e.value is num)
            e.key as String: '${e.value}',
      },
      eggLine = Map<String, String>.from(raw['eggLine'] as Map? ?? const {}),
      plate = raw['plate'] is Map
          ? DaemonPlateRules._(raw['plate'] as Map)
          : null;

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

  /// The pity guarantee: the hatch that would make it this many without a
  /// secret, from an egg that can hold one, draws only unowned secrets.
  final int secretGuaranteeAt;

  /// xp a duplicate gives the daemon it merges into; xp an egg earned past
  /// the held queue gives the paired daemon.
  final int duplicateXp, overflowXp;

  /// The first egg: this many habits, every one of [firstEggRequire] among
  /// them (a finished turn). Then the setup egg at [setupEggNeed] habits.
  final int firstEggNeed;
  final List<String> firstEggRequire;
  final int? setupEggNeed;
  final List<DaemonHabit> habits;
  final Map<String, DaemonEggKind> eggs;

  /// sha256 of each lowercased easter word: the words themselves never ship.
  final List<String> easterHashes;

  /// The slots a line template may use (`{who}`, `{q}`, `{recap}`, `{n}`,
  /// `{summary}`), and sample values for previews when the roster has them.
  final List<String> lineSlots;
  final Map<String, String> lineExample;
  static const defaultLineSlots = ['who', 'q', 'recap', 'n', 'summary'];

  /// An egg in the status line (README, "Eggs": "One line"), by stage:
  /// `p0`..`p4`, `blink`, `rock`, `burst`, `tumble`, `open`; `{k}` is the
  /// kind's mark.
  final Map<String, String> eggLine;

  /// How filled daemons are baked and coloured (`rules.plate`); null in a
  /// roster without them.
  final DaemonPlateRules? plate;

  Duration hold(DaemonMood mood) =>
      Duration(milliseconds: holdMs[mood.name] ?? 0);
}

/// `rules.plate` (README, "Plates"): the two widths a plate is baked at, the
/// rows each may take, the loop's frame time, and each glyph's brightness.
class DaemonPlateRules {
  DaemonPlateRules._(Map raw)
    : portraitCols = _size(raw, 'cols', 'portrait', 28),
      revealCols = _size(raw, 'cols', 'reveal', 56),
      portraitRows = _size(raw, 'maxRows', 'portrait', 12),
      revealRows = _size(raw, 'maxRows', 'reveal', 24),
      frameMs = (raw['frameMs'] as num? ?? 170).toInt(),
      room = (raw['room'] as num? ?? 0).toInt(),
      ink = {
        for (final e in (raw['ink'] as Map? ?? const {}).entries)
          e.key as String: (e.value as num).toDouble(),
      },
      light = {
        for (final e in (raw['light'] as Map? ?? const {}).entries)
          e.key as String: ?DaemonDef._color(
            DaemonDef._hex((e.value as Map?)?['hex']),
          ),
      },
      oddEye =
          DaemonDef._color(DaemonDef._hex((raw['oddEye'] as Map?)?['hex'])) ??
          const Color(0xff5fffd7),
      eggMs = DaemonEggMs._(raw['eggMs'] as Map? ?? const {});

  static int _size(Map raw, String group, String key, int fallback) =>
      ((raw[group] as Map?)?[key] as num?)?.toInt() ?? fallback;

  final int portraitCols, revealCols, portraitRows, revealRows, frameMs;

  /// Whole portrait rows an individual's canvas may add above its
  /// species' for a hat or long tufts (README, "Individual art").
  final int room;

  /// A glyph's brightness: at most 1 mixes from the background toward the
  /// row's colour, above 1 on toward white. A glyph not listed is not drawn.
  final Map<String, double> ink;

  /// The light inside an egg: `plain` while it is earned, a rarity's
  /// (`common`, `rare`, `legendary`, `secret`) once it opens, and `peek`,
  /// the eyes in the chip.
  final Map<String, Color> light;

  /// An individual's odd eye (`e` cells).
  final Color oddEye;

  /// The opening's timing.
  final DaemonEggMs eggMs;
}

/// How an egg opens (`rules.plate.eggMs`): `p0` and `p4` loop a frame every
/// [loop] ms in the nest; opening is `rock` twice through ([rock] a frame),
/// `burst` ([burstHold] for its first frame, then [burst]), `tumble`
/// ([tumble]) and `open` ([open]).
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

/// How work earns eggs (`rules.earn`).
class DaemonEarn {
  DaemonEarn._(Map raw)
    : turnEvery = _int(raw, 'turn', 'every', 40),
      dailyCap = _int(raw, 'turn', 'dailyCap', 20),
      minutesPerTurn = _int(raw, 'turn', 'minutesPerTurn', 0),
      weekDays = _int(raw, 'week', 'days', 3),
      marathonTurns = _int(raw, 'marathon', 'turns', 500),
      marathonMachines = _int(raw, 'marathon', 'machines', 2),
      nights = _int(raw, 'night', 'nights', 3),
      nightFrom = _int(raw, 'night', 'fromHour', 0),
      nightTo = _int(raw, 'night', 'toHour', 4),
      awayMinutes = _int(raw, 'night', 'awayMinutes', 30),
      historyDays = _int(raw, 'history', 'days', 1);

  static int _int(Map raw, String group, String key, int fallback) =>
      ((raw[group] as Map?)?[key] as num?)?.toInt() ?? fallback;

  final int turnEvery, dailyCap, weekDays, marathonTurns, marathonMachines;

  /// Every this many agent-minutes a turn ran counts one turn more.
  final int minutesPerTurn;

  /// Night hours (they may run past midnight: 22 to 6) and how many nights
  /// earn a night egg; a night counts only for a turn that finished while
  /// the person was away this long.
  final int nights, nightFrom, nightTo, awayMinutes;

  /// Days a history date's egg stays open from the date.
  final int historyDays;
}

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

  /// UTC days (`YYYY-MM-DD`): shown as silhouettes from [announce], drawn
  /// from [release] on. Absent: always out.
  final String? announce, release;

  /// On hold: kept in the roster without dates, and never drawn, seeded,
  /// hatched or shown, whatever its dates would say.
  final bool hold;

  static DateTime? _day(String? day) =>
      day == null ? null : DateTime.tryParse('${day}T00:00:00.000Z');

  /// `released` (its daemons hatch), `announced` (silhouettes on shelves)
  /// or `hidden`, at [now] (card.mjs `dropState`). A drop on hold is hidden
  /// before its dates are even looked at.
  String state(DateTime now) {
    if (hold) return 'hidden';
    final release = _day(this.release);
    if (release == null || !release.isAfter(now.toUtc())) return 'released';
    final announce = _day(this.announce);
    return announce != null && !announce.isAfter(now.toUtc())
        ? 'announced'
        : 'hidden';
  }

  bool releasedAt(DateTime now) => state(now) == 'released';

  /// Whether anything of it may show at [now]: released, or announced.
  bool shownAt(DateTime now) => state(now) != 'hidden';
}

/// The two stops a filled daemon's colour runs between, top row to bottom.
class DaemonGradient {
  const DaemonGradient(this.top, this.bottom);
  final Color top, bottom;

  static DaemonGradient? _parse(Object? raw) {
    if (raw is! Map) return null;
    Color? stop(String key) =>
        DaemonDef._color(DaemonDef._hex((raw[key] as Map?)?['hex']));
    final top = stop('top'), bottom = stop('bottom');
    return top == null || bottom == null ? null : DaemonGradient(top, bottom);
  }
}

class DaemonDef {
  DaemonDef._(Map raw)
    : _raw = raw,
      traits = DaemonTraitCatalogue._parse(raw['traits']),
      id = raw['id'] as String,
      n = (raw['n'] as num).toInt(),
      drop = raw['drop'] as String,
      rarity = raw['rarity'] as String,
      xterm = ((raw['color'] as Map)['xterm'] as num).toInt(),
      hex = (raw['color'] as Map)['hex'] as String,
      family = [
        for (final f in raw['family'] as List)
          ((f as List)[0] as String, (f[1] as num?)?.toInt()),
      ],
      lore = raw['lore'] as String,
      first = raw['first'] as String,
      lines = Map<String, String>.from(raw['lines'] as Map),
      examples = {
        for (final e in (raw['examples'] as Map? ?? const {}).entries)
          if (e.value is String) e.key as String: e.value as String,
      },
      shinyHex = _hex((raw['shiny'] as Map?)?['hex']) ??
          _hex((raw['color'] as Map)['shiny']),
      lightHex = _hex((raw['color'] as Map)['light']) ??
          _hex(raw['light'] is Map ? (raw['light'] as Map)['hex'] : raw['light']),
      suggest = Map<String, String>.from(raw['suggest'] as Map? ?? const {}),
      eyes = raw['eyes'] == null
          ? null
          : Map<String, String>.from(raw['eyes'] as Map),
      lid = raw['lid'] as String?,
      darkOnly = raw['darkOnly'] == true,
      sprites = Map<String, String>.from(raw['sprites'] as Map),
      work = [for (final w in raw['work'] as List) w as String],
      workMs = (raw['workMs'] as num).toInt(),
      plate = raw['plate'] == true,
      gradient = DaemonGradient._parse(raw['gradient']),
      shinyGradient = DaemonGradient._parse(raw['shinyGradient']),
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
      turn = raw['turn'] as String? ?? '';

  final Map _raw;

  /// Its trait catalogue (README, "Individuals"): the colour families,
  /// markings, rare extras and proportions every hatch rolls from. Null for
  /// a species without one.
  final DaemonTraitCatalogue? traits;

  /// This species as an individual shows it in the status line: a rare
  /// extra's own [sprites] and [work] frames, a fidgety one's [workMs]
  /// (render.mjs `individualDaemon`). Everything else stays the species'.
  DaemonDef variant({
    Map<String, String>? sprites,
    List<String>? work,
    int? workMs,
  }) => DaemonDef._({
    ..._raw,
    'sprites': ?sprites,
    'work': ?work,
    'workMs': ?workMs,
  });

  final String id;
  final int n;
  final String drop, rarity;
  final int xterm;
  final String hex;
  final List<(String, int?)> family;
  final String lore, first;
  final Map<String, String> lines, suggest;

  /// Each mood's line filled with sample values, for previews only.
  final Map<String, String> examples;

  /// The roster's own shiny and light-theme colours, when it has them.
  final String? shinyHex, lightHex;
  final Map<String, String>? eyes;
  final String? lid;
  final bool darkOnly;
  final Map<String, String> sprites;
  final List<String> work;
  final int workMs;

  /// Drawn filled (README, "Plates"): its portrait is a baked plate
  /// (`plates.dart`), coloured down [gradient] ([shinyGradient] when shiny),
  /// and it has no line [portraits]. Its status line sprite is line art.
  final bool plate;
  final DaemonGradient? gradient, shinyGradient;
  final Map<String, List<String>> portraits;
  final Map<String, DaemonPart> parts;
  final Map<String, Map<String, String>> moodParts;
  final String turn;

  bool get secret => rarity == 'secret';
  Color get color => _color(hex)!;
  Color? get shinyColor => _color(shinyHex);
  Color? get lightColor => _color(lightHex);

  static String? _hex(Object? value) =>
      value is String && RegExp(r'^#[0-9a-fA-F]{6}$').hasMatch(value)
      ? value
      : null;
  static Color? _color(String? hex) => hex == null
      ? null
      : Color(0xff000000 | int.parse(hex.substring(1), radix: 16));
  String line(DaemonMood mood) => lines[mood.name] ?? '';

  /// `screen -> tmux -> tim`
  String get familyLine => family.map((f) => f.$1).join(' -> ');

  /// `1987 -> 2007 -> 2026`, only the years that are known.
  String get familyYears =>
      family.map((f) => f.$2).whereType<int>().join(' -> ');
}

/// A colour family an individual may be (`traits.colours[i]`): its name, its
/// weight in the roll, and the gradient its body runs down.
class DaemonTraitColour {
  const DaemonTraitColour(this.name, this.weight, this.top, this.bottom);
  final String name;
  final num weight;
  final String top, bottom;
  DaemonGradient get gradient =>
      DaemonGradient(DaemonDef._color(top)!, DaemonDef._color(bottom)!);
}

/// A rare extra (`traits.extras[i]`): its name (null is none), weight, the
/// colour it is painted in, and its own status-line sprites and work frames
/// in the species' sprite contract.
class DaemonTraitExtra {
  const DaemonTraitExtra(
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
  Color? get colour => DaemonDef._color(hex);
}

/// A species' trait catalogue (`roster.json` `daemons[].traits`, README
/// "Individuals"). Lists keep the roster's order: the roll walks them, and
/// [props] is drawn in its key order.
class DaemonTraitCatalogue {
  DaemonTraitCatalogue._(Map raw)
    : colours = [
        for (final c in raw['colours'] as List)
          DaemonTraitColour(
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
          DaemonTraitExtra(
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
      props = {
        for (final e in (raw['props'] as Map).entries)
          e.key as String: (
            ((e.value as List)[0] as num).toDouble(),
            (e.value[1] as num).toDouble(),
          ),
      },
      flags = {
        for (final e in (raw['flags'] as Map? ?? const {}).entries)
          e.key as String: (
            high: (e.value as Map)['high'] as String?,
            low: e.value['low'] as String?,
          ),
      },
      accents = [for (final a in raw['accents'] as List) a as String],
      oddEye = (raw['oddEye'] as num).toDouble(),
      fidgety = (raw['fidgety'] as num).toDouble();

  static DaemonTraitCatalogue? _parse(Object? raw) =>
      raw is Map ? DaemonTraitCatalogue._(raw) : null;

  /// Colour families; the first is the species' own gradient.
  final List<DaemonTraitColour> colours;

  /// Markings: `(name, weight)`, a null name being none.
  final List<(String?, num)> marks;
  final List<DaemonTraitExtra> extras;

  /// Proportions, each `(lo, hi)` around 1, in the catalogue's order.
  final Map<String, (double, double)> props;

  /// A proportion's flag near an end of its range.
  final Map<String, ({String? high, String? low})> flags;

  /// The colours markings are painted in.
  final List<String> accents;

  /// The chance of an odd eye, and of a fidgety temper.
  final double oddEye, fidgety;

  DaemonTraitColour? colour(String? name) =>
      colours.where((c) => c.name == name).firstOrNull;
  DaemonTraitExtra? extra(String? name) =>
      name == null ? null : extras.where((e) => e.name == name).firstOrNull;
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

  /// Every daemon a draw may give at [now]: the released drops, in order.
  List<DaemonDef> released(DateTime now) => [
    for (final d in daemons)
      if (drop(d.drop)?.releasedAt(now) ?? false) d,
  ];
  int dropSize(String id) => daemons.where((d) => d.drop == id).length;

  /// The drops that may show at [now], in order: released and announced.
  /// One on hold, or not yet announced, shows nowhere.
  List<DaemonDrop> shownDrops(DateTime now) => [
    for (final d in drops)
      if (d.shownAt(now)) d,
  ];

  /// 0, 1 or 2 for `0.1`, `1.0`, `2.0`; unknown versions draw as the first.
  int versionIndex(String? version) {
    final at = rules.versions.indexOf(version ?? '');
    return at < 0 ? 0 : at;
  }
}

/// The roster every surface draws from.
final daemonRoster = DaemonRoster.parse(daemonRosterJson);

/// The banner face a daemon's name is drawn in (`daemons/banner.json`): a
/// fixed number of rows per glyph and a gap between letters.
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
