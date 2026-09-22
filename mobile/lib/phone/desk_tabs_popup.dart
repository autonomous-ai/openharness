import 'package:flutter/material.dart';

import 'package:harness_mobile/core/last_opened_agent.dart' show AgentRef;
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/state/app_state.dart';

import 'agent_index.dart';
import 'agent_tile.dart';
import 'desk_groups.dart';
import 'desk_tab_strip.dart';
import 'phone_card.dart';
import 'phone_navigation.dart';

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
    // A column of rows outgrows Flutter's 9/16 cap on the second tab of any
    // real desk — and short of the top on purpose, so the terminal underneath
    // stays recognisable while its own panel is open. Same two lines every
    // phone sheet here is built with; see [showPhoneSheet].
    isScrollControlled: true,
    constraints: BoxConstraints(
      maxHeight: MediaQuery.sizeOf(context).height * 0.85,
    ),
    builder: (sheetContext) => _DeskTabsPanel(
      groups: groups,
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
    required this.groups,
    required this.initialId,
    required this.showing,
    required this.onOpen,
  });

  final List<DeskGroup> groups;

  /// The tab the panel opens on — the one the agent on screen belongs to.
  final String? initialId;

  final AgentRef showing;

  final void Function(DeskGroup group, AgentEntry entry) onOpen;

  @override
  State<_DeskTabsPanel> createState() => _DeskTabsPanelState();
}

class _DeskTabsPanelState extends State<_DeskTabsPanel> {
  late String? _selectedId = widget.initialId;

  /// The tab being read. Falls back to the first, which is only reachable if
  /// the desk dropped a tab while the panel was open.
  DeskGroup get _group =>
      widget.groups.where((group) => group.id == _selectedId).firstOrNull ??
      widget.groups.first;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final group = _group;
    return SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          DeskTabStrip(
            groups: widget.groups,
            selectedId: group.id,
            onPick: (picked) => setState(() => _selectedId = picked.id),
          ),
          const SizedBox(height: 6),
          if (group.isEmpty)
            const _TabIsEmpty()
          else
            // Flexible, not Expanded: a tab of two agents makes a panel two
            // rows tall, and only a long one grows to the cap and scrolls.
            Flexible(
              child: ListView.separated(
                shrinkWrap: true,
                padding: EdgeInsets.fromLTRB(
                  _sideInset,
                  4,
                  _sideInset,
                  MediaQuery.paddingOf(context).bottom + 8,
                ),
                itemCount: group.entries.length,
                separatorBuilder: (context, index) =>
                    const SizedBox(height: kPhoneCardGap),
                itemBuilder: (context, index) {
                  final entry = group.entries[index];
                  final showing =
                      entry.machineId == widget.showing.machineId &&
                      entry.agent.id == widget.showing.agentId;
                  return AgentTile(
                    machine: entry.machine,
                    agent: entry.agent,
                    // The agent already on screen keeps its row — it is the one
                    // you came from, and the list would read as missing an
                    // agent without it — and wears the accent rim instead.
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
          const SizedBox(height: 4),
        ],
      ),
    );
  }
}

/// A tab whose agents are all out of reach — the machine they run on is asleep
/// or wants its password. The tab is still listed and still opens to this,
/// because a tab missing from the row reads as one somebody deleted.
class _TabIsEmpty extends StatelessWidget {
  const _TabIsEmpty();

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(_sideInset, 10, _sideInset, 18),
      child: Text(
        'Nothing here this phone can open — the machine these agents run on '
        'is asleep or wants its password.',
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
