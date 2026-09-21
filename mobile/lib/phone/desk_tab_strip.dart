import 'dart:async';

import 'package:flutter/material.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/widgets/touch_target.dart';
import 'package:harness_mobile/state/app_state.dart';

import 'desk_groups.dart';
import 'phone_navigation.dart';

/// The account's tabs, along the top of the terminal: one chip per tab, the one
/// you are in lit.
///
/// ⚠️ **This is the only way to change tabs on a phone, because a swipe no
/// longer does it.** A swipe used to walk every agent on the account; it walks
/// the agents of the tab you are in. That is the whole trade — a tab of four
/// agents is four swipes rather than forty — and it only works if the other
/// tabs are one tap away, in sight, without leaving the terminal.
///
/// ⚠️ **It draws nothing unless there is a choice.** One group is not a choice,
/// and a phone whose account has no tabs (or whose desk never answered) has
/// exactly one — so nothing about this screen changes for it.
class DeskTabStrip extends StatefulWidget {
  const DeskTabStrip({
    super.key,
    required this.notifier,
    required this.groups,
    required this.active,
  });

  final AppNotifier notifier;

  /// The tabs as this phone can show them — see [deskGroups].
  final List<DeskGroup> groups;

  /// The one the phone is in, from [activeDeskGroup].
  final DeskGroup? active;

  /// The row's height, insets included — what the header's column grows by.
  ///
  /// Shallow on purpose: every point of it is a point of terminal, and the row
  /// rides over one. A chip is 30pt tall inside it rather than the 44 a thumb
  /// wants, which the width makes up for — the target runs the whole length of
  /// the name, and [TouchTarget] takes what is left of the row around it.
  static const double height = 36;

  @override
  State<DeskTabStrip> createState() => _DeskTabStripState();
}

class _DeskTabStripState extends State<DeskTabStrip> {
  final _scroller = ScrollController();

  /// One key per tab, so the tab in play can be scrolled to.
  ///
  /// Kept across builds and keyed by the tab's own id: a strip of eight tabs is
  /// wider than a phone, and a tab switched to from outside the strip —
  /// search, a notification, the agent this launch opened on — is otherwise lit
  /// somewhere off the right edge.
  final _keys = <String?, GlobalKey>{};

  @override
  void dispose() {
    _scroller.dispose();
    super.dispose();
  }

  @override
  void didUpdateWidget(DeskTabStrip old) {
    super.didUpdateWidget(old);
    if (old.active?.id == widget.active?.id) return;
    // After the frame: the chip for the new tab may not have been laid out yet,
    // and `ensureVisible` needs a box to aim at.
    WidgetsBinding.instance.addPostFrameCallback((_) => _revealActive());
  }

  void _revealActive() {
    if (!mounted) return;
    final target = _keys[widget.active?.id]?.currentContext;
    if (target == null) return;
    unawaited(
      Scrollable.ensureVisible(
        target,
        alignment: 0.5,
        duration: const Duration(milliseconds: 220),
        curve: Curves.easeOut,
      ),
    );
  }

  /// A tab was tapped: the phone remembers it is in that tab, then opens the
  /// agent of it that the phone was last on — its first, the first time.
  ///
  /// ⚠️ The order matters. [AppNotifier.selectDeskTab] is what settles which tab
  /// an agent that sits on TWO of them belongs to (see [activeDeskGroup]); set
  /// after the open, it would be read a frame too late and the strip would light
  /// the tab that was left.
  void _select(DeskGroup group) {
    if (group.id == widget.active?.id || group.isEmpty) return;
    widget.notifier.selectDeskTab(group.id);
    final remembered = widget.notifier.deskLastAgentIn(group.id);
    final target = remembered != null && group.holds(remembered)
        ? remembered
        : (
            machineId: group.entries.first.machineId,
            agentId: group.entries.first.agent.id,
          );
    openAgent(context, widget.notifier, target.machineId, target.agentId);
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    _keys.removeWhere((id, _) => !widget.groups.any((group) => group.id == id));
    return SizedBox(
      height: DeskTabStrip.height,
      child: ListView.separated(
        controller: _scroller,
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 3),
        itemCount: widget.groups.length,
        separatorBuilder: (_, _) => const SizedBox(width: 6),
        itemBuilder: (context, index) {
          final group = widget.groups[index];
          return _TabChip(
            key: _keys.putIfAbsent(group.id, GlobalKey.new),
            group: group,
            selected: group.id == widget.active?.id,
            onTap: () => _select(group),
          );
        },
      ),
    );
  }
}

/// One tab: its name, and how many of its agents this phone can open.
///
/// ⚠️ **A tab with none is drawn, dimmed and inert.** Its agents are on a
/// machine that is asleep or wants a password — a tab dropped from the strip for
/// that reads as a tab somebody deleted, and the count is the only thing on this
/// screen that says otherwise.
class _TabChip extends StatelessWidget {
  const _TabChip({
    super.key,
    required this.group,
    required this.selected,
    required this.onTap,
  });

  final DeskGroup group;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final color = group.isEmpty
        ? AppPalette.textFaint
        : selected
        ? AppPalette.accentOnSurface
        : AppPalette.textSecondary;
    return Semantics(
      button: !group.isEmpty,
      selected: selected,
      label: switch (group.entries.length) {
        0 => '${group.name}, no agents here now',
        1 => '${group.name}, 1 agent',
        final count => '${group.name}, $count agents',
      },
      child: TouchTarget(
        child: GestureDetector(
          onTap: group.isEmpty ? null : onTap,
          behavior: HitTestBehavior.opaque,
          child: DecoratedBox(
            decoration: BoxDecoration(
              color: selected
                  ? AppSurface.accentWash
                  : group.isEmpty
                  ? null
                  : AppSurface.selectedFill,
              borderRadius: BorderRadius.circular(999),
            ),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 11),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  // Bounded rather than ellipsed to a width: a tab is usually
                  // named after a project, and half a name in a row of chips
                  // tells you less than the next chip along would have.
                  ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 140),
                    child: Text(
                      group.name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: color,
                        fontSize: 13,
                        fontWeight: selected
                            ? FontWeight.w600
                            : FontWeight.w500,
                      ),
                    ),
                  ),
                  if (!group.isEmpty) ...[
                    const SizedBox(width: 6),
                    Text(
                      '${group.entries.length}',
                      style: TextStyle(
                        color: selected
                            ? AppPalette.accentOnSurface
                            : AppPalette.textFaint,
                        fontSize: 12,
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
