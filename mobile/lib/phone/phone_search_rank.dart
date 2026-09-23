import 'package:harness_mobile/core/fuzzy_match.dart';
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
/// The desktop's `swarmFieldMatchScore`, unchanged. The bands, cheapest first:
/// an exact field, a prefix, a substring anywhere, and last a scattered-letter
/// subsequence whose cost grows with how far apart the letters landed. A
/// non-title field takes a flat 64, which is what keeps a name match ahead of
/// every piece of metadata under it.
int? phoneFieldMatchScore(String field, String term, {required bool title}) {
  final offset = field.indexOf(term);
  final spread = offset >= 0 ? 0 : subsequenceSpread(field, term);
  if (spread == null) return null;
  return (title ? 0 : 64) +
      (field == term
          ? 0
          : offset == 0
          ? 8
          : offset > 0
          ? 16
          : 128 + spread);
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
    );
    if (score == null) continue;
    if (best == null || score < best.score) best = (score: score, index: i);
    if (best.score <= 64) break;
  }
  return best;
}

/// What a word found only in the conversation costs: more than any metadata
/// match can, so an agent that IS "llama" stays ahead of one that talked about
/// it. The desktop's figure.
const _contentScore = 256;

/// The rows [query] reaches, best first — the desktop's `rankSwarmDestinations`.
///
/// A word that matches no field is looked for in the agent's session content —
/// its recent requests, its latest answer, what it is writing right now — which
/// is how "llama" finds the agent somebody asked about llama.cpp. Rows that
/// needed the content rank after every row that matched on the agent itself.
///
/// ⚠️ **The tie-breaks are the desktop's, in the desktop's order**, with one
/// deliberate substitution: content, then score, then — only with nothing typed
/// — the tier below, then how recently the row was OPENED, then [all]'s own
/// order, and finally the id so two rows can never swap places on a rebuild.
/// [recent] is the phone's visit history (see [PhoneSearchHistory]).
///
/// ⚠️ **The substitution is the last-but-one step: [all]'s order where the
/// desktop compares names.** The desktop can afford alphabetical there because
/// by the time it is reached its visit history has already placed almost
/// everything — it records every pane you focus, over weeks. A phone opened for
/// the first time has no history at all, so EVERY row fell through to that step
/// and the box opened on an alphabetical list: `Codex harness 8:16` above the
/// agent that finished a minute ago. That is not what the desktop looks like,
/// it is what the desktop's last resort looks like.
///
/// [phoneSearchCatalog] hands its agents in [recentAgents] order — waiting on
/// you, then working, then whose conversation moved last — so deferring to it
/// puts the phone's best guess where the desktop puts its worst one, and the two
/// converge on the same list as the history fills.
///
/// It is also what keeps the list still. That order is decided when the CATALOG
/// is built, and the catalog is cached against the shape of the fleet
/// ([PhoneSearchCatalogCache]) — so a turn event, which moves `lastActiveAt`
/// every second on a busy machine, does not rebuild it and cannot move a row out
/// from under a thumb.
List<PhoneDestination> rankPhoneDestinations(
  List<PhoneDestination> all,
  String query, {
  List<String> recent = const [],
  SessionPreviewStore? previews,
}) {
  final needle = query.trim().toLowerCase();
  final terms = phoneSearchTerms(query);
  final recency = {for (var i = 0; i < recent.length; i++) recent[i]: i};
  final ranked =
      <({PhoneDestination entry, int score, bool content, int index})>[];
  for (final (index, entry) in all.indexed) {
    // An exact hit on the name — or on the agent's own title — wins outright,
    // ahead of every scored row. Typing one in full is the least ambiguous
    // thing somebody can do.
    if (entry.fields.take(entry.titleFieldCount).contains(needle)) {
      ranked.add((entry: entry, score: -1, content: false, index: index));
      continue;
    }
    var total = 0;
    var content = false;
    String? excerpt;
    for (final term in terms) {
      final best = phoneBestFieldMatch(entry, term);
      if (best == null) {
        excerpt ??= entry.previewKey == null
            ? ''
            : previews?.read(entry.previewKey!)?.searchText ?? '';
        // Literal only, never the scattered-letter match the fields get: a few
        // turns of prose contain almost every short run of letters somewhere,
        // and a fuzzy hit in them would return every agent on the account.
        if (!excerpt.contains(term)) {
          total = -1;
          break;
        }
        content = true;
        total += _contentScore;
        continue;
      }
      total += best.score;
    }
    if (total >= 0) {
      ranked.add((entry: entry, score: total, content: content, index: index));
    }
  }
  // A group or a command is not something the phone can open, so with nothing
  // typed it sits under every agent — the desktop's `!hasView` tier.
  //
  // ⚠️ **The desktop's third tier, `current`, is deliberately absent.** It
  // demotes the pane you are looking at, and porting that rule literally
  // inverted its effect. The desktop's box is always opened with `adding: true`
  // and so always targets a NEW tab or pane (`swarm_screen.dart`), where nothing
  // is focused — so `current` almost never fires there, and the agent you came
  // from ranks near the top: in a live window it sat at rows[2] of 16. A phone's
  // search is ALWAYS opened from a terminal showing an agent, so the same rule
  // fired every single time and buried that agent at the bottom.
  //
  // Matching the desktop means matching what it does, not what it says. And the
  // agent you came from is the most recently active one anyway, so the order it
  // falls into is the one the catalog already wanted.
  int tier(PhoneDestination e) => !e.isAgent
      ? 3
      : recency.containsKey(e.id)
      ? 0
      : 1;
  ranked.sort((a, b) {
    if (needle.isEmpty) return _monitorOrder(a, b);
    var order = (a.content ? 1 : 0).compareTo(b.content ? 1 : 0);
    if (order == 0) order = a.score.compareTo(b.score);
    if (order == 0 && needle.isEmpty) {
      order = tier(a.entry).compareTo(tier(b.entry));
    }
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

/// With nothing typed, the list the field opens on: the agents in the desktop's Harness Monitor
/// order ([compareMonitorOrder]), and whatever is not an agent after them in [all]'s order.
///
/// ⚠️ **Not the typed ranking with an empty query, which is what it was.** That put the agents THIS
/// phone had visited first, then its own guess — so the field opened on a list that matched nothing
/// on the laptop beside it, and the agent at the top of the desktop's monitor could be halfway down
/// the phone's. Somebody moving between the two reads the same list on both now. Once a word is
/// typed the match decides, as it always has.
int _monitorOrder(
  ({PhoneDestination entry, int score, bool content, int index}) a,
  ({PhoneDestination entry, int score, bool content, int index}) b,
) {
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
