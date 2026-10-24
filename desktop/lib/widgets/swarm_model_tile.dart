import 'package:flutter/material.dart';

import '../models/model_search_catalog.dart';
import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../state/swarm_navigation.dart';
import '../state/swarm_search.dart';
import 'desktop_chrome.dart';

/// What a row of a Swarm's Manage models is, which its mark says at a glance.
enum SwarmModelKind { api, apiModel, local, live, get, add, more, shared }

SwarmModelKind swarmModelKind(
  SwarmSearchController search,
  SwarmDestination row,
) {
  if (row.isCreate) return SwarmModelKind.add;
  if (search.isModelDownloadsRow(row)) return SwarmModelKind.more;
  if (search.isApiRow(row)) return SwarmModelKind.api;
  if (search.isApiModelRow(row)) return SwarmModelKind.apiModel;
  final entry = search.models?.entries[row.modelId];
  final local = entry?.local;
  if (local == null) return SwarmModelKind.shared;
  if (entry?.needsDownload == true || !local.downloaded) {
    return SwarmModelKind.get;
  }
  final swarm = search.swarmModels;
  return search.modelRowLive(row) ||
          (swarm != null && local.servedOn(swarm.grid))
      ? SwarmModelKind.live
      : SwarmModelKind.local;
}

/// Green while something is live, as every status dot in the app is.
Color get swarmModelLive =>
    grid.AppTheme.pick(const Color(0xFF246C3F), const Color(0xFF86E6A3));

/// A rounded square holding the kind's mark: neutral, green while it serves, the accent for adding.
class SwarmModelTile extends StatelessWidget {
  const SwarmModelTile({super.key, required this.kind, this.size = 30});

  final SwarmModelKind kind;
  final double size;

  @override
  Widget build(BuildContext context) {
    final tone = switch (kind) {
      SwarmModelKind.add => DesktopChrome.accent,
      SwarmModelKind.live => grid.AppPalette.online,
      _ => null,
    };
    final ink = switch (kind) {
      SwarmModelKind.add => DesktopChrome.accent,
      SwarmModelKind.live => swarmModelLive,
      _ => DesktopChrome.muted,
    };
    return Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color:
            tone?.withValues(alpha: .13) ??
            DesktopChrome.foreground.withValues(alpha: .06),
        borderRadius: BorderRadius.circular(size * .27),
        border: Border.all(
          color:
              tone?.withValues(alpha: .32) ??
              DesktopChrome.foreground.withValues(alpha: .09),
        ),
      ),
      child: Icon(
        switch (kind) {
          SwarmModelKind.api => AppIcons.cloud,
          SwarmModelKind.apiModel => AppIcons.sparkles,
          SwarmModelKind.local || SwarmModelKind.live => AppIcons.cpu,
          SwarmModelKind.get => AppIcons.download,
          SwarmModelKind.add => AppIcons.plus,
          SwarmModelKind.more => AppIcons.chevronDown,
          SwarmModelKind.shared => AppIcons.server,
        },
        size: size * .5,
        color: ink,
      ),
    );
  }
}

/// A small rounded label at a row's end: green while live, the error colour when it failed, else quiet.
class SwarmModelPill extends StatelessWidget {
  const SwarmModelPill(
    this.label, {
    super.key,
    this.live = false,
    this.failed = false,
    this.textKey,
  });

  final String label;
  final bool live, failed;
  final Key? textKey;

  @override
  Widget build(BuildContext context) {
    final color = failed
        ? Theme.of(context).colorScheme.error
        : live
        ? swarmModelLive
        : DesktopChrome.muted;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(
        color: live
            ? grid.AppPalette.online.withValues(alpha: .13)
            : DesktopChrome.foreground.withValues(alpha: .06),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (live) ...[
            Container(
              width: 6,
              height: 6,
              decoration: BoxDecoration(
                color: grid.AppPalette.online,
                shape: BoxShape.circle,
              ),
            ),
            const SizedBox(width: 5),
          ],
          Text(
            label,
            key: textKey,
            maxLines: 1,
            style: DesktopChrome.text(size: 11, medium: true, color: color),
          ),
        ],
      ),
    );
  }
}

/// A section's heading's two halves: `Get for this Mac · 64 GB` is the title `Get for this Mac` and the note `64 GB`.
({String title, String? note}) swarmModelHeading(
  ModelSearchSection? section,
  String heading,
) {
  final parts = heading.split(' · ');
  final title = parts.first;
  final rest = parts.skip(1).join(' · ');
  return (
    title: title,
    note: rest.isNotEmpty
        ? rest
        : switch (section) {
            ModelSearchSection.apis => 'Shared on your key',
            ModelSearchSection.local => 'On ${thisComputerName()}',
            _ => null,
          },
  );
}
