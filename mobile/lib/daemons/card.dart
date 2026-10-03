/// The Dart port of `daemons/tools/card.mjs`: the card people share and the
/// zoo as a shelf, as printable ASCII. `test/daemons/render_frames_test.dart`
/// checks every card against `daemons/frames.json`.
///
/// A card never shows a live mood: it is a portrait, not a presence indicator.
library;

import 'plates.dart';
import 'render.dart';
import 'roster.dart';
import 'zoo.dart';

const cardWidth = 42;
const _inner = cardWidth - 4;

List<DaemonDef> _regulars(DaemonRoster roster) =>
    roster.daemons.where((d) => d.rarity != 'secret').toList();

/// `#03/09`, or `#S/09` for a secret: secrets sit outside the numbered set.
String cardNumber(DaemonRoster roster, DaemonDef d) {
  final set = _regulars(roster).where((x) => x.drop == d.drop).toList();
  final of = set.length.toString().padLeft(2, '0');
  if (d.rarity == 'secret') return '#S/$of';
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
    // A line that breaks keeps room for its ` \`; the last line may run to
    // the edge.
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

/// `1 in 2,130`: a rarity's N with a comma every three digits (card.mjs
/// `oneInText`).
String oneInText(int n) =>
    '1 in ${n.toString().replaceAllMapped(RegExp(r'\B(?=(\d{3})+(?!\d))'), (_) => ',')}';

/// What a card shows of [d] at [version]: its line portrait at rest, or for a
/// daemon drawn filled its portrait plate, `idle`, frame 0 (card.mjs
/// `cardLines(..., { plate })`). A plate daemon with no baked plate — a roster
/// newer than its plates — shows its one-line sprite rather than nothing.
List<String> cardPortrait(DaemonRoster roster, DaemonDef d, String version) {
  if (!d.plate) {
    return renderPortrait(roster, d, version, DaemonMood.idle, motion: false);
  }
  final plate = daemonPlates.still(d.id, PlateSize.portrait, version);
  if (plate.isNotEmpty) return plate;
  return [
    renderSprite(
      roster,
      d,
      roster.versionIndex(version),
      DaemonMood.idle,
      motion: false,
    ),
  ];
}

/// The card as lines of printable ASCII, 42 columns wide: the portrait at its
/// version (a filled daemon's portrait plate, [plate] when given: an
/// individual's own once harnessd has drawn it), the number, rarity, name,
/// lineage and first words. An individual passes its [traits] and the [name]
/// it was given: the card says `pip the tim`, then its flags and how rare it
/// is.
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
  final drop = roster.drop(d.drop) ?? DaemonDrop(d.drop, 1, d.drop);
  String row(String s) {
    final padded = s.padRight(_inner);
    return '| ${padded.substring(0, _inner)} |';
  }

  final head =
      '${cardNumber(roster, d)}  DROP ${drop.n}: '
      '${drop.name.toUpperCase()}';
  final rarity = '${shiny ? 'SHINY ' : ''}${d.rarity.toUpperCase()}';
  final gap = _inner - head.length - rarity.length;
  final called = name ?? nickname;
  final title =
      '${called != null ? '$called the ' : ''}${d.id} $v'
      '${serial != null ? '  #${serial.toString().padLeft(4, '0')}' : ''}';
  final portrait = plate ?? cardPortrait(roster, d, v);
  final width = portrait.fold<int>(0, (w, l) => l.length > w ? l.length : w);
  final pad = ((_inner - width) / 2).floor();
  final left = ' ' * (pad < 0 ? 0 : pad);
  var stamp = '  hatched ${hatched ?? ''}${egg != null ? ', $egg egg' : ''}';
  stamp = stamp.replaceFirst(RegExp(r'\s+,'), ',');
  return [
    '.${'-' * (cardWidth - 2)}.',
    row('$head${' ' * (gap < 1 ? 1 : gap)}$rarity'),
    row(''),
    for (final line in portrait) row('$left$line'),
    row(''),
    row('  $title'),
    if (traits != null) ...[
      for (final line in flagLines(
        individualFlags(roster, d.id, traits),
        _inner - 2,
      ))
        row('  $line'),
      row('  ${oneInText(oneIn(roster, d.id, traits))}'),
    ],
    row('  ${d.familyLine}'),
    row(''),
    for (final line in wrapWords('"${d.first}"', _inner - 2)) row('  $line'),
    if (hatched != null || egg != null) ...[row(''), row(stamp)],
    "'${'-' * (cardWidth - 2)}'",
  ];
}

