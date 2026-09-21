import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/stats/harness_stats.dart';

import 'phone_header.dart';
import 'settings_row.dart';

/// What this app has done, on a phone: agents spawned, time agents worked, turns — and the date
/// the counting started under them.
///
/// The figures come from [harnessStats], the app's own counters. They are not a vendor's and not a
/// file on disk, so unlike the desktop's Settings ▸ Usage there is no ledger half here and no
/// permission to ask: a phone has none of the `~/.claude` / `~/.codex` transcripts that half reads,
/// and every token figure would be zero for agents that really are running.
///
/// ⚠️ **Deliberately NOT the desktop's `StatsSummaryCards` layout.** That draws three cards in a
/// row — a shape that collapses to one column below 420pt anyway, which is every phone — with an
/// 11.5pt label and a 20pt figure sized for a settings pane read at desk distance. This stacks
/// three full-width rows instead, each with its glyph, its label and a figure large enough to read
/// at arm's length, which is also what lets the number carry the unit ("3h 24m") without wrapping.
class StatsPage extends StatelessWidget {
  const StatsPage({super.key, this.stats});

  /// The counters to draw. Defaults to the singleton; the parameter exists so a caller can pass
  /// its own instance, exactly as the desktop's `UsageSection` takes one.
  final HarnessStats? stats;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    // [HarnessStats] is a `ChangeNotifier` and every hook in `AppNotifier` notifies, so the figures
    // move while this page is open — an agent started from another tab lands here without a
    // refresh, and a turn's minutes land the moment it ends. Nothing to pull.
    return ListenableBuilder(
      listenable: stats ?? harnessStats,
      builder: (context, _) {
        AppTheme.watch(context);
        return Scaffold(
          backgroundColor: AppPalette.windowBg,
          body: SafeArea(
            bottom: false,
            child: Column(
              children: [
                const PhoneHeader(title: 'Stats'),
                Expanded(
                  child: _Body(summary: (stats ?? harnessStats).summary),
                ),
              ],
            ),
          ),
        );
      },
    );
  }
}

class _Body extends StatelessWidget {
  const _Body({required this.summary});

  final StatsSummary summary;

  @override
  Widget build(BuildContext context) => ListView(
    physics: const AlwaysScrollableScrollPhysics(),
    padding: EdgeInsets.fromLTRB(
      16,
      4,
      16,
      MediaQuery.paddingOf(context).bottom + 24,
    ),
    children: summary.isEmpty
        // "Nothing tracked yet" and "0, 0, 0" read very differently: three zeroes look like a
        // broken counter, and this says what would make them move.
        ? const [
            _EmptyState(),
            SettingsNote(
              'These are this app’s own counters — what it watched happen, not what any '
              'agent account was billed. Nothing here is sent anywhere.',
            ),
          ]
        : [
            _StatCard(
              icon: LucideIcons.bot300,
              label: 'Agents spawned',
              value: formatStatCount(summary.agentsSpawned),
            ),
            const SizedBox(height: kStatCardGap),
            _StatCard(
              icon: LucideIcons.clock300,
              label: 'Time agents worked',
              value: formatWorkedTime(summary.timeWorked),
            ),
            const SizedBox(height: kStatCardGap),
            _StatCard(
              icon: LucideIcons.messagesSquare300,
              label: 'Turns',
              value: formatStatCount(summary.turns),
            ),
            if (summary.firstEventAt case final since?)
              SettingsNote('Tracking since ${formatTrackingDate(since)}.'),
          ],
  );
}

/// The gap between two stat cards — the same one two phone cards keep, so a column of these reads
/// as the same kind of list as the machines and agents tabs.
const double kStatCardGap = 10;

/// One figure, full width: its glyph and label on one line, the number under them.
///
/// The number sits BELOW the label rather than opposite it, which is the other shape a row like
/// this could take. A right-aligned figure has to share the row with a label that can be as long as
/// "Time agents worked", and the longest value ("3d 21h") then lands in a different place on every
/// row; stacked, all three numbers start on the same left margin and can be compared down the
/// column at a glance.
class _StatCard extends StatelessWidget {
  const _StatCard({
    required this.icon,
    required this.label,
    required this.value,
  });

  final IconData icon;
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(14, 13, 14, 15),
      decoration: BoxDecoration(
        color: AppGlass.rowFill,
        borderRadius: BorderRadius.circular(AppCard.radius),
        border: Border.all(color: AppGlass.hair),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            children: [
              Icon(icon, size: 15, color: AppPalette.textFaint),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: AppPalette.textSecondary,
                    fontSize: 12.5,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 6),
          Text(
            value,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              color: AppPalette.textPrimary,
              fontSize: 28,
              fontWeight: FontWeight.w600,
              letterSpacing: -0.5,
              // Tabular, so a counter ticking from 9 to 10 while the page is open does not reflow
              // the figure beside it.
              fontFeatures: AppFont.tabularFigures,
            ),
          ),
        ],
      ),
    );
  }
}

/// Nothing has happened yet. A sentence rather than three zeroes.
class _EmptyState extends StatelessWidget {
  const _EmptyState();

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 26),
      decoration: BoxDecoration(
        color: AppSurface.recess,
        borderRadius: BorderRadius.circular(AppCard.radius),
        border: Border.all(color: AppGlass.hair),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(LucideIcons.bot300, size: 26, color: AppPalette.textFaint),
          const SizedBox(height: 12),
          Text(
            'Nothing tracked yet',
            textAlign: TextAlign.center,
            style: TextStyle(
              color: AppPalette.textPrimary,
              fontSize: 16,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 6),
          Text(
            'Start your first agent and this page begins counting.',
            textAlign: TextAlign.center,
            style: TextStyle(
              color: AppPalette.textSecondary,
              fontSize: 13,
              height: 1.4,
            ),
          ),
        ],
      ),
    );
  }
}

/// `1,284` — a count with its thousands grouped.
///
/// Grouped by hand rather than through `intl`: this package deliberately carries no localisation
/// dependency, and the one separator a stat needs is not worth adding one for.
String formatStatCount(int count) {
  final digits = count.abs().toString();
  final out = StringBuffer(count < 0 ? '-' : '');
  for (var i = 0; i < digits.length; i++) {
    // A separator before every digit whose distance from the end is a multiple of three, except at
    // the very start — which is what keeps `1,000` from coming out as `,1,000`.
    if (i > 0 && (digits.length - i) % 3 == 0) out.write(',');
    out.write(digits[i]);
  }
  return out.toString();
}

/// `4h 12m`, `3d 5h`, `18m` — a worked duration at a glance.
///
/// The desktop's `formatWorkedTime` exactly, kept in step deliberately: the same counter is drawn
/// in both apps, and a phone that rounded differently would look like it had counted differently.
/// Days and hours past a day, hours and minutes past an hour, minutes below. Never seconds: the
/// smallest thing being summed is a turn, and a figure that ticked every second would be the only
/// moving thing on the screen.
String formatWorkedTime(Duration worked) {
  if (worked <= Duration.zero) return '0m';
  if (worked.inDays > 0) return '${worked.inDays}d ${worked.inHours % 24}h';
  if (worked.inHours > 0) return '${worked.inHours}h ${worked.inMinutes % 60}m';
  return '${worked.inMinutes}m';
}

/// `Sep 16, 2026` — the date the counting started.
///
/// The month as a name rather than a number, because `9/16/2026` and `16/9/2026` are the same
/// string read two ways and this line has no second figure to disambiguate it.
String formatTrackingDate(DateTime at) {
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  final local = at.toLocal();
  return '${months[local.month - 1]} ${local.day}, ${local.year}';
}
