/// The daemon's lines as templates (`daemons/README.md`, Voice): a roster line
/// may hold slots, `{who}` the harness, `{q}` the question, `{recap}` the
/// turn's recap, `{n}` the count that matters, `{summary}` the brief's facts.
/// The window fills them from what it knows at the moment it speaks. A slot it
/// cannot fill takes its clause with it; a line with nothing left becomes a
/// neutral line. Never a literal `{who}`, never a made-up fact.
///
/// Plain lines (no slots) come back as they are, so this works with today's
/// roster and the templated one alike.
library;

import 'roster.dart';

final _slot = RegExp(r'\{([a-zA-Z]+)\}');

/// Sentences end at `.`, `!` or `?` followed by a space.
final _sentenceBreak = RegExp(r'(?<=[.!?])\s+');

/// Clauses inside a sentence: `, ` `; ` `: ` ` - ` and a run of two or more
/// spaces (zsh's `[1]  + done  {who}` columns).
final _clauseBreak = RegExp(r'(,\s+|;\s+|:\s+|\s+-\s+|\s{2,})');

/// The autonomy dial's levels as a person reads them (`daemons/BRAIN.md`,
/// "Autonomy dial").
const daemonAutonomyLabels = {
  'watch': 'watch',
  'suggest': 'suggest',
  'act-on-key': 'act on key',
  'act-within-rules': 'act within rules',
};

String daemonAutonomyLabel(String level) =>
    daemonAutonomyLabels[level] ?? level;

/// Whether [level] lets the daemon act on its own (above `suggest`): the
/// badge shows then, in the slot's tooltip and the panel.
bool daemonAutonomyAboveSuggest(String? level) =>
    level == 'act-on-key' || level == 'act-within-rules';

/// What each version brought, as the lookbook's growth section writes it
/// (`daemons/lookbook.html`, "growth"): tim's own log. A daemon without one
/// says the bond it reached.
const _changelogs = <String, Map<String, List<String>>>{
  'tim': {
    '0.1': ['a head and eight stubs', 'says hello'],
    '1.0': [
      'arms long enough to split a window',
      'learned your agents by name',
    ],
    '2.0': ['eight arms, one per pane', 'in-jokes from your logbook'],
  },
};

/// The changelog line a level-up shows: `tim 1.0: arms long enough to split a
/// window; learned your agents by name`.
String daemonChangelog(
  DaemonDef def,
  String version, {
  required int bond,
  required int xp,
}) {
  final log = _changelogs[def.id]?[version];
  return log == null || log.isEmpty
      ? '${def.id} $version: bond level $bond, $xp xp.'
      : '${def.id} $version: ${log.join('; ')}';
}

/// What a line may say when its own words cannot be filled.
const neutralDaemonLines = <DaemonMood, String>{
  DaemonMood.idle: 'nothing needs you.',
  DaemonMood.work: 'agents working.',
  DaemonMood.need: 'a harness needs you.',
  DaemonMood.done: 'a turn finished.',
  DaemonMood.fail: 'a turn failed.',
  DaemonMood.back: 'welcome back.',
  DaemonMood.nap: 'napping.',
  DaemonMood.boop: 'hi.',
};

/// A value as a line holds it: one line, trimmed, at most [limit] characters.
String? slotValue(String? value, {int limit = 60}) {
  if (value == null) return null;
  final flat = value.replaceAll(RegExp(r'\s+'), ' ').trim();
  if (flat.isEmpty) return null;
  if (flat.length <= limit) return flat;
  return '${flat.substring(0, limit - 3).trimRight()}...';
}

/// Whether [line] has slots to fill.
bool isDaemonTemplate(String line) => _slot.hasMatch(line);

/// [template] with its slots filled from [values], a clause dropped for each
/// slot that has no value, or null when nothing worth saying is left.
String? fillDaemonLine(String template, Map<String, String?> values) {
  if (!_slot.hasMatch(template)) return template;
  bool known(String name) => (values[name]?.isNotEmpty ?? false);
  bool missing(String text) => _slot.allMatches(text).any((m) => !known(m[1]!));
  String fill(String text) =>
      text.replaceAllMapped(_slot, (m) => values[m[1]!] ?? '');

  final kept = <String>[];
  for (final sentence in template.split(_sentenceBreak)) {
    if (sentence.trim().isEmpty) continue;
    if (!missing(sentence)) {
      kept.add(fill(sentence));
      continue;
    }
    // What is left of a sentence that lost a slot must still hold a fact:
    // a label (`E37:`) or voice v3's tag at the end (`(bell)`, `woof`) is
    // not a line on its own.
    final reduced = _dropClauses(sentence, missing);
    if (reduced != null && _slot.hasMatch(reduced)) kept.add(fill(reduced));
  }
  final line = kept.join(' ').trim();
  // Nothing left, or only punctuation and a label: not worth a line.
  if (RegExp(r'[A-Za-z0-9]').allMatches(line).length < 2) return null;
  return line;
}

/// The sentence without the clauses that hold a missing slot, or null when
/// what remains is only a label (`E37:`) or nothing.
String? _dropClauses(String sentence, bool Function(String) missing) {
  final end = RegExp(r'[.!?]+$').firstMatch(sentence)?[0] ?? '';
  final body = sentence.substring(0, sentence.length - end.length);
  // Split into clauses, keeping each separator with the clause after it.
  final parts = <(String sep, String text)>[];
  var at = 0;
  var sep = '';
  for (final m in _clauseBreak.allMatches(body)) {
    parts.add((sep, body.substring(at, m.start)));
    sep = m[0]!;
    at = m.end;
  }
  parts.add((sep, body.substring(at)));
  final keep = [
    for (final part in parts)
      if (!missing(part.$2) && part.$2.trim().isNotEmpty) part,
  ];
  if (keep.isEmpty) return null;
  final buffer = StringBuffer(keep.first.$2.trimLeft());
  for (final part in keep.skip(1)) {
    buffer
      ..write(part.$1)
      ..write(part.$2);
  }
  var text = buffer.toString().trimRight();
  text = text.replaceFirst(RegExp(r'[\s,;:\-]+$'), '');
  // A label left alone (`E37`, `[1]`) says nothing.
  if (RegExp(r'[a-z]{2,}').allMatches(text).isEmpty &&
      !keep.any((part) => part.$2.contains('{'))) {
    return null;
  }
  return '$text$end';
}

/// The daemon's line for [mood], filled from [values]; the neutral line when
/// its own words cannot be filled.
String daemonLine(DaemonDef def, DaemonMood mood, Map<String, String?> values) {
  final template = def.line(mood);
  if (template.isEmpty) return neutralDaemonLines[mood]!;
  return fillDaemonLine(template, values) ?? neutralDaemonLines[mood]!;
}

/// A preview of the line (review captures, the panel while nothing is going
/// on): filled from [values] when every slot can be, else the roster's own
/// example, else the line with what cannot be filled dropped.
String daemonPreviewLine(
  DaemonDef def,
  DaemonMood mood,
  Map<String, String?> values,
) {
  final template = def.line(mood);
  final complete = !_slot
      .allMatches(template)
      .any((m) => values[m[1]!]?.isNotEmpty != true);
  if (complete) return daemonLine(def, mood, values);
  return def.examples[mood.name] ?? daemonLine(def, mood, values);
}