/// The card of an individual you own: its version, shine, serial, name, its
/// flags and how rare it is (not for seed 0, the species as it was before
/// individuals), the day it hatched and its egg; on its own portrait [plate]
/// when harnessd has drawn it. A guest's daemon (`origin: 'local'`) has no
/// serial: only the server mints.
List<String> ownedCardLines(
  DaemonRoster roster,
  DaemonDef d,
  ZooDaemon mine, {
  List<String>? plate,
}) => cardLines(
  roster,
  d,
  version: mine.version,
  shiny: mine.shiny,
  serial: mine.origin == 'local' ? null : mine.serial,
  name: mine.name,
  traits: mine.seed == 0 ? null : mine.traits(roster),
  hatched: mine.hatchedDay,
  egg: mine.egg,
  plate: plate,
);

/// The rows of [cardLines] that hold the portrait, `[from, to)`: the rows a
/// card colours with the daemon's colour, or a plate's down its gradient
/// (card.mjs `cardSvg`). Row 1 is the head, coloured by rarity.
({int from, int to}) cardPortraitRows(
  DaemonRoster roster,
  DaemonDef d,
  String version, {
  List<String>? plate,
}) => (
  from: 3,
  to: 3 + (plate ?? cardPortrait(roster, d, version)).length,
);

/// `#0042`: a serial as the card writes it.
String serialLabel(int serial) => '#${serial.toString().padLeft(4, '0')}';

/// The card as it is shared: inside a fenced code block, so it keeps its
/// columns in Slack, GitHub and a chat app.
String fencedCard(List<String> lines) => '```\n${lines.join('\n')}\n```';

/// A species on a shelf (card.mjs's `{ id, shiny, dupes }`): whether one of
/// it is shiny, and how many more of it there are than one (individuals, or
/// duplicates merged into one before individuals).
class ShelfEntry {
  const ShelfEntry(this.id, {this.shiny = false, this.dupes = 0});
  ShelfEntry.of(ZooDaemon d) : this(d.id, shiny: d.shiny, dupes: d.dupes);
  final String id;
  final bool shiny;
  final int dupes;
}

/// A zoo's individuals as shelf entries, one per species in the order it was
/// first hatched: `x3` for three tims, shiny when any of them is.
List<ShelfEntry> shelfEntriesOf(Iterable<ZooDaemon> individuals) {
  final by = <String, ShelfEntry>{};
  for (final d in individuals) {
    final had = by[d.id];
    by[d.id] = had == null
        ? ShelfEntry.of(d)
        : ShelfEntry(
            d.id,
            shiny: had.shiny || d.shiny,
            dupes: had.dupes + 1 + d.dupes,
          );
  }
  return by.values.toList();
}

/// Plain ids, none shiny, none doubled.
List<ShelfEntry> shelfEntries(Iterable<String> ids) => [
  for (final id in ids) ShelfEntry(id),
];

/// The drops a shelf shows at [now], in roster order: released ones, and
/// announced ones as silhouettes. One not yet announced, or on hold, shows
/// nowhere.
List<DaemonDrop> shelfDrops(DaemonRoster roster, DateTime now) => [
  for (final drop in roster.drops)
    if (drop.stateAt(now) != DropState.hidden) drop,
];

/// One slot on a shelf: an owned daemon's sprite, `[ ? ]` for a numbered slot
/// still empty, `[ ! ]` for a secret not found yet, or, in a drop announced
/// but not released, the `#` silhouette of a regular's 0.1 sprite.
class ShelfCell {
  const ShelfCell({
    required this.top,
    required this.label,
    required this.slot,
    this.daemon,
    this.shiny = false,
    this.count = 1,
    this.silhouette = false,
  });

  /// The sprite, a silhouette, or `[ ? ]`/`[ ! ]`.
  final String top;

  /// The daemon's id (`tim x2` with a duplicate merged in), its number
  /// (`#03`), or `secret`.
  final String label;

  /// The roster daemon this slot is for, owned or not.
  final DaemonDef slot;

  /// The owned daemon, for its colour; null for an empty slot.
  final DaemonDef? daemon;

  /// An owned one that is shiny: it wears its shiny colour.
  final bool shiny;

