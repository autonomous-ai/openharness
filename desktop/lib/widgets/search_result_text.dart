import 'package:flutter/widgets.dart';

import '../core/fuzzy_match.dart';
import '../state/session_content_search.dart';
import '../state/swarm_navigation.dart';

/// [strict]: the field was matched by [swarmFieldMatchScore]'s rules for
/// harness rows, so scattered letters are emphasised the way they matched.
typedef SearchFieldMatch = ({
  String field,
  String term,
  bool title,
  bool strict,
});

/// Match only the field that earns each query term's ranking score. Work is
/// bounded to visible rows; discovery and ranking retain their existing path.
List<SearchFieldMatch> searchResultMatches(
  SwarmDestination row,
  List<String> terms,
) {
  final matches = <SearchFieldMatch>[];
  for (final term in terms.take(12).toSet()) {
    if (term.length > 128) continue;
    int? best;
    var fieldIndex = -1;
    for (var i = 0; i < row.fields.length; i++) {
      final field = row.fields[i];
      if (field.length > 4096) continue;
      final score = swarmFieldMatchScore(
        field,
        term,
        title: i < row.titleFieldCount,
        strict: row.agentId != null,
      );
      if (score != null && (best == null || score < best)) {
        best = score;
        fieldIndex = i;
      }
      if (best != null && best <= 64) break;
    }
    if (fieldIndex >= 0) {
      matches.add((
        field: row.fields[fieldIndex],
        term: term,
        title: fieldIndex == 0,
        strict: row.agentId != null,
      ));
    }
  }
  return matches;
}

typedef SearchTextRun = ({String text, bool matched});

/// Preserve whole graphemes when case folding changes offsets or a query
/// matches part of an emoji/combining sequence. Long labels remain plain text;
/// emphasis must not add unbounded layout work to the one-line result list.
List<SearchTextRun> searchTextRuns(
  String text,
  Iterable<SearchFieldMatch> matches,
) {
  if (matches.isEmpty || text.isEmpty || text.length > 1024) {
    return [(text: text, matched: false)];
  }
  final clusters = <({int start, int end, int foldedStart, int foldedEnd})>[];
  final folded = StringBuffer();
  var offset = 0, foldedOffset = 0;
  for (final cluster in text.characters) {
    final lower = cluster.toLowerCase();
    clusters.add((
      start: offset,
      end: offset + cluster.length,
      foldedStart: foldedOffset,
      foldedEnd: foldedOffset + lower.length,
    ));
    offset += cluster.length;
    foldedOffset += lower.length;
    folded.write(lower);
  }
  final normalized = folded.toString();
  final positions = <({int start, int end})>[];
  for (final match in matches) {
    // A path or other hidden field may produce a result without appearing in
    // its two visible labels. Do not invent an emphasis in unrelated text.
    final fieldAt = normalized.indexOf(match.field);
    if (fieldAt < 0) continue;
    final exact = match.field.indexOf(match.term);
    if (exact >= 0) {
      positions.add((
        start: fieldAt + exact,
        end: fieldAt + exact + match.term.length,
      ));
    } else {
      final fuzzy = <({int start, int end})>[];
      void onMatch(int start, int end) =>
          fuzzy.add((start: fieldAt + start, end: fieldAt + end));
      if ((match.strict
              ? wordSubsequenceSpread(match.field, match.term, onMatch: onMatch)
              : subsequenceSpread(match.field, match.term, onMatch: onMatch)) !=
          null) {
        positions.addAll(fuzzy);
      }
    }
  }
  if (positions.isEmpty) return [(text: text, matched: false)];
  positions.sort((a, b) => a.start.compareTo(b.start));
  final runs = <SearchTextRun>[];
  var start = 0;
  var positionIndex = 0;
  bool? active;
  for (final cluster in clusters) {
    while (positionIndex < positions.length &&
        positions[positionIndex].end <= cluster.foldedStart) {
      positionIndex++;
    }
    final matched =
        positionIndex < positions.length &&
        positions[positionIndex].start < cluster.foldedEnd;
    if (active != null && active != matched) {
      runs.add((text: text.substring(start, cluster.start), matched: active));
      start = cluster.start;
    }
    active = matched;
  }
  runs.add((text: text.substring(start), matched: active ?? false));
  return runs;
}

