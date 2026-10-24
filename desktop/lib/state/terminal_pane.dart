import 'package:flutter/widgets.dart';

import '../terminal/terminal_session.dart';
import '../core/models.dart' show SharedHarness;

/// What a tile shows.
///
/// A [web] tile is a domain harness's viewer — the board, the part, the
/// episode — served on the agent's machine and drawn beside that agent's
/// terminal. It is DERIVED from the agent (the daemon says where the viewer
/// is, and the tile follows) and never persisted: a restored layout re-opens
/// it from the agent's next frame, so a stale URL from a previous run can
/// never be loaded. [companion] and [devices] are built-in native DSH viewers,
/// derived only after their account's experiment is enabled. A [finder] tile
/// is a folder on its machine, browsed in place (`lib/finder/`), opened beside
/// the chat New Harness starts with it; like the other viewers it is never in
/// the saved layout or the desk.
enum PaneKind { terminal, web, companion, devices, finder }

/// One tile in the terminal grid.
///
/// The INTENT (which agent this tile is for) and the live [session] are kept
/// apart on purpose. A restored layout names agents on machines that have not
/// answered yet, and machines answer in an order this side does not decide —
/// so a tile has to be able to exist, and say what it is waiting for, before
/// there is anything to attach. The same split is what lets a tile survive its
/// machine going offline and coming back without the grid reshuffling around
/// it.
class TerminalPane {
  TerminalPane({
    required this.id,
    required this.machineId,
    this.agentId,
    this.kind = PaneKind.terminal,
    this.url,
    this.viewerError,
    this.ownerAgentId,
    this.finderRoot,
  }) : assert(
         kind != PaneKind.web || (agentId == null && ownerAgentId != null),
         'a web tile belongs to an agent through ownerAgentId, never agentId',
       ),
       assert(
         (kind == PaneKind.finder) == (finderRoot != null) &&
             (kind != PaneKind.finder || agentId == null),
         'a Finder tile has a folder and no agent; no other tile has a folder',
       );

  final PaneKind kind;
  bool get isWeb => kind == PaneKind.web;
  bool get isCompanion => kind == PaneKind.companion;
  bool get isDevices => kind == PaneKind.devices;
  bool get isFinder => kind == PaneKind.finder;
  bool get isViewer => isWeb || isCompanion || isDevices || isFinder;

  /// Whether this is [agentId]'s own viewer on [machineId] — its harness's
  /// page, or the Finder opened with its chat — which lives beside that
  /// agent's terminal, so it moves and closes with it.
  bool viewsAgent(String machineId, String? agentId) =>
      (isWeb || isFinder) &&
      agentId != null &&
      this.machineId == machineId &&
      ownerAgentId == agentId;

  /// [PaneKind.finder] only: the folder the tile browses, on [machineId].
  final String? finderRoot;

  /// [PaneKind.web] only: what the tile loads. Changes when the agent's frame
  /// names a new viewer URL; the panel navigates rather than remounts.
  String? url;
  String? viewerError;

  /// The agent whose viewer this is: a web viewer's harness, a Finder's
  /// chat. The native companion viewer can exist before its agent starts,
  /// then follows the selected individual.
  /// Kept OFF [agentId]
  /// on purpose — everything that attaches a terminal, persists a layout or
  /// remembers a closed agent keys on [agentId] being set, and none of that
  /// applies to a viewer.
  String? ownerAgentId;

  /// Stable for the tile's whole life, including across a machine going away
  /// and returning. Widget keys hang off this: keying on the agent id instead
  /// would tear down and rebuild the WebView — and with it the scrollback the
  /// user was reading — every time a tile were reassigned.
  final int id;

  String machineId;

  /// Null means the tile is about the MACHINE, not an agent on it.
  ///
  /// A machine that needs linking cannot list its agents — that is what needing
  /// a link means — so there is no agent to put in a tile, and without this the
  /// link screen would have no way onto the screen at all. The same shape
  /// carries "this machine has no agents yet".
  String? agentId;

  /// A tile this window restored when it opened. Opening the app IS the
  /// gesture, so this tile's FIRST attach may claim the terminal even if
  /// another screen is driving it (see `AttachIntent`). Spent on that attach —
  /// a machine that only comes back hours later is not the same arrival — and
  /// dropped wholesale a few minutes after launch either way.
  bool claimOnFirstAttach = false;

