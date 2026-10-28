import 'dart:async';

import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_menu.dart';
import '../widgets/desktop_chrome.dart';
import 'controller.dart';
import 'section_heading.dart';
import 'workspaces.dart';

/// The Workspace menu at the top of the Swarm sidebar
/// (docs/plans/2026-10-27-swarm-workspaces.md, Shown on each platform): the
/// Workspace of the Swarm on screen, opening to the person's Workspaces with
/// their Swarms, invitations waiting, and the Workspace's actions. Shown only
/// when there is something to switch, accept or manage
/// ([SwarmWorkspaces.showsMenu]); otherwise the sidebar is as it was.
class SwarmWorkspaceMenu extends StatefulWidget {
  const SwarmWorkspaceMenu({
    super.key,
    required this.workspaces,
    required this.tabId,
    required this.onOpenSwarm,
    this.onSettings,
    this.onNewSwarm,
    this.onNewWorkspace,
    this.operationId = superTabOperationId,
  });
  final SwarmWorkspaces workspaces;

  /// The Swarm on screen.
  final String tabId;
  final void Function(String id, String name) onOpenSwarm;
  final ValueChanged<SwarmWorkspace>? onSettings;
  final ValueChanged<SwarmWorkspace>? onNewSwarm;
  final VoidCallback? onNewWorkspace;
  final String Function() operationId;

  @override
  State<SwarmWorkspaceMenu> createState() => _SwarmWorkspaceMenuState();
}

class _SwarmWorkspaceMenuState extends State<SwarmWorkspaceMenu> {
  final _menu = MenuController();
  final _focus = FocusNode(debugLabel: 'Workspace menu');

  /// Swarms being joined and Workspaces being accepted: a second press waits.
  final _busy = <String>{};

  @override
  void initState() {
    super.initState();
    widget.workspaces.shownTabId = widget.tabId;
    unawaited(widget.workspaces.refresh());
  }

  @override
  void didUpdateWidget(SwarmWorkspaceMenu old) {
    super.didUpdateWidget(old);
    widget.workspaces.shownTabId = widget.tabId;
  }

  @override
  void dispose() {
    _focus.dispose();
    super.dispose();
  }

  Future<void> _act(String key, Future<void> Function() action) async {
    if (!_busy.add(key)) return;
    try {
      await action();
    } on SuperTabFailure catch (failure) {
      if (mounted) {
        ScaffoldMessenger.maybeOf(context)
            ?.showSnackBar(SnackBar(content: Text(failure.message)));
      }
    } finally {
      _busy.remove(key);
    }
  }

  void _open(SwarmWorkspaceSwarm swarm) {
    _menu.close();
    widget.onOpenSwarm(swarm.id, swarm.name);
  }

  void _join(SwarmWorkspaceSwarm swarm) {
    _menu.close();
    unawaited(
      _act(swarm.id, () async {
        await widget.workspaces.api.join(
          swarm.id,
          operationId: widget.operationId(),
        );
        widget.onOpenSwarm(swarm.id, swarm.name);
        await widget.workspaces.refresh();
      }),
    );
  }

  void _accept(SwarmWorkspaceInvitation invitation) {
    _menu.close();
    unawaited(
      _act(invitation.workspaceId, () async {
        await widget.workspaces.api.accept(invitation.workspaceId);
        await widget.workspaces.refresh();
      }),
    );
  }

  /// Switching to a Workspace opens its first Swarm the person is in.
  void _switch(SwarmWorkspace workspace) {
    final first = workspace.swarms.where((s) => s.member).firstOrNull;
    if (first == null) return;
    _open(first);
  }

  void _run(VoidCallback action) {
    _menu.close();
    action();
  }

