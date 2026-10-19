import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart' show StringCharacters;

import 'shared_tabs_model.dart';

/// What [planSharedPlacement] asks the desk for, and what this computer has
/// now seen of each shared tab.
@immutable
class SharedPlacement {
  const SharedPlacement({
    required this.createTabs,
    required this.addPanes,
    required this.seen,
  });

  /// Member desk tabs to create, by their derived desk id (R1).
  final List<({String id, String name})> createTabs;

  /// Other accounts' harnesses to place, each in its desk tab.
  final List<({String deskTabId, String machineId, String agentId})> addPanes;

  /// Per shared tab, the other accounts' harnesses this computer has seen in
  /// its roster (`SharedTabHarness.key`, the desk's pane key). Kept in the
  /// key-value store as `shared_tabs.placed`.
  final Map<String, Set<String>> seen;
}

/// Where other accounts' harnesses go on this account's desk (1c spec; step 0
/// Variant A; R1, R2). Roster membership and desk presence are separate facts:
/// the roster places a pane once, after which the desk owns it.
///
/// [deskPaneKeys] holds every pane of every desk tab, in the desk's key format
/// (`machineId\u0000agentId`, which `SharedTabHarness.key` matches).
SharedPlacement planSharedPlacement({
  required String me,
  required List<SharedTab> tabs,
  required Set<String> deskTabIds,
  required Set<String> deskPaneKeys,
  required Map<String, Set<String>> seen,
}) {
  final creates = <({String id, String name})>[];
  final adds = <({String deskTabId, String machineId, String agentId})>[];
  final nextSeen = <String, Set<String>>{};
  for (final tab in tabs) {
    final deskTabId = tab.deskTabId(me);
    final foreign = tab.harnesses.where((h) => h.accountId != me).toList();
    final before = seen[tab.sharedTabId];
    if (deskTabId == null) {
      // Owned, and the daemon has not said which desk tab it shared: wait.
      if (before != null) nextSeen[tab.sharedTabId] = before;
      continue;
    }
    nextSeen[tab.sharedTabId] = {...?before, ...foreign.map((h) => h.key)};
    if (!deskTabIds.contains(deskTabId)) {
      // Closed by the person on this computer, or not this account's to create.
      if (before != null || tab.ownedBy(me)) continue;
      creates.add((id: deskTabId, name: tab.name));
      for (final h in foreign) {
        adds.add((
          deskTabId: deskTabId,
          machineId: h.machineId,
          agentId: h.agentId,
        ));
      }
      continue;
    }
    for (final h in foreign) {
      if (deskPaneKeys.contains(h.key)) continue;
      if (before != null && before.contains(h.key)) continue;
      adds.add((
        deskTabId: deskTabId,
        machineId: h.machineId,
        agentId: h.agentId,
      ));
    }
  }
  return SharedPlacement(createTabs: creates, addPanes: adds, seen: nextSeen);
}

final _controls = RegExp(r'\p{Cc}', unicode: true);
final _formats = RegExp(r'\p{Cf}', unicode: true);
final _spaces = RegExp(r'\s+', unicode: true);

/// A string another account chose (a tab name, a person's name or email) as
/// one line of plain text: control characters become spaces, format
/// characters (bidi overrides, zero-width marks) go, runs of space collapse.
/// The view still ellipsizes it; this only makes sure nothing in it can move
/// text around or break the line.
String plainSharedText(String text) => text
    .replaceAll(_controls, ' ')
    .replaceAll(_formats, '')
    .replaceAll(_spaces, ' ')
    .trim();

/// [plainSharedText] cut to [max] characters with an ellipsis, for another
/// account's string set inside a sentence (an email or a tab name): a 200
/// character one cannot make the sentence unbounded.
String shortSharedText(String text, [int max = 40]) {
  final plain = plainSharedText(text);
  final chars = plain.characters;
  return chars.length <= max ? plain : '${chars.take(max - 1)}…';
}

/// The desk's longest tab name (`DESK_NAME_MAX`, backend `lib/desk.ts`),
/// counted as the backend counts it: UTF-16 code units.
const deskNameMax = 80;

/// A shared tab's roster name as a desk tab name: [plainSharedText], cut on a
/// character boundary to [deskNameMax] UTF-16 units. Null when nothing is
/// left, so the caller names the tab as a new one. A name the desk refuses
/// fails the whole batch it rides in, and the desk keeps retrying it.
String? sharedDeskTabName(String name) {
  final plain = plainSharedText(name);
  final out = StringBuffer();
  var units = 0;
  for (final character in plain.characters) {
    if (units + character.length > deskNameMax) break;
    out.write(character);
    units += character.length;
  }
  final cut = out.toString().trim();
  return cut.isEmpty ? null : cut;
}
