import 'dart:async';

import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart';
import '../shared/widgets/skeleton.dart';
import '../state/app_state.dart';
import '../state/session_tail.dart';
import '../terminal/terminal_text.dart';
import '../widgets/session_tail_view.dart';

/// A stopped agent's saved conversation, without reopening its engine. The
/// ordinary terminal renderer owns any retained buffer and takes precedence.
/// History is an account-owned machine capability, not a Swarm membership grant.
class SuperTabSavedSession extends StatefulWidget {
  const SuperTabSavedSession({
    super.key,
    required this.app,
    required this.machineId,
    required this.harnessId,
    this.onResume,
  });

  final AppNotifier app;
  final String machineId, harnessId;
  final VoidCallback? onResume;

  @override
  State<SuperTabSavedSession> createState() => _SuperTabSavedSessionState();
}

class _SuperTabSavedSessionState extends State<SuperTabSavedSession> {
  final _scroll = ScrollController();
  (String, SessionTailKey)? _identity;
  SessionTails? _tails;

  (String, SessionTailKey)? _authorizedIdentity() {
    final account = widget.app.currentUser?.id;
    final machine = widget.app.stateOf(widget.machineId);
    final agent = machine?.agents
        .where((a) => a.id == widget.harnessId)
        .firstOrNull;
    final session = agent?.sessionId;
    if (account == null ||
        machine == null ||
        machine.belongsToOtherAccount ||
        !widget.app.searchableMachineIds.contains(widget.machineId) ||
        agent?.isStopped != true ||
        session == null ||
        session.isEmpty) {
      return null;
    }
    return (account, (machineId: widget.machineId, sessionId: session));
  }

  @override
  void initState() {
    super.initState();
    widget.app.addListener(_changed);
    _sync();
  }

  @override
  void didUpdateWidget(SuperTabSavedSession oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.app != widget.app) {
      oldWidget.app.removeListener(_changed);
      widget.app.addListener(_changed);
      _tails?.dispose();
      _tails = null;
      _identity = null;
    }
    _sync();
  }

  void _sync() {
    final identity = _authorizedIdentity();
    if (identity == _identity) return;
    _tails?.dispose();
    _tails = null;
    _identity = identity;
    if (identity == null) return;
    // Keep this cache scoped to the exact account and saved session. A late
    // history reply cannot repopulate a cache after sign-out or revoked access.
    final tails = SessionTails((machineId, sessionId, {beforeTurn}) async {
      if (!mounted || _authorizedIdentity() != identity) return null;
      final reply = await widget.app.readSessionTail(
        machineId,
        sessionId,
        beforeTurn: beforeTurn,
      );
      return mounted && _authorizedIdentity() == identity ? reply : null;
    }, capacity: 1);
    _tails = tails;
    tails.addListener(_redraw);
    unawaited(tails.want(identity.$2));
  }

  void _changed() {
    _sync();
    _redraw();
  }

  void _redraw() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    widget.app.removeListener(_changed);
    _tails?.dispose();
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    TerminalFontScope.watch(context);
    final identity = _authorizedIdentity();
    final tails = identity == _identity ? _tails : null;
    final key = identity?.$2;
    final tail = key == null ? null : tails?.read(key);
    final loading =
        tails != null && key != null && tail == null && !tails.unavailable(key);
    final opening = widget.app.pendingAgentRestart(
      widget.machineId,
      widget.harnessId,
    );
    final body = terminalContentStyle(color: AppPalette.textPrimary);
    final muted = terminalContentStyle(color: AppPalette.textSecondary);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(14, 8, 10, 8),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  opening?.busy == true
                      ? 'Resuming…'
                      : tail != null && tail.rows.isNotEmpty
                      ? 'Saved conversation'
                      : 'Stopped',
                  style: AppType.caption(color: AppPalette.textSecondary),
                ),
              ),
              if (widget.onResume != null)
                TextButton(
                  onPressed: opening?.busy == true ? null : widget.onResume,
                  child: const Text('Resume'),
                ),
            ],
          ),
        ),
        Expanded(
          child:
              tail != null &&
                  tail.rows.isNotEmpty &&
                  tails != null &&
                  key != null
              ? SelectionArea(
                  child: SessionTailView(
                    key: ValueKey(identity),
                    tail: tail,
                    tails: tails,
                    tailKey: key,
                    controller: _scroll,
                    words: const [],
                    body: body,
                    muted: muted,
                    gap: terminalCellSizeOf(context).height,
                    padding: const EdgeInsets.fromLTRB(14, 4, 14, 16),
                  ),
                )
              : loading
              ? Padding(
                  padding: const EdgeInsets.all(14),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      SkeletonText(style: body, widthFactor: .65),
                      const SizedBox(height: 12),
                      SkeletonText(style: body, widthFactor: .9),
                      SkeletonText(style: body, widthFactor: .7),
                    ],
                  ),
                )
              : Center(
                  child: Padding(
                    padding: const EdgeInsets.all(20),
                    child: Text(
                      'Saved conversation is unavailable on this machine.',
                      textAlign: TextAlign.center,
                      style: AppType.body(color: AppPalette.textSecondary),
                    ),
                  ),
                ),
        ),
      ],
    );
  }
}
