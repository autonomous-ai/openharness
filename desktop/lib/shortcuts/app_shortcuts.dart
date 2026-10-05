import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

import '../logging/debug_surface.dart';

/// Harness uses Command as a direct prefix for frequent workspace actions.
/// T opens a tab, N creates a harness. S opens Store, M machines, I models,
/// O projects, P harnesses, and Shift-P commands.
/// Shift-L chooses a layout. H/J/K/L and arrows focus panes; B routes a task.
/// The same definitions feed live keys, help and search.
///
/// Unclaimed input stays with the focused agent or text field. Composition,
/// copy/paste and the coding agent's own prompt editing must keep working.
/// AppKit's Edit menu has no competing equivalents for C/V/X/A, and Hide has
/// no H equivalent: Flutter owns editing and Harness owns Command-H navigation.
/// Menu clicks still use their usual responder-chain actions.

enum ShortcutAction {
  newSwarm,
  closeSwarm,
  reopenClosedSwarm,
  showHistory,
  renameSwarm,
  nextSwarm,
  previousSwarm,
  showSettings,
  toggleRail,
  nextAgent,
  previousAgent,
  focusPaneLeft,
  focusPaneRight,
  focusPaneAbove,
  focusPaneBelow,
  movePaneLeft,
  movePaneRight,
  movePaneUp,
  movePaneDown,

  /// Send the focused pane to another tab, terminal and all.
  movePaneToTab,

  /// The agent this window was on before the current one — tmux's `prefix ;`.
  lastPane,

  /// One pane filling the grid, and back. tmux's `prefix z`.
  zoomPane,

  /// Find a live question and jump to the agent waiting for input.
  showAttention,

  findTerminal,
  findNext,
  findPrevious,

  /// Add an agent to the current swarm, independently of navigation.
  addAgent,

  closePane,
  newAgent,

  /// A plain shell in a pane, like a native terminal's new tab — the daemon
  /// treats whatever engine is later typed into it as the pane's agent.
  newTerminal,

  /// Another agent of the focused pane's kind — same machine, folder, harness,
  /// profile and permission mode — with a fresh conversation: fork minus the
  /// context. No dialog, like [newTerminal].
  cloneAgent,

  /// Start the focused pane's harness again in place, resuming its
  /// conversation where the engine can — the pane, its folder and its settings
  /// all stay. Asks first, unlike [cloneAgent]: the running process ends.
  restartAgent,
  shareAgent,
  routeTask,
  orchestrate,
  team,
  reload,
  showLayout,
  pinPane,
  showShortcuts,
  showDebug,
}

enum ShortcutGroup { navigate, panes, actions }

extension ShortcutGroupLabel on ShortcutGroup {
  String get label => switch (this) {
    ShortcutGroup.navigate => 'Workspace',
    ShortcutGroup.panes => 'Panes',
    ShortcutGroup.actions => 'Actions',
  };
}

class AppShortcut {
  const AppShortcut({
    required this.action,
    required this.activator,
    required this.label,
    required this.group,
  });

  final ShortcutAction action;
  final SingleActivator activator;
  final String label;
  final ShortcutGroup group;
}

