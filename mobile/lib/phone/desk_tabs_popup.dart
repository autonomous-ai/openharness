import 'package:flutter/material.dart';

import 'package:harness_mobile/core/last_opened_agent.dart' show AgentRef;
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/state/app_state.dart';

import 'agent_context_line.dart';
import 'agent_index.dart';
import 'desk_groups.dart';
import 'desk_tab_strip.dart';
import 'phone_card.dart';
import 'phone_navigation.dart';
import 'terminal_header.dart' show BadgedEngineMark;

/// The account's tabs, and the agents inside the one being read, as a panel up
/// from the bottom of the terminal.
///
/// ```
/// ────────────────────────────────
///   Desktop   Docker   Other
///   ───────
///  ┌────────┐┌────────┐┌───────
///  │ ◆●     ││ ◆●     ││ ◆●
///  │ api-3  ││ web    ││ cli
///  │ harness││ site   ││ tools
///  └────────┘└────────┘└───────
/// ```
///
/// ⚠️ **Two moves, not one.** A tab name changes which agents the row below
/// offers and nothing else; opening happens on a card. That is what lets
/// somebody look into another tab — see what is running there — without losing
/// the terminal they are in, which a sheet of tab names could not do.
///
/// ⚠️ **From the bottom, because that is where the thumb is.** The mark that
/// opens it rides the header at the top of the phone, but the list it opens is
/// a list to reach into, so it comes up from the bottom edge like every other
/// phone sheet here.
///
/// [showing] is the agent on screen: it decides which tab the panel opens on
/// (see [activeDeskGroup]), and its card is the one wearing the rim.
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

/// The panel itself: the tab names, and the cards of whichever tab is picked.
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
          const SizedBox(height: 10),
          SizedBox(
            height: _cardHeight,
            child: group.isEmpty
                ? const _TabIsEmpty()
                : ListView.separated(
                    scrollDirection: Axis.horizontal,
                    padding: const EdgeInsets.symmetric(
                      horizontal: DeskTabStrip.sideInset,
                    ),
                    itemCount: group.entries.length,
                    separatorBuilder: (context, index) =>
                        const SizedBox(width: kPhoneCardGap),
                    itemBuilder: (context, index) {
                      final entry = group.entries[index];
                      return SizedBox(
                        width: _cardWidth,
                        child: _AgentCard(
                          entry: entry,
                          showing:
                              entry.machineId == widget.showing.machineId &&
                              entry.agent.id == widget.showing.agentId,
                          onTap: () => widget.onOpen(group, entry),
                        ),
                      );
                    },
                  ),
          ),
          const SizedBox(height: 14),
        ],
      ),
    );
  }
}

/// A card's box. Three short lines of type, and wide enough that two and a bit
/// of them show at once — the half card at the edge is what says the row
/// scrolls, without a scrollbar on a phone that draws none.
const double _cardHeight = 104;
const double _cardWidth = 168;

/// One agent in the row: its engine and state, its name, and where it runs.
class _AgentCard extends StatelessWidget {
  const _AgentCard({
    required this.entry,
    required this.showing,
    required this.onTap,
  });

  final AgentEntry entry;

  /// The agent whose terminal is already on screen. It keeps its card — it is
  /// the one you came from, and the row would read as missing an agent without
  /// it — and wears the accent rim instead.
  final bool showing;

  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return PhoneCard(
      height: _cardHeight,
      onTap: onTap,
      border: showing
          ? Border.all(color: AppPalette.accentOnSurface, width: 1.5)
          : null,
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          BadgedEngineMark(
            agent: entry.agent,
            status: entry.summary,
            // The card's own fill, so the dot reads as notched into the mark.
            ring: AppGlass.rowFill,
            size: 26,
          ),
          const SizedBox(height: 8),
          Text(
            entry.agent.name,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              color: AppPalette.textPrimary,
              fontSize: 15,
              fontWeight: FontWeight.w600,
              height: 1.2,
            ),
          ),
          const SizedBox(height: 3),
          AgentContextLine(
            project: entry.project,
            machineName: entry.machineName,
          ),
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
      padding: const EdgeInsets.symmetric(horizontal: DeskTabStrip.sideInset),
      child: Align(
        alignment: Alignment.centerLeft,
        child: Text(
          'Nothing here this phone can open — the machine these agents run on '
          'is asleep or wants its password.',
          style: TextStyle(color: AppPalette.textSecondary, fontSize: 13.5),
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
