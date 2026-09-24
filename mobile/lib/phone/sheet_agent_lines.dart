import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/core/agent_output_stats.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/notify/unread_marks.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';

import 'agent_index.dart';
import 'compact_age.dart';
import 'phone_prompt_context.dart';
import 'search_result_text.dart';

// An agent's row in the sheet, said the way the desktop's Harness Monitor says it
// (`desktop/lib/widgets/harness_session_manager.dart`, `_SessionRow`):
//
// ```
//  Logo Harness_4.svg update · 50m   Start failed
//  ▭ MacBookPro2021.local  ▢ autonomous-harness  ⑂ feat/mobile…
//  4.5M tokens · +120 −48 · 2 PRs
// ```
//
// ⚠️ **Shared by the tabs and the search**, which the sheet swaps in place: an agent keeps the row
// it had in the tabs when the field takes focus, so the swap changes what is listed, never how.

/// Metadata in the monitor's face — the terminal's monospace, as the desktop's `monoMeta` is.
TextStyle _meta(Color color) => phoneBoxMonoStyle(size: 11.5, color: color);

/// The monitor's two place colours: the folder in teal, the branch in green.
const _folderTint = Color(0xff79bbaf);
const _branchTint = Color(0xff8dbb79);

/// The edit counts' own colours — added in the branch's green, removed red — as the desktop draws
/// them.
const _addedTint = _branchTint;
const _removedTint = Color(0xffd28f87);

/// The word the monitor puts after a row's age when something is wrong with it, or null.
///
/// Only the exceptions: ready, working, waiting and paused already have their own mark on the row
/// (its status dot, or `Stopped` at its end), and saying them twice is noise. The desktop's `status`,
/// less its `View only` — a phone lists no shared harnesses.
String? agentAttention(AgentEntry entry) {
  final agent = entry.agent;
  if (entry.machine.nodeOnline == false) return 'Offline';
  if (agent.isStopped) return null;
  return switch (agent.launchState) {
    'failed' => 'Start failed',
    'starting' => 'Starting',
    _ => null,
  };
}

/// The name, then how long ago the agent last moved, then [agentAttention].
///
/// The age is the machine's `updatedAt` — the same clock the list is sorted on
/// ([compareMonitorOrder]), so the ages read down the list in order.
class SheetAgentTitle extends StatelessWidget {
  const SheetAgentTitle({
    super.key,
    required this.entry,
    required this.name,
    required this.now,
    this.unread = false,
  });

  final AgentEntry entry;

  /// Whether the agent finished a turn nobody has looked at yet — see
  /// `notify/done_notice.dart`. Marked with an [UnreadDot] before the name.
  final bool unread;

  /// The name as the caller draws it — plain in the tabs, with the query's hits in bold in search.
  final Widget name;

  final DateTime now;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final activity = entry.agent.updatedAt;
    final attention = agentAttention(entry);
    return Row(
      children: [
        if (unread) const UnreadDot(),
        Flexible(child: name),
        if (activity != null)
          Padding(
            padding: const EdgeInsets.only(left: 8),
            child: Text(
              '· ${harnessActivityAge(activity, now)}',
              maxLines: 1,
              style: _meta(AppPalette.textSecondary),
            ),
          ),
        if (attention != null)
          Padding(
            padding: const EdgeInsets.only(left: 10),
            child: Text(
              attention,
              maxLines: 1,
              style: _meta(AppPalette.textSecondary),
            ),
          ),
      ],
    );
  }
}

/// Where the agent runs — machine, folder, branch, each with its mark — and, when its machine has
/// measured any, what it has produced.
class SheetAgentMeta extends StatelessWidget {
  const SheetAgentMeta({
    super.key,
    required this.entry,
    this.matches = const [],
  });

  final AgentEntry entry;

  /// What the query reached, set in bold where it lands. Empty in the tabs, where nothing was
  /// searched.
  final Iterable<PhoneFieldMatch> matches;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final project = entry.project;
    final folder = project?.label;
    final branch = project?.shownBranch;
    final agent = entry.agent;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            _part(
              LucideIcons.monitor,
              entry.machineName,
              AppPalette.textSecondary,
            ),
            if (folder != null && folder.isNotEmpty) ...[
              const SizedBox(width: 10),
              _part(LucideIcons.folder, folder, _folderTint),
            ],
            if (branch != null && branch.isNotEmpty) ...[
              const SizedBox(width: 10),
              _part(LucideIcons.gitBranch, branch, _branchTint),
            ],
          ],
        ),
        if (agent.hasMonitorStats) ...[
          const SizedBox(height: 3),
          _AgentStats(agent: agent),
        ],
      ],
    );
  }

  /// One mark and its words, giving way to the others when the row runs short.
  Widget _part(IconData icon, String text, Color color) => Flexible(
    child: Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(icon, size: 11, color: color),
        const SizedBox(width: 4),
        Flexible(
          child: SearchResultText(text, matches: matches, style: _meta(color)),
        ),
      ],
    ),
  );
}

/// `4.5M tokens · +120 −48 · 2 PRs` — the desktop's `_MonitorStats`, each part only when the machine
/// reported it.
class _AgentStats extends StatelessWidget {
  const _AgentStats({required this.agent});

  final Agent agent;

  @override
  Widget build(BuildContext context) {
    final style = _meta(AppPalette.textSecondary);
    final stats = agent.outputStats;
    final tokens = agent.tokensUsed;
    final pullRequests = stats?.pullRequestsCreated;
    final parts = <InlineSpan>[
      if (tokens != null) TextSpan(text: '${formatCount(tokens)} tokens'),
      if (stats != null && stats.hasEdits)
        TextSpan(
          children: [
            TextSpan(
              text: '+${formatCount(stats.linesAdded!)}',
              style: const TextStyle(color: _addedTint),
            ),
            const TextSpan(text: ' '),
            TextSpan(
              text: '−${formatCount(stats.linesRemoved!)}',
              style: const TextStyle(color: _removedTint),
            ),
          ],
        ),
      if (pullRequests != null)
        TextSpan(text: '$pullRequests ${pullRequests == 1 ? 'PR' : 'PRs'}'),
    ];
    return Text.rich(
      TextSpan(
        style: style,
        children: [
          for (var i = 0; i < parts.length; i++) ...[
            if (i > 0) const TextSpan(text: '  ·  '),
            parts[i],
          ],
        ],
      ),
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
    );
  }
}
