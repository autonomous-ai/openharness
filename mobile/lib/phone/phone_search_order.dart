import 'phone_search_index.dart';

/// The place each row keeps for as long as one search is open.
///
/// ⚠️ **A list somebody is reading must not reorder itself.** [phoneSearchIndex]
/// hands its rows in `recentAgents` order, and recency MOVES: every turn event
/// stamps its agent's `lastActiveAt`, and that row jumps to the top — from under
/// a finger already on its way to the row that was there. On a fleet with
/// several agents working it never settles, and a turn left open by a restarted
/// daemon heartbeats every second for ever, so the list reshuffles roughly as
/// fast as it can be read. What the person gets for it is a tap on the wrong
/// agent.
///
/// So the order is taken ONCE — from the first index this search is built with,
/// which is the ranked one worth offering — and every rebuild after that is
/// arranged back into it. The rows still say what is true right now: `working`
/// replaces an age, a quote appears under a name as its preview lands. Only
/// WHERE they are is held still.
///
/// One search, one order: both ways in mount [PhoneSearchResults] when the
/// search opens and drop it when it closes, so the next one opens freshly
/// ranked rather than on an order frozen minutes ago.
class PhoneSearchOrder {
  /// Row id → its place. Ids are [PhoneSearchResult.id], stable across rebuilds.
  final Map<String, int> _slots = {};

  int _next = 0;

  /// [rows] in the frozen order, rows this search has not seen before last.
  ///
  /// An agent that appears mid-search — one just created, or a machine that has
  /// only now answered — goes to the END rather than into the middle. Dropping
  /// it into recency order would be exactly the shove this class exists to
  /// stop, and a row nobody has looked for yet has not earned the top of a list
  /// somebody is already reading.
  ///
  /// ⚠️ **A slot is never released.** A machine redialling takes its agents out
  /// of `agentIndex` for the length of the redial (`phoneMachineListsAgents`),
  /// which backgrounding the app does every time. Forgetting them there would
  /// send every one of that machine's rows to the bottom of the list and back
  /// on each reconnect — the same jump, arriving by the other door. Kept, they
  /// come back exactly where they were.
  List<PhoneSearchResult> arrange(List<PhoneSearchResult> rows) {
    for (final row in rows) {
      _slots.putIfAbsent(row.id, () => _next++);
    }
    return [...rows]..sort((a, b) => _slots[a.id]!.compareTo(_slots[b.id]!));
  }
}
