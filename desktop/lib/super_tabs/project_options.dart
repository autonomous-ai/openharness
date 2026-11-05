import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';

import '../core/github_repository.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../widgets/desktop_chrome.dart';
import 'controller.dart';
import 'detail_dialog.dart';
import 'dialog_scope.dart';
import 'model.dart';
import 'project_github.dart';
import 'project_visibility.dart';

/// The spacing scale's steps (4, 8, 12) from the shared control gap, as the leaderboard rows take them.
const _gap = DesktopChrome.controlGap;
const _halfGap = _gap / 2;

/// How many branches a repository has, by `git ls-remote --heads` with this
/// computer's own git login, or null when it could not be reached. One with
/// none has no commit yet.
typedef RepositoryBranchCount = Future<int?> Function(String url);

Future<int?> _branchCount(String url) async {
  try {
    final result = await Process.run(
      'git',
      ['ls-remote', '--heads', '--', url],
      // Never a prompt for a password nobody sees, and only GitHub's ways in.
      environment: {
        'GIT_TERMINAL_PROMPT': '0',
        'GIT_ALLOW_PROTOCOL': 'https:ssh',
      },
    ).timeout(const Duration(seconds: 20));
    if (result.exitCode != 0) return null;
    return '${result.stdout}'
        .split('\n')
        .where((l) => l.trim().isNotEmpty)
        .length;
  } on Object {
    return null;
  }
}

/// A project's details, read only: its description, repository, coordinator and whether teammates' agents can
/// push there, in the shared details frame (Ken, 2026-10-28). Its owner can share a repository from the Repository
/// row while none is set (task #3211): other machines then clone it instead of starting in an empty folder.
Future<void> _showProjectDetails(
  BuildContext context,
  SuperTabController c,
  SuperTabProject project,
  RepositoryBranchCount branches,
) => showAppDialog<void>(
  context: context,
  builder: (context) => SuperTabDialogScope(
    controller: c,
    projectId: project.id,
    requireWrite: false,
    child: ListenableBuilder(
      listenable: c,
      builder: (context, _) {
        final current = c.snapshot?.projects
            .where((p) => p.id == project.id)
            .firstOrNull;
        final group = c.snapshot?.conversation(project.leadConversationId);
        final brief = group?.brief.trim() ?? '';
        return SuperTabDetailDialog(
          title: current?.name ?? project.name,
          body: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Padding(
                padding: const EdgeInsets.only(bottom: _gap + _halfGap),
                child: brief.isEmpty
                    ? Text(
                        'No description yet',
                        style: DesktopChrome.metadata(),
                      )
                    : SelectableText(brief, style: DesktopChrome.text()),
              ),
              SuperTabDetailRow(
                label: 'Repository',
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    SelectableText(
                      current?.repository?['repositoryUrl'] as String? ??
                          current?.repository?['cwd'] as String? ??
                          'Not set',
                      style: DesktopChrome.control(),
                    ),
                    if (current != null &&
                        current.ownerId == c.accountId &&
                        current.repository?['repositoryUrl'] == null)
                      TextButton(
                        onPressed: () =>
                            _shareRepository(context, c, current, branches),
                        child: const Text('Share repository'),
                      ),
                  ],
                ),
              ),
              SuperTabDetailRow(
                label:
                    c.snapshot?.coordinatorNameOf(project.id) ??
                    kDefaultCoordinatorName,
                value: group?.leadId == null
                    ? 'Starting…'
                    : c.snapshot!.agentName(group!.leadId!),
              ),
              // Whether teammates' agents can push to its repository, and what to do about it.
              ProjectGitHubAccess(
                controller: c,
                projectId: project.id,
                detailRow: true,
              ),
            ],
          ),
        );
      },
    ),
  ),
);

/// The project menu's Project settings… (Quiet Swarm, screen 9): the rows the
/// reader may use, each closing the dialog and then doing its work.
Future<void> showProjectSettings(
  BuildContext context,
  SuperTabController c,
  SuperTabProject project,
  List<(String, VoidCallback)> rows, {
  double rowHeight = 32,
}) => showAppDialog<void>(
  context: context,
  builder: (context) => SuperTabDialogScope(
    controller: c,
    projectId: project.id,
    requireWrite: false,
    child: SuperTabDetailDialog(
      title: 'Project settings',
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (final (label, action) in rows)
            InkWell(
              onTap: () {
                Navigator.of(context).pop();
                action();
              },
              child: Container(
                constraints: BoxConstraints(minHeight: rowHeight),
                alignment: Alignment.centerLeft,
                child: Text(label, style: DesktopChrome.control()),
              ),
            ),
        ],
      ),
    ),
  ),
);

