import 'package:harness_mobile/core/fuzzy_match.dart';
import 'package:harness_mobile/state/session_content_search.dart';
import 'package:harness_mobile/state/session_preview.dart';

import 'agent_index.dart' show compareMonitorOrder;
import 'phone_destination.dart';

final _words = RegExp(r'\s+');

/// The query, split into the words that each have to match something.
///
/// Every word must hit — possibly a DIFFERENT field each — so "review mac" finds
/// the review agent on the MacBook without either word matching the whole row.
/// The desktop's `swarmQueryTerms`, and the freedom to match different fields is
/// what makes word order not matter.
List<String> phoneSearchTerms(String query) {
  final needle = query.trim().toLowerCase();
  return needle.isEmpty ? const [] : needle.split(_words);
}

/// How well [term] matches [field]: LOWER is better, null does not match.
///
/// The desktop's `swarmFieldMatchScore`, unchanged. Whole words beat fragments: "port" is exact in
/// "port", a prefix of "port audit", a word of "windows port" and only a fragment of "support".
/// A non-title field takes a flat 64, which keeps a name match ahead of every piece of metadata.
///
/// [strict] is for harness rows — hundreds of names and long folder paths, where loose letters
/// match nearly anything ("auth" in every `.../autonomous-harness/...`): scattered letters must
/// start a word and stay close, and two letters count only as initials. Commands, machines,
/// projects and models are short curated lists that keep any scattered letters.
int? phoneFieldMatchScore(
  String field,
  String term, {
  required bool title,
  bool strict = false,
}) {
  final offset = field.indexOf(term);
  final int score;
  if (offset == 0) {
    score = field.length == term.length ? 0 : 8;
  } else if (offset > 0) {
    score = wordStartIndexOf(field, term, offset) >= 0 ? 12 : 16;
  } else {
    final spread = strict
        ? wordSubsequenceSpread(field, term)
        : subsequenceSpread(field, term);
    if (spread == null) return null;
    score = 128 + spread;
  }
  return (title ? 0 : 64) + score;
}

/// How well a row matched, coarsest first — the desktop's `SwarmMatchStrength`. Harnesses order
/// by when their conversation last moved only among equally good matches, so the one named for a word is never buried under
/// newer ones that mention it in a folder or a recap.
enum PhoneMatchStrength {
  /// The whole query is the name.
  exact,

  /// Every word starts a word of the name or title.
  name,

  /// A fragment of the name, or a whole word of the project, branch or machine.
  context,

  /// A fragment of the project, branch, folder or machine.
  fragment,

  /// Every word in one turn of the conversation — asked, answered, or a file or command it
  /// touched — as the machine's session index found it.
  said,

  /// The words appear in the conversation, but not together.
  content,

  /// Scattered letters of the name or its context: real words anywhere in the conversation are
  /// better evidence than letters strewn across a name.
  scattered;

  static PhoneMatchStrength ofScore(int score) => score <= 12
      ? name
      : score <= 76
      ? context
      : score < 128
      ? fragment
      : scattered;
}

/// The field [term] reaches best on [row] — its score and its index in
/// [PhoneDestination.fields] — or null when it reaches none.
///
/// Shared by the ranking and by the emphasis, so the field a row is ranked on is
/// the field that is emboldened. The desktop means the same ("the same field
/// preference drives ranking and the visible match emphasis") but its two copies
/// of this loop disagree: `search_result_text.dart` passes `title: i == 0`,
/// which scores an agent's own title as metadata and can move the emphasis onto
/// a different field than the one that earned the row its place. One helper here
/// is what keeps that from being possible.
///
/// ⚠️ **Stops at the first field scoring 64 or better**, exactly as the desktop
/// does. Every field past the titles is metadata, whose best possible score IS
/// 64, so an exact, prefix or substring title match already beats anything left
/// to find. Scanning on would let a later field win ties the desktop gives to
/// the earlier one, and rank the two apps' lists differently.
({int score, int index})? phoneBestFieldMatch(
  PhoneDestination row,
  String term,
) {
  ({int score, int index})? best;
  for (var i = 0; i < row.fields.length; i++) {
    final field = row.fields[i];
    // Bounded: one agent named with a pasted log must not make a keystroke
    // cost more than a frame.
    if (field.length > 4096) continue;
    final score = phoneFieldMatchScore(
      field,
      term,
      title: i < row.titleFieldCount,
      strict: row.isAgent,
    );
    if (score == null) continue;
    if (best == null || score < best.score) best = (score: score, index: i);
    if (best.score <= 64) break;
  }
  return best;
}