const List<AppShortcut> kAppShortcuts = [
  AppShortcut(
    action: ShortcutAction.findTerminal,
    activator: SingleActivator(LogicalKeyboardKey.keyF, meta: true),
    label: 'Find in the focused terminal',
    group: ShortcutGroup.navigate,
  ),
  AppShortcut(
    action: ShortcutAction.findNext,
    activator: SingleActivator(LogicalKeyboardKey.keyG, meta: true),
    label: 'Next terminal match',
    group: ShortcutGroup.navigate,
  ),
  AppShortcut(
    action: ShortcutAction.findPrevious,
    activator: SingleActivator(
      LogicalKeyboardKey.keyG,
      meta: true,
      shift: true,
    ),
    label: 'Previous terminal match',
    group: ShortcutGroup.navigate,
  ),
  // --- navigate -------------------------------------------------------------
  //
  // Command-arrows and H/J/K/L focus panes; bare keys stay with the terminal.
  AppShortcut(
    action: ShortcutAction.focusPaneLeft,
    activator: SingleActivator(LogicalKeyboardKey.keyH, meta: true),
    label: 'Focus the pane to the left',
    group: ShortcutGroup.navigate,
  ),
  AppShortcut(
    action: ShortcutAction.focusPaneBelow,
    activator: SingleActivator(LogicalKeyboardKey.keyJ, meta: true),
    label: 'Focus the pane below',
    group: ShortcutGroup.navigate,
  ),
  AppShortcut(
    action: ShortcutAction.focusPaneAbove,
    activator: SingleActivator(LogicalKeyboardKey.keyK, meta: true),
    label: 'Focus the pane above',
    group: ShortcutGroup.navigate,
  ),
  AppShortcut(
    action: ShortcutAction.focusPaneRight,
    activator: SingleActivator(LogicalKeyboardKey.keyL, meta: true),
    label: 'Focus the pane to the right',
    group: ShortcutGroup.navigate,
  ),
  AppShortcut(
    action: ShortcutAction.focusPaneLeft,
    activator: SingleActivator(LogicalKeyboardKey.arrowLeft, meta: true),
    label: 'Focus the pane to the left',
    group: ShortcutGroup.navigate,
  ),
  AppShortcut(
    action: ShortcutAction.focusPaneBelow,
    activator: SingleActivator(LogicalKeyboardKey.arrowDown, meta: true),
    label: 'Focus the pane below',
    group: ShortcutGroup.navigate,
  ),
  AppShortcut(
    action: ShortcutAction.focusPaneAbove,
    activator: SingleActivator(LogicalKeyboardKey.arrowUp, meta: true),
    label: 'Focus the pane above',
    group: ShortcutGroup.navigate,
  ),
  AppShortcut(
    action: ShortcutAction.focusPaneRight,
    activator: SingleActivator(LogicalKeyboardKey.arrowRight, meta: true),
    label: 'Focus the pane to the right',
    group: ShortcutGroup.navigate,
  ),

  // --- panes ----------------------------------------------------------------
  //
  // Shift-Command-arrows move the pane itself in the same direction.
  AppShortcut(
    action: ShortcutAction.movePaneLeft,
    activator: SingleActivator(
      LogicalKeyboardKey.arrowLeft,
      meta: true,
      shift: true,
    ),
    label: 'Move this pane left',
    group: ShortcutGroup.panes,
  ),
  AppShortcut(
    action: ShortcutAction.movePaneDown,
    activator: SingleActivator(
      LogicalKeyboardKey.arrowDown,
      meta: true,
      shift: true,
    ),
    label: 'Move this pane down',
    group: ShortcutGroup.panes,
  ),
  AppShortcut(
    action: ShortcutAction.movePaneUp,
    activator: SingleActivator(
      LogicalKeyboardKey.arrowUp,
      meta: true,
      shift: true,
    ),
    label: 'Move this pane up',
    group: ShortcutGroup.panes,
  ),
  AppShortcut(
    action: ShortcutAction.movePaneRight,
    activator: SingleActivator(
      LogicalKeyboardKey.arrowRight,
      meta: true,
      shift: true,
    ),
    label: 'Move this pane right',
    group: ShortcutGroup.panes,
  ),
  AppShortcut(
    action: ShortcutAction.movePaneToTab,
    activator: SingleActivator(
      LogicalKeyboardKey.keyM,
      meta: true,
      shift: true,
    ),
    label: 'Move this pane to another tab',
    group: ShortcutGroup.panes,
  ),

  // ⌘⏎ — tmux's `prefix z`, one of the most-pressed keys that multiplexer has.
  // Enter because it reads as "make THIS the thing", and because it is the one
  // chord on this list nobody has to look up twice.
  AppShortcut(
    action: ShortcutAction.zoomPane,
    activator: SingleActivator(LogicalKeyboardKey.enter, meta: true),
    label: 'Zoom this pane, or put it back',
    group: ShortcutGroup.panes,
  ),
  AppShortcut(
    action: ShortcutAction.closePane,
    activator: SingleActivator(
      LogicalKeyboardKey.keyW,
      meta: true,
      shift: true,
    ),
    label: 'Close the focused pane',
    group: ShortcutGroup.panes,
  ),
  AppShortcut(
    action: ShortcutAction.showLayout,
    activator: SingleActivator(
      LogicalKeyboardKey.keyL,
      meta: true,
      shift: true,
    ),
    label: 'Choose the grid layout',
    group: ShortcutGroup.panes,
  ),

  // --- agents ---------------------------------------------------------------
  //
  // In Swarms, brackets follow Chrome's Back/Forward history. Directional
  // pane movement keeps its own keys; Shift-brackets step through tabs.
  AppShortcut(
    action: ShortcutAction.previousAgent,
    activator: SingleActivator(LogicalKeyboardKey.bracketLeft, meta: true),
    label: 'Back',
    group: ShortcutGroup.navigate,
  ),
  AppShortcut(
    action: ShortcutAction.nextAgent,
    activator: SingleActivator(LogicalKeyboardKey.bracketRight, meta: true),
    label: 'Forward',
    group: ShortcutGroup.navigate,
  ),
  // Control-Tab and Shift-brackets move through tabs. Pane directions and
  // agent history have their own shortcuts above.
  AppShortcut(
    action: ShortcutAction.nextAgent,
    activator: SingleActivator(LogicalKeyboardKey.tab, control: true),
    label: 'Next pane',
    group: ShortcutGroup.navigate,
  ),
  AppShortcut(
    action: ShortcutAction.previousAgent,
    activator: SingleActivator(
      LogicalKeyboardKey.tab,
      control: true,
      shift: true,
    ),
    label: 'Previous pane',
    group: ShortcutGroup.navigate,
  ),
  AppShortcut(
    action: ShortcutAction.toggleRail,
    activator: SingleActivator(LogicalKeyboardKey.backslash, meta: true),
    label: 'Show or hide the sidebar',
    group: ShortcutGroup.navigate,
  ),

  // --- actions --------------------------------------------------------------
  AppShortcut(
    action: ShortcutAction.newAgent,
    activator: SingleActivator(LogicalKeyboardKey.keyN, meta: true),
    label: 'New Harness',
    group: ShortcutGroup.actions,
  ),
  AppShortcut(
    action: ShortcutAction.routeTask,
    activator: SingleActivator(LogicalKeyboardKey.keyB, meta: true),
    label: 'Describe a task, and let it pick the harness',
    group: ShortcutGroup.actions,
  ),
  AppShortcut(
    action: ShortcutAction.reload,
    activator: SingleActivator(LogicalKeyboardKey.keyR, meta: true),
    label: 'Reload machines and harnesses',
    group: ShortcutGroup.actions,
  ),
  AppShortcut(
    action: ShortcutAction.showShortcuts,
    activator: SingleActivator(LogicalKeyboardKey.slash, meta: true),
    label: 'Show keyboard shortcuts',
    group: ShortcutGroup.actions,
  ),
];

