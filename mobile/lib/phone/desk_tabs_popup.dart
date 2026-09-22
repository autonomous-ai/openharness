import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/core/last_opened_agent.dart' show AgentRef;
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/state/app_state.dart';

import 'agent_index.dart';
import 'agent_tile.dart';
import 'agents_page.dart' show openNewAgent;
import 'desk_add_agent_sheet.dart';
import 'desk_groups.dart';
import 'desk_tab_strip.dart';
import 'phone_card.dart';
import 'phone_navigation.dart';
import 'phone_status.dart';

/// The account's tabs, and the agents inside the one being read, as a panel up
/// from the bottom of the terminal.
///
/// ```
/// ────────────────────────────────
///   Desktop   Docker   Other
///   ───────
///  ┌──────────────────────────┐
///  │ ◆  api-3      Live     › │
///  │    harness · Mac mini    │
///  ├──────────────────────────┤
///  │ ◆  web        Idle     › │
///  │    site · Mac mini       │
///  └──────────────────────────┘
/// ```
///
/// ⚠️ **Two moves, not one.** A tab name changes which agents the list below
/// offers and nothing else; opening happens on a row. That is what lets
/// somebody look into another tab — see what is running there — without losing
/// the terminal they are in, which a sheet of tab names could not do.
///
/// ⚠️ **From the bottom, because that is where the thumb is.** The mark that
/// opens it rides the header at the top of the phone, but the list it opens is
/// a list to reach into, so it comes up from the bottom edge like every other
/// phone sheet here.
///
/// ⚠️ **The agents scroll DOWN, and they are the Agents tab's own rows.** They
/// were cards side by side, which put a scroll across the panel at right
/// angles to the one every other list here has — and made a phone read four
/// agents through a letterbox. A column reads at a glance, takes long names
/// whole, and is the row an agent already has everywhere else ([AgentTile]).
///
/// [showing] is the agent on screen: it decides which tab the panel opens on
/// (see [activeDeskGroup]), and its row is the one wearing the rim.
Future<void> showDeskTabsPopup(
  BuildContext context,
  AppNotifier notifier, {
  required AgentRef showing,
}) {
  final groups = deskGroups(notifier, visibleAgents(agentIndex(notifier)));
  final active = activeDeskGroup(notifier, groups, showing);
  return showModalBottomSheet<void>(
    context: context,
    useRootNavigator: true,
    showDragHandle: true,
    backgroundColor: AppPalette.panelBg,
    // A column of rows outgrows Flutter's 9/16 cap, which is not a height
    // anything here asked for — see [_DeskTabsPanelState.build] for the one
    // this panel keeps.
    isScrollControlled: true,
    builder: (sheetContext) => _DeskTabsPanel(
      notifier: notifier,
      initialId: active.id,
      showing: showing,
      // Close first, then open: the terminal this pushes must not arrive
      // underneath a panel that is still animating out — the same order every
      // row in [showPhoneSheet] takes.
      onOpen: (group, entry) {
        Navigator.of(sheetContext).pop();
        openDeskAgent(context, notifier, group, entry);
      },
    ),
  );
}

/// The rows' own side inset: [phoneListPadding]'s 16, not the strip's 20. A
/// card carries its content 13 further in again, so rows lined up on the names
/// above them read as indented from them.
const double _sideInset = 16;

/// The panel itself: the tab names, and the rows of whichever tab is picked.
class _DeskTabsPanel extends StatefulWidget {
  const _DeskTabsPanel({
    required this.notifier,
    required this.initialId,
    required this.showing,
    required this.onOpen,
  });

  /// ⚠️ **The groups are rebuilt from here on every change, not passed in
  /// once.** An agent added to a tab from this panel has to appear in it while
  /// the panel is still open — a list computed before the sheet was shown
  /// answered a tap by doing nothing visible at all.
  final AppNotifier notifier;

  /// The tab the panel opens on — the one the agent on screen belongs to.
  final String? initialId;

  final AgentRef showing;

  final void Function(DeskGroup group, AgentEntry entry) onOpen;

  @override
  State<_DeskTabsPanel> createState() => _DeskTabsPanelState();
}

class _DeskTabsPanelState extends State<_DeskTabsPanel> {
  late String? _selectedId = widget.initialId;

  List<DeskGroup> get _groups =>
      deskGroups(widget.notifier, visibleAgents(agentIndex(widget.notifier)));

  /// The tab being read. Falls back to the first, which is only reachable if
  /// the desk dropped a tab while the panel was open.
  DeskGroup _groupIn(List<DeskGroup> groups) =>
      groups.where((group) => group.id == _selectedId).firstOrNull ??
      groups.first;

