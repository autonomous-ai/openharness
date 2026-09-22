import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../state/app_state.dart';
import '../terminal/terminal_session.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../theme/app_theme.dart';
import 'agent_drag.dart';
import 'engine_identity.dart';
import 'pane_header_actions.dart';
import 'rename_agent_dialog.dart';
import 'terminal_pane_badges.dart';

/// Horizontal inset shared by the header strip and the Find row that replaces
/// it, so the two line up when Find swaps in.
const double stripPadding = 14;

typedef TerminalNotice = ({String label, String detail, IconData icon});

class TerminalPaneHeader extends StatelessWidget {
  final AppNotifier notifier;
  final TerminalSession session;
  final TerminalNotice? notice;
  final bool readOnly;
  final VoidCallback? onClose;

  /// Ends the agent (with a confirmation), as the rail's row menu does. Null
  /// where the pane cannot name a live agent to end.
  final VoidCallback? onDelete;
  final bool compact;
  final VoidCallback? onToggleZoom;
  final bool zoomed;
  final VoidCallback? onToggleComposer;
  final bool composerVisible;

  /// This strip's drag gesture, or null when there is nothing to drag.
  ///
  /// Null with a SINGLE pane, and then the strip is inert on purpose: there is
  /// no other tile to trade places with, so a drag would have no meaning to
  /// give it. It used to move the WINDOW here (window_manager's
  /// DragToMoveArea, left over from hiding the title bar) — but once AppKit's
  /// `startDragging` takes a gesture it keeps it, so the two meanings cannot
  /// share one drag. The window is moved from HarnessTopBar now.
  final PaneDragHandle? paneDrag;

  const TerminalPaneHeader({
    super.key,
    required this.notifier,
    required this.session,
    this.notice,
    this.readOnly = false,
    this.onClose,
    this.onDelete,
    this.compact = false,
    this.onToggleZoom,
    this.zoomed = false,
    this.paneDrag,
    this.onToggleComposer,
    this.composerVisible = false,
  });

