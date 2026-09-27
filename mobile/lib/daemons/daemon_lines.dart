/// What the daemon says on the phone: one line for its mood, lowercase, and
/// every word of it true (`daemons/README.md`, Voice).
///
/// A roster line is a template once the roster declares `rules.lineSlots`:
/// `{who}` a harness, `{q}` its question, `{n}` a count, `{recap}` and
/// `{summary}` what the pair brain writes. The phone fills what it knows and
/// drops the clause around a slot it cannot fill; a line with nothing left
/// becomes a neutral line of plain facts. A literal `{who}` is never shown.
///
/// Voice v3: the lines that need you (`need`, `fail`) are facts first, the
/// daemon's joke a short tag at the end after two spaces — `codex: run the
/// migration?  (bell)`. When the phone cannot fill the facts (a question with
/// no words, a failure it has no recap for) it says its own plain facts and
/// keeps the tag: `docs failed to start.  (pane is dead)`.
///
/// Before the roster has slots its lines are written-out examples ("codex
/// finished the refactor. 3 files, tests pass.") that would read as facts, so
/// the phone speaks the neutral line instead — except for a boop, which is
/// only ever the daemon talking about itself.
library;

import 'package:flutter/foundation.dart';

import 'roster.dart';

/// The facts a line may carry, as the phone knows them.
@immutable
class DaemonFacts {
  const DaemonFacts({
    this.waiting = const [],
    this.working = const [],
    this.failing = const [],
    this.harnesses = 0,
  });

  /// Harnesses waiting on you, with the question each asks (null when the
  /// question has no words the phone can show).
  final List<({String who, String? q})> waiting;

  /// Harnesses mid-turn, by name.
  final List<String> working;

  /// Harnesses you have open that failed to start, by name.
  final List<String> failing;

  /// Every harness the phone can reach.
  final int harnesses;
}

final _slot = RegExp(r'\{([a-zA-Z]+)\}');

/// [template] with its slots filled from [values]. A sentence holding a slot
/// with no value is dropped whole; null when nothing is left worth saying.
String? fillLine(String template, Map<String, String?> values) {
  final sentences = template
      .split(RegExp(r'(?<=[.!?;])\s+'))
      .where((s) => s.trim().isNotEmpty);
  final kept = <String>[];
  for (final sentence in sentences) {
    final missing = _slot
        .allMatches(sentence)
        .any((m) => (values[m[1]!] ?? '').trim().isEmpty);
    if (missing) continue;
    kept.add(sentence.replaceAllMapped(_slot, (m) => values[m[1]!]!.trim()));
  }
  final line = kept.join(' ').trim();
  // Only punctuation or an answer hint (`[y/n]`) left is not a line.
  if (line.replaceAll(RegExp(r'\[[^\]]*\]|[^a-zA-Z0-9]'), '').isEmpty) {
    return null;
  }
  return line;
}

String _count(int n, String one, String many) => '$n ${n == 1 ? one : many}';

/// The line in plain facts, for when a template cannot be filled.
String neutralLine(DaemonMood mood, DaemonFacts facts) {
  switch (mood) {
    case DaemonMood.need:
      final waiting = facts.waiting;
      if (waiting.length == 1) return '${waiting.single.who} needs you.';
      if (waiting.isNotEmpty) {
        return '${_count(waiting.length, 'harness', 'harnesses')} need you.';
      }
      return 'a harness needs you.';
    case DaemonMood.work:
      final working = facts.working;
      if (working.length == 1) return '${working.single} is working.';
      if (working.isNotEmpty) {
        return '${_count(working.length, 'harness', 'harnesses')} working.';
      }
      return 'agents working.';
    case DaemonMood.fail:
      final failing = facts.failing;
      if (failing.length == 1) return '${failing.single} failed to start.';
      if (failing.isNotEmpty) {
        return '${_count(failing.length, 'harness', 'harnesses')} '
            'failed to start.';
      }
      return 'something failed.';
    case DaemonMood.boop:
      return 'hi.';
    case DaemonMood.idle:
    case DaemonMood.done:
    case DaemonMood.back:
    case DaemonMood.nap:
      if (facts.harnesses == 0) return 'nothing needs you.';
      return '${_count(facts.harnesses, 'harness', 'harnesses')} idle. '
          'nothing needs you.';
  }
}

/// The slots the phone can fill for [mood].
Map<String, String?> slotsFor(DaemonMood mood, DaemonFacts facts) {
  final first = facts.waiting.firstOrNull;
  final n = switch (mood) {
    DaemonMood.need => facts.waiting.length,
    DaemonMood.work => facts.working.length,
    DaemonMood.fail => facts.failing.length,
    _ => facts.harnesses,
  };
  final who = switch (mood) {
    DaemonMood.need => first?.who,
    DaemonMood.work => facts.working.length == 1 ? facts.working.single : null,
    DaemonMood.fail => facts.failing.firstOrNull,
    _ => null,
  };
  return {
    'who': who,
    'q': mood == DaemonMood.need ? first?.q : null,
    'n': n > 0 ? '$n' : null,
    // Written by the pair brain; the phone has no recap or summary of its own.
    'recap': null,
    'summary': null,
  };
}

final _tagged = RegExp(r'^(.*\S)\s{2,}(\S.*)$');

/// The short tag a voice v3 need or fail [template] ends with — `(bell)` in
/// `{who}: {q}  (bell)` — or null. A tag is the daemon's own words after the
/// facts: two spaces, then no slot.
String? lineTag(DaemonMood mood, String template) {
  if (mood != DaemonMood.need && mood != DaemonMood.fail) return null;
  final match = _tagged.firstMatch(template);
  if (match == null) return null;
  final facts = match[1]!, tag = match[2]!;
  if (!_slot.hasMatch(facts) || _slot.hasMatch(tag)) return null;
  return tag;
}

/// The daemon's line for [mood], true to [facts].
String daemonLine(
  DaemonRoster roster,
  DaemonDef d,
  DaemonMood mood,
  DaemonFacts facts,
) {
  final template = d.line(mood);
  if (roster.rules.lineSlots == null) {
    // Written-out examples, not templates: only the boop is safe to repeat.
    if (mood == DaemonMood.boop && template.isNotEmpty) return template;
    return neutralLine(mood, facts);
  }
  if (template.isEmpty) return neutralLine(mood, facts);
  final filled = fillLine(template, slotsFor(mood, facts));
  if (filled != null) return filled;
  // Facts the phone cannot fill: its own, first, and the daemon's tag after.
  final tag = lineTag(mood, template);
  final neutral = neutralLine(mood, facts);
  return tag == null ? neutral : '$neutral  $tag';
}
