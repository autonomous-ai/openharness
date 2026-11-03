import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../widgets/desktop_chrome.dart';

/// Which of the Swarm's projects may run agents on a machine (Tony, 2026-11-03; backend machines.ts `machine.projects`),
/// in the machine's details. Its owner chooses All projects or Only some; anyone else reads the choice. [kept] null is
/// every project, as a machine nobody limited serves. [onChanged] gets the projects kept, in [projects]' order, or null
/// for All. Choosing Only starts with every project ticked, so nothing changes until the owner unticks one, and the last
/// ticked project cannot be unticked: a machine kept for none is no choice to offer here.
class SuperTabMachineProjects extends StatelessWidget {
  const SuperTabMachineProjects({
    super.key,
    required this.projects,
    required this.kept,
    required this.editable,
    required this.onChanged,
    this.busy = false,
  });

  final List<({String id, String name})> projects;
  final List<String>? kept;
  final bool editable;
  final bool busy;
  final ValueChanged<List<String>?> onChanged;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final kept = this.kept;
    final heading = Text(
      'Projects that may use it',
      style: DesktopChrome.text(),
    );
    if (!editable) {
      final names = kept == null
          ? 'All projects'
          : projects
                .where((p) => kept.contains(p.id))
                .map((p) => p.name)
                .join(', ');
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          heading,
          const SizedBox(height: grid.AppDesktop.controlGap / 2),
          Text(
            names.isEmpty ? 'No project now' : names,
            style: DesktopChrome.control(color: DesktopChrome.muted),
          ),
        ],
      );
    }
    final ids = projects.map((p) => p.id).toList();
    void toggle(String id, bool on) {
      final next = {...?kept};
      on ? next.add(id) : next.remove(id);
      onChanged(ids.where(next.contains).toList());
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        heading,
        RadioGroup<bool>(
          groupValue: kept != null,
          onChanged: (only) {
            if (busy || only == null || only == (kept != null)) return;
            onChanged(only ? ids : null);
          },
          // Side by side, as the mockup Tony was shown (11-03); each choice clickable by its words too.
          child: Wrap(
            spacing: grid.AppDesktop.groupGap,
            children: [
              _choice(
                false,
                'All projects',
                const ValueKey('machine-projects-all'),
                kept != null,
                ids,
              ),
              _choice(
                true,
                'Only:',
                const ValueKey('machine-projects-only'),
                kept == null,
                ids,
              ),
            ],
          ),
        ),
        if (kept != null)
          Wrap(
            spacing: grid.AppDesktop.groupGap,
            children: [
              for (final project in projects)
                Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Checkbox(
                      key: ValueKey('machine-project-${project.id}'),
                      value: kept.contains(project.id),
                      semanticLabel: project.name,
                      onChanged:
                          busy ||
                              (kept.length == 1 && kept.contains(project.id))
                          ? null
                          : (on) => toggle(project.id, on ?? false),
                    ),
                    Text(project.name, style: DesktopChrome.control()),
                  ],
                ),
            ],
          ),
      ],
    );
  }

  /// One of the two choices: the radio, and its words, which choose it too when it is not chosen yet.
  Widget _choice(
    bool only,
    String label,
    Key key,
    bool changes,
    List<String> ids,
  ) => InkWell(
    borderRadius: BorderRadius.circular(grid.AppControl.radius),
    onTap: busy || !changes ? null : () => onChanged(only ? ids : null),
    child: Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Radio<bool>(key: key, value: only, enabled: !busy),
        Padding(
          padding: const EdgeInsets.only(right: grid.AppDesktop.controlGap),
          child: Text(label, style: DesktopChrome.control()),
        ),
      ],
    ),
  );
}
