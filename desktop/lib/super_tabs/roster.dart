import 'package:clock/clock.dart';

import 'dart:async';

import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/theme/appearance_prefs_store.dart';
import '../shared/widgets/app_dialog.dart';
import '../shared/widgets/app_icon_button.dart';
import '../state/app_state.dart';
import '../state/harness_activity.dart';
import '../terminal/terminal_theme.dart';
import '../terminal/terminal_theme_store.dart';
import '../widgets/desktop_chrome.dart';
import '../widgets/engine_identity.dart';
import '../widgets/harness_activity_mark.dart';
import 'agent_details.dart';
import 'controller.dart';
import 'dialog_scope.dart';
import 'identity.dart';
import 'profile_sheet.dart';
import 'model.dart';
import 'section_heading.dart';
import 'team_glance.dart';
import 'team_glance_panel.dart';

/// The current Swarm's authorized people, with agents from the selected project.
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
  static const _peopleShown = 5;
  bool _allPeople = false;
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

  bool _canRemove(SuperTabAgent agent) =>
      c.canWrite && (c.isOwner || agent.contributorId == c.accountId);

  String? _removeReason(SuperTabAgent agent) =>
      c.snapshot?.leadProtectionReason(agent.id);

  Future<void> _remove(SuperTabAgent agent) async {
    var busy = false, attempted = false;
    final name = c.snapshot!.agentName(agent.id);
    // The Mac, for an agent in that Mac's Harness Team account.
    final place = c.snapshot?.placeOf(agent.machineId) ?? agent.machineId;
    final machine =
        widget.app?.stateOf(place)?.machine.displayName ??
        c.snapshot?.pool(place)?['name'] as String? ??
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
              final reason = _removeReason(current ?? agent);
              final enabled =
                  permitted &&
                  reason == null &&
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
                            reason ??
                                (available && permitted
                                    ? 'Any open task needs to be assigned again or closed. Its session on $machine will stop.'
                                    : 'This action is no longer available.'),
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
              !group.closed &&
              group.assignment?['agentId'] == agent.id &&
              superTabWorkWaits(group.assignment?['status']),
        ) ==
        true) {
      return HarnessActivity.needsInput;
    }
    return native ?? HarnessActivity.unknown;
  }

  Future<void> _details(SuperTabAgent agent) => showSuperTabAgentDetails(
    context,
    c,
    widget.app,
    agent,
    widget.onOpenAgent,
  );

  Widget _agentIdentity(String name, String role, String badge) =>
      LayoutBuilder(
        builder: (context, constraints) {
          final nameStyle = DesktopChrome.control();
          final tagStyle = DesktopChrome.metadata();
          final scale = MediaQuery.textScalerOf(context);
          double measure(String text, TextStyle style) {
            final painter = TextPainter(
              text: TextSpan(text: text, style: style),
              textDirection: Directionality.of(context),
              textScaler: scale,
              maxLines: 1,
            )..layout();
            final width = painter.width;
            painter.dispose();
            return width;
          }

          final badgeWidth = (measure(badge, tagStyle) + 10).clamp(
            0.0,
            constraints.maxWidth,
          );
          final nameWidth = measure(name, nameStyle).clamp(
            0.0,
            (constraints.maxWidth - badgeWidth - 6).clamp(0.0, double.infinity),
          );
          Widget tag(String text) => Container(
            padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
            decoration: BoxDecoration(
              color: grid.AppSurface.hoverFill,
              borderRadius: BorderRadius.circular(4),
            ),
            child: Text(
              text,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: tagStyle,
            ),
          );
          return Row(
            children: [
              if (nameWidth > 0) ...[
                SizedBox(
                  width: nameWidth,
                  child: Text(
                    name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: nameStyle,
                  ),
                ),
                const SizedBox(width: 6),
              ],
              Semantics(
                label: role,
                excludeSemantics: true,
                child: SizedBox(width: badgeWidth, child: tag(badge)),
              ),
            ],
          );
        },
      );

  Widget _agent(SuperTabAgent agent) {
    final name = c.snapshot!.agentName(agent.id), activity = _activity(agent);
    final info = SuperTabAgentInfo(c, widget.app, agent, activity: activity);
    // One line, readable in a second (Dee, 2026-10-27): state, machine, model and effort. The task is in the tooltip.
    final glance = superTabAgentGlance(info);
    final project = c.snapshot!.projects
        .where((p) => p.id == _agentProjectId(agent))
        .firstOrNull;
    final customRole = c.snapshot!.activeRoleForAgent(agent);
    final role =
        customRole?.name ??
        (c.snapshot!.isLead(agent.id)
            ? 'Product Manager'
            : agent.isReviewer
            ? 'Reviewer'
            : 'Engineer');
    final badge =
        customRole?.name ??
        (c.snapshot!.isLead(agent.id)
            ? 'PM'
            : agent.isReviewer
            ? 'Rev'
            : 'Dev');
    final status = info.status ?? 'Status unavailable';
    final tooltip = [
      [name, role, ?project?.name].join(' · '),
      if (info.tooltip.isNotEmpty) info.tooltip,
      if (!info.tooltip.contains(status)) status,
    ].join('\n');
    final theme = terminalThemeFor(
      grid.AppTheme.surfacePalette,
      terminalThemeStore.value,
    );
    return Tooltip(
      message: tooltip,
      constraints: const BoxConstraints(maxWidth: 820),
      child: GestureDetector(
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
                PopupMenuItem(
                  value: 'remove',
                  enabled: _removeReason(agent) == null,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text('Remove from Swarm'),
                      if (_removeReason(agent) case final reason?) Text(reason),
                    ],
                  ),
                ),
            ],
          );
          if (choice == 'details' && mounted) await _details(agent);
          if (choice == 'remove' && mounted) {
            final current = c.snapshot?.agent(agent.id);
            if (current != null &&
                _canRemove(current) &&
                _removeReason(current) == null) {
              await _remove(current);
            }
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
              SuperTabAvatar.agent(
                agent,
                name: name,
                size: 24,
                engineBadge: false,
              ),
              const SizedBox(width: 8),
              Expanded(child: _agentIdentity(name, role, badge)),
              const SizedBox(width: 8),
              EngineMark(engine: agent.engine, size: 14),
            ],
          ),
          subtitle: Padding(
            padding: const EdgeInsets.only(left: 32),
            child: Row(
              children: [
                ActivityMark(
                  activity: activity,
                  tooltip: false,
                  showIdle: true,
                  color: activityColor(
                    activity,
                    theme,
                    color: appearancePrefsStore.value.prompt.color,
                  ),
                ),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    glance.line,
                    key: ValueKey('super-member-line-${agent.id}'),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: DesktopChrome.metadata(),
                  ),
                ),
              ],
            ),
          ),
          onTap: () => unawaited(_details(agent)),
          onLongPress: () => unawaited(_details(agent)),
        ),
      ),
    );
  }

  List<Widget> _members() {
    final state = c.snapshot;
    // The backend already scopes this snapshot to projects the person can
    // access. The roster follows the selected project; without one it keeps
    // the full directory, as the Product Managers' conversation, which belongs
    // to no project, does. Local machine inventory is not membership here.
    final projectId = c.selected?.projectId == ''
        ? null
        : c.selected?.projectId;
    // A private conversation lists only who reads it: its people and the
    // agents in it, the project's Lead.
    final audience = c.selected?.audience;
    final members =
        state?.agents
            .where(
              (agent) =>
                  (projectId == null || _agentProjectId(agent) == projectId) &&
                  (audience == null || c.selected!.agentIds.contains(agent.id)),
            )
            .toList() ??
        const <SuperTabAgent>[];
    final leads = members.where((a) => state!.isLead(a.id)).toList();
    final agents = members.where((a) => !state!.isLead(a.id)).toList();
    final people =
        state?.people
            .where((p) => audience == null || audience.contains(p.id))
            .toList() ??
        const <SuperTabPerson>[];
    final shownPeople = _allPeople ? people : people.take(_peopleShown);
    return [
      SuperTabSectionHeading(
        'Humans',
        onAdd: c.isOwner ? widget.onInvite : null,
        addTooltip: 'Invite people',
      ),
      for (final person in shownPeople)
        ListTile(
          key: ValueKey('super-person-${person.id}'),
          dense: true,
          minTileHeight: 36,
          minVerticalPadding: 6,
          minLeadingWidth: 24,
          contentPadding: const EdgeInsets.symmetric(horizontal: 16),
          horizontalTitleGap: 8,
          leading: SuperTabAvatar.person(person, size: 24),
          title: Tooltip(
            message: person.email,
            child: Text.rich(
              TextSpan(
                text: superTabPersonName(person.email),
                children: [
                  if (person.statusAt(clock.now()) case final status?)
                    TextSpan(
                      text: '  ${status.text}',
                      style: DesktopChrome.metadata(),
                    ),
                ],
              ),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: DesktopChrome.control(),
            ),
          ),
          // One's own row is where one's avatar and status are changed.
          onTap: () => person.id == c.accountId && c.canWrite
              ? showSuperTabProfile(context, c)
              : showAppDialog<void>(
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
      if (people.length > _peopleShown)
        ListTile(
          dense: true,
          minTileHeight: 36,
          contentPadding: const EdgeInsets.symmetric(horizontal: 16),
          title: Text(
            _allPeople
                ? 'Show less'
                : 'Show ${people.length - _peopleShown} more',
            style: DesktopChrome.metadata(),
          ),
          onTap: () => setState(() => _allPeople = !_allPeople),
        ),
      const SizedBox(height: 16),
      SuperTabSectionHeading(
        'Agents',
        // An agent joins the Product Managers' conversation by leading a project,
        // and a private conversation holds only the project's Lead.
        onAdd:
            c.canWrite &&
                c.selected != null &&
                c.selected!.id != c.snapshot?.leadsConversationId &&
                audience == null
            ? () => widget.onAddAgent(c.selected!)
            : null,
        addTooltip: 'Add agent',
        actions: [
          AppIconButton(
            icon: AppIcons.layoutGrid,
            tooltip: 'Team at a glance',
            onPressed: () =>
                unawaited(showSuperTabTeamGlance(context, c, widget.app)),
          ),
        ],
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
