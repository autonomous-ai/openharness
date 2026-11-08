/// The Dart port of `daemons/tools/render.mjs`, the reference renderer. Every
/// frame it draws must match `daemons/frames.json` byte for byte
/// (`test/daemons/render_frames_test.dart` checks all of them).
///
/// Placeholders in sprites and portraits:
///   `{e}`          an eye: the mood's eye, or the lid while blinking (never in noBlinkMoods)
///   `{<part>}`     a moving part (d.parts): its `rest` glyph, or a frame of `work` every `ms` while working
///   `{<moodPart>}` a mood-driven part (d.moodParts): its value for the mood, else its idle value
///
/// The rest of this file draws what the lookbook draws around a daemon: an
/// egg's stage and its one line, the banner name and the copyable card.
/// A filled daemon (`plate: true`) has no line portrait: its portrait is a
/// baked plate (`plates.dart`), and its card shows that.
library;

import 'dart:math';

import 'individuals.dart';
import 'plates.dart';
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

/// One line for the status bar. [versionIndex] is 0, 1 or 2 (0.1, 1.0, 2.0);
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

/// The portrait for a version, falling back to the nearest one drawn. A
/// filled daemon has none: its portrait plate stands in (idle, frame 0), as
/// on its card.
List<String> portraitFor(DaemonRoster roster, DaemonDef d, String version) {
  final own = d.portraits[version];
  if (own != null) return own;
  if (d.plate) return cardPortrait(roster, d, version);
  if (d.portraits.isEmpty) return const [];
  final versions = roster.rules.versions;
  final drawn = versions.where(d.portraits.containsKey).toList();
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
/// sprite is centred on its [baseWidth] (the version's sprite, before a
/// borrowed baton or a nap's `z` is added), so those additions grow to the
/// right and the face never shifts a cell.
String statusCell(DaemonRoster roster, String sprite, [int? baseWidth]) {
  final cells = roster.rules.statusCells;
  final base = baseWidth ?? sprite.length;
  final left = max(0, ((cells - min(base, cells)) / 2).floor());
  // Always exactly cells + 2 wide (render.mjs statusCell): a borrowed baton
  // may run into the right gutter; nothing else ever reaches it.
  return ' ${' ' * left}$sprite'.padRight(cells + 2).substring(0, cells + 2);
}

/// The base width [statusCell] centres on: the version's sprite in its idle
/// mood.
int baseWidth(DaemonRoster roster, DaemonDef d, int versionIndex) =>
    renderSprite(roster, d, versionIndex, DaemonMood.idle, motion: false).length;

/// The hatchling before it has colour: every drawn cell becomes `#`.
String silhouette(String sprite) => sprite.replaceAll(RegExp(r'[^ ]'), '#');

// ── eggs (README, "Eggs") ────────────────────────────────────────────────────

/// How far along a habit egg is (render.mjs `habitProgress`): for the first
/// egg, habits count up to `firstEgg.need`, and until every required habit
/// (a finished turn) is among them at most need - 1 count; the setup egg
/// counts every known habit toward `setupEgg.need`. Unknown and repeated
/// habits count nothing. `(done, need)`.
(int, int) habitProgress(
  DaemonRoster roster,
  Iterable<String> habitsDone, {
  String kind = 'first',
}) {
  final rules = roster.rules;
  final known = {for (final h in rules.habits) h.key};
  final done = {
    for (final k in habitsDone)
      if (known.contains(k)) k,
  };
  if (kind == 'setup') {
    final need = rules.setupEggNeed ?? 0;
    return (min(done.length, need), need);
  }
  final need = rules.firstEggNeed;
  final required = rules.firstEggRequire.every(done.contains);
  return (min(done.length, required ? need : need - 1), need);
}

/// The stage an egg shows while it is earned (render.mjs `eggStage`): `p4`
/// once it is earned and waits to be opened; otherwise by done / need, `p0`
/// at none, `p1` below a third, `p2` below two thirds, `p3` from there.
String eggStage(num done, num need, {bool ready = false}) {
  if (ready) return 'p4';
  final f = need > 0 ? done / need : 0;
  if (!(f > 0)) return 'p0';
  return f < 1 / 3
      ? 'p1'
      : f < 2 / 3
      ? 'p2'
      : 'p3';
}

/// The stages an egg is baked at, in order (`plates/egg.mjs` `STAGES`):
/// earning, then opening.
const eggEarningStages = ['p0', 'p1', 'p2', 'p3', 'p4'];
const eggOpeningStages = ['rock', 'burst', 'tumble', 'open'];

/// An egg in the status line, eight cells at most (render.mjs `eggLine`):
/// `{k}` is the kind's mark; a ready egg (`p4`, or rocking as it opens)
/// blinks with [lid]. Stage `hatchling` shows the hatchling's 0.1 [sprite]
/// between the halves of its shell, `)` + sprite + `(`, or the sprite alone
/// when that does not fit.
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

// ── the banner: a daemon's name in the face from daemons/banner.json ──────────

/// A daemon's name as a banner (render.mjs `renderBanner`): every glyph padded
/// to its own widest row, `gap` columns between letters, blank rows dropped.
/// A character the face does not have is drawn as its blank.
List<String> renderBanner(DaemonBanner banner, String word) {
  final blank = banner.glyphs[' '] ?? List.filled(banner.rows, '');
  final glyphs = [
    for (final ch in word.toLowerCase().split(''))
      if (banner.glyphs[ch] ?? blank case final g)
        [
          for (final r in g)
            r.padRight(g.fold(0, (w, row) => max(w, row.length))),
        ],
  ];
  return [
    for (var r = 0; r < banner.rows; r++)
      glyphs.map((g) => g[r]).join(' ' * banner.gap).trimRight(),
  ].where((line) => line.trim().isNotEmpty).toList();
}

/// A name as the reveal's banner draws it.
List<String> bannerRows(String word) => renderBanner(daemonBanner, word);

// ── the card (a port of `daemons/tools/card.mjs`) ───────────────────────────

const cardWidth = 42;
const _cardInner = cardWidth - 4;

/// `#03/09`, or `#S/09` for a secret: secrets sit outside the numbered set.
String cardNumber(DaemonRoster roster, DaemonDef d) {
  final set = [
    for (final x in roster.daemons)
      if (!x.secret && x.drop == d.drop) x,
  ];
  final of = set.length.toString().padLeft(2, '0');
  if (d.secret) return '#S/$of';
  return '#${(set.indexOf(d) + 1).toString().padLeft(2, '0')}/$of';
}

/// Words wrapped the way card.mjs wraps them.
List<String> wrapWords(String text, int width) {
  final out = <String>[];
  var line = '';
  for (final word in text.split(' ')) {
    if ('$line $word'.trim().length > width) {
      out.add(line.trim());
      line = word;
    } else {
      line += ' $word';
    }
  }
  if (line.trim().isNotEmpty) out.add(line.trim());
  return out;
}

String eggName(String kind) => '$kind egg';

/// What a card shows as its portrait (card.mjs `cardLines`): a filled
/// daemon's portrait plate at the version, idle, frame 0; anyone else's line
/// portrait, idle and still.
List<String> cardPortrait(DaemonRoster roster, DaemonDef d, String version) {
  if (d.plate) {
    return daemonPlates.frame(
      d.id,
      PlateSize.portrait,
      version,
      DaemonMood.idle,
    );
  }
  return renderPortrait(roster, d, version, DaemonMood.idle, motion: false);
}

/// The card as lines of printable ASCII, 42 columns wide: the portrait at its
/// version (a filled daemon's portrait [plate], by default its baked one; an
/// individual's own once harnessd has drawn it), the number (secrets
/// `#S/09`), the rarity, the name with the [name] given at the hatch and the
/// serial when there are any, an individual's flags and how rare it is (with
/// its [traits]), the family, the first words and the hatched line. Never a
/// live mood: a card is a portrait, not a presence indicator.
List<String> cardLines(
  DaemonRoster roster,
  DaemonDef d, {
  String? version,
  bool shiny = false,
  int? serial,
  String? name,
  String? nickname,
  DaemonTraits? traits,
  String? hatched,
  String? egg,
  List<String>? plate,
}) {
  final v = version ?? roster.rules.versions.first;
  final drop = roster.drop(d.drop);
  String row(String s) {
    final padded = s.padRight(_cardInner);
    return '| ${padded.substring(0, _cardInner)} |';
  }

  final head =
      '${cardNumber(roster, d)}  DROP ${drop?.n ?? 1}: '
      '${(drop?.name ?? d.drop).toUpperCase()}';
  final rarity = '${shiny ? 'SHINY ' : ''}${d.rarity.toUpperCase()}';
  final called = name ?? nickname;
  final title =
      '${called != null && called.isNotEmpty ? '$called the ' : ''}'
      '${d.id} $v'
      '${serial != null ? '  #${serial.toString().padLeft(4, '0')}' : ''}';
  final portrait = plate ?? cardPortrait(roster, d, v);
  final width = portrait.fold(0, (w, l) => max(w, l.length));
  final pad = max(0, ((_cardInner - width) / 2).floor());
  final hasHatched = (hatched != null && hatched.isNotEmpty) ||
      (egg != null && egg.isNotEmpty);
  return [
    '.${'-' * (cardWidth - 2)}.',
    row('$head${' ' * max(1, _cardInner - head.length - rarity.length)}$rarity'),
    row(''),
    for (final l in portrait) row('${' ' * pad}$l'),
    row(''),
    row('  $title'),
    if (traits != null && d.traits != null) ...[
      for (final l in flagLines(
        individualFlags(roster, d.id, traits),
        _cardInner - 2,
      ))
        row('  $l'),
      row('  ${oneInText(oneIn(roster, d.id, traits))}'),
    ],
    row('  ${d.familyLine}'),
    row(''),
    for (final l in wrapWords('"${d.first}"', _cardInner - 2)) row('  $l'),
    if (hasHatched) ...[
      row(''),
      row(
        '  hatched ${hatched ?? ''}'
                '${egg != null && egg.isNotEmpty ? ', ${eggName(egg)}' : ''}'
            .replaceFirst(RegExp(r'\s+,'), ','),
      ),
    ],
    "'${'-' * (cardWidth - 2)}'",
  ];
}

/// The card for an individual in the zoo: at its version, with the name it
/// was given, its flags and `1 in N` (from its [traits]; none for seed 0,
/// the species as it was before individuals), the day it hatched, the egg it
/// came from, and its serial (`#0042`) when the server minted one (a guest's
/// has none). [plate] is its own portrait once harnessd has drawn it.
List<String> zooCardLines(
  DaemonRoster roster,
  DaemonDef d, {
  required String version,
  bool shiny = false,
  String? name,
  DaemonTraits? traits,
  String? hatched,
  String? egg,
  int? serial,
  List<String>? plate,
}) => cardLines(
  roster,
  d,
  version: version,
  shiny: shiny,
  serial: serial,
  name: name,
  traits: traits != null && traits.seed != 0 ? traits : null,
  hatched: hatched == null || hatched.length < 10
      ? null
      : hatched.substring(0, 10),
  egg: egg,
  plate: plate,
);

/// A card as it copies: a fenced code block.
String cardCodeBlock(List<String> lines) => '```\n${lines.join('\n')}\n```';

/// `[ SHINY RARE ]  #05/09`
String rarityStamp(DaemonRoster roster, DaemonDef d, {required bool shiny}) =>
    '[ ${shiny ? 'SHINY ' : ''}${d.rarity.toUpperCase()} ]  '
    '${cardNumber(roster, d)}';
