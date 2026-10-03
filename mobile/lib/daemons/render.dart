/// The Dart port of `daemons/tools/render.mjs`, the reference renderer, for
/// the phone. Every frame it draws must match `daemons/frames.json` byte for
/// byte (`test/daemons/render_frames_test.dart` checks all of them: sprites,
/// portraits, status cells and banners).
///
/// Placeholders in sprites and portraits:
///   `{e}`          an eye: the mood's eye, or the lid while blinking (never in noBlinkMoods)
///   `{<part>}`     a moving part (d.parts): its `rest` glyph, or a frame of `work` every `ms` while working
///   `{<moodPart>}` a mood-driven part (d.moodParts): its value for the mood, else its idle value
///
/// The rest of this file is the egg (how far along it is, its stage and its
/// one line in the status line: [habitProgress], [eggStage], [eggLine]), the
/// individual (its roll, flags, rarity and status line: [rollTraits],
/// [individualFlags], [oneIn], [renderIndividualSprite]), the `#` silhouette,
/// and the name as a banner ([renderBanner]), each checked against
/// `frames.json`. Cards and shelves are in `card.dart`; the egg's and an
/// individual's plate colours in `plates.dart`.
library;

import 'package:flutter/foundation.dart' show immutable;

import 'roster.dart';

final _placeholder = RegExp(r'\{([a-zA-Z]+)\}');

String eyeFor(DaemonRoster roster, DaemonDef d, DaemonMood mood) =>
    d.eyes?[mood.name] ?? roster.rules.eyes[mood.name] ?? 'o';

String _fill(
  String tpl,
  DaemonRoster roster,
  DaemonDef d,
  DaemonMood mood, {
  int t = 0,
  String? lid,
  bool motion = true,
}) {
  final blinking =
      lid != null &&
      lid.isNotEmpty &&
      !roster.rules.noBlinkMoods.contains(mood.name);
  final eye = blinking ? (d.lid ?? lid) : eyeFor(roster, d, mood);
  final moving = motion && mood == DaemonMood.work;
  return tpl.replaceAllMapped(_placeholder, (match) {
    final key = match[1]!;
    if (key == 'e') return eye;
    final moodPart = d.moodParts[key];
    if (moodPart != null) return moodPart[mood.name] ?? moodPart['idle']!;
    final part = d.parts[key];
    if (part != null) {
      return moving ? part.work[(t ~/ part.ms) % part.work.length] : part.rest;
    }
    return match[0]!;
  });
}

/// One line for the status slot. [versionIndex] is 0, 1 or 2 (0.1, 1.0, 2.0);
/// [t] is milliseconds.
String renderSprite(
  DaemonRoster roster,
  DaemonDef d,
  int versionIndex,
  DaemonMood mood, {
  int t = 0,
  String? lid,
  bool motion = true,
}) {
  final rules = roster.rules;
  final last = rules.versions.length - 1;
  final moving = motion && (mood == DaemonMood.work || mood == DaemonMood.back);
  var tpl = d.sprites[rules.versions[versionIndex]]!;
  if (moving && versionIndex == last) {
    final ms = mood == DaemonMood.back ? rules.backFrameMs : d.workMs;
    tpl = d.work[(t ~/ ms) % d.work.length];
  }
  var s = _fill(tpl, roster, d, mood, t: t, lid: lid, motion: false);
  // Younger versions have no moving part yet; they borrow the twirling baton.
  if (moving && versionIndex < last && s.length <= rules.statusCells - 2) {
    s += ' ${r'|/-\'[(t ~/ 130) % 4]}';
  }
  if (mood == DaemonMood.nap && s.length < rules.statusCells) s += 'z';
  return s;
}

/// The portrait for a version, falling back to the nearest one drawn. None
/// for a daemon drawn filled: it has plates instead (`plates.dart`).
List<String> portraitFor(DaemonRoster roster, DaemonDef d, String version) {
  final own = d.portraits[version];
  if (own != null) return own;
  final versions = roster.rules.versions;
  final drawn = versions.where(d.portraits.containsKey).toList();
  if (drawn.isEmpty) return const [];
  final at = versions.indexOf(version);
  final below = drawn.where((v) => versions.indexOf(v) <= at).toList();
  return d.portraits[below.isNotEmpty ? below.last : drawn.first]!;
}

List<String> renderPortrait(
  DaemonRoster roster,
  DaemonDef d,
  String version,
  DaemonMood mood, {
  int t = 0,
  String? lid,
  bool motion = true,
}) => [
  for (final line in portraitFor(roster, d, version))
    _fill(line, roster, d, mood, t: t, lid: lid, motion: motion),
];

