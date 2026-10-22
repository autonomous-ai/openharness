import 'dart:async';

import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/theme/appearance_prefs_store.dart';
import '../shared/widgets/app_dialog.dart';
import '../state/app_state.dart';
import '../state/harness_activity.dart';
import '../terminal/terminal_theme.dart';
import '../terminal/terminal_theme_store.dart';
import '../widgets/desktop_chrome.dart';
import '../widgets/engine_identity.dart';
import '../widgets/harness_activity_mark.dart';
import 'controller.dart';
import 'dialog_scope.dart';
import 'identity.dart';
import 'model.dart';
import 'section_heading.dart';

/// Tab-wide people and capacity, with agents from the selected project.
class SuperTabRoster extends StatefulWidget {
  const SuperTabRoster({
    super.key,
    required this.controller,
    required this.onInvite,
    required this.onOpenAgent,
    required this.onAddAgent,
    this.app,
  });
  final SuperTabController controller;
  final AppNotifier? app;
  final VoidCallback onInvite;
  final ValueChanged<SuperTabAgent> onOpenAgent;
  final ValueChanged<SuperTabConversation> onAddAgent;
  @override
  State<SuperTabRoster> createState() => _SuperTabRosterState();
}

class _SuperTabRosterState extends State<SuperTabRoster> {
  SuperTabController get c => widget.controller;

  String? _agentProjectId(SuperTabAgent agent) => agent.hasProjectId
      ? agent.projectId
      : c.snapshot?.conversations
            .where(
              (group) =>
                  group.agentIds.contains(agent.id) || group.leadId == agent.id,
            )
            .firstOrNull
            ?.projectId;

  String _role(SuperTabAgent agent) => c.snapshot!.isLead(agent.id)
      ? 'Product Manager'
      : agent.isReviewer
      ? 'Reviewer'
      : 'Engineer';

  bool _canRemove(SuperTabAgent agent) =>
      c.canWrite && (c.isOwner || agent.contributorId == c.accountId);