  /// Whether [group] can take another agent: a real tab on a desk this phone
  /// may write to. The leftover group is not a tab — there is nothing to add
  /// an agent TO — and neither is the single group a phone with no desk shows.
  bool _canAddTo(DeskGroup group) =>
      group.id != null && widget.notifier.deskWritable;

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
              name: entry.agent.name,
            ),
            name: entry.agent.name,
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
                Navigator.of(context).pop();
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
                Navigator.of(context).pop();
                unawaited(openNewAgent(context, notifier, host));
              },
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return ListenableBuilder(
      listenable: widget.notifier,
      builder: (context, _) => _panel(context),
    );
  }

  Widget _panel(BuildContext context) {
    final groups = _groups;
    final group = _groupIn(groups);
    return SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          DeskTabStrip(
            groups: groups,
            selectedId: group.id,
            onPick: (picked) => setState(() => _selectedId = picked.id),
            // Undrawn on a desk that cannot be written to — see
            // [AppNotifier.deskWritable].
            onAddTab: widget.notifier.deskWritable ? _addTab : null,
          ),
          const SizedBox(height: 6),
          // ⚠️ **One height, whatever the tab holds.** Sized to its contents,
          // the panel stood up and sat down as tabs were read — a tab of one
          // agent, then a tab of six — and the names along the top moved with
          // it, so the next tab was somewhere else by the time the thumb got
          // there. Half the screen: enough for four rows, and the terminal
          // keeps the other half.
          SizedBox(
            height: MediaQuery.sizeOf(context).height * 0.5,
            // ⚠️ **An empty tab keeps its sentence AND gets the `+`.** The two
            // answer different halves of the same screen: the sentence says
            // why there is nothing here, and the `+` is what to do about it.
            // Dropped in favour of the row, a tab whose machine is asleep
            // silently became a tab that merely had nothing in it.
            child: group.isEmpty
                ? Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      _TabIsEmpty(everHeldAgents: _everHeldAgents(group)),
                      if (_canAddTo(group))
                        Padding(
                          padding: const EdgeInsets.symmetric(
                            horizontal: _sideInset,
                          ),
                          child: _AddAgentRow(
                            tabName: group.name,
                            onTap: () => _addAgentTo(group),
                          ),
                        ),
                    ],
                  )
                : ListView.separated(
                    padding: EdgeInsets.fromLTRB(
                      _sideInset,
                      4,
                      _sideInset,
                      MediaQuery.paddingOf(context).bottom + 8,
                    ),
                    itemCount:
                        group.entries.length + (_canAddTo(group) ? 1 : 0),
                    separatorBuilder: (context, index) =>
                        const SizedBox(height: kPhoneCardGap),
                    itemBuilder: (context, index) {
                      // ⚠️ **Last in the list, and shaped like the rows above
                      // it rather than like the `+` on the tab row.** This one
                      // adds an agent to the tab being read; that one opens a
                      // tab. Two identical marks would be a guess, so the one
                      // that could be mistaken carries the words — and standing
                      // IN the list is itself the sentence "into this list".
                      if (index == group.entries.length) {
                        return _AddAgentRow(
                          tabName: group.name,
                          onTap: () => _addAgentTo(group),
                        );
                      }
                      final entry = group.entries[index];
                      final showing =
                          entry.machineId == widget.showing.machineId &&
                          entry.agent.id == widget.showing.agentId;
                      return AgentTile(
                        machine: entry.machine,
                        agent: entry.agent,
                        // The agent already on screen keeps its row — it is the
                        // one you came from, and the list would read as missing
                        // an agent without it — and wears the accent rim.
                        border: showing
                            ? Border.all(
                                color: AppPalette.accentOnSurface,
                                width: 1.5,
                              )
                            : null,
                        onTap: () => widget.onOpen(group, entry),
                      );
                    },
                  ),
          ),
        ],
      ),
    );
  }
}

/// The `+` at the foot of a tab's agents: one more agent in THIS tab.
///
/// ⚠️ **A row, not a mark, and that is the whole of how it is told apart from
/// the `+` on the tab row above.** They are the same glyph doing two different
/// things, so nothing rests on the glyph: this one is as wide as the agent
/// rows, sits at the end of them, is drawn in the dashes that mean "not filled
/// in yet", and says which tab it fills. See [DeskTabStrip].
class _AddAgentRow extends StatelessWidget {
  const _AddAgentRow({required this.tabName, required this.onTap});

  final String tabName;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Semantics(
      button: true,
      label: 'Add agent to $tabName',
      // ⚠️ The words on the row are "this tab", which is clear under a thumb
      // that has just read the tab's name and useless read aloud on its own.
      // Excluded, the row announces the tab it fills.
      excludeSemantics: true,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: () {
          HapticFeedback.selectionClick();
          onTap();
        },
        child: CustomPaint(
          painter: _DashedRim(color: AppGlass.hair),
          child: SizedBox(
            height: 56,
            child: Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Icon(
                  LucideIcons.plus300,
                  size: 18,
                  color: AppPalette.textSecondary,
                ),
                const SizedBox(width: 8),
                Flexible(
                  child: Text(
                    'Add agent to this tab',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      color: AppPalette.textSecondary,
                      fontSize: 14.5,
                      fontWeight: FontWeight.w500,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// The dashes around [_AddAgentRow]. A card's own rim is a hairline all the way
/// round, which is what every FILLED row here wears; broken, it reads as a
/// place for a row rather than as one.
class _DashedRim extends CustomPainter {
  const _DashedRim({required this.color});

  final Color color;

  static const double _radius = 14;
  static const double _dash = 5;
  static const double _gap = 4;

  @override
  void paint(Canvas canvas, Size size) {
    final rim = Path()
      ..addRRect(
        RRect.fromRectAndRadius(
          Offset.zero & size,
          const Radius.circular(_radius),
        ),
      );
    final brush = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1
      ..color = color;
    for (final metric in rim.computeMetrics()) {
      var at = 0.0;
      while (at < metric.length) {
        canvas.drawPath(
          metric.extractPath(at, (at + _dash).clamp(0, metric.length)),
          brush,
        );
        at += _dash + _gap;
      }
    }
  }

  @override
  bool shouldRepaint(_DashedRim old) => old.color != color;
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
      padding: const EdgeInsets.fromLTRB(_sideInset, 10, _sideInset, 18),
      child: Text(
        everHeldAgents
            ? 'Nothing here this phone can open — the machine these agents run '
                  'on is asleep or wants its password.'
            : 'This tab has no agents yet.',
        style: TextStyle(color: AppPalette.textSecondary, fontSize: 13.5),
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
