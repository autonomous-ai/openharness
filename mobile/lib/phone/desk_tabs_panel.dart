import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/core/last_opened_agent.dart' show AgentRef;
import 'package:harness_mobile/notify/agent_notice.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/state/app_state.dart';

import 'agent_index.dart';
import 'agents_page.dart' show openNewAgent;
import 'desk_add_agent_sheet.dart';
import 'desk_groups.dart';
import 'desk_tab_rename_dialog.dart';
import 'desk_tab_strip.dart';
import 'phone_navigation.dart';
import 'phone_status.dart';
import 'sheet_agent_lines.dart';
import 'sheet_list.dart';

/// The account's tabs, and the agents inside the one being read — what the
/// terminal's search sheet shows under its field until the field is focused.
///
/// ```
///  (▓Desktop▓) ( Docker ) ( Other )  (+)
///    DESKTOP                          2
///  ╭────────────────────────────────╮
///  │ ▣  api-3                  ◌  › │
///  │    harness · ⑂ main · Mac mini │
///  │    ────────────────────────────│
///  │ +  Add harness to this tab     │
///  ╰────────────────────────────────╯
/// ```
///
/// ⚠️ **Two moves, not one.** A tab's pill changes which agents the list below
/// offers and nothing else; opening happens on a row. That is what lets
/// somebody look into another tab — see what is running there — without losing
/// the terminal they are in, which a sheet of tab names could not do.
///
/// ⚠️ **Under the search field, not behind a mark of its own.** This was a
/// sheet of its own, opened from a grid mark in the terminal header, beside a
/// search that was a second screen. Finding an agent by where it is and finding
/// it by name are one errand, so they are one sheet now, opened from the
/// floating Search button and reading the tabs until something is typed — see
/// [TerminalSearchOverlay].
///
/// ⚠️ **The agents scroll DOWN, in one inset group.** They were cards side by
/// side, which put a scroll across the panel at right angles to the one every
/// other list here has — and made a phone read four agents through a
/// letterbox. They were then the Agents tab's own cards ([AgentTile]), until
/// it showed that the search replacing them in place drew the same agents as
/// flat lines: focusing the field swapped one look for another. Both are
/// [SheetRow]s now — see [DeskAgentRow].
///
/// ⚠️ **It fills the height it is given, and the sheet around it gives one
/// height whatever the tab holds.** Sized to its contents, the panel stood up
/// and sat down as tabs were read — a tab of one agent, then a tab of six — and
/// the pills along the top moved with it, so the next tab was somewhere else by
/// the time the thumb got there.
class DeskTabsPanel extends StatefulWidget {
  const DeskTabsPanel({
    super.key,
    required this.notifier,
    required this.onOpen,
    required this.onClose,
    this.showing,
  });

  /// ⚠️ **The groups are rebuilt from here on every change, not passed in
  /// once.** An agent added to a tab from this panel has to appear in it while
  /// the panel is still open — a list computed before the panel was shown
  /// answered a tap by doing nothing visible at all.
  final AppNotifier notifier;

  /// A row tapped: the agent, and the tab it was picked out of — what
  /// [openDeskAgent] takes.
  ///
  /// ⚠️ The caller puts the panel away FIRST: a terminal arriving under a panel
  /// still on its way out is the order every sheet here avoids.
  final void Function(DeskGroup group, AgentEntry entry) onOpen;

  /// Puts the panel away without opening anything here — for the paths that
  /// leave it for another screen, the new-agent form.
  final VoidCallback onClose;

  /// The agent on screen: it decides which tab the panel opens on (see
  /// [activeDeskGroup]), and its row is the one wearing the check. Null opens
  /// on the tab the phone was last in, and checks nothing.
  final AgentRef? showing;

  @override
  State<DeskTabsPanel> createState() => _DeskTabsPanelState();
}