  Future<void> _remove(SuperTabAgent agent) async {
    var busy = false, attempted = false;
    final name = c.snapshot!.agentName(agent.id);
    final machine =
        widget.app?.stateOf(agent.machineId)?.machine.displayName ??
        c.snapshot?.machines
                .where((m) => m['machineId'] == agent.machineId)
                .firstOrNull?['name']
            as String? ??
        'its computer';
    await showAppDialog<void>(
      context: context,
      builder: (context) => SuperTabDialogScope(
        controller: c,
        child: StatefulBuilder(
          builder: (context, update) => ListenableBuilder(
            listenable: c,
            builder: (context, _) {
              final current = c.snapshot?.agent(agent.id);
              final pending = c.pendingCommand;
              final checking =
                  pending?['type'] == 'agent.remove' &&
                  pending?['agentId'] == agent.id;
              final available = current != null || checking || busy;
              final permitted = _canRemove(current ?? agent);
              final enabled =
                  permitted &&
                  !busy &&
                  !c.saving &&
                  (checking || !c.hasPendingAction);
              return PopScope(
                canPop: !busy,
                child: AlertDialog(
                  title: Text(
                    available
                        ? 'Remove $name from this Swarm?'
                        : 'Agent unavailable',
                  ),
                  content: SizedBox(
                    width: 400,
                    child: SingleChildScrollView(
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            available && permitted
                                ? 'Any open task needs to be assigned again or closed. Its session on $machine is left to its owner.'
                                : 'This action is no longer available.',
                          ),
                          if (attempted && c.operationError != null) ...[
                            const SizedBox(height: 12),
                            Text(c.operationError!),
                          ],
                        ],
                      ),
                    ),
                  ),
                  actions: [
                    TextButton(
                      autofocus: true,
                      onPressed: busy ? null : () => Navigator.pop(context),
                      child: Text(
                        checking || !available || !permitted
                            ? 'Close'
                            : 'Cancel',
                      ),
                    ),
                    if (available && permitted)
                      FilledButton(
                        style: grid.dangerButtonStyle(),
                        onPressed: !enabled
                            ? null
                            : () async {
                                update(() {
                                  busy = true;
                                  attempted = true;
                                });
                                final result = checking
                                    ? await c.retry()
                                    : await c.command({
                                        'type': 'agent.remove',
                                        'agentId': agent.id,
                                      });
                                if (!context.mounted) return;
                                if (result != null) {
                                  Navigator.pop(context);
                                } else {
                                  update(() => busy = false);
                                }
                              },
                        child: Text(checking ? 'Retry' : 'Remove from Swarm'),
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

  HarnessActivity _activity(SuperTabAgent agent) {
    final app = widget.app;
    final native = app == null
        ? null
        : harnessActivity(app, agent.machineId, agent.harnessId);
    // Keep the shared lifecycle precedence. A retained workgroup question must
    // not make a stopped or disconnected harness look available for input.
    if (native == HarnessActivity.offline ||
        native == HarnessActivity.paused ||
        native == HarnessActivity.starting ||
        native == HarnessActivity.failed ||
        native == HarnessActivity.needsInput) {
      return native!;
    }
    if (c.snapshot?.conversations.any(
          (group) =>
              !group.archived &&
              group.assignment?['agentId'] == agent.id &&
              superTabWorkWaits(group.assignment?['status']),
        ) ==
        true) {
      return HarnessActivity.needsInput;
    }
    return native ?? HarnessActivity.unknown;
  }

  Future<void> _details(SuperTabAgent agent) => showAppDialog<void>(
    context: context,
    builder: (context) => AlertDialog(
      title: Text(c.snapshot!.agentName(agent.id)),
      content: SizedBox(
        width: 320,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(_role(agent)),
            Text(engineIdentity(agent.engine).label),
            if (agent.name != c.snapshot!.agentName(agent.id))
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text('Harness: ${agent.name}'),
              ),
            for (final field in [
              ('Model', 'model'),
              ('Effort', 'effort'),
              ('Context', 'contextWindow'),
              ('Version', 'engineVersion'),
            ])
              if (agent.configuration[field.$2] case final value?)
                Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: Text('${field.$1}: $value'),
                ),
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(
                widget.app?.stateOf(agent.machineId)?.machine.displayName ??
                    'Machine unavailable',
              ),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('Close'),
        ),
        FilledButton(
          onPressed: () {
            Navigator.pop(context);
            widget.onOpenAgent(agent);
          },
          child: const Text('Open terminal'),
        ),
      ],
    ),
  );

  Widget _agent(SuperTabAgent agent) {
    final name = c.snapshot!.agentName(agent.id), activity = _activity(agent);
    final project = c.snapshot!.projects
        .where((p) => p.id == _agentProjectId(agent))
        .firstOrNull;
    final theme = terminalThemeFor(
      grid.AppTheme.surfacePalette,
      terminalThemeStore.value,
    );
    return GestureDetector(
      onSecondaryTapUp: (event) async {
        final choice = await showMenu<String>(
          context: context,
          position: RelativeRect.fromLTRB(
            event.globalPosition.dx,
            event.globalPosition.dy,
            event.globalPosition.dx,
            event.globalPosition.dy,
          ),
          items: [
            const PopupMenuItem(value: 'details', child: Text('Details')),
            if (_canRemove(c.snapshot?.agent(agent.id) ?? agent))
              const PopupMenuItem(
                value: 'remove',
                child: Text('Remove from Swarm'),
              ),
          ],
        );
        if (choice == 'details' && mounted) await _details(agent);
        if (choice == 'remove' && mounted) {
          final current = c.snapshot?.agent(agent.id);
          if (current != null && _canRemove(current)) await _remove(current);
        }
      },
      child: ListTile(
        key: ValueKey('super-member-${agent.id}'),
        dense: true,
        minTileHeight: 48,
        minVerticalPadding: 6,
        contentPadding: const EdgeInsets.symmetric(horizontal: 16),
        title: Row(
          children: [
            Tooltip(
              message: engineIdentity(agent.engine).label,
              child: SuperTabAvatar(
                identity: 'agent:${agent.id}',
                name: name,
                size: 24,
              ),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: Row(
                children: [
                  Flexible(
                    child: Tooltip(
                      message: name,
                      child: Text(
                        name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: DesktopChrome.control(),
                      ),
                    ),
                  ),
                  const SizedBox(width: 6),
                  Tooltip(
                    message: _role(agent),
                    child: Semantics(
                      label: _role(agent),
                      excludeSemantics: true,
                      child: Container(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 5,
                          vertical: 1,
                        ),
                        decoration: BoxDecoration(
                          color: grid.AppSurface.hoverFill,
                          borderRadius: BorderRadius.circular(4),
                        ),
                        child: Text(
                          c.snapshot!.isLead(agent.id)
                              ? 'PM'
                              : agent.isReviewer
                              ? 'Rev'
                              : 'Dev',
                          style: DesktopChrome.metadata(),
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(width: 8),
            ActivityMark(
              activity: activity,
              color: activityColor(
                activity,
                theme,
                color: appearancePrefsStore.value.prompt.color,
              ),
            ),
          ],
        ),
        subtitle: project == null
            ? null
            : Padding(
                padding: const EdgeInsets.only(left: 32),
                child: Tooltip(
                  message: project.name,
                  child: Text(
                    project.name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: DesktopChrome.metadata(),
                  ),
                ),
              ),
        onTap: () => widget.onOpenAgent(agent),
        onLongPress: () => unawaited(_details(agent)),
      ),
    );
  }

  List<Widget> _members() {
    final state = c.snapshot;
    final projectId = c.selected?.projectId;
    final members =
        state?.agents
            .where(
              (agent) =>
                  projectId != null && _agentProjectId(agent) == projectId,
            )
            .toList() ??
        const <SuperTabAgent>[];
    final leads = members.where((a) => state!.isLead(a.id)).toList();
    final agents = members.where((a) => !state!.isLead(a.id)).toList();
    return [
      SuperTabSectionHeading(
        'Humans',
        onAdd: c.isOwner ? widget.onInvite : null,
        addTooltip: 'Invite people',
      ),
      for (final person in state?.people ?? const <SuperTabPerson>[])
        ListTile(
          dense: true,
          minTileHeight: 36,
          minVerticalPadding: 6,
          minLeadingWidth: 24,
          contentPadding: const EdgeInsets.symmetric(horizontal: 16),
          horizontalTitleGap: 8,
          leading: SuperTabAvatar(
            identity: 'person:${person.id}',
            name: superTabPersonName(person.email),
            size: 24,
          ),
          title: Tooltip(
            message: person.email,
            child: Text(
              superTabPersonName(person.email),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: DesktopChrome.control(),
            ),
          ),
          onTap: () => showAppDialog<void>(
            context: context,
            builder: (context) => AlertDialog(
              title: Text(superTabPersonName(person.email)),
              content: Text('${person.email}\n${person.role}'),
              actions: [
                TextButton(
                  onPressed: () {
                    Navigator.pop(context);
                    widget.onInvite();
                  },
                  child: const Text('Manage people'),
                ),
                TextButton(
                  onPressed: () => Navigator.pop(context),
                  child: const Text('Close'),
                ),
              ],
            ),
          ),
        ),
      const SizedBox(height: 16),
      SuperTabSectionHeading(
        'Agents',
        onAdd: c.canWrite && c.selected != null
            ? () => widget.onAddAgent(c.selected!)
            : null,
        addTooltip: 'Add agent',
      ),
      for (final agent in [...leads, ...agents]) _agent(agent),
    ];
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return Material(
      color: DesktopChrome.surface,
      child: ListenableBuilder(
        listenable: Listenable.merge([
          c,
          if (widget.app != null) ...[widget.app!, widget.app!.agentUnread],
          terminalThemeStore,
          appearancePrefsStore,
        ]),
        builder: (context, _) => ListView(
          key: PageStorageKey('super-tab-resources-${c.tabId}'),
          padding: const EdgeInsets.symmetric(vertical: 12),
          children: _members(),
        ),
      ),
    );
  }
}