/// Open Settings ▸ Debug — the app's own log, as this session still holds it.
///
/// Kept out of [kAppShortcuts] because it is not always there: a release build
/// has no Debug screen (see [kDebugSurfaceEnabled]), and a key that opens
/// nothing is worse than a key that was never taken.
const AppShortcut kDebugShortcut = AppShortcut(
  action: ShortcutAction.showDebug,
  activator: SingleActivator(LogicalKeyboardKey.keyD, meta: true, shift: true),
  label: 'Open the debug log',
  group: ShortcutGroup.actions,
);

/// Every shortcut THIS build has — [kAppShortcuts], plus the developer ones the
/// build is allowed to show.
///
/// The one list the bindings, the ⌘/ sheet and the tooltips all read, so a
/// build cannot bind a key it does not document or document one it does not
/// bind.
List<AppShortcut> appShortcuts({bool swarmMode = true}) =>
    [
          for (final shortcut in kAppShortcuts)
            if (!swarmMode ||
                (!const {
                      ShortcutAction.toggleRail,
                      ShortcutAction.closePane,
                      ShortcutAction.reload,
                    }.contains(shortcut.action) &&
                    !shortcut.activator.control))
              shortcut,
          if (swarmMode) ...kSwarmShortcuts,
          if (kDebugSurfaceEnabled) kDebugShortcut,
        ]
        .where(
          (shortcut) =>
              !kIsWeb || shortcut.activator.trigger != LogicalKeyboardKey.tab,
        )
        .map(_platformShortcut)
        .toList(growable: false);