class _DeskTabsPanelState extends State<DeskTabsPanel> {
  /// The tab being read: at first the one the agent on screen belongs to.
  ///
  /// ⚠️ Kept by this state and nothing above it, so a panel that stays built
  /// while something covers it comes back on the tab that was being read — see
  /// [TerminalSearchOverlay], which keeps it built under the results.
  late String? _selectedId = activeDeskGroup(
    widget.notifier,
    _groups,
    widget.showing,
  ).id;

  List<DeskGroup> get _groups =>
      deskGroups(widget.notifier, visibleAgents(agentIndex(widget.notifier)));

  /// The tab being read. Falls back to the first, which is only reachable if
  /// the desk dropped a tab while the panel was open.
  DeskGroup _groupIn(List<DeskGroup> groups) =>
      groups.where((group) => group.id == _selectedId).firstOrNull ??
      groups.first;

  /// Whether [group] can take another agent: a real tab on a desk this phone
  /// may write to. The single group a phone with no desk shows is not a tab —
  /// there is nothing to add an agent TO.
  bool _canAddTo(DeskGroup group) =>
      group.id != null && widget.notifier.deskWritable;

  /// Whether [group] is the single one a phone with no desk shows.
  ///
  /// It takes a row of its own rather than [_canAddTo]'s: there is no tab to
  /// add an agent TO, but a new harness can still be started from it.
  bool _canStartUntabbed(DeskGroup group) =>
      group.id == null && _hostMachineId != null;

  /// Every agent this phone could put in a tab: the ones it can actually open,
  /// which is the same test [deskGroups] makes of the ones already in them.
  List<AgentEntry> get _openable => [
    for (final entry in visibleAgents(agentIndex(widget.notifier)))
      if (entry.agent.terminalAvailable) entry,
  ];

  /// The machine a new agent would be made on: the first that can host one,
  /// which is also the form's own first question and changed there. Null where
  /// none can — every machine asleep, or wanting its password — and that is
  /// what leaves "New agent" out of the sheet rather than drawn dead.
  String? get _hostMachineId => [
    for (final machine in filterableMachines(widget.notifier))
      if (phoneMachineStatusOf(machine) == PhoneMachineStatus.ready) machine,
  ].firstOrNull?.machine.machineId;

  AgentRef _refOf(AgentEntry entry) =>
      (machineId: entry.machineId, agentId: entry.agent.id);

  /// Whether an empty [group] is empty because its agents are out of REACH, or
  /// because it holds none at all.
  ///
  /// The two look identical on screen and are nothing alike: the first is a
  /// machine asleep and the agents are still there, the second is a tab that
  /// has been emptied or has only just been made. Read from the desk itself —
  /// [DeskGroup] carries the agents this phone can open, which is by definition
  /// none in both cases.
  bool _everHeldAgents(DeskGroup group) =>
      widget.notifier.deskTabs
          .where((tab) => tab.id == group.id)
          .firstOrNull
          ?.panes
          .isNotEmpty ??
      false;

  /// A double tap on a tab's name.
  ///
  /// ⚠️ **The tab is picked as well as renamed, and not as an afterthought.**
  /// The first tap of the two has already picked it, so the panel below is
  /// showing what is being named — and after a rename the row under the names
  /// would otherwise belong to a different tab than the one just typed.
  void _rename(DeskGroup group) {
    final id = group.id;
    if (id == null) return;
    setState(() => _selectedId = id);
    unawaited(
      showDeskTabRenameDialog(
        context,
        widget.notifier,
        tabId: id,
        currentName: group.name,
      ),
    );
  }

