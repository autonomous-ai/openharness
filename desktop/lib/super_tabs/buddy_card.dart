import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../core/models.dart' show Agent;
import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../state/app_state.dart';
import '../state/swarm_navigation.dart' show externalEngineName;
import '../widgets/desktop_chrome.dart';
import 'buddies.dart'
    show buddyMachineName, confirmRemoveBuddy, showRenameBuddy;
import 'buddy_restart.dart';
import 'controller.dart';
import 'identity.dart';
import 'launch_flags_field.dart';

/// The Buddy pane's name on the Board, as a button: the Buddy's avatar, its
/// [label] and a chevron. It owns the card it opens under itself (spec
/// 2026-11-06-board-buddy-card): status, machine, engine, the launch flags as
/// chips, and Restart, Rename and Remove. Esc, a click outside or a second
/// click closes it.
class BuddyCardButton extends StatefulWidget {
  const BuddyCardButton({
    super.key,
    required this.controller,
    required this.projectId,
    this.app,
    required this.label,
  });

  final SuperTabController controller;

  /// The Buddy chat's project, the one the old menu passed to Restart Buddy.
  final String projectId;
  final AppNotifier? app;
  final String label;

  static const cardWidth = 340.0;

  @override
  State<BuddyCardButton> createState() => _BuddyCardButtonState();
}

class _BuddyCardButtonState extends State<BuddyCardButton> {
  static const _gap = grid.AppDesktop.menuInset;
  static const _inset = grid.AppDesktop.groupGap;

  /// Rename and Remove fit beside Restart in the card's width.
  static final _compact = TextButton.styleFrom(
    minimumSize: const Size(0, grid.AppControl.height),
    padding: const EdgeInsets.symmetric(horizontal: grid.AppDesktop.controlGap),
  );

  final _fieldKey = GlobalKey<LaunchFlagsFieldState>();
  final _portal = OverlayPortalController();
  final _link = LayerLink();
  final _buttonFocus = FocusNode(debugLabel: 'Buddy card button');
  final _cardFocus = FocusNode(debugLabel: 'Buddy card');

  /// How far left the card sits so it stays inside the window.
  var _shift = 0.0;
  List<String> _words = const [];
  String? _marked, _message;
  var _busy = false, _flagsFocused = false, _warning = false;

  SuperTabController get c => widget.controller;
  AppNotifier? get app => widget.app;

  @override
  void dispose() {
    _buttonFocus.dispose();
    _cardFocus.dispose();
    super.dispose();
  }

  Agent? get _agent => buddyMachineAgent(c, widget.projectId, app);