  TerminalSession? session;

  /// Ephemeral input provenance. Never persisted in shared pane layout.
  String? inputContext;
  bool watchOnly = false;

  /// Browser viewer input, installed only while its renderer is mounted.
  bool Function()? focusViewerInput;

  /// A width in pixels this tile asks for instead of its share of the tab:
  /// a Finder showing only its files, or folded to a rail. The grid gives it
  /// to a full-height tile at the tab's left or right edge
  /// (`pinFixedColumn`); never saved.
  double? fixedWidth;

  /// What closing this tile must ask first, installed only while its panel
  /// is mounted: a Finder tile's unsaved tabs. False keeps the tile open.
  Future<bool> Function()? beforeClose;
  SharedHarness? sharedHarness;
  String? sharedOwnerName;

  /// Last visible geometry, retained while this controller is parked off screen.
  Size? lastViewSize;

  /// The grid cell's widget key — a GlobalKey, and measured to be necessary.
  ///
  /// The layout puts cells in DIFFERENT parents depending on how many there
  /// are: with four, two live in the top Row and two in the bottom one. A
  /// ValueKey only preserves an element within one parent, so any move across
  /// that boundary rebuilds the cell — remounting TerminalPanel, taking a fresh
  /// layout pass, and paying a resize round trip to tmux.
  ///
  /// Probed on the real arrangement before this existed: swapping two cells
  /// across the Rows remounted 2 of them, and simply GROWING from two panes to
  /// three remounted all 3 — so the flash was already there, on every add,
  /// before reordering was a feature. With a GlobalKey the same swap remounts 0.
  ///
  /// Lives on the pane so its lifetime is the tile's, exactly like [id].
  final GlobalKey cellKey = GlobalKey();

  /// The slot this tile insists on keeping, or null for a tile that is happy to
  /// slide.
  ///
  /// What it protects against is the hole a close leaves: shut the second of
  /// four tiles and everything after it slides up one, so the agent someone was
  /// reading in the bottom-left is suddenly top-right — the grid rearranged
  /// itself under a hand that only asked to close something else. A pinned tile
  /// stays where it is and the others fill in around it.
  ///
  /// It binds automatic movement only. Dragging a tile is an explicit answer to
  /// the same question, so a drag always wins and takes the pin with it —
  /// otherwise the tile would spring back and the drag would look broken.
  int? pinnedSlot;

  bool get isPinned => pinnedSlot != null;

  /// Whether this tile shows the composer textbox under its terminal.
  ///
  /// Only ever consulted for a remote machine — that is the one where typing straight into the
  /// pane pays a network round trip per keystroke. Off by default, and remembered, so the choice
  /// survives a restart the way the rest of the layout does.
  bool composerVisible = false;

  /// First-arrival suggestion, local to this view and never part of the shared layout.
  String? firstTask;
}

/// A tile as it survives a restart: intent only, never the session.
class PaneLayoutEntry {
  const PaneLayoutEntry({
    required this.machineId,
    required this.agentId,
    this.composerVisible = false,
    this.pinnedSlot,
  });

  final String machineId;
  final String agentId;
  final bool composerVisible;
  final int? pinnedSlot;

  Map<String, dynamic> toJson() => {
    'machineId': machineId,
    'agentId': agentId,
    'composerVisible': composerVisible,
    // Absent for the tiles nobody pinned, which is nearly all of them.
    'pinnedSlot': ?pinnedSlot,
  };

  static PaneLayoutEntry? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final machineId = raw['machineId'];
    final agentId = raw['agentId'];
    if (machineId is! String || machineId.isEmpty) return null;
    if (agentId is! String || agentId.isEmpty) return null;
    final composer = raw['composerVisible'];
    return PaneLayoutEntry(
      machineId: machineId,
      agentId: agentId,
      // Absent means a layout written before the composer existed. Those default to OFF, matching a
      // tile the user has never had an opinion about — never to ON, which would read as a setting
      // they chose.
      composerVisible: composer is bool ? composer : false,
      // A negative or absurd slot is read as "not pinned" rather than clamped:
      // a pin is a place someone chose, and inventing a different one for them
      // is worse than forgetting it.
      pinnedSlot: switch (raw['pinnedSlot']) {
        final int slot when slot >= 0 => slot,
        _ => null,
      },
    );
  }
}