/// The status cell: statusCells wide plus one cell of gutter each side. The
/// sprite is centred on its [base] width (the version's sprite before a
/// borrowed baton or a nap's `z` is added), so those grow to the right and the
/// face never shifts a cell.
String statusCell(DaemonRoster roster, String sprite, [int? base]) {
  final cells = roster.rules.statusCells;
  final width = base ?? sprite.length;
  final left = ((cells - (width < cells ? width : cells)) / 2).floor();
  final pad = left < 0 ? 0 : left;
  // Always exactly cells + 2 wide: a borrowed baton may run into the right
  // gutter (render.mjs statusCell).
  final cell = ' ${' ' * pad}$sprite'.padRight(cells + 2);
  return cell.substring(0, cells + 2);
}

/// The base width [statusCell] centres on: the version's sprite in its idle
/// mood.
int baseWidth(DaemonRoster roster, DaemonDef d, int versionIndex) =>
    renderSprite(
      roster,
      d,
      versionIndex,
      DaemonMood.idle,
      motion: false,
    ).length;

/// The hatchling before it has colour: every drawn cell becomes `#`.
String silhouette(String sprite) => sprite.replaceAll(RegExp(r'[^ ]'), '#');

/// A level-up that reached a new version, in three quick frames: the old
/// sprite's shape as a `#` silhouette, the new one's, then the new sprite —
/// the hatch's own silhouette-then-colour, for a daemon that grows.
List<String> versionMorph(String from, String to) => [
  silhouette(from),
  silhouette(to),
  to,
];

// ── eggs ─────────────────────────────────────────────────────────────────────

/// How far along a habit egg is (render.mjs `habitProgress`): the first egg
/// counts known habits up to `firstEgg.need`, and until every required habit
/// (a finished turn) is among them at most need - 1; the setup egg ([kind]
/// `setup`) counts every known habit toward `setupEgg.need`. Unknown and
/// repeated habits count nothing.
({int done, int need}) habitProgress(
  DaemonRoster roster,
  Iterable<String> habitsDone, {
  String kind = 'first',
}) {
  final rules = roster.rules;
  final known = {for (final h in rules.habits) h.key};
  final done = <String>{
    for (final k in habitsDone)
      if (known.contains(k)) k,
  };
  if (kind == 'setup') {
    final need = rules.setupEggNeed ?? rules.firstEggNeed;
    return (done: done.length < need ? done.length : need, need: need);
  }
  final need = rules.firstEggNeed;
  final required = rules.firstEggRequire.every(done.contains);
  final most = required ? need : need - 1;
  return (done: done.length < most ? done.length : most, need: need);
}

/// The stages an egg is baked in (`plates/egg.mjs` STAGES): while it is
/// earned `p0` to `p4`, and as it opens `rock`, `burst`, `tumble`, `open`.
const eggStages = [
  'p0',
  'p1',
  'p2',
  'p3',
  'p4',
  'rock',
  'burst',
  'tumble',
  'open',
];

/// The stage an egg shows while it is earned (render.mjs `eggStage`): `p4`
/// once it is earned and waits to be opened; otherwise by [done] / [need],
/// `p0` at none, `p1` below a third, `p2` below two thirds, `p3` from there.
String eggStage(int done, int need, {bool ready = false}) {
  if (ready) return 'p4';
  final f = need > 0 ? done / need : 0.0;
  if (!(f > 0)) return 'p0';
  return f < 1 / 3
      ? 'p1'
      : f < 2 / 3
      ? 'p2'
      : 'p3';
}

/// An egg in the status line, eight cells at most (render.mjs `eggLine`,
/// `rules.eggLine`): `{k}` is the kind's mark, and a ready egg (`p4`, or
/// rocking as it opens) blinks with [lid]. Stage `hatchling` is the
/// hatchling's 0.1 [sprite] between the halves of its shell, `)` + sprite +
/// `(`, or the sprite alone when that does not fit.
String eggLine(
  DaemonRoster roster,
  String kind,
  String stage, {
  String? lid,
  String sprite = '',
}) {
  final rules = roster.rules;
  if (stage == 'hatchling') {
    return sprite.length + 2 <= rules.statusCells ? ')$sprite(' : sprite;
  }
  final blinking =
      lid != null && lid.isNotEmpty && (stage == 'p4' || stage == 'rock');
  final line = (blinking ? rules.eggLine['blink'] : rules.eggLine[stage]) ?? '';
  return line.replaceFirst('{k}', rules.eggs[kind]?.mark ?? ' ');
}