  /// The `+` on the tab row: a tab of its own for an agent picked or made now.
  ///
  /// ⚠️ **The tab is written only once there is something to put in it.** A
  /// tab created up front and then abandoned — the form cancelled, the machine
  /// refusing — would be an empty tab on every computer the person owns, put
  /// there by a tap they took back. For a new agent that means arming
  /// [AppNotifier.openNextAgentInNewDeskTab] and letting the agent's own
  /// arrival make the tab.
  void _addTab() {
    final notifier = widget.notifier;
    final host = _hostMachineId;
    unawaited(
      showDeskAddAgentSheet(
        context,
        title: 'New tab',
        choices: _openable,
        onPick: (entry) {
          final group = DeskGroup(
            id: notifier.createDeskTabFor(
              _refOf(entry),
              name: entry.agent.displayName,
            ),
            name: entry.agent.displayName,
            entries: [entry],
          );
          if (group.id == null) return;
          // Opened, not merely listed: the tab exists now and the phone is in
          // it, and a panel that stayed put would say neither.
          widget.onOpen(group, entry);
        },
        onCreate: host == null
            ? null
            : () {
                notifier.openNextAgentInNewDeskTab();
                // Away first, then the form: it is pushed over the terminal,
                // and must not arrive under a panel still on its way out.
                widget.onClose();
                unawaited(
                  openNewAgent(
                    context,
                    notifier,
                    host,
                  ).whenComplete(notifier.forgetNewDeskTabIntent),
                );
              },
      ),
    );
  }

  /// The row at the foot of the single group a phone with no desk shows: a
  /// harness that belongs to no tab, the way every harness did before the desk
  /// existed.
  ///
  /// The phone is taken out of any tab first: an agent made here joins
  /// whatever tab the phone is in ([PhoneDesk.adopt]).
  void _startUntabbed() {
    final host = _hostMachineId;
    if (host == null) return;
    final notifier = widget.notifier;
    notifier.selectDeskTab(null);
    widget.onClose();
    unawaited(openNewAgent(context, notifier, host));
  }

  /// The `+` at the foot of a tab's list: another agent in the tab being read.
  ///
  /// The panel stays open on the way back — this is a list being filled, and
  /// the agent appears in it under the thumb that added it.
  void _addAgentTo(DeskGroup group) {
    final id = group.id;
    if (id == null) return;
    final notifier = widget.notifier;
    final host = _hostMachineId;
    unawaited(
      showDeskAddAgentSheet(
        context,
        title: 'Add to “${group.name}”',
        choices: [
          for (final entry in _openable)
            if (!group.holds(_refOf(entry))) entry,
        ],
        onPick: (entry) => notifier.addAgentToDeskTab(id, _refOf(entry)),
        onCreate: host == null
            ? null
            : () {
                // The tab the phone is in is the tab an agent made here joins
                // — see [PhoneDesk.adopt] — so this is what aims that.
                notifier.selectDeskTab(id);
                widget.onClose();
                unawaited(openNewAgent(context, notifier, host));
              },
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return ListenableBuilder(
      // The unread marks have their own notifier — see `notify/agent_unread.dart`.
      listenable: Listenable.merge([
        widget.notifier,
        widget.notifier.agentNotices.unread,
      ]),
      builder: (context, _) => _panel(context),
    );
  }

  Widget _panel(BuildContext context) {
    final groups = _groups;
    final group = _groupIn(groups);
    final showing = widget.showing;
    final canAdd = _canAddTo(group);
    final canStart = _canStartUntabbed(group);
    final count = group.entries.length + (canAdd || canStart ? 1 : 0);
    final padding = EdgeInsets.fromLTRB(
      kSheetInset,
      0,
      kSheetInset,
      MediaQuery.paddingOf(context).bottom + 16,
    );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        DeskTabStrip(
          groups: groups,
          selectedId: group.id,
          onPick: (picked) => setState(() => _selectedId = picked.id),
          // Undrawn on a desk that cannot be written to — see
          // [AppNotifier.deskWritable].
          onAddTab: widget.notifier.deskWritable ? _addTab : null,
          onRename: widget.notifier.deskWritable ? _rename : null,
          unreadFor: (tab) => widget.notifier.agentNotices.unread.mostUrgentOf(
            tab.entries.map(_refOf),
          ),
        ),
        SheetCaption(
          label: group.name,
          // A count only where there is something to count: `0` over a tab
          // whose machine is asleep would say the tab is empty, which is the
          // one thing the sentence under it says it is not.
          count: group.isEmpty ? null : '${group.entries.length}',
        ),
        Expanded(
          // ⚠️ **An empty tab keeps its sentence AND gets the `+`.** The two
          // answer different halves of the same screen: the sentence says why
          // there is nothing here, and the `+` is what to do about it. Dropped
          // in favour of the row, a tab whose machine is asleep silently became
          // a tab that merely had nothing in it.
          child: group.isEmpty
              // A list, not a column, though it holds two things: the height
              // it is given is what the sheet has left over, and on a phone
              // lying on its side that is less than the two of them.
              ? ListView(
                  padding: padding,
                  children: [
                    _TabIsEmpty(everHeldAgents: _everHeldAgents(group)),
                    if (canAdd)
                      _AddAgentRow(
                        tabName: group.name,
                        first: true,
                        last: true,
                        onTap: () => _addAgentTo(group),
                      )
                    else if (canStart)
                      _NewHarnessRow(
                        first: true,
                        last: true,
                        onTap: _startUntabbed,
                      ),
                  ],
                )
              : ListView.builder(
                  padding: padding,
                  itemCount: count,
                  itemBuilder: (context, index) {
                    // ⚠️ **Last in the group, and a row of it rather than a
                    // mark like the `+` on the tab row.** This one adds an
                    // agent to the tab being read; that one opens a tab. Two
                    // identical marks would be a guess, so the one that could
                    // be mistaken carries the words — and closing the group
                    // of the tab's agents is itself the sentence "into this
                    // list".
                    if (index == group.entries.length) {
                      return canStart
                          ? _NewHarnessRow(
                              first: index == 0,
                              last: true,
                              onTap: _startUntabbed,
                            )
                          : _AddAgentRow(
                              tabName: group.name,
                              first: index == 0,
                              last: true,
                              onTap: () => _addAgentTo(group),
                            );
                    }
                    final entry = group.entries[index];
                    return DeskAgentRow(
                      entry: entry,
                      unread: widget.notifier.agentNotices.unread.kindFor(
                        _refOf(entry),
                      ),
                      onScreen:
                          showing != null &&
                          entry.machineId == showing.machineId &&
                          entry.agent.id == showing.agentId,
                      first: index == 0,
                      last: index == count - 1,
                      onTap: () => widget.onOpen(group, entry),
                    );
                  },
                ),
        ),
      ],
    );
  }
}

