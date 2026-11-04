import 'package:flutter/material.dart';

import '../shared/widgets/app_dialog.dart';
import '../widgets/desktop_chrome.dart';
import 'controller.dart';
import 'dialog_scope.dart';
import 'model.dart';

/// How the Swarm shows a person: their name, else their username.
String projectPersonName(SuperTabPerson p) => p.name ?? p.username;

/// Whether [p] is a member of [project] now: listed, and not a person who left and rejoined since (another
/// generation; a missing one on either side counts as the same).
bool projectHolds(SuperTabProject project, SuperTabPerson p) {
  if (!project.memberIds.contains(p.id)) return false;
  final stored = project.memberGenerations[p.id];
  return stored == null || p.generation == null || stored == p.generation;
}

/// The Add people picker's two lists (Diego, 2026-11-04): the Swarm's people who can be added to [project], by name,
/// and those already in it, the owner first. [query] narrows both, as a case-insensitive substring of name,
/// username or email.
({List<SuperTabPerson> addable, List<SuperTabPerson> inProject})
projectPeopleLists(
  List<SuperTabPerson> people,
  SuperTabProject project,
  String query,
) {
  final q = query.trim().toLowerCase();
  bool matches(SuperTabPerson p) =>
      q.isEmpty ||
      [
        p.name ?? '',
        p.username,
        p.email,
      ].any((s) => s.toLowerCase().contains(q));
  bool isIn(SuperTabPerson p) =>
      p.id == project.ownerId || projectHolds(project, p);
  final shown = people.where(matches).toList();
  return (
    addable: shown.where((p) => !isIn(p)).toList()
      ..sort(
        (a, b) =>
            projectPersonName(a)
                .toLowerCase()
                .compareTo(projectPersonName(b).toLowerCase()),
      ),
    inProject: [
      ...shown.where((p) => p.id == project.ownerId),
      ...shown.where((p) => p.id != project.ownerId && isIn(p)),
    ],
  );
}

/// The People "+" of a private project the reader owns (Diego, 2026-11-04): pick Swarm people to bring in. Add sends
/// `project.sharing` with the project's members as the live snapshot holds them when it is pressed, plus the ticks.
Future<void> showProjectAddPeople(
  BuildContext context,
  SuperTabController c,
  SuperTabProject project,
) {
  final ticked = <String>{};
  var query = '';
  var busy = false;
  return showAppDialog<void>(
    context: context,
    builder: (context) => SuperTabDialogScope(
      controller: c,
      projectId: project.id,
      requireWrite: true,
      child: StatefulBuilder(
        builder: (context, update) => ListenableBuilder(
          listenable: c,
          builder: (context, _) {
            final current = c.snapshot?.projectById(project.id) ?? project;
            final people = c.snapshot?.people ?? const <SuperTabPerson>[];
            final lists = projectPeopleLists(people, current, query);
            final addableIds = {
              for (final p in projectPeopleLists(people, current, '').addable)
                p.id,
            };
            final count = ticked.where(addableIds.contains).length;
            final live = c.snapshot?.projectById(project.id);
            final canAdd =
                live != null && live.isPrivate && live.ownerId == c.accountId;
            Widget heading(String text) => Padding(
              padding: const EdgeInsets.only(top: 12, bottom: 4),
              child: Text(text, style: DesktopChrome.metadata()),
            );
            return AlertDialog(
              title: Text('Add people to ${current.name}'),
              content: SizedBox(
                width: 400,
                child: SingleChildScrollView(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      TextField(
                        key: const ValueKey('project-add-search'),
                        autofocus: true,
                        decoration: const InputDecoration(
                          hintText: 'Search people in this Swarm',
                        ),
                        onChanged: (value) => update(() => query = value),
                      ),
                      heading('Not in this project'),
                      if (lists.addable.isEmpty)
                        Text(
                          query.trim().isEmpty
                              ? 'Everyone in this Swarm is in this project.'
                              : 'No one matches',
                          style: DesktopChrome.text(),
                        ),
                      for (final person in lists.addable)
                        CheckboxListTile(
                          key: ValueKey('project-add-person-${person.id}'),
                          dense: true,
                          contentPadding: EdgeInsets.zero,
                          title: Text(
                            projectPersonName(person),
                            style: DesktopChrome.control(),
                          ),
                          subtitle: Text(person.email),
                          value: ticked.contains(person.id),
                          onChanged: busy
                              ? null
                              : (value) => update(
                                  () => value == true
                                      ? ticked.add(person.id)
                                      : ticked.remove(person.id),
                                ),
                        ),
                      if (lists.inProject.isNotEmpty) heading('Already in'),
                      for (final person in lists.inProject)
                        Padding(
                          padding: const EdgeInsets.symmetric(vertical: 4),
                          child: Row(
                            children: [
                              Flexible(
                                child: Text(
                                  projectPersonName(person),
                                  style: DesktopChrome.control(),
                                ),
                              ),
                              if (person.id == current.ownerId) ...[
                                const SizedBox(width: 8),
                                Text(
                                  'Project owner',
                                  style: DesktopChrome.metadata(),
                                ),
                              ],
                            ],
                          ),
                        ),
                      if (c.operationError != null) ...[
                        const SizedBox(height: 12),
                        Text(c.operationError!),
                      ],
                      if (c.hasPendingAction)
                        TextButton(
                          onPressed: c.saving ? null : c.retry,
                          child: const Text('Check pending action'),
                        ),
                    ],
                  ),
                ),
              ),
              actions: [
                TextButton(
                  onPressed: busy ? null : () => Navigator.pop(context),
                  child: const Text('Cancel'),
                ),
                FilledButton(
                  key: const ValueKey('project-add-confirm'),
                  onPressed:
                      busy ||
                          c.saving ||
                          c.hasPendingAction ||
                          !canAdd ||
                          count == 0
                      ? null
                      : () async {
                          update(() => busy = true);
                          // Read now, not when the dialog opened: a member added elsewhere since is kept.
                          final live = c.snapshot?.projectById(project.id);
                          if (live == null ||
                              !live.isPrivate ||
                              live.ownerId != c.accountId) {
                            update(() => busy = false);
                            return;
                          }
                          final people =
                              c.snapshot?.people ?? const <SuperTabPerson>[];
                          final inNow = {
                            for (final p in people)
                              if (projectHolds(live, p)) p.id,
                          };
                          final result = await c.command({
                            'type': 'project.sharing',
                            'projectId': project.id,
                            'visibility': 'private',
                            'memberIds': {
                              ...inNow,
                              ...ticked.where(addableIds.contains),
                            }.where((id) => id != live.ownerId).toList(),
                          });
                          if (!context.mounted) return;
                          if (result != null) {
                            Navigator.pop(context);
                          } else {
                            update(() => busy = false);
                          }
                        },
                  child: Text(
                    count == 1 ? 'Add 1 person' : 'Add $count people',
                  ),
                ),
              ],
            );
          },
        ),
      ),
    ),
  );
}