// ── individuals ──────────────────────────────────────────────────────────────
//
// A species (tim, the octopus) is a type; every hatch is its own individual.
// The server draws a seed; the traits follow from the species and the seed
// alone, the same on every client, from the species' catalogue. A trait is
// never stored as truth: only the seed is.

const _mask32 = 0xffffffff;

/// `Math.imul`: the low 32 bits of [a] × [b], worked in halves so no step
/// needs more than 53 bits.
int _imul(int a, int b) {
  a &= _mask32;
  b &= _mask32;
  final ah = a >> 16, al = a & 0xffff, bh = b >> 16, bl = b & 0xffff;
  return ((((ah * bl + al * bh) & 0xffff) << 16) + al * bl) & _mask32;
}

/// A small repeatable random stream from a seed (plate.mjs `rng`,
/// mulberry32), 0 <= r() < 1.
double Function() plateRng(int seed) {
  var a = seed & _mask32;
  return () {
    a = (a + 0x6d2b79f5) & _mask32;
    var t = a;
    t = _imul(t ^ (t >> 15), t | 1);
    t = (t ^ ((t + _imul(t ^ (t >> 7), t | 61)) & _mask32)) & _mask32;
    return ((t ^ (t >> 14)) & _mask32) / 4294967296;
  };
}

/// What one individual is (render.mjs `rollTraits`): its seed, colour family,
/// markings, rare extra, eyes, each proportion in catalogue order, temper and
/// the accent its markings are painted in.
@immutable
class DaemonTraits {
  const DaemonTraits({
    required this.seed,
    required this.colour,
    this.marks,
    this.extra,
    this.oddEye = false,
    this.props = const {},
    this.temper = 'calm',
    required this.accent,
  });

  final int seed;
  final String colour;
  final String? marks, extra;
  final bool oddEye;

  /// Each proportion, in the catalogue's order.
  final Map<String, double> props;

  /// `calm` or `fidgety`.
  final String temper;

  /// `#rrggbb`.
  final String accent;

  bool get fidgety => temper == 'fidgety';

  /// The traits as render.mjs writes them, keys in its order.
  Map<String, Object?> toJson() => {
    'seed': seed,
    'colour': colour,
    'marks': marks,
    'extra': extra,
    'oddEye': oddEye,
    ...props,
    'temper': temper,
    'accent': accent,
  };
}

/// The traits of an individual of species [id] hatched with [seed], a whole
/// number from 1 to 4294967295 (render.mjs `rollTraits`). Seed 0 is the
/// species as it was drawn before individuals: its first colour, no
/// markings, no extra, every proportion 1, calm. Otherwise one stream of
/// [plateRng] is drawn in this order: the colour, the markings, the extra
/// (each a weighted pick), the odd eye, each proportion in the catalogue's
/// order (rounded to hundredths), and the temper; the accent is
/// `accents[seed % accents.length]`. Null for a species without a catalogue.
DaemonTraits? rollTraits(DaemonRoster roster, String id, int seed) {
  final t = roster.byId(id)?.traits;
  if (t == null) return null;
  if (seed == 0) {
    return DaemonTraits(
      seed: 0,
      colour: t.colours.first.name,
      props: {for (final p in t.props) p.key: 1},
      accent: t.accents.first,
    );
  }
  final r = plateRng(seed);
  T pick<T>(List<(T, num)> list) {
    var x = r() * list.fold<num>(0, (a, e) => a + e.$2);
    for (final e in list) {
      if ((x -= e.$2) < 0) return e.$1;
    }
    return list.first.$1;
  }

  final colour = pick([for (final c in t.colours) (c.name, c.weight)]);
  final marks = pick(t.marks);
  final extra = pick([for (final e in t.extras) (e.name, e.weight)]);
  final oddEye = r() < t.oddEye;
  final props = <String, double>{
    for (final p in t.props) p.key: ((p.lo + (p.hi - p.lo) * r()) * 100).round() / 100,
  };
  final temper = r() < t.fidgety ? 'fidgety' : 'calm';
  return DaemonTraits(
    seed: seed,
    colour: colour,
    marks: marks,
    extra: extra,
    oddEye: oddEye,
    props: props,
    temper: temper,
    accent: t.accents[seed % t.accents.length],
  );
}

