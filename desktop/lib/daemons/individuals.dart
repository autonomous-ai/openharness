/// Individuals (`daemons/README.md`, "Individuals"): a species (tim, the
/// octopus) is a type; every hatch is its own individual, with a seed the
/// server drew and the traits that follow from it. The Dart port of
/// `daemons/tools/render.mjs` `rollTraits`, `individualFlags`, `oneIn`,
/// `individualDaemon` and `renderIndividualSprite`, and of `card.mjs`
/// `flagLines` and `oneInText`; `test/daemons/render_frames_test.dart`
/// checks every one against `frames.json` (`traitRolls`,
/// `individualSprites`, the individuals' cards).
///
/// A trait is never stored as truth: only the seed is.
library;

import 'render.dart';
import 'roster.dart';

/// `plate.mjs` `rng`: mulberry32 on [seed], a stream of numbers in [0, 1).
/// Every client draws the same stream for the same seed.
double Function() plateRng(int seed) {
  var a = seed & 0xffffffff;
  // Math.imul: the low 32 bits of the product, without leaving 32 bits.
  int imul(int x, int y) =>
      (((x & 0xffff) * y) + ((((x >> 16) * y) & 0xffff) << 16)) & 0xffffffff;
  return () {
    a = (a + 0x6d2b79f5) & 0xffffffff;
    var t = a;
    t = imul(t ^ (t >> 15), t | 1);
    t = (t ^ ((t + imul(t ^ (t >> 7), t | 61)) & 0xffffffff)) & 0xffffffff;
    return ((t ^ (t >> 14)) & 0xffffffff) / 4294967296;
  };
}

/// An individual's traits (render.mjs `rollTraits`): its colour family, its
/// markings and rare extra (null: none), an odd eye, each proportion, its
/// temper and the accent its markings are painted in.
class DaemonTraits {
  const DaemonTraits({
    required this.seed,
    required this.colour,
    required this.props,
    required this.accent,
    this.marks,
    this.extra,
    this.oddEye = false,
    this.temper = 'calm',
  });

  final int seed;
  final String colour;
  final String? marks, extra;
  final bool oddEye;

  /// Each proportion, in the catalogue's order.
  final Map<String, double> props;

  /// `calm` or `fidgety`.
  final String temper;
  final String accent;

  bool get fidgety => temper == 'fidgety';

