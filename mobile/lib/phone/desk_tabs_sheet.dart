import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/core/last_opened_agent.dart' show AgentRef;
import 'package:harness_mobile/state/app_state.dart';

import 'agent_index.dart';
import 'desk_groups.dart';
import 'phone_navigation.dart';
import 'phone_sheet.dart';

/// The account's tabs, as a sheet — the way to another tab on a phone, now that
/// a swipe stays inside the one you are in.
///
/// ⚠️ **A sheet and not a row of chips along the top, and the difference is the
/// terminal.** The terminal is the screen; every point of chrome above it is a
/// line of somebody's session that is not shown. A rail of tabs cost a line and
/// a half permanently, for a decision that is made a few times a day — so what
/// stays on screen is one mark in the header beside `⋯`, and the list lives
/// behind it.
///
/// [showing] is the agent on screen, which is what decides the tab the phone is
/// in — see [activeDeskGroup]. Opened from the terminal page, so it always has
/// one.
Future<void> showDeskTabsSheet(
  BuildContext context,
  AppNotifier notifier, {
  required AgentRef showing,
}) {
  final groups = deskGroups(notifier, visibleAgents(agentIndex(notifier)));
  final active = activeDeskGroup(notifier, groups, showing);
  return showPhoneSheet(
    context,
    title: 'Tabs',
    actions: [
      for (final group in groups)
        PhoneSheetAction(
          // The tab you are in wears the tick; the rest wear the tab mark. A
          // colour alone would say it to fewer people.
          icon: group.id == active.id
              ? LucideIcons.check300
              : LucideIcons.layoutGrid300,
          label: group.name,
          value: switch (group.entries.length) {
            // Its agents are on a machine that is asleep or wants its password.
            // Listed anyway: a tab missing from this list reads as one somebody
            // deleted. See [DeskGroup].
            0 => 'not here now',
            1 => '1 agent',
            final count => '$count agents',
          },
          // A tab with nothing this phone can open is a row to read, not one to
          // press — [showPhoneSheet] draws it dimmed and stays open on a tap.
          enabled: !group.isEmpty,
          onTap: () => _open(context, notifier, group),
        ),
    ],
  );
}

/// Switch to [group]: the phone is in that tab from here, and the agent it
/// opens is the one this phone was last on in it — its first, the first time.
///
/// ⚠️ The order matters. [AppNotifier.selectDeskTab] is what settles which tab
/// an agent that sits on TWO of them belongs to (see [activeDeskGroup]); set
/// after the open, it would be read a frame too late and the sheet would tick
/// the tab that was left.
void _open(BuildContext context, AppNotifier notifier, DeskGroup group) {
  if (group.isEmpty) return;
  notifier.selectDeskTab(group.id);
  final remembered = notifier.deskLastAgentIn(group.id);
  final target = remembered != null && group.holds(remembered)
      ? remembered
      : (
          machineId: group.entries.first.machineId,
          agentId: group.entries.first.agent.id,
        );
  openAgent(context, notifier, target.machineId, target.agentId);
}