  Widget _quietRow(String label, {String? note, String? tooltip}) {
    final row = Padding(
      // Lines up with an [AppMenuItem]'s label and trailing edge.
      padding: const EdgeInsets.fromLTRB(40, 8, 15, 8),
      child: Row(
        children: [
          Expanded(
            child: Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: DesktopChrome.control(color: DesktopChrome.muted),
            ),
          ),
          if (note != null) Text(note, style: DesktopChrome.metadata()),
        ],
      ),
    );
    return tooltip == null ? row : Tooltip(message: tooltip, child: row);
  }

  Widget _action(String label) =>
      Text(label, style: DesktopChrome.metadata(color: grid.AppPalette.accent));

  List<Widget> _swarmRows(SwarmWorkspace workspace, double width) => [
    for (final swarm in workspace.swarms)
      if (swarm.member)
        SizedBox(
          width: width,
          child: AppMenuItem(
            label: swarm.name,
            selected: swarm.id == widget.tabId,
            expandLabel: true,
            onPressed: () => _open(swarm),
          ),
        )
      else if (swarm.openToWorkspace && workspace.role.createsSwarms)
        SizedBox(
          width: width,
          child: AppMenuItem(
            label: swarm.name,
            expandLabel: true,
            trailing: _action('Join'),
            onPressed: () => _join(swarm),
          ),
        )
      else
        _quietRow(
          swarm.name,
          note: 'Not a member',
          tooltip: 'Only people in this Swarm can open it.',
        ),
    if (workspace.swarms.isEmpty) _quietRow('No Swarms yet'),
  ];

  List<Widget> _menuChildren(SwarmWorkspace current, double width) {
    final all = widget.workspaces.workspaces ?? const <SwarmWorkspace>[];
    final invitations = widget.workspaces.invitations;
    final error = widget.workspaces.error;
    return [
      // A failed refresh keeps the list read last, and says so quietly.
      if (error != null) ...[
        SizedBox(
          width: width,
          child: AppMenuItem(
            icon: AppIcons.circleAlert,
            label: 'Workspaces could not be refreshed',
            detail: error,
            expandLabel: true,
            trailing: _action('Retry'),
            onPressed: () => unawaited(widget.workspaces.refresh()),
          ),
        ),
        const AppMenuDivider(),
      ],
      for (final workspace in all) ...[
        SizedBox(
          width: width,
          child: AppMenuItem(
            key: ValueKey('super-workspace-${workspace.id}'),
            icon: AppIcons.layers,
            label: workspace.name,
            note: workspace.role.label,
            expandLabel: true,
            onPressed: () => _switch(workspace),
          ),
        ),
        ..._swarmRows(workspace, width),
      ],
      if (invitations.isNotEmpty) ...[
        const AppMenuDivider(),
        for (final invitation in invitations)
          SizedBox(
            width: width,
            child: AppMenuItem(
              icon: AppIcons.circlePlus,
              label: 'Invited: ${invitation.name} as ${invitation.role.label}',
              expandLabel: true,
              trailing: _action('Accept'),
              onPressed: () => _accept(invitation),
            ),
          ),
      ],
      const AppMenuDivider(),
      if (widget.onNewSwarm != null && current.role.createsSwarms)
        SizedBox(
          width: width,
          child: AppMenuItem(
            icon: AppIcons.plus,
            label: 'New Swarm in ${current.name}',
            expandLabel: true,
            onPressed: () => _run(() {
              widget.workspaces.chooseForNewSwarm(current.id);
              widget.onNewSwarm!(current);
            }),
          ),
        ),
      if (widget.onSettings != null && current.role.managesPeople)
        SizedBox(
          width: width,
          child: AppMenuItem(
            icon: AppIcons.users,
            label: 'Workspace settings…',
            expandLabel: true,
            onPressed: () => _run(() => widget.onSettings!(current)),
          ),
        ),
      if (widget.onNewWorkspace != null)
        SizedBox(
          width: width,
          child: AppMenuItem(
            icon: AppIcons.squarePlus,
            label: 'New Workspace…',
            expandLabel: true,
            onPressed: () => _run(widget.onNewWorkspace!),
          ),
        ),
    ];
  }

  Widget _row(SwarmWorkspace current, MenuController menu) => Padding(
    padding: const EdgeInsets.only(bottom: 2),
    child: Material(
      color: menu.isOpen ? grid.AppSurface.selectedFill : Colors.transparent,
      borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
      clipBehavior: Clip.antiAlias,
      child: Semantics(
        button: true,
        label: 'Workspace: ${current.name}',
        child: InkWell(
          key: const ValueKey('super-workspace-menu'),
          focusNode: _focus,
          onTap: () {
            if (menu.isOpen) {
              menu.close();
            } else {
              menu.open();
            }
          },
          hoverColor: grid.AppSurface.hoverFill,
          focusColor: grid.AppSurface.hoverFill,
          borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 36),
            child: Row(
              children: [
                SizedBox(width: SuperTabSectionHeading.indentFor(0)),
                SizedBox(
                  width: SuperTabSectionHeading.actionWidth,
                  child: Icon(
                    AppIcons.layers,
                    size: AppIcons.inlineSize,
                    color: DesktopChrome.foreground,
                  ),
                ),
                Expanded(
                  child: Text(
                    current.name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: DesktopChrome.control(medium: true),
                  ),
                ),
                Padding(
                  padding: const EdgeInsets.only(right: 10),
                  child: Icon(
                    AppIcons.chevronDown,
                    size: AppIcons.inlineSize,
                    color: DesktopChrome.muted,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    ),
  );

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.workspaces,
    builder: (context, _) {
      grid.AppTheme.watch(context);
      final current = widget.workspaces.current(widget.tabId);
      if (!widget.workspaces.showsMenu || current == null) {
        return const SizedBox.shrink();
      }
      return LayoutBuilder(
        builder: (context, constraints) {
          final width = constraints.maxWidth.clamp(240.0, 360.0);
          return MenuAnchor(
            controller: _menu,
            childFocusNode: _focus,
            consumeOutsideTap: true,
            alignmentOffset: const Offset(0, grid.AppControl.menuGap),
            // As tall as the window allows, so a few Workspaces need no
            // scrolling to reach the actions at the end.
            style: grid.AppMenu.style(
              minWidth: width,
              maxWidth: width,
              maxHeight: (MediaQuery.sizeOf(context).height - 96).clamp(
                240.0,
                720.0,
              ),
            ),
            onOpen: () => unawaited(widget.workspaces.refresh()),
            menuChildren: _menuChildren(current, width),
            builder: (context, menu, _) => _row(current, menu),
          );
        },
      );
    },
  );
}
