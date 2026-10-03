import 'package:flutter/material.dart';

import 'package:harness_mobile/core/fuzzy_match.dart';

/// fzf's way of saying things, for Find's rows (`find_row.dart`): the typed letters lit in
/// fzf's green, and an age the way a terminal writes one.

/// [text] as spans with each typed term lit — a substring where there is one (one that starts a
/// word first: "port" lights "windows port", not "support"), else scattered letters in order.
///
/// [strict] lights scattered letters the way a harness row matched them (see
/// `phoneFieldMatchScore`): starting a word and close together, or two letters as initials — so
/// what is lit is what earned the row its place.
List<TextSpan> fzfHighlight(
  String text,
  List<String> terms, {
  required TextStyle base,
  required TextStyle hit,
  bool strict = false,
}) {
  final lit = List<bool>.filled(text.length, false);
  final lower = text.toLowerCase();
  // Case folding that changes the length would shift every index: leave such text plain.
  if (lower.length != text.length) return [TextSpan(text: text, style: base)];
  for (final raw in terms) {
    final term = raw.toLowerCase();
    if (term.isEmpty) continue;
    var at = wordStartIndexOf(lower, term);
    if (at < 0) at = lower.indexOf(term);
    if (at >= 0) {
      for (var i = at; i < at + term.length; i++) {
        lit[i] = true;
      }
      continue;
    }
    if (strict) {
      wordSubsequenceSpread(
        lower,
        term,
        onMatch: (start, end) {
          for (var i = start; i < end; i++) {
            lit[i] = true;
          }
        },
      );
      continue;
    }
    var from = 0;
    final marks = <int>[];
    for (final unit in term.split('')) {
      final found = lower.indexOf(unit, from);
      if (found < 0) {
        marks.clear();
        break;
      }
      marks.add(found);
      from = found + 1;
    }
    for (final i in marks) {
      lit[i] = true;
    }
  }
  final spans = <TextSpan>[];
  var start = 0;
  for (var i = 1; i <= text.length; i++) {
    if (i == text.length || lit[i] != lit[start]) {
      spans.add(
        TextSpan(
          text: text.substring(start, i),
          style: lit[start] ? hit : base,
        ),
      );
      start = i;
    }
  }
  return spans;
}

/// How long ago, the way a terminal would say it: `now`, `3m`, `2h`, `5d`.
String fzfAge(DateTime? at, DateTime now) {
  if (at == null) return '';
  final gone = now.difference(at);
  if (gone.inMinutes < 1) return 'now';
  if (gone.inHours < 1) return '${gone.inMinutes}m';
  if (gone.inDays < 1) return '${gone.inHours}h';
  return '${gone.inDays}d';
}