/// The browser owns Command/Control keys such as Print, New Tab and Close,
/// and a Linux desktop owns Super — Hyprland and GNOME bind most Super chords
/// to windows and workspaces before the app sees them. Both use Option/Alt as
/// the workspace prefix. Editing and terminal Control keys keep their normal
/// behavior; help and live bindings share this mapping.
bool get altWorkspacePrefix =>
    kIsWeb || defaultTargetPlatform == TargetPlatform.linux;

String get workspaceCommandModifier => altWorkspacePrefix ? 'alt' : 'cmd';

/// Where "⌘ becomes Alt" would take a key a Linux terminal program already
/// answers — Alt+Enter is the engine prompt's newline, Alt+T Claude Code's
/// thinking toggle, Alt+F/B/D the shell's word motions — the command moves to
/// Alt-Shift instead, and whatever that displaced moves on to a free key.
const _linuxAltShortcuts = <ShortcutAction, SingleActivator>{
  ShortcutAction.newSwarm: SingleActivator(
    LogicalKeyboardKey.keyT,
    alt: true,
    shift: true,
  ),
  ShortcutAction.newTerminal: SingleActivator(
    LogicalKeyboardKey.enter,
    alt: true,
    shift: true,
  ),
  // tmux's `prefix z`, which ⌘⏎ stands for on a Mac.
  ShortcutAction.zoomPane: SingleActivator(LogicalKeyboardKey.keyZ, alt: true),
  ShortcutAction.routeTask: SingleActivator(
    LogicalKeyboardKey.keyB,
    alt: true,
    shift: true,
  ),
  ShortcutAction.findTerminal: SingleActivator(
    LogicalKeyboardKey.keyF,
    alt: true,
    shift: true,
  ),
  ShortcutAction.showDebug: SingleActivator(
    LogicalKeyboardKey.keyX,
    alt: true,
    shift: true,
  ),
};

/// The keymap's string-bound commands, moved for the same reasons.
const linuxAltCommandKeys = <String, List<String>>{
  // VS Code's key, kept from before Linux took Alt.
  'navigation.commands': ['ctrl+shift+p'],
  'harnesses.list': ['alt+shift+p'],
  'pane.split_down': ['alt+shift+d'],
  // Alt-Shift-F already opens terminal Find on Linux.
  'pane.toggle_shading': ['ctrl+alt+f'],
  'app.daemon_talk': ['alt+shift+a'],
};

String platformWorkspaceBinding(String keys) {
  if (!altWorkspacePrefix || !keys.split('+').contains('cmd')) return keys;
  final parts = keys.split('+');
  return {
    for (final part in parts) part == 'cmd' ? workspaceCommandModifier : part,
  }.join('+');
}

