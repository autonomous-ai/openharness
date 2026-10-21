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
import 'identity.dart';
import 'machines.dart';
import 'model.dart';
import 'section_heading.dart';

/// Tab-wide membership above tab-wide execution capacity. Group selection does
/// not change who appears here or what machines the team has contributed.
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
            Text(engineIdentity(agent.engine).label),
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
        .where((p) => p.id == agent.projectId)
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
          ],
        );
        if (choice == 'details' && mounted) await _details(agent);
      },
      child: ListTile(
        key: ValueKey('super-member-${agent.id}'),
        dense: true,
        contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 1),
        title: Row(
          children: [
            Tooltip(
              message: engineIdentity(agent.engine).label,
              child: EngineMark(engine: agent.engine, size: 20),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Tooltip(
                message: name,
                child: Text(
                  name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: DesktopChrome.control(medium: true),
                ),
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
                padding: const EdgeInsets.only(left: 30),
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
    final leads =
        state?.agents.where((a) => state.isLead(a.id)).toList() ??
        const <SuperTabAgent>[];
    final agents =
        state?.agents.where((a) => !state.isLead(a.id)).toList() ??
        const <SuperTabAgent>[];
    return [
      SuperTabSectionHeading(
        'Humans',
        onAdd: c.isOwner ? widget.onInvite : null,
        addTooltip: 'Invite people',
      ),
      for (final person in state?.people ?? const <SuperTabPerson>[])
        ListTile(
          dense: true,
          contentPadding: const EdgeInsets.symmetric(horizontal: 16),
          horizontalTitleGap: 10,
          leading: SuperTabAvatar(
            identity: 'person:${person.id}',
            name: superTabPersonName(person.email),
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
      const SizedBox(height: 20),
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
          children: [
            ..._members(),
            const SizedBox(height: 20),
            SuperTabMachines(
              controller: c,
              app: widget.app,
              onAddAgent: widget.onAddAgent,
              embedded: true,
            ),
          ],
        ),
      ),
    );
  }
}
