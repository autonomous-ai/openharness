import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../widgets/desktop_chrome.dart';
import 'controller.dart';
import 'dialog_scope.dart';
import 'model.dart';
import 'project_github.dart';
import 'project_visibility.dart';
import 'roles_editor.dart';

Future<void> showProjectAction(
  BuildContext context,
  SuperTabController c,
  SuperTabProject project,
  String action,
) async {
  if (action == 'delete') {
    await _deleteProject(context, c, project);
    return;
  }
  var name = project.name;
  var visibility = project.isPrivate ? 'private' : 'public';
  final members = project.memberIds.toSet();
  var minutes = project.updateMinutes;
  var mode = project.skillSet;
  var busy = false;
  await showAppDialog<void>(
    context: context,
    builder: (context) => SuperTabDialogScope(
      controller: c,
      projectId: project.id,
      requireWrite: action != 'details',
      child: StatefulBuilder(
        builder: (context, update) => ListenableBuilder(
          listenable: c,
          builder: (context, _) {
            final current = c.snapshot?.projects
                .where((p) => p.id == project.id)
                .firstOrNull;
            final group = c.snapshot?.conversation(project.leadConversationId);
            final canManage = current?.ownerId == c.accountId;
            final readOnly = action == 'details';
            return AlertDialog(
              title: Text(switch (action) {
                'rename' => 'Rename project',
                'sharing' => 'Sharing',
                'skills' => 'Instructions for this project',
                'cadence' => 'Project updates',
                _ => 'Project details',
              }),
              content: SizedBox(
                width: 400,
                child: SingleChildScrollView(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      // Whether teammates' agents can push to its repository, and what to do about it.
                      if (action == 'details') ...[
                        ProjectGitHubAccess(controller: c, projectId: project.id),
                        const SizedBox(height: 16),
                      ],
                      if (action == 'rename')
                        TextFormField(
                          autofocus: true,
                          initialValue: name,
                          maxLength: 160,
                          onChanged: (value) => update(() => name = value),
                        ),
                      if (action == 'sharing') ...[
                        ProjectVisibility(
                          value: visibility,
                          onChanged: busy || !canManage
                              ? null
                              : (value) => update(() => visibility = value),
                        ),
                        const SizedBox(height: 16),
                        Text(
                          visibility == 'public'
                              ? 'Everyone in this swarm can open this project.'
                              : 'Only the people below can open this project.',
                          style: DesktopChrome.text(),
                        ),
                        if (visibility == 'private')
                          for (final person
                              in c.snapshot?.people ?? const <SuperTabPerson>[])
                            CheckboxListTile(
                              dense: true,
                              contentPadding: EdgeInsets.zero,
                              title: Text(
                                person.email,
                                style: DesktopChrome.control(),
                              ),
                              subtitle: person.id == project.ownerId
                                  ? const Text('Project owner')
                                  : null,
                              value:
                                  person.id == project.ownerId ||
                                  members.contains(person.id),
                              onChanged:
                                  busy ||
                                      !canManage ||
                                      person.id == project.ownerId
                                  ? null
                                  : (value) => update(
                                      () => value == true
                                          ? members.add(person.id)
                                          : members.remove(person.id),
                                    ),
                            ),
                      ],
                      if (action == 'cadence') ...[
                        Text(
                          'The product manager consolidates new workgroup reports while work is active.',
                          style: DesktopChrome.text(),
                        ),
                        const SizedBox(height: 12),
                        DropdownButton<int>(
                          value: minutes,
                          items: [
                            for (final value in const [1, 5, 15, 30])
                              DropdownMenuItem(
                                value: value,
                                child: Text(
                                  'Every $value ${value == 1 ? 'minute' : 'minutes'}',
                                ),
                              ),
                          ],
                          onChanged: busy
                              ? null
                              : (value) => update(() => minutes = value!),
                        ),
                        const SizedBox(height: 8),
                        Text(
                          'Questions, blockers and completion are reported immediately. No new progress means no update.',
                          style: DesktopChrome.metadata(),
                        ),
                      ],
                      if (action == 'skills')
                        Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              'Instructions',
                              style: DesktopChrome.metadata(),
                            ),
                            const SizedBox(height: 8),
                            RadioGroup<String>(
                              groupValue: mode,
                              onChanged: (value) {
                                if (busy ||
                                    !canManage ||
                                    value == null ||
                                    (value == 'custom' &&
                                        current?.roles == null)) {
                                  return;
                                }
                                update(() => mode = value);
                              },
                              child: Column(
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  RadioListTile<String>(
                                    value: 'default',
                                    enabled: !busy && canManage,
                                    contentPadding: EdgeInsets.zero,
                                    title: const Text(
                                      'Default — the team process; agents otherwise work their usual way',
                                    ),
                                  ),
                                  RadioListTile<String>(
                                    value: 'orchestration',
                                    enabled: !busy && canManage,
                                    contentPadding: EdgeInsets.zero,
                                    title: const Text(
                                      'Harness orchestration — adds Harness practices: plans, test-first, review rounds',
                                    ),
                                  ),
                                  RadioListTile<String>(
                                    value: 'custom',
                                    enabled:
                                        !busy &&
                                        canManage &&
                                        current?.roles != null,
                                    contentPadding: EdgeInsets.zero,
                                    title: const Text('Custom'),
                                  ),
                                ],
                              ),
                            ),
                            if (canManage)
                              current?.roles == null
                                  ? OutlinedButton(
                                      onPressed:
                                          busy || c.saving || c.hasPendingAction
                                          ? null
                                          : () async {
                                              update(() => busy = true);
                                              await c.command({
                                                'type': 'project.roles.create',
                                                'projectId': project.id,
                                                'roles': defaultProjectRoles(),
                                              });
                                              if (context.mounted) {
                                                update(() => busy = false);
                                              }
                                            },
                                      child: const Text('Create custom set'),
                                    )
                                  : TextButton(
                                      onPressed: busy
                                          ? null
                                          : () => showRolesEditor(
                                              context,
                                              c,
                                              project.id,
                                            ),
                                      child: const Text('Edit custom roles'),
                                    ),
                          ],
                        ),
                      if (readOnly) ...[
                        Text(
                          current?.name ?? project.name,
                          style: DesktopChrome.text(medium: true),
                        ),
                        const SizedBox(height: 12),
                        Text(
                          group?.brief.isNotEmpty == true ? group!.brief : 'Discuss the project with its product manager to define the work.',
                          style: DesktopChrome.text(),
                        ),
                        const SizedBox(height: 16),
                        Text('Repository', style: DesktopChrome.metadata()),
                        SelectableText(
                          current?.repository?['repositoryUrl'] as String? ??
                              current?.repository?['cwd'] as String? ??
                              'Not set',
                        ),
                        const SizedBox(height: 16),
                        Text(
                          'Product Manager',
                          style: DesktopChrome.metadata(),
                        ),
                        Text(
                          group?.leadId == null
                              ? 'Starting…'
                              : c.snapshot!.agentName(group!.leadId!),
                        ),
                      ],
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
                  child: Text(readOnly ? 'Close' : 'Cancel'),
                ),
                if (!readOnly)
                  FilledButton(
                    onPressed:
                        busy ||
                            c.saving ||
                            c.hasPendingAction ||
                            name.trim().isEmpty ||
                            (action == 'skills' &&
                                mode == 'custom' &&
                                current?.roles == null) ||
                            (action != 'cadence' && !canManage)
                        ? null
                        : () async {
                            update(() => busy = true);
                            final result = await c.command({
                              'type':
                                  'project.${action == 'rename'
                                      ? 'rename'
                                      : action == 'sharing'
                                      ? 'sharing'
                                      : action == 'skills'
                                      ? 'skills'
                                      : 'cadence'}',
                              'projectId': project.id,
                              if (action == 'rename') 'name': name.trim(),
                              if (action == 'sharing') ...{
                                'visibility': visibility,
                                'memberIds': members.toList(),
                              },
                              if (action == 'cadence') 'minutes': minutes,
                              if (action == 'skills') 'mode': mode,
                            });
                            if (!context.mounted) return;
                            if (result != null) {
                              Navigator.pop(context);
                            } else {
                              update(() => busy = false);
                            }
                          },
                    child: const Text('Save'),
                  ),
              ],
            );
          },
        ),
      ),
    ),
  );
}