/// What a word found only in the conversation costs: more than any metadata match can, so an
/// agent that IS "llama" stays ahead of one that talked about it. The desktop's figure.
const _contentScore = 256;

typedef _Match = ({
  PhoneDestination entry,
  int score,
  PhoneMatchStrength strength,

  /// How the machine's session index ranked this row among its hits, as a reciprocal rank
  /// (higher is better), when it found it.
  double said,
  int index,
});

/// The rows [query] reaches, best first — the desktop's `rankSwarmDestinationsByActivity` and
/// `rankSwarmDestinations`, from main's Cmd-P search (docs/research/2026-09-26-session-search.md).
///
/// Each word may match a different field, in either order: "mini auth" and "auth mini" both find
/// Auth on Mac mini. A word no field holds is looked for in the session excerpt the app already
/// has, at word starts only ("port" does not find every "support"). [contentHits] are what the
/// machines' session indexes found for this query, by row id: everything ever said in each
/// session. A hit vouches for every word, so it admits a row the fields alone cannot, and lifts
/// one that only scattered letters matched.
///
/// ⚠️ **Typed, a list of agents orders by how well each matched, then by when its conversation last
/// moved** — not by that alone, which buried the harness named `hn` 6th of 166 under newer ones
/// whose folder paths spell h…n. With nothing typed it is the conversations that moved last first,
/// and [recent] (this phone's visits) only breaks ties.
List<PhoneDestination> rankPhoneDestinations(
  List<PhoneDestination> all,
  String query, {
  List<String> recent = const [],
  SessionPreviewStore? previews,
  bool byActivity = false,
  Map<String, SessionContentHit>? contentHits,
}) {
  final needle = query.trim().toLowerCase();
  final terms = phoneSearchTerms(query);
  final recency = {for (var i = 0; i < recent.length; i++) recent[i]: i};
  final ranked = <_Match>[];
  for (final (index, entry) in all.indexed) {
    // An exact hit on the name — or on the agent's own title — wins outright.
    if (needle.isNotEmpty &&
        entry.fields.take(entry.titleFieldCount).contains(needle)) {
      ranked.add((
        entry: entry,
        score: -1,
        strength: PhoneMatchStrength.exact,
        said: 0,
        index: index,
      ));
      continue;
    }
    final hit = terms.isEmpty ? null : contentHits?[entry.id];
    final hitStrength = hit == null
        ? null
        : hit.together
        ? PhoneMatchStrength.said
        : PhoneMatchStrength.content;
    var total = 0;
    var strength = PhoneMatchStrength.name;
    String? excerpt;
    for (final term in terms) {
      final best = phoneBestFieldMatch(entry, term);
      final PhoneMatchStrength termStrength;
      final int cost;
      if (best == null) {
        excerpt ??= entry.previewKey == null
            ? ''
            : previews?.read(entry.previewKey!)?.searchText ?? '';
        if (wordStartIndexOf(excerpt, term) < 0) {
          total = -1;
          break;
        }
        termStrength = PhoneMatchStrength.content;
        cost = _contentScore;
      } else {
        termStrength = PhoneMatchStrength.ofScore(best.score);
        cost = best.score;
      }
      if (termStrength.index > strength.index) strength = termStrength;
      total += cost;
    }
    if (hitStrength != null &&
        (total < 0 || hitStrength.index < strength.index)) {
      strength = hitStrength;
      if (total < 0) total = _contentScore * terms.length;
    }
    if (total >= 0) {
      ranked.add((
        entry: entry,
        score: total,
        strength: strength,
        // Reciprocal rank: each machine's index ranks its own hits, and a machine's first is as
        // good as another's first.
        said: hit == null ? 0 : 1 / (1 + hit.position),
        index: index,
      ));
    }
  }
  bool conversation(_Match match) =>
      match.strength == PhoneMatchStrength.said ||
      match.strength == PhoneMatchStrength.content;
  ranked.sort((a, b) {
    // Nothing typed: the conversation that moved last first, then this phone's visits.
    if (needle.isEmpty) {
      var order = _lastMovedFirst(a.entry, b.entry);
      if (order == 0) {
        order = (recency[a.entry.id] ?? 1 << 20).compareTo(
          recency[b.entry.id] ?? 1 << 20,
        );
      }
      return order != 0 ? order : _monitorOrder(a, b);
    }
    if (byActivity) {
      var order = a.strength.index.compareTo(b.strength.index);
      // What was said is ranked by the index, which weighs how well it matched against how long
      // ago; the conversation's last move decides between equal answers.
      if (order == 0 && conversation(a)) order = b.said.compareTo(a.said);
      if (order == 0) order = _lastMovedFirst(a.entry, b.entry);
      if (order == 0) {
        order = (recency[a.entry.id] ?? 1 << 20).compareTo(
          recency[b.entry.id] ?? 1 << 20,
        );
      }
      if (order == 0) order = a.score.compareTo(b.score);
      if (order == 0) order = a.index.compareTo(b.index);
      return order == 0 ? a.entry.id.compareTo(b.entry.id) : order;
    }
    // Commands, machines, projects: names outrank metadata, metadata outranks what was said.
    var order = (conversation(a) ? 1 : 0).compareTo(conversation(b) ? 1 : 0);
    if (order == 0) order = a.score.compareTo(b.score);
    if (order == 0) {
      order = (recency[a.entry.id] ?? 999).compareTo(
        recency[b.entry.id] ?? 999,
      );
    }
    if (order == 0) order = a.index.compareTo(b.index);
    return order == 0 ? a.entry.id.compareTo(b.entry.id) : order;
  });
  return [for (final row in ranked) row.entry];
}