  @override
  Widget build(BuildContext context) {
    // A WATCHER renders the terminal without holding it (see [TerminalSession.watching]), and its
    // status is `controlling` — so every switch below has to ask about it FIRST, or it reads as a
    // pane that takes typing when it does not.
    final watching = session.watching;
    final color = watching
        ? AppColors.warning
        : switch (session.status) {
            TerminalSessionStatus.controlling => AppColors.success,
            TerminalSessionStatus.opening ||
            TerminalSessionStatus.resyncing => AppColors.warning,
            TerminalSessionStatus.takenOver => AppColors.warning,
            TerminalSessionStatus.error => AppColors.danger,
            TerminalSessionStatus.closed => AppColors.mutedStrong,
          };
    final profile = notifier
        .stateOf(session.machineId)
        ?.agents
        .where((agent) => agent.id == session.agentId)
        .firstOrNull
        ?.codexHome;
    final status =
        notice ??
        (watching
            ? (
                label: 'Take control',
                icon: Icons.lock_outline,
                detail: 'Read only: another app controls this terminal. Take control moves input ownership to this app.',
              )
            : null) ??
        switch (session.status) {
          TerminalSessionStatus.controlling => null,
          TerminalSessionStatus.opening => (
            label: 'Connecting',
            icon: Icons.sync,
            detail:
                'Connecting to this terminal. Retained output is read only.',
          ),
          TerminalSessionStatus.resyncing => (
            label: 'Restoring',
            icon: Icons.sync,
            detail: 'Restoring this terminal. Retained output is read only.',
          ),
          TerminalSessionStatus.takenOver => (
            label: 'Take control',
            icon: Icons.lock_outline,
            detail:
                'Read only: ${session.takenOverBy?.name ?? 'another app'} controls this terminal. Take control moves input ownership to this app.',
          ),
          TerminalSessionStatus.error || TerminalSessionStatus.closed => (
            label: 'Reconnect',
            icon: Icons.refresh,
            detail:
                session.errorMessage ??
                session.errorCode ??
                'This stream is closed. Retained output is read only.',
          ),
        };
    final canReconnect =
        notice == null &&
        !readOnly &&
        (watching ||
            session.status == TerminalSessionStatus.error ||
            session.status == TerminalSessionStatus.closed ||
            session.status == TerminalSessionStatus.takenOver);
    final machine = notifier.stateOf(session.machineId);
    final agent = machine?.agents
        .where((a) => a.id == session.agentId)
        .firstOrNull;
    final project = agent == null ? null : machine?.projectOf(agent);
    final machineName = machine?.machine.displayName ?? session.machineId;
    final folder = project?.folder;
    final branch = project?.branchLabel;
    final identityDetail = [
      session.agentName,
      machineName,
      if (project != null) project.cwd,
      if (branch != null) 'Branch: $branch',
      if (profile != null) 'Codex profile: $profile',
      'Double-click to rename',
    ].join('\n');
    final remoteComposer = machine != null && !machine.isLocalMachine
        ? onToggleComposer
        : null;
    final actionsWidth = remoteComposer == null ? 88.0 : 118.0;
    final details = [?folder, ?branch, machineName];
    final branchIndex = branch == null ? null : (folder == null ? 0 : 1);
    final strip = PaneHeaderHover(
      child: SizedBox(
        height: compact ? 38 : 46,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: stripPadding),
          child: LayoutBuilder(
            builder: (context, constraints) => Row(
              children: [
                EngineMark(engine: session.engineId, size: 17),
                const SizedBox(width: 10),
                Expanded(
                  child: Tooltip(
                    message: identityDetail,
                    waitDuration: const Duration(milliseconds: 700),
                    child: GestureDetector(
                      behavior: HitTestBehavior.opaque,
                      onDoubleTap: () => unawaited(
                        showAgentRenameDialog(
                          context,
                          notifier,
                          session.machineId,
                          session.agentId,
                          session.agentName,
                        ),
                      ),
                      child: Text(
                        session.agentName,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          color: AppColors.text,
                          fontFamily: AppFonts.sans,
                          fontSize: 13,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                if (status != null)
                  ConstrainedBox(
                    constraints: BoxConstraints(
                      maxWidth: math.max(
                        0,
                        math.min(
                          constraints.maxWidth * .3,
                          constraints.maxWidth - actionsWidth - 110,
                        ),
                      ),
                    ),
                    child: Align(
                      alignment: Alignment.centerRight,
                      child: Tooltip(
                        message: status.detail,
                        child: TextButton(
                          onPressed: canReconnect
                              // Opening it again is the claim — see
                              // [AppNotifier.selectAgent].
                              ? () => notifier.selectAgent(
                                  session.machineId,
                                  session.agentId,
                                )
                              : null,
                          style: TextButton.styleFrom(
                            foregroundColor: color,
                            disabledForegroundColor: AppColors.textSoft,
                            minimumSize: Size.zero,
                            tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                            padding: const EdgeInsets.symmetric(
                              horizontal: 6,
                              vertical: 4,
                            ),
                          ),
                          child: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Icon(status.icon, size: 14),
                              const SizedBox(width: 6),
                              Flexible(
                                child: Text(
                                  status.label,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: const TextStyle(fontSize: 11),
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                    ),
                  )
                else if (!compact)
                  Padding(
                    padding: const EdgeInsets.all(4),
                    child: Icon(Icons.circle, size: 8, color: color),
                  ),
                // Which of the three paths carries this pane's bytes. Absent for a local machine's own
                // terminal, which has no such distinction and so gets no badge.
                //
                // The wire word and the word a person reads differ for the middle state, deliberately:
                // the CLI sends 'turn' (it is a TURN allocation) but both middle and last are relays to
                // a reader, so they read as "relay" and "ws". 'relay' on the wire kept its original
                // meaning — the backend WebSocket — so an older CLI is never mislabelled.
                if (!compact && session.linkMode != null)
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 2),
                    child: LinkModeMark(mode: session.linkMode!),
                  ),
                ConstrainedBox(
                  constraints: BoxConstraints(
                    maxWidth: math.max(
                      actionsWidth,
                      constraints.maxWidth * (status == null ? .55 : .3),
                    ),
                  ),
                  child: PaneHeaderActions(
                    name: session.agentName,
                    zoomed: zoomed,
                    onZoom: onToggleZoom,
                    onDelete: onDelete,
                    onClose: onClose,
                    onToggleComposer: remoteComposer,
                    composerVisible: composerVisible,
                    details: Tooltip(
                      message: [
                        if (project != null) project.cwd,
                        if (branch != null) 'Branch: $branch',
                        machineName,
                      ].join('\n'),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          for (var i = 0; i < details.length; i++) ...[
                            if (i > 0)
                              Text(
                                '  •  ',
                                style: TextStyle(
                                  fontSize: 10,
                                  color: AppColors.mutedStrong,
                                ),
                              ),
                            Flexible(
                              child: Row(
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  if (i == branchIndex) ...[
                                    Icon(
                                      LucideIcons.gitBranch300,
                                      size: 12,
                                      color: AppColors.mutedStrong,
                                    ),
                                    const SizedBox(width: 4),
                                  ],
                                  Flexible(
                                    child: Text(
                                      details[i],
                                      maxLines: 1,
                                      overflow: TextOverflow.ellipsis,
                                      style: TextStyle(
                                        fontFamily: AppFonts.sans,
                                        fontSize: 12,
                                        color: AppColors.mutedStrong,
                                      ),
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          ],
                        ],
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
    final handle = paneDrag;
    if (handle == null) return strip;

    return Draggable<PaneDragRef>(
      data: handle.ref,
      // The grip is kept where the hand took it, so the ghost stays under the
      // cursor at the same spot on the header it was picked up by.
      dragAnchorStrategy: childDragAnchorStrategy,
      onDragStarted: () => paneDragging.value = handle.ref,
      onDragEnd: (_) => paneDragging.value = null,
      onDraggableCanceled: (_, _) => paneDragging.value = null,
      feedback: _PaneGhost(session: session, size: handle.size, header: strip),

      // The header itself does NOT change — the whole tile fades instead, in
      // _PaneCell, so what dims is the thing that is moving rather than one
      // strip of it.
      child: strip,
    );
  }
}

/// The whole tile, carried under the cursor.
///
/// ⚠️ THIS IS DRAWN, NOT PHOTOGRAPHED, AND THE PHOTOGRAPH IS WHY. The obvious
/// way to carry "the whole pane" is RepaintBoundary.toImage() on press — and it
/// FROZE THE APP. That call is a GPU readback on the raster thread, and the
/// raster thread in this app is never idle: every pane holds a terminal that
/// repaints on its own, so asking it to stop and hand a surface back on every
/// pointer-down deadlocked the window. It is not a tuning problem; there is
/// nothing to tune down to.
///
/// So the ghost is built from what is already known — the pane's measured size
/// and its own header — and the body is a plain surface rather than a copy of
/// the scrollback. It reads as the tile because it is tile-SHAPED and carries
/// the tile's name, which is what the eye is following.
///
/// See-through on purpose: a full-size opaque copy sits exactly over the tile
/// being aimed at and hides the "Swap with this pane" highlight that says the
/// drop will land.
class _PaneGhost extends StatelessWidget {
  const _PaneGhost({
    required this.session,
    required this.size,
    required this.header,
  });

  final TerminalSession session;

  /// The tile's size, handed down from the grid's LayoutBuilder.
  final Size size;

  final Widget header;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final tile = size;
    return Material(
      color: Colors.transparent,
      child: Opacity(
        opacity: 0.75,
        child: Container(
          width: tile.width,
          height: tile.height,
          decoration: BoxDecoration(
            color: grid.AppPalette.windowBg,
            border: Border.all(color: AppColors.accent, width: 1.5),
            boxShadow: [
              BoxShadow(
                color: Colors.black.withValues(alpha: 0.45),
                blurRadius: 24,
                offset: const Offset(0, 10),
              ),
            ],
          ),
          child: Column(
            children: [
              header,
              Divider(height: 1, color: AppColors.border),
              Expanded(
                child: Center(
                  child: Text(
                    session.agentName,
                    style: TextStyle(
                      color: AppColors.mutedStrong,
                      fontFamily: AppFonts.sans,
                      fontSize: 15,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