/// One agent in the tab being read.
///
/// The row the sheet's search draws an agent with too ([SheetSearchRow]), so
/// focusing the field changes which agents are listed and not how one looks.
class DeskAgentRow extends StatelessWidget {
  const DeskAgentRow({
    super.key,
    required this.entry,
    required this.onScreen,
    required this.first,
    required this.last,
    required this.onTap,
    this.unread,
  });

  final AgentEntry entry;

  /// Its news nobody has gone to yet — see [SheetAgentTitle.unread].
  final NoticeKind? unread;

  /// The agent on screen. It keeps its row — it is the one you came from, and
  /// the list would read as missing an agent without it — and wears the check
  /// where the others have a chevron.
  final bool onScreen;

  /// Whether this row opens the group, and whether it closes it.
  final bool first, last;

  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final agent = entry.agent;
    return SheetRow(
      first: first,
      last: last,
      selected: onScreen,
      enabled: agent.terminalAvailable,
      onTap: agent.terminalAvailable ? onTap : null,
      leading: SheetEngineTile(
        engine: agent.engine,
        displayName: agent.engineDisplayName,
      ),
      title: SheetAgentTitle(
        entry: entry,
        now: DateTime.now(),
        unread: unread,
        name: Text(
          agent.displayName,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: sheetRowTitleStyle(),
        ),
      ),
      subtitle: SheetAgentMeta(entry: entry),
      trailing: SheetAgentStatus(summary: entry.summary, onScreen: onScreen),
      chevron: !onScreen,
    );
  }
}