  void _open() {
    final box = context.findRenderObject() as RenderBox?;
    final overlay =
        Overlay.maybeOf(context)?.context.findRenderObject() as RenderBox?;
    _shift = 0;
    if (box != null && overlay != null && box.hasSize) {
      final left = box.localToGlobal(Offset.zero, ancestor: overlay).dx;
      final over = left + BuddyCardButton.cardWidth + _gap - overlay.size.width;
      if (over > 0) _shift = over;
    }
    // A restart still in flight keeps its words, status and message across a
    // close and reopen, so a second press cannot send a second restart.
    setState(() {
      _flagsFocused = false;
      if (_busy) return;
      _words = [...?_agent?.launchArgs];
      _marked = _message = null;
      _warning = false;
    });
    _portal.show();
    // The card takes the focus from the button so Esc and Tab act in it.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && _portal.isShowing) _cardFocus.requestFocus();
    });
  }

  void _close() {
    if (!_portal.isShowing) return;
    _portal.hide();
    _buttonFocus.requestFocus();
  }

  KeyEventResult _key(FocusNode _, KeyEvent event) {
    if (event is KeyDownEvent &&
        event.logicalKey == LogicalKeyboardKey.escape &&
        _portal.isShowing) {
      _close();
      return KeyEventResult.handled;
    }
    return KeyEventResult.ignored;
  }

  Future<void> _restart(Agent agent) async {
    final app = this.app;
    if (_busy || app == null) return;
    // Text typed but not yet a chip is part of the flags.
    final field = _fieldKey.currentState;
    final words = field == null ? _words : field.takePending();
    if (words == null) {
      setState(() {
        _marked = null;
        _warning = false;
        _message = 'Close the quote in the launch flags, or remove it.';
      });
      return;
    }
    setState(() {
      _busy = true;
      _message = _marked = null;
      _words = words;
    });
    final result = await restartBuddyWithFlags(
      c,
      widget.projectId,
      app,
      text: launchArgsLine(words),
      saved: launchArgsLine(agent.launchArgs),
    );
    // The card may have been closed meanwhile: the result is kept for the
    // next open.
    if (!mounted) return;
    if (result.outcome == BuddyRestartOutcome.done) {
      setState(() => _busy = false);
      _close();
      return;
    }
    setState(() {
      _busy = false;
      _message = result.message;
      _warning = result.outcome == BuddyRestartOutcome.ignored;
      _marked = result.outcome == BuddyRestartOutcome.refused
          ? _named(result.message)
          : null;
    });
  }

  /// The chip the daemon's [detail] starts with, compared before any `=`.
  String? _named(String? detail) {
    final first = detail?.trim().split(RegExp(r'\s')).first;
    if (first == null || first.isEmpty) return null;
    String head(String word) => word.split('=').first;
    return _words.where((w) => head(w) == head(first)).firstOrNull;
  }

  void _then(Future<void> Function() action) {
    _close();
    unawaited(action());
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final listenable = Listenable.merge([c, ?app]);
    return CompositedTransformTarget(
      link: _link,
      child: Focus(
        canRequestFocus: false,
        skipTraversal: true,
        onKeyEvent: _key,
        child: ListenableBuilder(
          listenable: listenable,
          builder: (context, _) => OverlayPortal(
            controller: _portal,
            overlayChildBuilder: (_) => _overlay(context),
            child: _button(context),
          ),
        ),
      ),
    );
  }

  Widget _button(BuildContext context) {
    final buddy = readerBuddy(c, widget.projectId);
    return Semantics(
      button: true,
      label: '${widget.label}, Buddy options',
      excludeSemantics: true,
      child: InkWell(
        key: const ValueKey('super-board-buddy-button'),
        focusNode: _buttonFocus,
        borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
        onTap: () => _portal.isShowing ? _close() : _open(),
        child: Padding(
          padding: const EdgeInsets.all(_gap),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              _avatar(buddy, AppIcons.inlineSize + _gap),
              const SizedBox(width: _gap),
              Flexible(
                child: Text(
                  widget.label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: DesktopChrome.control().copyWith(
                    fontWeight: grid.AppFont.semibold,
                  ),
                ),
              ),
              const SizedBox(width: _gap),
              Icon(
                AppIcons.chevronDown,
                size: AppIcons.inlineSize,
                color: DesktopChrome.muted,
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _avatar(dynamic buddy, double size) => buddy == null
      ? SuperTabAvatar(
          identity: 'buddy:${widget.projectId}',
          name: widget.label,
          size: size,
          face: true,
        )
      : SuperTabAvatar.agent(
          buddy,
          name: widget.label,
          size: size,
          engineBadge: false,
        );

  Widget _overlay(BuildContext context) => Positioned.fill(
    child: Stack(
      children: [
        Positioned.fill(
          child: GestureDetector(
            key: const ValueKey('super-buddy-card-barrier'),
            behavior: HitTestBehavior.opaque,
            onTap: _close,
          ),
        ),
        CompositedTransformFollower(
          link: _link,
          showWhenUnlinked: false,
          targetAnchor: Alignment.bottomLeft,
          followerAnchor: Alignment.topLeft,
          offset: Offset(-_shift, _gap),
          child: Align(
            alignment: Alignment.topLeft,
            child: Focus(
              focusNode: _cardFocus,
              onKeyEvent: _key,
              child: FocusTraversalGroup(child: _card(context)),
            ),
          ),
        ),
      ],
    ),
  );

  Widget _card(BuildContext context) {
    final highContrast = MediaQuery.highContrastOf(context);
    final buddy = readerBuddy(c, widget.projectId);
    final agent = _agent;
    final editable = c.canWrite && !c.saving && !c.hasPendingAction;
    final canRestart =
        editable &&
        agent != null &&
        buddy != null &&
        buddy.harnessId.isNotEmpty &&
        buddy.machineId.isNotEmpty;
    final live = agent != null && !agent.isStopped;
    final machine = buddy == null
        ? 'its machine'
        : buddyMachineName(c, buddy.machineId, app: app);
    final engine = externalEngineName(agent?.engine ?? buddy?.engine ?? '');
    final dot = _busy
        ? grid.AppPalette.warn
        : live
        ? grid.AppPalette.online
        : DesktopChrome.hint;
    final status = _busy
        ? 'Restarting…'
        : live
        ? 'Running'
        : 'Stopped';
    final muted = DesktopChrome.control(color: DesktopChrome.muted);
    Widget fact(String label, String value) => Padding(
      padding: const EdgeInsets.only(top: _gap),
      child: Row(
        children: [
          Text(label, style: muted),
          const SizedBox(width: _gap),
          Flexible(
            child: Text(
              value,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: DesktopChrome.control(medium: true),
            ),
          ),
        ],
      ),
    );
    return SizedBox(
      width: BuddyCardButton.cardWidth,
      child: DecoratedBox(
        key: const ValueKey('super-buddy-card'),
        decoration: BoxDecoration(
          color: grid.AppMenu.fill,
          borderRadius: BorderRadius.circular(grid.AppMenu.panelRadius),
          border: Border.all(
            color: highContrast
                ? DesktopChrome.foreground.withValues(alpha: .55)
                : grid.AppMenu.rim,
          ),
          boxShadow: grid.AppSurface.shadow,
        ),
        child: Material(
          type: MaterialType.transparency,
          child: Padding(
            padding: const EdgeInsets.all(_inset),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  children: [
                    _avatar(buddy, grid.AppControl.heightField),
                    const SizedBox(width: grid.AppDesktop.controlGap),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            widget.label,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: DesktopChrome.control().copyWith(
                              fontWeight: grid.AppFont.semibold,
                            ),
                          ),
                          Row(
                            children: [
                              DecoratedBox(
                                decoration: BoxDecoration(
                                  color: dot,
                                  shape: BoxShape.circle,
                                ),
                                child: const SizedBox.square(dimension: _gap),
                              ),
                              const SizedBox(width: _gap),
                              Text(status, style: DesktopChrome.metadata()),
                            ],
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
                fact('Runs on', machine),
                if (canRestart) ..._flags(agent, engine, machine),
                if (_message case final message?) ...[
                  const SizedBox(height: _gap),
                  Text(
                    message,
                    key: const ValueKey('super-buddy-card-message'),
                    style: DesktopChrome.control(
                      color: _warning
                          ? grid.AppPalette.warn
                          : grid.AppPalette.dangerFill,
                    ),
                  ),
                ],
                const SizedBox(height: _inset),
                _buttons(agent, canRestart: canRestart, editable: editable),
              ],
            ),
          ),
        ),
      ),
    );
  }

  List<Widget> _flags(Agent agent, String engine, String machine) => [
    const SizedBox(height: _inset),
    Text('Launch flags', style: DesktopChrome.control(medium: true)),
    const SizedBox(height: _gap),
    LaunchFlagsField(
      key: _fieldKey,
      words: _words,
      readOnly: _busy,
      marked: _marked,
      onChanged: (words) => setState(() {
        _words = words;
        _marked = null;
      }),
      onFocusChanged: (focused) {
        if (mounted) setState(() => _flagsFocused = focused);
      },
    ),
    const SizedBox(height: _gap),
    Text(
      _flagsFocused
          ? 'Press Enter or Space to add · ⌫ removes the last flag'
          : "Added to $engine's command line each time this Buddy starts on "
                '$machine. Your Buddy runs with full permissions. Don\'t put '
                'secrets here: other people on that computer can see them.',
      style: DesktopChrome.metadata(),
    ),
  ];

  Widget _buttons(
    Agent? agent, {
    required bool canRestart,
    required bool editable,
  }) {
    final stopped = agent?.isStopped ?? true;
    return Row(
      children: [
        // Restart and Rename on the left; Remove is pushed to the right edge.
        Expanded(
          child: Wrap(
            spacing: _gap,
            runSpacing: _gap,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              if (canRestart)
                FilledButton.icon(
                  key: const ValueKey('super-buddy-card-restart'),
                  onPressed: _busy ? null : () => unawaited(_restart(agent!)),
                  icon: _busy
                      ? const SizedBox.square(
                          dimension: AppIcons.inlineSize,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(
                          AppIcons.rotateCw,
                          size: AppIcons.inlineSize,
                        ),
                  label: Text(
                    _busy
                        ? 'Restarting'
                        : stopped
                        ? 'Start'
                        : 'Restart',
                  ),
                ),
              TextButton(
                key: const ValueKey('super-buddy-card-rename'),
                style: _compact,
                onPressed: editable && !_busy
                    ? () => _then(
                        () => showRenameBuddy(context, c, widget.projectId),
                      )
                    : null,
                child: const Text('Rename'),
              ),
            ],
          ),
        ),
        const SizedBox(width: _gap),
        TextButton(
          key: const ValueKey('super-buddy-card-remove'),
          style: _compact.copyWith(
            foregroundColor: WidgetStatePropertyAll(grid.AppPalette.dangerFill),
          ),
          onPressed:
              editable && !_busy && readerBuddy(c, widget.projectId) != null
              ? () => _then(
                  () => confirmRemoveBuddy(context, c, widget.projectId),
                )
              : null,
          child: const Text('Remove'),
        ),
      ],
    );
  }
}