SingleActivator _platformActivator(SingleActivator keys) {
  if (!altWorkspacePrefix || !keys.meta) return keys;
  final modifier = workspaceCommandModifier;
  return SingleActivator(
    keys.trigger,
    meta: modifier == 'cmd',
    control: keys.control || modifier == 'ctrl',
    alt: keys.alt || modifier == 'alt',
    shift: keys.shift,
    includeRepeats: keys.includeRepeats,
  );
}

/// ⌥⌘←/→ is the Mac's tab key, as in Safari and Chrome. With Alt as the
/// prefix it would be Alt+arrows — the shell's word motions and the
/// browser's Back/Forward — so Linux and the web keep Alt-Shift-brackets.
const _altPrefixTabShortcuts = <ShortcutAction, SingleActivator>{
  ShortcutAction.nextSwarm: SingleActivator(
    LogicalKeyboardKey.bracketRight,
    alt: true,
    shift: true,
  ),
  ShortcutAction.previousSwarm: SingleActivator(
    LogicalKeyboardKey.bracketLeft,
    alt: true,
    shift: true,
  ),
};

AppShortcut _platformShortcut(AppShortcut shortcut) => !altWorkspacePrefix
    ? shortcut
    : AppShortcut(
        action: shortcut.action,
        activator:
            (shortcut.activator.meta
                ? _altPrefixTabShortcuts[shortcut.action]
                : null) ??
            (kIsWeb ? null : _linuxAltShortcuts[shortcut.action]) ??
            _platformActivator(shortcut.activator),
        label: shortcut.label,
        group: shortcut.group,
      );

/// Swarm bindings replace the old workspace navigation in the retained legacy
/// screen. Live Swarm bindings, tooltips, and help all use this same catalog.
const kSwarmShortcuts = [
  AppShortcut(
    action: ShortcutAction.shareAgent,
    activator: SingleActivator(
      LogicalKeyboardKey.keyS,
      meta: true,
      shift: true,
      includeRepeats: false,
    ),
    label: 'Share the focused harness',
    group: ShortcutGroup.actions,
  ),
  AppShortcut(
    action: ShortcutAction.addAgent,
    activator: SingleActivator(LogicalKeyboardKey.keyO, meta: true),
    label: 'Open Project',
    group: ShortcutGroup.actions,
  ),
  AppShortcut(
    action: ShortcutAction.newSwarm,
    activator: SingleActivator(LogicalKeyboardKey.keyT, meta: true),
    label: 'New Tab',
    group: ShortcutGroup.navigate,
  ),
  // ⌘⇧T is New Terminal, as it is in a terminal app. "Reopen last closed
  // harness" used to sit on it; it lives on in the History menu, the ⇧⌘P
  // command palette and `keybindings.jsonc`, without a default chord.
  AppShortcut(
    action: ShortcutAction.newTerminal,
    activator: SingleActivator(
      LogicalKeyboardKey.keyT,
      meta: true,
      shift: true,
    ),
    label: 'New Terminal',
    group: ShortcutGroup.actions,
  ),
  // ⌘⇧E, not ⌘⇧R: R is Rename Tab, and ⌘R is Split Right. E for "engine
  // again" — the pane stays, the process starts over.
  AppShortcut(
    action: ShortcutAction.restartAgent,
    activator: SingleActivator(
      LogicalKeyboardKey.keyE,
      meta: true,
      shift: true,
    ),
    label: 'Restart Harness',
    group: ShortcutGroup.actions,
  ),
  // ⌘⇧N was Create Agent until ⌘N became New Harness (01989f5a); reclaimed
  // for its shifted sibling: ⌘N starts a new one, ⌘⇧N another of this one.
  AppShortcut(
    action: ShortcutAction.cloneAgent,
    activator: SingleActivator(
      LogicalKeyboardKey.keyN,
      meta: true,
      shift: true,
    ),
    label: 'Clone Harness',
    group: ShortcutGroup.actions,
  ),
  AppShortcut(
    action: ShortcutAction.closeSwarm,
    activator: SingleActivator(LogicalKeyboardKey.keyW, meta: true),
    label: 'Close Tab',
    group: ShortcutGroup.navigate,
  ),
  AppShortcut(
    action: ShortcutAction.renameSwarm,
    activator: SingleActivator(
      LogicalKeyboardKey.keyR,
      meta: true,
      shift: true,
    ),
    label: 'Rename Tab',
    group: ShortcutGroup.navigate,
  ),
  AppShortcut(
    action: ShortcutAction.nextSwarm,
    activator: SingleActivator(
      LogicalKeyboardKey.arrowRight,
      meta: true,
      alt: true,
    ),
    label: 'Next Tab',
    group: ShortcutGroup.navigate,
  ),
  AppShortcut(
    action: ShortcutAction.previousSwarm,
    activator: SingleActivator(
      LogicalKeyboardKey.arrowLeft,
      meta: true,
      alt: true,
    ),
    label: 'Previous Tab',
    group: ShortcutGroup.navigate,
  ),
  AppShortcut(
    action: ShortcutAction.nextSwarm,
    activator: SingleActivator(LogicalKeyboardKey.tab, control: true),
    label: 'Next Tab',
    group: ShortcutGroup.navigate,
  ),
  AppShortcut(
    action: ShortcutAction.previousSwarm,
    activator: SingleActivator(
      LogicalKeyboardKey.tab,
      control: true,
      shift: true,
    ),
    label: 'Previous Tab',
    group: ShortcutGroup.navigate,
  ),
  AppShortcut(
    action: ShortcutAction.showAttention,
    activator: SingleActivator(
      LogicalKeyboardKey.keyI,
      meta: true,
      shift: true,
    ),
    label: 'Show harnesses needing input',
    group: ShortcutGroup.navigate,
  ),
  AppShortcut(
    action: ShortcutAction.closePane,
    activator: SingleActivator(
      LogicalKeyboardKey.keyW,
      meta: true,
      shift: true,
    ),
    label: 'Close the focused pane',
    group: ShortcutGroup.panes,
  ),
  AppShortcut(
    action: ShortcutAction.showSettings,
    activator: SingleActivator(LogicalKeyboardKey.comma, meta: true),
    label: 'Open Settings',
    group: ShortcutGroup.actions,
  ),
];