/// The `+` at the foot of a tab's agents: one more agent in THIS tab.
///
/// ⚠️ **A row, not a mark, and that is the whole of how it is told apart from
/// the `+` on the tab row above.** They are the same glyph doing two different
/// things, so nothing rests on the glyph: this one is a row of the group it
/// fills, closes it, is written in the accent iOS gives a row that acts rather
/// than opens, and says which tab it fills. See [DeskTabStrip].
class _AddAgentRow extends StatelessWidget {
  const _AddAgentRow({
    required this.tabName,
    required this.first,
    required this.last,
    required this.onTap,
  });

  final String tabName;
  final bool first, last;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final accent = AppPalette.accentOnSurface;
    return SheetRow(
      first: first,
      last: last,
      // ⚠️ The words on the row are "this tab", which is clear under a thumb
      // that has just read the tab's name and useless read aloud on its own.
      // Read aloud, the row names the tab it fills.
      semanticsLabel: 'Add harness to $tabName',
      leading: SheetTile(
        child: Icon(LucideIcons.plus, size: 18, color: accent),
      ),
      title: Text(
        'Add harness to this tab',
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: sheetRowTitleStyle().copyWith(color: accent),
      ),
      // It adds here rather than going anywhere.
      chevron: false,
      onTap: () {
        HapticFeedback.selectionClick();
        onTap();
      },
    );
  }
}

/// The row at the foot of the no-desk group: start a harness that no tab owns.
///
/// ⚠️ **"New harness", not "Add harness" — a different verb for a different
/// act.** The row in a real tab PUTS something that exists into that tab; this
/// one makes something that did not exist, and there is no tab to put it in.
class _NewHarnessRow extends StatelessWidget {
  const _NewHarnessRow({
    required this.first,
    required this.last,
    required this.onTap,
  });

  final bool first, last;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final accent = AppPalette.accentOnSurface;
    return SheetRow(
      first: first,
      last: last,
      semanticsLabel: 'New harness, in no tab',
      leading: SheetTile(
        child: Icon(LucideIcons.plus, size: 18, color: accent),
      ),
      title: Text(
        'New harness',
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: sheetRowTitleStyle().copyWith(color: accent),
      ),
      // It opens the New Harness form, so it keeps the chevron the rows that
      // go somewhere wear.
      onTap: () {
        HapticFeedback.selectionClick();
        onTap();
      },
    );
  }
}

/// A tab whose agents are all out of reach — the machine they run on is asleep
/// or wants its password. The tab is still listed and still opens to this,
/// because a tab missing from the row reads as one somebody deleted.
class _TabIsEmpty extends StatelessWidget {
  const _TabIsEmpty({required this.everHeldAgents});

  /// Whether the tab holds agents this phone cannot reach, as opposed to no
  /// agents at all — see [_DeskTabsPanelState._everHeldAgents].
  final bool everHeldAgents;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Padding(
      // Under the caption's own first letter, and clear of the row below it.
      padding: const EdgeInsets.fromLTRB(
        kSheetCaptionInset - kSheetInset,
        2,
        kSheetCaptionInset - kSheetInset,
        14,
      ),
      child: Text(
        everHeldAgents
            ? 'Nothing here this phone can open — the machine these harnesses run '
                  'on is asleep or wants its password.'
            : 'This tab has no harnesses yet.',
        style: TextStyle(
          color: AppPalette.textSecondary,
          fontSize: 13.5,
          height: 1.4,
        ),
      ),
    );
  }
}

/// Open [entry] from [group]: the phone is in that tab from here.
///
/// ⚠️ The order matters. [AppNotifier.selectDeskTab] is what settles which tab
/// an agent that sits on TWO of them belongs to (see [activeDeskGroup]); set
/// after the open, it would be read a frame too late and the panel would come
/// back barring the tab that was left.
void openDeskAgent(
  BuildContext context,
  AppNotifier notifier,
  DeskGroup group,
  AgentEntry entry,
) {
  notifier.selectDeskTab(group.id);
  openAgent(context, notifier, entry.machineId, entry.agent.id);
}
