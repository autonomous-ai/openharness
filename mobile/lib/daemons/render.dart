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
/// The rest of this file draws what the lookbook draws around a daemon while it
/// hatches: the nest, the egg and the `#` silhouette (the desktop's
/// `render.dart` has the same helpers; this is a copy, not a dependency), and
/// the name as a banner ([renderBanner], checked against `frames.json` too).
/// Cards and shelves are in `card.dart`.
library;

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

/// Which nest stage the first egg shows for the habits done (render.mjs
/// nestStage): habits count up to the egg's need, and until every required
/// habit is done at most need - 1 count; the count maps evenly onto the stages.
int nestStage(DaemonRoster roster, Iterable<String> habitsDone) {
  final rules = roster.rules;
  final known = {for (final h in rules.habits) h.key};
  final done = {for (final k in habitsDone) if (known.contains(k)) k};
  final need = rules.firstEggNeed;
  final required = rules.firstEggRequire.every(done.contains);
  final counted = required
      ? (done.length < need ? done.length : need)
      : (done.length < need - 1 ? done.length : need - 1);
  final last = rules.nest.length - 1;
  return counted >= need ? last : (counted * last) ~/ need;
}

/// The nest glyph for the habits done.
String nestFor(DaemonRoster roster, Iterable<String> habitsDone) =>
    roster.rules.nest[nestStage(roster, habitsDone)];

// ── the egg, as the hatch reveal draws it ────────────────────────────────────

const _eggWidth = 18;

List<String> _eggRows(DaemonRoster roster) => [
  for (final row in roster.rules.egg) row.padRight(_eggWidth),
];

/// One frame of the egg: [offset] -1, 0 or 1 cell of wobble, [crack] 0–2.
String eggFrame(DaemonRoster roster, {int offset = 0, int crack = 0}) {
  final all = _eggRows(roster);
  final rows = all.sublist(0, all.length - 1);
  final nest = all.last;
  if (crack == 1) rows[2] = r'     | /\/  |     ';
  if (crack == 2) rows[2] = r'     |/\/\/\|     ';
  String shift(String r) => offset < 0
      ? '${r.substring(1)} '
      : offset > 0
      ? ' ${r.substring(0, r.length - 1)}'
      : r;
  return [' ' * _eggWidth, ...rows.map(shift), nest].join('\n');
}

/// The top pops off.
String eggPopFrame(DaemonRoster roster) => [
  "    '  .--.  .    ",
  r'      /\/\/\      ',
  "         '        ",
  r'     |\/\/\/|     ',
  '     |      |     ',
  r'      \    /      ',
  _eggRows(roster).last,
].join('\n');

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