  /// The shape `frames.json` pins: the seed, colour, marks, extra and odd
  /// eye, each proportion, then the temper and accent.
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
/// [plateRng] is drawn in this order: the colour, the markings and the extra
/// (each a weighted pick), the odd eye, each proportion in the catalogue's
/// order (rounded to hundredths), and the temper. The accent is
/// `accents[seed % accents.length]`. Null for a species without a catalogue.
DaemonTraits? rollTraits(DaemonRoster roster, String id, int seed) {
  final t = roster.byId(id)?.traits;
  if (t == null) return null;
  if (seed == 0) {
    return DaemonTraits(
      seed: 0,
      colour: t.colours.first.name,
      props: {for (final k in t.props.keys) k: 1},
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
  final props = {
    for (final MapEntry(key: k, value: (lo, hi)) in t.props.entries)
      k: ((lo + (hi - lo) * r()) * 100).round() / 100,
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

/// An individual as command-line flags (render.mjs `individualFlags`):
/// `tim -c coral --spots --glasses --fidgety`. The colour always; then its
/// markings, its extra, `--odd-eye`, a proportion's flag when it falls in
/// the top fifth of its range (a `low` flag, the bottom fifth), in catalogue
/// order, and `--fidgety`.
String individualFlags(DaemonRoster roster, String id, DaemonTraits traits) {
  final t = roster.byId(id)!.traits!;
  final out = [id, '-c ${traits.colour}'];
  if (traits.marks != null) out.add('--${traits.marks}');
  if (traits.extra != null) out.add('--${traits.extra}');
  if (traits.oddEye) out.add('--odd-eye');
  for (final MapEntry(key: k, value: (lo, hi)) in t.props.entries) {
    final f = t.flags[k];
    final v = traits.props[k] ?? 1;
    if (f?.high != null && v >= hi - (hi - lo) * 0.2) out.add('--${f!.high}');
    if (f?.low != null && v <= lo + (hi - lo) * 0.2) out.add('--${f!.low}');
  }
  if (traits.fidgety) out.add('--fidgety');
  return out.join(' ');
}

/// How rare an individual's look is, as the N of `1 in N` (render.mjs
/// `oneIn`): N = round(1 / p), p the chance of its colour, its markings, its
/// extra and its eyes (odd or not) together. Proportions and temper do not
/// count.
int oneIn(DaemonRoster roster, String id, DaemonTraits traits) {
  final t = roster.byId(id)!.traits!;
  double chance<T>(List<(T, num)> list, T value) =>
      (list.where((e) => e.$1 == value).firstOrNull?.$2 ?? 0) /
      list.fold<num>(0, (a, e) => a + e.$2);
  final p =
      chance([for (final c in t.colours) (c.name, c.weight)], traits.colour) *
      chance(t.marks, traits.marks) *
      chance([for (final e in t.extras) (e.name, e.weight)], traits.extra) *
      (traits.oddEye ? t.oddEye : 1 - t.oddEye);
  return p > 0 ? (1 / p).round() : 0;
}

/// `1 in 2,130` (card.mjs `oneInText`).
String oneInText(int n) => '1 in ${n.toString().replaceAllMapped(
  RegExp(r'\B(?=(\d{3})+(?!\d))'),
  (_) => ',',
)}';

/// An individual's flags as card lines, [width] at most (card.mjs
/// `flagLines`): wrapped at spaces as a long command is, every line but the
/// last ending in ` \` and the lines after the first indented two.
List<String> flagLines(String flags, int width) {
  final words = flags.split(' ');
  final out = <String>[];
  var line = '';
  for (final (i, word) in words.indexed) {
    final indent = out.isNotEmpty ? '  ' : '';
    final next = '$indent$line $word';
    // A line that breaks keeps room for its ` \`; the last may run to the
    // edge.
    if (line.isEmpty) {
      line = word;
    } else if (next.length <= width - 2 ||
        (i == words.length - 1 && next.length <= width)) {
      line += ' $word';
    } else {
      out.add('$indent$line \\');
      line = word;
    }
  }
  out.add('${out.isNotEmpty ? '  ' : ''}$line');
  return out;
}

final _variants = Expando<Map<String, DaemonDef>>();

/// The species as an individual shows it in the status line (render.mjs
/// `individualDaemon`): a rare extra brings its own sprites and work frames,
/// and a fidgety one works at half `workMs`. Colour, markings and the odd
/// eye do not show there. Use it wherever a daemon's sprite is drawn
/// ([renderSprite], [baseWidth], [eggLine]'s hatchling).
DaemonDef? individualDaemon(
  DaemonRoster roster,
  String id,
  DaemonTraits? traits,
) {
  final d = roster.byId(id);
  if (d == null || traits == null) return d;
  final extra = d.traits?.extra(traits.extra);
  final sprites = extra?.sprites, work = extra?.work;
  final fidgety = traits.fidgety;
  if ((sprites == null || work == null) && !fidgety) return d;
  final key = '${sprites == null ? '' : traits.extra} $fidgety';
  final cache = _variants[d] ??= {};
  return cache[key] ??= d.variant(
    sprites: sprites,
    work: sprites == null ? null : work,
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
  individualDaemon(roster, id, traits)!,
  versionIndex,
  mood,
  t: t,
  lid: lid,
  motion: motion,
);

/// How an individual is called: `pip the tim` with the name it was given,
/// else `tim #0042` with its serial, else the species.
String individualName(String id, {String? name, int? serial}) =>
    name != null && name.isNotEmpty
    ? '$name the $id'
    : serial != null
    ? '$id #${serial.toString().padLeft(4, '0')}'
    : id;

/// The colour family [traits] names for species [def], its first (the
/// species' own) when it names none it knows.
DaemonTraitColour? traitColour(DaemonDef def, DaemonTraits? traits) {
  final t = def.traits;
  if (t == null) return null;
  return t.colour(traits?.colour) ?? t.colours.first;
}