  /// How many of it you have had (`x2`).
  final int count;

  /// A regular of a drop announced but not released yet.
  final bool silhouette;

  bool get owned => daemon != null;
}

Map<String, ShelfEntry> _byId(Iterable<ShelfEntry> owned) => {
  for (final e in owned) e.id: e,
};

/// The shelf's slots for a drop at [now], in roster order; none for a drop not
/// announced yet or on hold.
List<ShelfCell> shelfCells(
  DaemonRoster roster,
  Iterable<ShelfEntry> owned, {
  String? drop,
  DateTime? now,
}) {
  final have = _byId(owned);
  final id = drop ?? roster.drops.first.id;
  final state =
      roster.drop(id)?.stateAt(now ?? DateTime.now()) ?? DropState.released;
  if (state == DropState.hidden) return const [];
  return [
    for (final d in roster.daemons.where((d) => d.drop == id))
      _cell(roster, d, state == DropState.released ? have[d.id] : null, state),
  ];
}

ShelfCell _cell(
  DaemonRoster roster,
  DaemonDef d,
  ShelfEntry? mine,
  DropState state,
) {
  final number = d.secret ? 'secret' : cardNumber(roster, d).substring(0, 3);
  if (state == DropState.announced) {
    return ShelfCell(
      top: d.secret
          ? '[ ! ]'
          : silhouette(
              renderSprite(roster, d, 0, DaemonMood.idle, motion: false),
            ),
      label: number,
      slot: d,
      silhouette: !d.secret,
    );
  }
  if (mine == null) {
    return ShelfCell(top: d.secret ? '[ ! ]' : '[ ? ]', label: number, slot: d);
  }
  return ShelfCell(
    top: renderSprite(
      roster,
      d,
      roster.rules.versions.length - 1,
      DaemonMood.idle,
      motion: false,
    ),
    label: mine.dupes > 0 ? '${d.id} x${mine.dupes + 1}' : d.id,
    slot: d,
    daemon: d,
    shiny: mine.shiny,
    count: mine.dupes + 1,
  );
}

/// `zoo: drop 1 unix  3/9  +secret`, or for a drop announced but not
/// released, `zoo: drop 2 bsd  out 2026-10-15`.
String shelfTitle(
  DaemonRoster roster,
  Iterable<ShelfEntry> owned, {
  String? drop,
  DateTime? now,
}) {
  final have = _byId(owned);
  final id = drop ?? roster.drops.first.id;
  final set = roster.daemons.where((d) => d.drop == id).toList();
  final info = roster.drop(id);
  final head = 'zoo: drop ${info?.n ?? 1} ${info?.name ?? id}  ';
  if (info?.stateAt(now ?? DateTime.now()) == DropState.announced) {
    return '${head}out ${info!.release}';
  }
  final count = set.where((d) => have.containsKey(d.id) && !d.secret).length;
  final of = set.where((d) => !d.secret).length;
  final secret = set.any((d) => d.secret && have.containsKey(d.id));
  return '$head$count/$of${secret ? '  +secret' : ''}';
}

/// The shelf as text, five slots to a row, ten columns each: card.mjs's
/// `shelfLines`, for sharing. The sheet lays the same [shelfCells] out to fit
/// the screen instead.
List<String> shelfLines(
  DaemonRoster roster,
  Iterable<ShelfEntry> owned, {
  String? drop,
  DateTime? now,
}) {
  final at = now ?? DateTime.now();
  final cells = shelfCells(roster, owned, drop: drop, now: at);
  if (cells.isEmpty) return const [];
  final rows = <String>[];
  for (var i = 0; i < cells.length; i += 5) {
    final slice = cells.sublist(i, i + 5 > cells.length ? cells.length : i + 5);
    rows.add(slice.map((c) => c.top.padRight(10)).join().trimRight());
    rows.add(slice.map((c) => c.label.padRight(10)).join().trimRight());
    rows.add('');
  }
  final all = [shelfTitle(roster, owned, drop: drop, now: at), '', ...rows];
  return all.sublist(0, all.length - 1);
}

/// `[ * SHINY * RARE ]  #05/09`, the hatch reveal's stamp.
String rarityStamp(DaemonRoster roster, DaemonDef d, {required bool shiny}) =>
    '[ ${shiny ? '* SHINY * ' : ''}${d.rarity.toUpperCase()} ]  '
    '${cardNumber(roster, d)}';
