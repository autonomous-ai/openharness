import 'package:flutter/material.dart';

import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/stats/harness_stats.dart';

import 'phone_navigation.dart';
import 'settings_row.dart';
import 'stats_page.dart';

/// The Settings row that opens [StatsPage].
///
/// A function rather than a widget class, and it lives here rather than in the settings list, for
/// one reason: that list builds every row inline, so a feature owning a page of its own would
/// otherwise have its row wired up in a file that knows nothing else about it. This keeps the row,
/// the page and the counters behind them together — the settings list only has to call it.
///
/// [notifier] is unused today and deliberately still taken: every other entry point on that list is
/// handed one, and a row that later wants the app model — a count of live agents beside the figure,
/// say — should not change the shape of the call to get it.
Widget buildStatsSettingsRow(BuildContext context, AppNotifier notifier) =>
    // Subscribed to the counters rather than reading them once: the settings list rebuilds on the
    // app model, which does not move when an agent is spawned from another tab, so the figure below
    // would otherwise sit at whatever it was when Settings was first drawn.
    ListenableBuilder(
      listenable: harnessStats,
      builder: (context, _) {
        final summary = harnessStats.summary;
        return SettingsRow(
          title: 'Stats',
          // The headline figure on the row itself, so the list answers "has this counted
          // anything?" without a push. Empty reads as an em dash rather than "0 agents", which
          // looks like a figure that was measured and came out zero.
          value: summary.isEmpty
              ? '—'
              : '${formatStatCount(summary.agentsSpawned)} '
                    '${summary.agentsSpawned == 1 ? 'agent' : 'agents'}',
          onTap: () =>
              Navigator.of(context).push(phoneRoute((_) => const StatsPage())),
        );
      },
    );
