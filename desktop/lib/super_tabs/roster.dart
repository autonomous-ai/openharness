import 'dart:async';

import 'package:flutter/material.dart';

import '../core/models.dart' show Agent;
import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../shared/widgets/app_icon_button.dart';
import '../state/app_state.dart';
import '../widgets/desktop_chrome.dart';
import '../widgets/engine_identity.dart';
import 'controller.dart';
import 'identity.dart';
import 'machines.dart';
import 'model.dart';

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
  double _membersFraction = .56;
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

  Widget _heading(String text, {VoidCallback? add, String? tooltip}) => Padding(
    padding: const EdgeInsets.fromLTRB(16, 14, 12, 6),
    child: Row(
      children: [
        Expanded(
          child: Text(
            text,
            style: DesktopChrome.metadata().copyWith(
              fontWeight: FontWeight.w600,
            ),
          ),
        ),
        if (add != null)
          AppIconButton(
            icon: AppIcons.plus,
            tooltip: tooltip ?? text,
            onPressed: add,
          ),
      ],
    ),
  );

  Widget _agent(SuperTabAgent agent) {
    final name = c.snapshot!.agentName(agent.id), activity = _activity(agent);
    final waiting = activity == 'Needs you';
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
              child: Text(
                name,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: DesktopChrome.control(medium: true),
              ),
            ),
            const SizedBox(width: 6),
            Tooltip(
              message: engineIdentity(agent.engine).label,
              child: EngineMark(engine: agent.engine, size: 14),
            ),
          ],
        ),
        subtitle: Text(
          activity,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: DesktopChrome.metadata(
            color: waiting ? grid.AppPalette.warn : null,
          ),
        ),
        onTap: () => widget.onOpenAgent(agent),
        onLongPress: () => unawaited(_details(agent)),
      ),
    );
  }

  Widget _members() {
    final state = c.snapshot;
    final leads =
        state?.agents.where((a) => state.isLead(a.id)).toList() ??
        const <SuperTabAgent>[];
    final agents =
        state?.agents.where((a) => !state.isLead(a.id)).toList() ??
        const <SuperTabAgent>[];
    return ListView(
      padding: const EdgeInsets.only(bottom: 12),
      children: [
        _heading('Leads · ${leads.length}'),
        for (final agent in leads) _agent(agent),
        _heading(
          'Humans · ${state?.people.length ?? 0}',
          add: c.isOwner ? widget.onInvite : null,
          tooltip: 'Invite people',
        ),
        for (final person in state?.people ?? const <SuperTabPerson>[])
          ListTile(
            dense: true,
            horizontalTitleGap: 10,
            leading: SuperTabAvatar(
              identity: 'person:${person.id}',
              name: superTabPersonName(person.email),
            ),
            title: Text(
              superTabPersonName(person.email),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: DesktopChrome.control(),
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
        _heading('Agents · ${agents.length}'),
        for (final agent in agents) _agent(agent),
      ],
    );
  }

  @override
  Widget build(BuildContext context) => Material(
    color: DesktopChrome.surface,
    child: ListenableBuilder(
      listenable: Listenable.merge([c, if (widget.app != null) widget.app!]),
      builder: (context, _) => LayoutBuilder(
        builder: (context, size) => Column(
          children: [
            SizedBox(
              height: (size.maxHeight - 9) * _membersFraction,
              child: _members(),
            ),
            Semantics(
              label: 'Resize members and machines',
              child: MouseRegion(
                cursor: SystemMouseCursors.resizeRow,
                child: GestureDetector(
                  behavior: HitTestBehavior.opaque,
                  onVerticalDragUpdate: (event) => setState(
                    () => _membersFraction =
                        (_membersFraction + event.delta.dy / size.maxHeight)
                            .clamp(.25, .75),
                  ),
                  child: SizedBox(
                    height: 9,
                    child: Center(
                      child: Divider(height: 1, color: DesktopChrome.rim),
                    ),
                  ),
                ),
              ),
            ),
            Expanded(
              child: SuperTabMachines(
                controller: c,
                app: widget.app,
                onAddAgent: widget.onAddAgent,
              ),
            ),
          ],
        ),
      ),
    ),
  );
}