/// The conversation that moved last first — the true time; opening a harness is not work on it. An
/// agent never dated, and anything that is not an agent, after.
int _lastMovedFirst(PhoneDestination a, PhoneDestination b) {
  final left =
      (a.entry?.agent.updatedAt ?? a.lastAt)?.millisecondsSinceEpoch ?? 0;
  final right =
      (b.entry?.agent.updatedAt ?? b.lastAt)?.millisecondsSinceEpoch ?? 0;
  return right.compareTo(left);
}

/// With nothing typed, the list the field opens on: the agents in the desktop's Harness Monitor
/// order ([compareMonitorOrder]), and whatever is not an agent after them in [all]'s order.
///
/// ⚠️ **Not the typed ranking with an empty query, which is what it was.** That put the agents THIS
/// phone had visited first, then its own guess — so the field opened on a list that matched nothing
/// on the laptop beside it, and the agent at the top of the desktop's monitor could be halfway down
/// the phone's. Somebody moving between the two reads the same list on both now. Once a word is
/// typed the match decides, as it always has.
int _monitorOrder(_Match a, _Match b) {
  final left = a.entry.entry;
  final right = b.entry.entry;
  if (left != null && right != null) return compareMonitorOrder(left, right);
  if (left != null) return -1;
  if (right != null) return 1;
  return a.index.compareTo(b.index);
}

/// The line of [row]'s session content worth quoting under its name: the one
/// holding the first word no field matched, from a little before that word.
///
/// Null when every word matched the agent itself — the row's own detail then
/// says why it is there, and a quote would only be noise.
String? phoneContentSnippet(
  PhoneDestination row,
  List<String> terms,
  SessionPreviewStore? previews,
) {
  final key = row.previewKey;
  final preview = key == null ? null : previews?.read(key);
  if (preview == null) return null;
  for (final term in terms) {
    if (phoneBestFieldMatch(row, term) != null) continue;
    // Line by line: a saved answer runs to paragraphs, and a row has one line
    // to quote from.
    for (final part in preview.searchParts) {
      for (final raw in part.split('\n')) {
        final line = raw.trim();
        final at = line.toLowerCase().indexOf(term);
        if (at >= 0) return _quote(line, at);
      }
    }
  }
  return null;
}

/// How much of the line before the matched word stays in the quote.
const _lead = 16;

/// [line] from a little before [at], so the word lands near the row's start
/// rather than past the ellipsis on a phone's width.
String _quote(String line, int at) {
  // Lowercasing can change a string's length; an index into the folded line is
  // only trusted on the original when the two are the same length.
  final folds = line.toLowerCase().length == line.length;
  var start = folds && at > _lead ? at - _lead : 0;
  // Never start inside a surrogate pair — the quote would open on half an emoji.
  if (start > 0 && _isLowSurrogate(line.codeUnitAt(start))) start--;
  return start == 0 ? line : '…${line.substring(start).trimLeft()}';
}

bool _isLowSurrogate(int unit) => unit >= 0xDC00 && unit <= 0xDFFF;