Future<void> _deleteProject(
  BuildContext context,
  SuperTabController c,
  SuperTabProject project,
) async {
  var busy = false;
  await showAppDialog<void>(
    context: context,
    builder: (context) => SuperTabDialogScope(
      controller: c,
      // A confirmed deletion removes this project before command() returns.
      // Keep the account fence while allowing its original receipt to settle.
      child: StatefulBuilder(
        builder: (context, update) => ListenableBuilder(
          listenable: c,
          builder: (context, _) {
            final current = c.snapshot?.projects
                .where((p) => p.id == project.id)
                .firstOrNull;
            final pending = c.pendingCommand;
            final checking =
                pending?['type'] == 'project.delete' &&
                pending?['projectId'] == project.id;
            final available = current != null || checking;
            final canDelete =
                !busy &&
                !c.saving &&
                c.canWrite &&
                (checking ||
                    !c.hasPendingAction && current?.ownerId == c.accountId);
            return PopScope(
              canPop: !busy,
              child: AlertDialog(
                title: Text(
                  available ? 'Delete Project?' : 'Project unavailable',
                ),
                content: SizedBox(
                  width: 400,
                  child: SingleChildScrollView(
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          available
                              ? '“${current?.name ?? project.name}” and all of its conversations will be permanently deleted. Its Product Manager’s session will close too. This can’t be undone.'
                              : 'This project is no longer available.',
                          style: DesktopChrome.text(),
                        ),
                        if (c.operationError != null && available) ...[
                          const SizedBox(height: 12),
                          Text(
                            c.operationError!,
                            style: DesktopChrome.metadata(),
                          ),
                        ],
                      ],
                    ),
                  ),
                ),
                actions: [
                  TextButton(
                    autofocus: true,
                    onPressed: busy ? null : () => Navigator.pop(context),
                    child: Text(available && !checking ? 'Cancel' : 'Close'),
                  ),
                  if (available)
                    FilledButton(
                      style: grid.dangerButtonStyle(),
                      onPressed: !canDelete
                          ? null
                          : () async {
                              update(() => busy = true);
                              final result = checking
                                  ? await c.retry()
                                  : await c.command({
                                      'type': 'project.delete',
                                      'projectId': project.id,
                                    });
                              if (!context.mounted) return;
                              if (result != null) {
                                Navigator.pop(context);
                              } else {
                                update(() => busy = false);
                              }
                            },
                      child: Text(checking ? 'Retry' : 'Delete Project'),
                    ),
                ],
              ),
            );
          },
        ),
      ),
    ),
  );
}