Future<void> showProjectAction(
  BuildContext context,
  SuperTabController c,
  SuperTabProject project,
  String action, {
  RepositoryBranchCount? branches,
}) async {
  if (action == 'delete') {
    await _deleteProject(context, c, project);
    return;
  }
  if (action == 'details') {
    await _showProjectDetails(context, c, project, branches ?? _branchCount);
    return;
  }
  var name = project.name;
  var visibility = project.isPrivate ? 'private' : 'public';
  final members = project.memberIds.toSet();
  var busy = false;
  await showAppDialog<void>(
    context: context,
    builder: (context) => SuperTabDialogScope(
      controller: c,
      projectId: project.id,
      requireWrite: true,
      child: StatefulBuilder(
        builder: (context, update) => ListenableBuilder(
          listenable: c,
          builder: (context, _) {
            final current = c.snapshot?.projects
                .where((p) => p.id == project.id)
                .firstOrNull;
            final canManage = current?.ownerId == c.accountId;
            return AlertDialog(
              title: Text(action == 'rename' ? 'Rename project' : 'Sharing'),
              content: SizedBox(
                width: 400,
                child: SingleChildScrollView(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
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
                  onPressed:
                      busy ||
                          c.saving ||
                          c.hasPendingAction ||
                          name.trim().isEmpty ||
                          !canManage
                      ? null
                      : () async {
                          update(() => busy = true);
                          final result = await c.command({
                            'type': action == 'rename'
                                ? 'project.rename'
                                : 'project.sharing',
                            'projectId': project.id,
                            if (action == 'rename') 'name': name.trim(),
                            if (action == 'sharing') ...{
                              'visibility': visibility,
                              'memberIds': members.toList(),
                            },
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
                              ? '“${current?.name ?? project.name}” and all of its conversations will be permanently deleted. Its ${c.snapshot?.coordinatorNameOf(project.id) ?? kDefaultCoordinatorName}’s session will close too. This can’t be undone.'
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

/// The owner shares the project's GitHub repository (task #3211): checked on
/// this computer to have a commit, since other machines clone and branch from
/// it, then sent as the address any machine can use.
Future<void> _shareRepository(
  BuildContext context,
  SuperTabController c,
  SuperTabProject project,
  RepositoryBranchCount branches,
) async {
  var address = '';
  String? problem;
  var busy = false;
  await showAppDialog<void>(
    context: context,
    builder: (context) => SuperTabDialogScope(
      controller: c,
      projectId: project.id,
      requireWrite: true,
      child: StatefulBuilder(
        builder: (context, update) => ListenableBuilder(
          listenable: c,
          builder: (context, _) {
            Future<void> share() async {
              final repository = GitHubRepository.parse(address);
              if (repository == null) {
                update(
                  () => problem = 'Enter a GitHub repository, such as https://github.com/owner/repository.',
                );
                return;
              }
              update(() {
                busy = true;
                problem = null;
              });
              final count = await branches(repository.url);
              if (!context.mounted) return;
              if (count == null || count == 0) {
                update(() {
                  busy = false;
                  problem = count == null
                      ? 'This computer can’t reach ${repository.slug} on GitHub. Check the address, and that you can open the repository with your GitHub account.'
                      : '${repository.slug} has no commits yet. Add one, for example a README, then share it.';
                });
                return;
              }
              final result = await c.command({
                'type': 'project.repository',
                'projectId': project.id,
                'repositoryUrl': repository.shareableUrl,
              });
              if (!context.mounted) return;
              if (result != null) {
                Navigator.pop(context);
              } else {
                update(() => busy = false);
              }
            }

            return AlertDialog(
              title: const Text('Share repository'),
              content: SizedBox(
                width: 400,
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'Agents on other machines clone this repository instead of starting in an empty folder. It needs at least one commit.',
                      style: DesktopChrome.text(),
                    ),
                    const SizedBox(height: _gap),
                    TextField(
                      autofocus: true,
                      enabled: !busy,
                      decoration: const InputDecoration(
                        hintText: 'https://github.com/owner/repository',
                      ),
                      onChanged: (value) => update(() {
                        address = value;
                        problem = null;
                      }),
                      onSubmitted: (_) => busy ? null : share(),
                    ),
                    if (problem ?? c.operationError case final shown?) ...[
                      const SizedBox(height: _gap),
                      Text(shown, style: DesktopChrome.metadata()),
                    ],
                  ],
                ),
              ),
              actions: [
                TextButton(
                  onPressed: busy ? null : () => Navigator.pop(context),
                  child: const Text('Cancel'),
                ),
                FilledButton(
                  onPressed:
                      busy ||
                          c.saving ||
                          c.hasPendingAction ||
                          address.trim().isEmpty
                      ? null
                      : share,
                  child: const Text('Share'),
                ),
              ],
            );
          },
        ),
      ),
    ),
  );
}
