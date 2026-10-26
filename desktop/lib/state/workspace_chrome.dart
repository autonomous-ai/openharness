import 'package:flutter/widgets.dart';

import '../super_tabs/reading.dart';

/// The workspace's command table as a host composition sees it: the same ids
/// and callbacks keys, native menus and the command box already run.
class WorkspaceCommands {
  const WorkspaceCommands({
    required this.enabled,
    required this.canRun,
    required this.run,
  });

  /// False while a dialog or route owns the window; bar controls go inert.
  final bool Function() enabled;
  final bool Function(String id) canRun;
  final void Function(String id) run;
}

/// One entry of the workspace footer as a host composition sees it: what it
/// names, what it currently reads, and the same action its footer link runs.
class WorkspaceFooterItem {
  const WorkspaceFooterItem({
    required this.title,
    this.detail = '',
    this.onPressed,
  });

  final String title;
  final String detail;
  final VoidCallback? onPressed;
}

/// The workspace footer's content, for a host that lays it out its own way.
class WorkspaceFooter {
  const WorkspaceFooter({
    required this.summary,
    required this.items,
    this.share,
  });

  /// One line standing for the whole footer, e.g. `MacBook · feat/web`.
  final String summary;

  /// Subscriptions, then the focused harness's machine, project, branch, PR.
  final List<WorkspaceFooterItem> items;

  /// The Share action, when the Share button is enabled.
  final WorkspaceFooterItem? share;
}

/// What a host composition adds to the shared workspace. Desktop passes none;
/// the web build (`lib/web/`) puts its mouse-first menu before the tabs, a bar
/// over the picker, and names a machine for New Harness. [leadingWidth] is reserved before the tabs
/// are measured.
class WorkspaceChrome {
  const WorkspaceChrome({
    required this.leadingWidth,
    required this.leading,
    this.newHarnessMachine,
    this.pickerShowsBack = false,
    this.showsKeyHints = true,
    this.viewMachineCloses = false,
    this.showsShareStatus = false,
    this.scrollsTabsByArrows = false,
    this.compactTabs,
    this.compactFooter,
    this.compactBelow = 0,
    this.twoPaneColumnsBelow = 0,
    this.firstMachine,
    this.menuOnEveryTab = false,
    this.labelsPaneStatus = false,
    this.compactPaneHeader = false,
    this.superTabRecovers = false,
    this.superTabReading = const SuperTabReading(),
    this.subscriptionsNeedComputer = false,
  });

  /// What a workspace with no host chrome (Desktop) reads: every switch at
  /// today's behavior.
  static final _none = WorkspaceChrome(
    leadingWidth: (_) => 0,
    leading: (_, _) => const SizedBox.shrink(),
  );

  /// The chrome the enclosing workspace was given, or the defaults when it
  /// was given none. For widgets the workspace builds, its overlays included;
  /// `SwarmScreen`'s own State code reads `widget.chrome` directly.
  static WorkspaceChrome of(BuildContext context) =>
      WorkspaceChromeScope.maybeOf(context) ?? _none;

  /// Shown over the workspace while none of the account's computers is
  /// connected, instead of opening the machine picker unasked. Null keeps the
  /// picker.
  final Widget Function(BuildContext context)? firstMachine;

  final double Function(BuildContext context) leadingWidth;
  final Widget Function(BuildContext context, WorkspaceCommands commands)
  leading;

  /// Where New Harness starts when no machine is this computer — a browser
  /// runs none. Null (or no answer) keeps sending the person to Machines.
  final String? Function()? newHarnessMachine;

  /// True gives the picker a clickable Back out of an open machine or project.
  final bool pickerShowsBack;

  /// False hides keyboard hints inside the workspace's pickers ([KeyHints]).
  final bool showsKeyHints;

  /// True makes a machine's View pick it for New Harness and close the
  /// picker; false keeps View scoping the picker to its harnesses.
  final bool viewMachineCloses;

  /// True marks each shared harness's pane header Public or Private.
  final bool showsShareStatus;

  /// True puts arrows either side of a tab list too long for the bar.
  final bool scrollsTabsByArrows;

  /// Below [compactBelow] of window width the workspace goes compact: this
  /// replaces the tab list (the Store button steps aside), and only the focused
  /// harness is drawn — a phone has room for neither a tab row nor a grid.
  final Widget Function(BuildContext context, WorkspaceCommands commands)?
  compactTabs;

  /// Replaces the status bar while compact. It is handed the footer's content
  /// and owns its own height — zero hides it.
  final Widget Function(BuildContext context, WorkspaceFooter footer)?
  compactFooter;
  final double compactBelow;

  /// Below [twoPaneColumnsBelow] of window width the pane grid is drawn at
  /// most two columns wide, so a tablet's panes keep a readable header. Only
  /// the drawing: the tab's saved layout stays the one a wider window shows.
  /// Zero, the default, never applies. Audit finding S2.
  final double twoPaneColumnsBelow;

  /// The most pane columns a window [width] wide draws, or null for no limit.
  int? maxPaneColumnsAt(double width) => width < twoPaneColumnsBelow ? 2 : null;

  /// True gives every tab a right-click menu (Rename Tab, Close Tab), not only
  /// a shared one. Audit finding S10.
  final bool menuOnEveryTab;

  /// True labels a pane whose computer is connecting or reconnecting, or whose
  /// terminal is view only, in words beside its name. Audit findings S3, S4.
  final bool labelsPaneStatus;

  /// True draws a denser pane header below [compactBelow]: the harness name
  /// first, agent and model behind one control. Audit finding S2.
  final bool compactPaneHeader;

  /// True gives a Swarm tab's states a way forward: a first read that failed
  /// is the error and Retry in place of the conversation (no "Loading" beside
  /// it), and "Create a project to get started." carries New project. Audit
  /// findings S12, P5.
  final bool superTabRecovers;

  /// How the Swarm tabs keep themselves current. The default is Desktop's: a
  /// full read every 3 s, on screen or not. #180's report, fixes 1, 2a and 3.
  final SuperTabReading superTabReading;

  /// True leaves Subscriptions out of the compact footer while the account
  /// has no computer, once the machine list has said so: there is no agent
  /// account to read before one. While the list is on its way it stays.
  final bool subscriptionsNeedComputer;

  /// Whether a window [width] wide gets the compact pane header.
  bool compactPaneHeaderAt(double width) =>
      compactPaneHeader && width < compactBelow;
}

/// Hands the workspace's [WorkspaceChrome] to every widget below it, so a
/// widget the workspace builds reads it with [WorkspaceChrome.of] instead of
/// taking it as a parameter.
class WorkspaceChromeScope extends InheritedWidget {
  const WorkspaceChromeScope({
    super.key,
    required this.chrome,
    required super.child,
  });

  /// The chrome the workspace was given; null on Desktop.
  final WorkspaceChrome? chrome;

  static WorkspaceChrome? maybeOf(BuildContext context) => context
      .dependOnInheritedWidgetOfExactType<WorkspaceChromeScope>()
      ?.chrome;

  @override
  bool updateShouldNotify(WorkspaceChromeScope oldWidget) =>
      !identical(chrome, oldWidget.chrome);
}