/// An individual as command-line flags (render.mjs `individualFlags`): `tim
/// -c coral --spots --glasses --fidgety`. The colour always; then its
/// markings, its extra, `--odd-eye`, a proportion's flag when it falls in the
/// top fifth of its range (or, for a `low` flag, the bottom fifth), in
/// catalogue order, and `--fidgety`.
String individualFlags(DaemonRoster roster, String id, DaemonTraits traits) {
  final t = roster.byId(id)?.traits;
  final out = [id, '-c ${traits.colour}'];
  if (traits.marks != null) out.add('--${traits.marks}');
  if (traits.extra != null) out.add('--${traits.extra}');
  if (traits.oddEye) out.add('--odd-eye');
  for (final p in t?.props ?? const <DaemonProportion>[]) {
    final v = traits.props[p.key] ?? 1;
    if (p.high != null && v >= p.hi - (p.hi - p.lo) * 0.2) out.add('--${p.high}');
    if (p.low != null && v <= p.lo + (p.hi - p.lo) * 0.2) out.add('--${p.low}');
  }
  if (traits.fidgety) out.add('--fidgety');
  return out.join(' ');
}

/// How rare an individual's look is (render.mjs `oneIn`): N in `1 in N`,
/// `round(1 / p)`, p the chance of its colour, its markings, its extra and its
/// eyes (odd or not) together. Proportions and temper do not count.
int oneIn(DaemonRoster roster, String id, DaemonTraits traits) {
  final t = roster.byId(id)!.traits!;
  double chance<T>(List<(T, num)> list, T v) {
    final total = list.fold<num>(0, (a, e) => a + e.$2);
    final hit = list.where((e) => e.$1 == v).firstOrNull;
    return (hit?.$2 ?? 0) / total;
  }

  final p =
      chance([for (final c in t.colours) (c.name, c.weight)], traits.colour) *
      chance(t.marks, traits.marks) *
      chance([for (final e in t.extras) (e.name, e.weight)], traits.extra) *
      (traits.oddEye ? t.oddEye : 1 - t.oddEye);
  return (1 / p).round();
}

/// The daemon as an individual shows it in the status line (render.mjs
/// `individualDaemon`): a rare extra brings its own sprites and work frames,
/// and a fidgety one works at half `workMs`. Colour, markings and the odd eye
/// do not show there. The species itself when neither applies.
DaemonDef individualDaemon(
  DaemonRoster roster,
  String id,
  DaemonTraits? traits,
) {
  final d = roster.byId(id)!;
  final extra = d.traits?.extra(traits?.extra);
  final fidgety = traits?.fidgety == true;
  final sprites = extra?.sprites;
  if (sprites == null && !fidgety) return d;
  return d.asIndividual(
    sprites: sprites,
    work: sprites == null ? null : extra!.work,
    // JS halves it exactly; every workMs in the roster is even.
    workMs: fidgety ? d.workMs ~/ 2 : null,
  );
}

/// [renderSprite] for an individual: its extra's sprite, and its temper's
/// pace (render.mjs `renderIndividualSprite`).
String renderIndividualSprite(
  DaemonRoster roster,
  String id,
  DaemonTraits? traits,
  int versionIndex,
  DaemonMood mood, {
  int t = 0,
  String? lid,
  bool motion = true,
}) => renderSprite(
  roster,
  individualDaemon(roster, id, traits),
  versionIndex,
  mood,
  t: t,
  lid: lid,
  motion: motion,
);

// ── the banner ───────────────────────────────────────────────────────────────

/// A daemon's name as a banner, in the face from `daemons/banner.json`: every
/// glyph padded to its own widest row, `gap` columns between letters, blank
/// rows dropped. A character the face does not have is drawn as a space.
List<String> renderBanner(DaemonBanner banner, String word) {
  final blank = banner.glyphs[' '] ?? const <String>[];
  final glyphs = [
    for (final rune in word.toLowerCase().runes)
      _padGlyph(banner.glyphs[String.fromCharCode(rune)] ?? blank),
  ];
  return [
    for (var r = 0; r < banner.rows; r++)
      [for (final g in glyphs) r < g.length ? g[r] : '']
          .join(' ' * banner.gap)
          .trimRight(),
  ].where((l) => l.trim().isNotEmpty).toList();
}

/// A glyph's rows, each padded to its widest.
List<String> _padGlyph(List<String> rows) {
  final width = rows.fold(0, (w, r) => r.length > w ? r.length : w);
  return [for (final r in rows) r.padRight(width)];
}
