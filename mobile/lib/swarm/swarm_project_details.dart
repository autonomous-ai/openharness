import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/phone/phone_sheet.dart' show PhoneSheetAction;
import 'package:harness_mobile/phone/phone_shell_scope.dart';
import 'package:harness_mobile/phone/tty.dart';
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';
import 'package:harness_mobile/shared/widgets/touch_target.dart';

import 'swarm_invites.dart' show swarmMayInvite;
import 'swarm_leaderboard.dart' show swarmProjectPeople;
import 'swarm_project_team.dart' show swarmProjectHeads;
import 'swarm_reader.dart';
import 'swarm_row.dart';
import 'swarm_session.dart';
import 'swarm_start.dart' show SwarmComputers;
import 'team_glance.dart';

/// A project's details, from a tap on its name in its chat's header, as a
/// channel's name opens them in Slack (Tony, 2026-11-03): its #name over who
/// is on it; quick actions — its chat's Notifications ([onNotifications]),
/// Invite for the Swarm's owner alone ([onInvite], [swarmMayInvite]), and
/// Open terminal for someone who may write, by the menu's rule
/// (`swarmTerminalAction`); then Status, Work, Team with who is on it, and
/// Leaderboard. A tap closes the sheet and hands back what it opens, for the
/// page to open once the sheet is gone; the terminal opens at once, as the
/// menu's does.
class SwarmProjectDetailsSheet extends StatelessWidget {
  const SwarmProjectDetailsSheet({
    super.key,
    required this.reader,
    required this.projectId,
    required this.terminal,
    required this.onStatus,
    required this.onWork,
    required this.onTeam,
    required this.onLeaderboard,
    this.onNotifications,
    this.onInvite,
  });

  final SwarmReader reader;
  final String projectId;

  /// The PM's terminal, read at each build: null for someone who may not
  /// write, or with the project gone.
  final PhoneSheetActionOf terminal;

  final VoidCallback onStatus, onWork, onTeam, onLeaderboard;

  /// Null while the project chat is not read.
  final VoidCallback? onNotifications;

  /// Null for anyone but the Swarm's owner.
  final VoidCallback? onInvite;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: reader,
    builder: (context, _) {
      AppTheme.watch(context);
      final snapshot = reader.snapshot;
      final project = snapshot?.projectById(projectId);
      if (snapshot == null || project == null || reader.accessRevoked) {
        // The page closes it: blank meanwhile.
        return const SizedBox.shrink();
      }
      final heads = swarmProjectHeads(
        humans: swarmProjectPeople(snapshot, project).length,
        agents: swarmTeamGlance(snapshot, projectId: projectId).agents.length,
      );
      final term = terminal(
        PhoneShellScope.maybeOf(context),
        SwarmScope.computersOf(context),
      );
      void choose(VoidCallback action) => Navigator.of(context).pop(action);
      final quick = [
        if (onNotifications case final open?)
          _Quick(
            key: const ValueKey('swarm-project-details-notifications'),
            icon: LucideIcons.bell300,
            label: 'Notifications',
            onTap: () => choose(open),
          ),
        if (onInvite case final open? when swarmMayInvite(reader))
          _Quick(
            key: const ValueKey('swarm-project-details-invite'),
            icon: LucideIcons.userPlus300,
            label: 'Invite',
            onTap: () => choose(open),
          ),
        if (term case final term?)
          _Quick(
            key: const ValueKey('swarm-project-details-terminal'),
            icon: LucideIcons.squareTerminal300,
            label: term.label,
            hint: term.value,
            onTap: term.enabled
                ? () {
                    Navigator.of(context).pop();
                    term.onTap();
                  }
                : null,
          ),
      ];
      return SafeArea(
        top: false,
        child: ListView(
          shrinkWrap: true,
          padding: const EdgeInsets.fromLTRB(
            AppSpace.m,
            0,
            AppSpace.m,
            AppSpace.l,
          ),
          children: [
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: AppSpace.xs),
              child: Text(
                '#${project.name}',
                key: const ValueKey('swarm-project-details-title'),
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: Tty.of(context)
                    .style(size: 20, weight: FontWeight.w600)
                    .copyWith(height: 1.25),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(
                AppSpace.xs,
                AppSpace.xs,
                AppSpace.xs,
                0,
              ),
              child: Text(
                heads,
                style: AppType.caption(color: AppPalette.textSecondary),
              ),
            ),
            if (quick.isNotEmpty) ...[
              const SizedBox(height: AppSpace.l),
              Row(
                children: [
                  for (final (i, action) in quick.indexed) ...[
                    if (i > 0) const SizedBox(width: AppSpace.s),
                    Expanded(child: action),
                  ],
                ],
              ),
            ],
            const SizedBox(height: AppSpace.m),
            Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                _row(
                  'status',
                  LucideIcons.activity300,
                  'Status',
                  () => choose(onStatus),
                ),
                _row(
                  'work',
                  LucideIcons.listChecks300,
                  'Work',
                  () => choose(onWork),
                ),
                _row(
                  'team',
                  LucideIcons.users300,
                  'Team',
                  () => choose(onTeam),
                  value: heads,
                ),
                _row(
                  'leaderboard',
                  LucideIcons.trophy300,
                  'Leaderboard',
                  () => choose(onLeaderboard),
                ),
              ],
            ),
          ],
        ),
      );
    },
  );

  Widget _row(
    String name,
    IconData icon,
    String title,
    VoidCallback onTap, {
    String? value,
  }) => SwarmRow(
    key: ValueKey('swarm-project-details-$name'),
    leading: Icon(icon, size: 18, color: AppPalette.textSecondary),
    title: title,
    trailing: value == null
        ? null
        : Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(value, style: AppType.caption(color: AppPalette.textFaint)),
              const SizedBox(width: AppSpace.xs),
              Icon(
                LucideIcons.chevronRight300,
                size: 18,
                color: AppPalette.textFaint,
              ),
            ],
          ),
    onTap: onTap,
  );
}

/// The terminal's action for the shell and computers a sheet is under.
typedef PhoneSheetActionOf = PhoneSheetAction? Function(
  PhoneShellScope? shell,
  SwarmComputers? computers,
);

/// A quick action: its glyph in a round, its name under it; greyed, with
/// why ([hint]) heard, when it cannot open.
class _Quick extends StatelessWidget {
  const _Quick({
    super.key,
    required this.icon,
    required this.label,
    required this.onTap,
    this.hint,
  });

  final IconData icon;
  final String label;
  final String? hint;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final ink = onTap == null ? AppPalette.textFaint : AppPalette.textPrimary;
    return Semantics(
      button: true,
      enabled: onTap != null,
      label: [label, ?hint].join(', '),
      excludeSemantics: true,
      onTap: onTap,
      child: Material(
        color: AppPalette.swarmSearchSurface,
        borderRadius: BorderRadius.circular(AppCard.radius),
        child: InkWell(
          borderRadius: BorderRadius.circular(AppCard.radius),
          onTap: onTap,
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: minTouchTarget + 28),
            child: Padding(
              padding: const EdgeInsets.symmetric(
                horizontal: AppSpace.xs,
                vertical: AppSpace.m,
              ),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(icon, size: 22, color: ink),
                  const SizedBox(height: AppSpace.xs + 2),
                  Text(
                    label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    textAlign: TextAlign.center,
                    style: AppType.caption(color: ink),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
