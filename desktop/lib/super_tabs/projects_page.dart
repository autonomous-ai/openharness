import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../widgets/desktop_chrome.dart';
import '../widgets/laid_out_list.dart';
import 'controller.dart';
import 'model.dart';

/// The Desktop's Projects in the middle (task #4466, anh Dee 11-07): every project as a card, like repositories under
/// a GitHub org, most recent first. A card opens its project's Board; New project is the page's one blue button.
class SuperTabProjectsPage extends StatelessWidget {
  const SuperTabProjectsPage({
    super.key,
    required this.controller,
    required this.onOpen,
    this.onNewProject,
  });

  final SuperTabController controller;
  final ValueChanged<SuperTabProject> onOpen;

  /// Opens the New project form; without it the page offers none.
  final VoidCallback? onNewProject;

  /// A card's least width: two across at 880, more as the window grows.
  static const _cardWidth = 260.0;
  static const _gap = grid.AppDesktop.composerRowGap;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: controller,
    builder: (context, _) {
      grid.AppTheme.watch(context);
      final projects = superTabProjectsByRecent(controller);
      return LaidOutListView(
        padding: const EdgeInsets.all(grid.AppDesktop.panelPadding),
        children: [
          if (onNewProject case final onNewProject?)
            Align(
              alignment: Alignment.centerRight,
              child: FilledButton.icon(
                onPressed: onNewProject,
                icon: const Icon(AppIcons.plus, size: AppIcons.inlineSize),
                label: const Text('New project'),
              ),
            ),
          const SizedBox(height: grid.AppDesktop.groupGap),
          // Empty means empty: New project above is what fills it (anh Dee 11-07).
          if (projects.isNotEmpty)
            LayoutBuilder(
              builder: (context, box) {
                final across = math.max(
                  1,
                  ((box.maxWidth + _gap) / (_cardWidth + _gap)).floor(),
                );
                final width = (box.maxWidth - _gap * (across - 1)) / across;
                return Wrap(
                  spacing: _gap,
                  runSpacing: _gap,
                  children: [
                    for (final project in projects)
                      SizedBox(
                        width: width,
                        child: _ProjectCard(
                          controller: controller,
                          project: project,
                          onTap: () => onOpen(project),
                        ),
                      ),
                  ],
                );
              },
            ),
        ],
      );
    },
  );
}

/// The Swarm's projects, the one with the latest message in its chat or its tasks first, then by name.
List<SuperTabProject> superTabProjectsByRecent(SuperTabController controller) {
  final projects = [...?controller.snapshot?.projects];
  int latest(SuperTabProject project) => controller
      .projectConversations(project.id)
      .fold(0, (at, g) => math.max(at, g.lastMessageSequence));
  final at = {for (final project in projects) project.id: latest(project)};
  return projects..sort(
    (a, b) => switch (at[b.id]!.compareTo(at[a.id]!)) {
      0 => a.name.toLowerCase().compareTo(b.name.toLowerCase()),
      final order => order,
    },
  );
}

/// `owner/name` of a GitHub address, as GitHub lists a repository; null for none.
String? _repositoryName(SuperTabProject project) {
  final url = project.repository?['repositoryUrl'];
  if (url is! String) return null;
  final path = (Uri.tryParse(url)?.pathSegments ?? const <String>[])
      .where((part) => part.isNotEmpty)
      .toList();
  if (path.length < 2) return null;
  final name = path.last.endsWith('.git')
      ? path.last.substring(0, path.last.length - 4)
      : path.last;
  return '${path[path.length - 2]}/$name';
}

/// One project: its name (13 semibold primary) and one quiet line, its repository or Private, on a hairline card.
class _ProjectCard extends StatelessWidget {
  const _ProjectCard({
    required this.controller,
    required this.project,
    required this.onTap,
  });

  final SuperTabController controller;
  final SuperTabProject project;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final detail =
        _repositoryName(project) ?? (project.isPrivate ? 'Private' : null);
    final shape = RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
      side: BorderSide(color: DesktopChrome.rim),
    );
    return Material(
      key: ValueKey('super-group-${project.leadConversationId}'),
      color: Colors.transparent,
      shape: shape,
      clipBehavior: Clip.antiAlias,
      child: Semantics(
        button: true,
        label: [project.name, ?detail].join(', '),
        child: InkWell(
          onTap: onTap,
          hoverColor: grid.AppSurface.hoverFill,
          child: Padding(
            padding: const EdgeInsets.all(grid.AppDesktop.composerRowGap),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  project.name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: DesktopChrome.control(
                    color: grid.AppPalette.textPrimary,
                  ).copyWith(fontWeight: grid.AppFont.semibold),
                ),
                if (detail != null)
                  Text(
                    detail,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: DesktopChrome.metadata(
                      color: grid.AppPalette.textFaint,
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