/// Command-number selects the first nine tabs in their visible order. The
/// shortcut sheet prints one row; pane movement uses Command-arrows.
const int kTabDigitCount = 9;

List<SingleActivator> tabDigitActivators() => (const [
  SingleActivator(LogicalKeyboardKey.digit1, meta: true),
  SingleActivator(LogicalKeyboardKey.digit2, meta: true),
  SingleActivator(LogicalKeyboardKey.digit3, meta: true),
  SingleActivator(LogicalKeyboardKey.digit4, meta: true),
  SingleActivator(LogicalKeyboardKey.digit5, meta: true),
  SingleActivator(LogicalKeyboardKey.digit6, meta: true),
  SingleActivator(LogicalKeyboardKey.digit7, meta: true),
  SingleActivator(LogicalKeyboardKey.digit8, meta: true),
  SingleActivator(LogicalKeyboardKey.digit9, meta: true),
]).map(_platformActivator).toList(growable: false);

/// One line in the shortcuts UI: what it does, and every chord that does it.
///
/// Not the same shape as [AppShortcut], and deliberately. Two activators can
/// drive one action — `⌘]` and `⌃⇥` both focus the next pane — which the
/// bindings need as two entries and the reader needs as one line. Printed as
/// two rows it reads as a duplicate the screen forgot to collapse.
class ShortcutRow {
  const ShortcutRow({
    required this.label,
    required this.chords,
    required this.group,
  });

  final String label;

  /// Every way to fire it, in declaration order — the first is the one to
  /// learn, the rest are alternates.
  final List<KeyChord> chords;

  final ShortcutGroup group;
}

