import 'dart:async';

import 'package:flutter/material.dart';

import '../core/models.dart' show Agent;
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../state/app_state.dart';
import '../widgets/desktop_chrome.dart';
import '../widgets/engine_identity.dart';
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

  Agent? _native(SuperTabAgent agent) => widget.app
      ?.stateOf(agent.machineId)
      ?.agents
      .where((a) => a.id == agent.harnessId)
      .firstOrNull;

  String _activity(SuperTabAgent agent) {
    if (widget.app?.questionFor(agent.machineId, agent.harnessId) != null) {
      return 'Needs you';
    }
    final work = c.snapshot?.conversations
        .where(
          (g) =>
              !g.archived &&
              g.assignment?['agentId'] == agent.id &&
              !const ['done', 'stopped'].contains(g.assignment?['status']),
        )
        .firstOrNull;
    if (work?.assignment?['status'] == 'needs_human') return 'Needs you';
    final native = _native(agent);
    if (native?.isStopped == true) return 'Stopped';
    if (widget.app?.stateOf(agent.machineId)?.nodeOnline == false) {
      return 'Offline';
    }
    if (native?.title case final title? when title.trim().isNotEmpty) {
      return title;
    }
    if (work != null) return work.title;
    return native == null ? 'Status unavailable' : 'Ready';
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
    final waiting = activity == 'Needs you';
    final otherProject = project != null && project.id != c.selected?.projectId;
    final subtitle = otherProject ? '$activity  ${project.name}' : activity;
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
        horizontalTitleGap: 10,
        leading: SuperTabAvatar(identity: 'agent:${agent.id}', name: name),
        title: Row(
          children: [
            Flexible(
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
            const SizedBox(width: 6),
            Tooltip(
              message: engineIdentity(agent.engine).label,
              child: EngineMark(engine: agent.engine, size: 14),
            ),
          ],
        ),
        subtitle: Tooltip(
          message: [if (project != null) project.name, activity].join('\n'),
          child: Text(
            subtitle,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: DesktopChrome.metadata(
              color: waiting ? grid.AppPalette.warn : null,
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
  Widget build(BuildContext context) => Material(
    color: DesktopChrome.surface,
    child: ListenableBuilder(
      listenable: Listenable.merge([c, if (widget.app != null) widget.app!]),
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