class SearchResultText extends StatelessWidget {
  const SearchResultText(
    this.text, {
    super.key,
    required this.matches,
    required this.style,
    this.inlineIcon,
    this.iconOffset = 0,
  });
  final String text;
  final Iterable<SearchFieldMatch> matches;
  final TextStyle style;

  /// Insert a decorative mark without changing searchable text or match offsets.
  final Widget? inlineIcon;
  final int iconOffset;

  @override
  Widget build(BuildContext context) {
    final runs = searchTextRuns(text, matches);
    final insertIcon =
        inlineIcon != null && iconOffset >= 0 && iconOffset < text.length;
    if (!insertIcon && !runs.any((run) => run.matched)) {
      return Text(
        text,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: style,
      );
    }
    final spans = <InlineSpan>[];
    var offset = 0;
    for (final run in runs) {
      final emphasis = run.matched
          ? const TextStyle(fontWeight: FontWeight.w700)
          : null;
      if (insertIcon &&
          iconOffset >= offset &&
          iconOffset < offset + run.text.length) {
        final split = iconOffset - offset;
        if (split > 0) {
          spans.add(
            TextSpan(text: run.text.substring(0, split), style: emphasis),
          );
        }
        spans.add(
          WidgetSpan(
            alignment: PlaceholderAlignment.middle,
            child: ExcludeSemantics(
              child: Padding(
                padding: const EdgeInsets.only(right: 4),
                child: inlineIcon!,
              ),
            ),
          ),
        );
        spans.add(TextSpan(text: run.text.substring(split), style: emphasis));
      } else {
        spans.add(TextSpan(text: run.text, style: emphasis));
      }
      offset += run.text.length;
    }
    return Text.rich(
      TextSpan(children: spans),
      semanticsLabel: insertIcon ? text : null,
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      style: style,
    );
  }
}

/// Where a session index found the words: what was asked reads like a
/// prompt, a command like a shell line, and the agent's answer plainly.
String snippetLead(String field) => switch (field) {
  'ask' => '> ',
  'tools' => r'$ ',
  _ => '',
};

/// A session index snippet with its matched words in bold, one line.
List<SearchTextRun> snippetRuns(String snippet) {
  final runs = <SearchTextRun>[];
  var rest = snippet;
  while (rest.isNotEmpty) {
    final open = rest.indexOf(kSnippetMarkOpen);
    if (open < 0) {
      runs.add((text: rest, matched: false));
      break;
    }
    if (open > 0) runs.add((text: rest.substring(0, open), matched: false));
    final close = rest.indexOf(kSnippetMarkClose, open + 1);
    final end = close < 0 ? rest.length : close;
    if (end > open + 1) {
      runs.add((text: rest.substring(open + 1, end), matched: true));
    }
    rest = close < 0 ? '' : rest.substring(close + 1);
  }
  return runs;
}

class SessionSnippetText extends StatelessWidget {
  const SessionSnippetText(
    this.hit, {
    super.key,
    required this.style,
    this.maxLines = 1,
  });

  final SessionContentHit hit;
  final TextStyle style;

  /// One line in a result row; null lets the preview show all of it.
  final int? maxLines;

  @override
  Widget build(BuildContext context) => Text.rich(
    TextSpan(
      children: [
        TextSpan(text: snippetLead(hit.field)),
        for (final run in snippetRuns(hit.snippet))
          TextSpan(
            text: run.text,
            style: run.matched
                ? const TextStyle(fontWeight: FontWeight.w700)
                : null,
          ),
      ],
    ),
    key: key == null ? ValueKey('session-snippet:${hit.destinationId}') : null,
    maxLines: maxLines,
    overflow: maxLines == null ? null : TextOverflow.ellipsis,
    style: style,
  );
}