/// [kAppShortcuts] as the UI prints it: one row per action, alternates folded
/// in, and `⌘1`–`⌘9` as the single line it deserves.
///
/// Derived rather than written out, so a shortcut cannot be added to the
/// bindings and forgotten here.
List<ShortcutRow> shortcutRows() {
  final byAction = <ShortcutAction, List<KeyChord>>{};
  final order = <ShortcutAction>[];
  final labels = <ShortcutAction, String>{};
  final groups = <ShortcutAction, ShortcutGroup>{};

  for (final shortcut in appShortcuts()) {
    if (byAction.putIfAbsent(shortcut.action, () => []).isEmpty) {
      order.add(shortcut.action);
      labels[shortcut.action] = shortcut.label;
      groups[shortcut.action] = shortcut.group;
    }
    byAction[shortcut.action]!.add(describeShortcutKeys(shortcut.activator));
  }

  final rows = [
    for (final action in order)
      ShortcutRow(
        label: labels[action]!,
        chords: byAction[action]!,
        group: groups[action]!,
      ),
  ];

  // The digits are not in [kAppShortcuts] — nine near-identical rows would bury
  // everything around them — so they join here, at the end of their group.
  final digits = ShortcutRow(
    label: 'Select tabs 1–9',
    chords: [
      [workspaceKeyLabel, '1 – $kTabDigitCount'],
    ],
    group: ShortcutGroup.navigate,
  );
  final lastTab = rows.lastIndexWhere(
    (row) => row.group == ShortcutGroup.navigate,
  );
  rows.insert(lastTab + 1, digits);
  return rows;
}

/// A key this app deliberately does **not** take, and who has it instead.
class TerminalKey {
  const TerminalKey(this.chord, this.label);

  final KeyChord chord;
  final String label;
}

/// What the terminal keeps — the doc comment at the top of this file, stated
/// where a user can read it.
///
/// The shortcuts screen prints these beside the ones the app takes, because
/// "why is there no shortcut for X" is answered by seeing that X already
/// belongs to something.
List<TerminalKey> get kTerminalOwnedKeys => [
  if (defaultTargetPlatform == TargetPlatform.linux) ...[
    TerminalKey([controlKeyLabel, shiftKeyLabel, 'C'], 'Copy'),
    TerminalKey([controlKeyLabel, shiftKeyLabel, 'V'], 'Paste'),
    TerminalKey([controlKeyLabel, shiftKeyLabel, 'A'], 'Select all'),
  ] else ...const [
    TerminalKey(['⌘', 'C'], 'Copy'),
    TerminalKey(['⌘', 'V'], 'Paste'),
    TerminalKey(['⌘', 'A'], 'Select all'),
  ],
  const TerminalKey(['esc'], 'Interrupt the engine'),
  TerminalKey([altKeyLabel, '⏎'], "Newline in the engine's prompt"),
  // Kept as short as the rows around them: the deck's narrowest card is 280px, where a label much
  // past thirty characters takes a second line to itself.
  TerminalKey([altKeyLabel, '⌫'], 'Delete the previous word'),
  // ⌘⌫ is taken in the pane on Apple only — elsewhere ⌘ is Super and stays the app's.
  if (defaultTargetPlatform != TargetPlatform.linux)
    const TerminalKey(['⌘', '⌫'], "Delete to the line's start"),
  TerminalKey([controlKeyLabel, 'C'], 'Cancel / interrupt in the agent'),
];

/// Turns the declared shortcuts into the map [CallbackShortcuts] wants.
///
/// A missing handler is left unbound rather than bound to nothing: a key that
/// silently does nothing is worse than a key that was never taken, because the
/// terminal underneath could have had it.
Map<ShortcutActivator, VoidCallback> buildShortcutBindings({
  required Map<ShortcutAction, VoidCallback> handlers,
  void Function(int index)? onSelectTabIndex,
  bool swarmMode = true,
}) {
  final bindings = <ShortcutActivator, VoidCallback>{};
  for (final shortcut in appShortcuts(swarmMode: swarmMode)) {
    final handler = handlers[shortcut.action];
    if (handler != null) bindings[shortcut.activator] = handler;
  }
  if (onSelectTabIndex != null) {
    final digits = tabDigitActivators();
    for (var i = 0; i < digits.length; i++) {
      bindings[digits[i]] = () => onSelectTabIndex(i);
    }
  }
  return bindings;
}

/// One chord, split into the keys a keyboard actually has — `['⇧', '⌘', ']']`.
///
/// Split rather than joined because the shortcuts UI draws one keycap per key.
/// [describeShortcut] is the same thing run together, for the places that want
/// a string (a tooltip, a test's failure message).
typedef KeyChord = List<String>;

/// The browser and Linux spell modifiers out, joined by `+`, the way their own
/// apps print a chord; only a Mac draws Apple's glyphs.
bool get spellsModifierKeys => kIsWeb || linuxKeyLabels;

/// The native Linux app, whose command key is Super.
bool get linuxKeyLabels =>
    !kIsWeb && defaultTargetPlatform == TargetPlatform.linux;

/// The workspace prefix as a keycap: ⌘ on a Mac, Alt where
/// [altWorkspacePrefix] moved it.
String get workspaceKeyLabel => altWorkspacePrefix ? 'Alt' : '⌘';

String get controlKeyLabel => spellsModifierKeys ? 'Ctrl' : '⌃';
String get altKeyLabel => spellsModifierKeys ? 'Alt' : '⌥';
String get shiftKeyLabel => spellsModifierKeys ? 'Shift' : '⇧';

/// The command key: ⌘ on a Mac, and on Linux the logo key a PC keyboard has
/// in its place, which the desktop calls Super.
String get commandKeyLabel => kIsWeb
    ? 'Cmd'
    : linuxKeyLabels
    ? 'Super'
    : '⌘';

String get chordKeySeparator => spellsModifierKeys ? '+' : '';

/// The caps for [activator], in the order Apple prints them.
KeyChord describeShortcutKeys(SingleActivator activator) => [
  if (activator.control) controlKeyLabel,
  if (activator.alt) altKeyLabel,
  if (activator.shift) shiftKeyLabel,
  if (activator.meta) commandKeyLabel,
  _keyLabel(activator.trigger),
];

/// "⇧⌘]" — the way a Mac menu prints it, in the order Apple prints it.
String describeShortcut(SingleActivator activator) =>
    describeShortcutKeys(activator).join(chordKeySeparator);

String _keyLabel(LogicalKeyboardKey key) {
  // keyLabel spells these out ("Arrow Left"), which is not how a Mac prints a
  // shortcut.
  if (key == LogicalKeyboardKey.arrowLeft) return '←';
  if (key == LogicalKeyboardKey.arrowRight) return '→';
  if (key == LogicalKeyboardKey.arrowUp) return '↑';
  if (key == LogicalKeyboardKey.arrowDown) return '↓';
  if (key == LogicalKeyboardKey.enter) return '⏎';
  if (key == LogicalKeyboardKey.tab) return '⇥';
  if (key == LogicalKeyboardKey.escape) return 'esc';
  return key.keyLabel;
}

/// The chord for [action], ready to append to a tooltip.
///
/// Tooltips read this instead of spelling the keys out, so a rebinding cannot
/// leave a button advertising a key that no longer works.
String? shortcutHintFor(ShortcutAction action, {bool swarmMode = true}) {
  for (final shortcut in appShortcuts(swarmMode: swarmMode)) {
    if (shortcut.action == action) return describeShortcut(shortcut.activator);
  }
  return null;
}

/// "Reload machines  ⌘R"
String withShortcutHint(
  String tooltip,
  ShortcutAction action, {
  bool swarmMode = true,
}) {
  final hint = shortcutHintFor(action, swarmMode: swarmMode);
  return hint == null ? tooltip : '$tooltip  $hint';
}
