import 'dart:async';

import 'package:clock/clock.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../widgets/desktop_chrome.dart';
import '../widgets/engine_identity.dart';
import 'machine_icon.dart';
import 'profile_model.dart';
import 'swarm_type.dart';
import 'zone_time.dart';

/// What the card over a chat name or avatar shows (Huy, 11-04, like Slack's):
/// a person's name, status and local time; an agent's name, engine and model,
/// machine and task. A fact nobody knows is left out, never guessed.
sealed class SuperTabIdentityFacts {
  const SuperTabIdentityFacts(this.name);
  final String name;
}

class SuperTabPersonFacts extends SuperTabIdentityFacts {
  const SuperTabPersonFacts(super.name, {this.status, this.timeZone});

  /// Their status while it lasts.
  final SuperTabPersonStatus? status;

  /// Their zone's IANA name, for the time where they are; null until their
  /// app has told the Swarm.
  final String? timeZone;
}

class SuperTabAgentFacts extends SuperTabIdentityFacts {
  const SuperTabAgentFacts(
    super.name, {
    this.engine,
    this.model,
    this.machine,
    this.deviceType,
    this.task,
    this.onOpenTask,
  });

  /// The engine's id (`claude`), for its mark and its name.
  final String? engine;

  /// The model as people know it ("Opus 5.5").
  final String? model;
  final String? machine, deviceType;

  /// What it is doing with its task, the task's number and title in it
  /// ("Working on #2605 Chat: a card…").
  final String? task;

  /// Opens the task's chat.
  final VoidCallback? onOpenTask;
}

/// The card itself: the shared popover surface, flat rows, no avatar (the
/// row beside it has one).
class SuperTabIdentityCard extends StatefulWidget {
  const SuperTabIdentityCard({super.key, required this.facts});

  final SuperTabIdentityFacts facts;

  static const minWidth = 220.0, maxWidth = 320.0;

  @override
  State<SuperTabIdentityCard> createState() => _SuperTabIdentityCardState();
}

class _SuperTabIdentityCardState extends State<SuperTabIdentityCard> {
  static const _inset = grid.AppDesktop.groupGap;
  static const _rowGap = grid.AppDesktop.menuInset;

  @override
  void initState() {
    super.initState();
    // The zone table is read the first time a card needs it; the card
    // gains its time line once it is in.
    if (widget.facts case SuperTabPersonFacts(timeZone: _?)
        when !superTabZonesLoaded) {
      superTabLoadZones().then((_) {
        if (mounted) setState(() {});
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final highContrast = MediaQuery.highContrastOf(context);
    final facts = widget.facts;
    final rows = <Widget>[
      Text(
        facts.name,
        key: const ValueKey('super-identity-card-name'),
        style: SwarmType.name(context),
        maxLines: 2,
        overflow: TextOverflow.ellipsis,
      ),
      ...switch (facts) {
        SuperTabPersonFacts(:final status, :final timeZone) => [
          if (status != null)
            _Line(
              leading: status.emoji == null
                  ? null
                  : Text(status.emoji!, style: DesktopChrome.text()),
              text: status.text,
            ),
          if (superTabTimeNow(timeZone, clock.now()) case final localTime?)
            _Line(
              key: const ValueKey('super-identity-card-time'),
              leading: Icon(
                AppIcons.clock,
                size: AppIcons.inlineSize,
                color: DesktopChrome.muted,
              ),
              text: '${localTime.format(context)} local time',
            ),
        ],
        SuperTabAgentFacts() => [
          if (_engineLine(facts) case final line?)
            _Line(
              leading: EngineMark(
                engine: facts.engine,
                size: AppIcons.inlineSize,
              ),
              text: line,
            ),
          if (facts.machine case final machine?)
            _Line(
              leading: SuperTabMachineIcon(
                deviceType: facts.deviceType,
                color: DesktopChrome.muted,
              ),
              text: machine,
            ),
          if (facts.task case final task?)
            _TaskLine(text: task, onOpen: facts.onOpenTask),
        ],
      },
    ];
    return ConstrainedBox(
      constraints: const BoxConstraints(
        minWidth: SuperTabIdentityCard.minWidth,
        maxWidth: SuperTabIdentityCard.maxWidth,
      ),
      child: IntrinsicWidth(
        child: DecoratedBox(
          key: const ValueKey('super-identity-card'),
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
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(grid.AppMenu.panelRadius),
            ),
            clipBehavior: Clip.antiAlias,
            child: Padding(
              padding: const EdgeInsets.all(_inset),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  for (final (i, row) in rows.indexed) ...[
                    if (i > 0) const SizedBox(height: _rowGap),
                    row,
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  static String? _engineLine(SuperTabAgentFacts facts) {
    final engine = facts.engine?.trim().isNotEmpty == true
        ? engineIdentity(facts.engine).label
        : null;
    final parts = [?engine, ?facts.model];
    return parts.isEmpty ? null : parts.join(' ');
  }
}

/// One fact: an optional mark, then its words.
class _Line extends StatelessWidget {
  const _Line({super.key, this.leading, required this.text});

  final Widget? leading;
  final String text;

  @override
  Widget build(BuildContext context) => Row(
    children: [
      if (leading case final mark?) ...[
        SizedBox.square(dimension: AppIcons.inlineSize, child: mark),
        const SizedBox(width: grid.AppDesktop.controlGap),
      ],
      Flexible(
        child: Text(
          text,
          style: DesktopChrome.text(),
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
        ),
      ),
    ],
  );
}

/// The agent's task, as a link to its chat: a hand cursor, the hover fill
/// and an underline, and a chevron, so its colour is not the only sign.
class _TaskLine extends StatefulWidget {
  const _TaskLine({required this.text, this.onOpen});

  final String text;
  final VoidCallback? onOpen;

  @override
  State<_TaskLine> createState() => _TaskLineState();
}

class _TaskLineState extends State<_TaskLine> {
  var _hovered = false, _focused = false;

  @override
  Widget build(BuildContext context) {
    final active = _hovered || _focused;
    final style = DesktopChrome.text(color: grid.AppPalette.accentOnSurface);
    return Semantics(
      link: true,
      label: '${widget.text}, open its chat',
      excludeSemantics: true,
      child: InkWell(
        key: const ValueKey('super-identity-card-task'),
        onTap: widget.onOpen,
        onHover: (hovered) => setState(() => _hovered = hovered),
        onFocusChange: (focused) => setState(() => _focused = focused),
        mouseCursor: SystemMouseCursors.click,
        borderRadius: BorderRadius.circular(grid.AppControl.menuRadius),
        hoverColor: Colors.transparent,
        focusColor: Colors.transparent,
        child: Ink(
          decoration: BoxDecoration(
            color: active ? grid.AppSurface.hoverFill : Colors.transparent,
            borderRadius: BorderRadius.circular(grid.AppControl.menuRadius),
            border: Border.all(
              color: _focused ? DesktopChrome.focusRing : Colors.transparent,
            ),
          ),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  widget.text,
                  style: active
                      ? style.copyWith(decoration: TextDecoration.underline)
                      : style,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              const SizedBox(width: grid.AppDesktop.controlGap),
              Icon(
                AppIcons.chevronRight,
                size: AppIcons.inlineSize,
                color: grid.AppPalette.accentOnSurface,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Shows [facts]'s card under [child], a chat name or avatar: after
/// [openDelay] of hover, at once when keyboard focus lands in [child], and
/// gone [closeDelay] after the pointer and the focus have left both [child]
/// and the card. Escape closes it and keeps the focus where it was. The card
/// follows its anchor as the chat scrolls, and opens above it when there is
/// no room below.
class SuperTabHoverCard extends StatefulWidget {
  const SuperTabHoverCard({
    super.key,
    required this.facts,
    required this.child,
  });

  /// Worked out when the card opens, so it shows what is true then.
  final SuperTabIdentityFacts Function() facts;
  final Widget child;

  static const openDelay = Duration(milliseconds: 500);
  static const closeDelay = Duration(milliseconds: 150);

  /// Room the card needs below its anchor before it opens above instead.
  static const _roomBelow = 200.0;
  static const _gap = grid.AppDesktop.menuInset;

  @override
  State<SuperTabHoverCard> createState() => _SuperTabHoverCardState();
}

class _SuperTabHoverCardState extends State<SuperTabHoverCard> {
  final _portal = OverlayPortalController();
  final _link = LayerLink();
  final _anchorFocus = FocusNode(
    debugLabel: 'Identity card anchor',
    canRequestFocus: false,
    skipTraversal: true,
  );
  final _cardFocus = FocusNode(
    debugLabel: 'Identity card',
    canRequestFocus: false,
    skipTraversal: true,
  );
  Timer? _openTimer, _closeTimer;
  var _overAnchor = false, _overCard = false, _above = false;

  /// Escape closed the card: the focus it sends back to the name does not
  /// open it again, until the focus has left the name.
  var _dismissed = false;
  SuperTabIdentityFacts? _facts;

  @override
  void initState() {
    super.initState();
    _anchorFocus.addListener(_focusMoved);
    _cardFocus.addListener(_focusMoved);
  }

  @override
  void dispose() {
    _openTimer?.cancel();
    _closeTimer?.cancel();
    _anchorFocus.dispose();
    _cardFocus.dispose();
    super.dispose();
  }

  bool get _focused => _anchorFocus.hasFocus || _cardFocus.hasFocus;

  void _focusMoved() {
    if (!mounted) return;
    if (_anchorFocus.hasFocus && !_portal.isShowing) {
      if (!_dismissed) _show();
    } else if (!_focused) {
      _dismissed = false;
      _hideSoon();
    }
  }

  void _enterAnchor() {
    _overAnchor = true;
    _closeTimer?.cancel();
    if (_portal.isShowing) return;
    unawaited(superTabLoadZones());
    _openTimer?.cancel();
    _openTimer = Timer(SuperTabHoverCard.openDelay, _show);
  }

  void _show() {
    _openTimer?.cancel();
    _closeTimer?.cancel();
    if (!mounted) return;
    final box = context.findRenderObject() as RenderBox?;
    final overlay =
        Overlay.maybeOf(context)?.context.findRenderObject() as RenderBox?;
    if (box != null && overlay != null && box.hasSize) {
      final bottom = box
          .localToGlobal(box.size.bottomLeft(Offset.zero), ancestor: overlay)
          .dy;
      _above = overlay.size.height - bottom < SuperTabHoverCard._roomBelow;
    }
    setState(() => _facts = widget.facts());
    _portal.show();
  }

  void _hideSoon() {
    _openTimer?.cancel();
    if (!_portal.isShowing) return;
    _closeTimer?.cancel();
    _closeTimer = Timer(SuperTabHoverCard.closeDelay, () {
      if (!mounted || _overAnchor || _overCard || _focused) return;
      _portal.hide();
    });
  }

  void _hideNow() {
    _openTimer?.cancel();
    _closeTimer?.cancel();
    _portal.hide();
  }

  /// Escape closes the card. While it is open, Tab on the name goes into
  /// the card (its own reading order would take the row's buttons beside the
  /// name first) and Shift-Tab in the card goes back to the name.
  KeyEventResult _onKey(FocusNode _, KeyEvent event) {
    if (event is! KeyDownEvent || !_portal.isShowing) {
      return KeyEventResult.ignored;
    }
    final inCard = _cardFocus.hasFocus;
    if (event.logicalKey == LogicalKeyboardKey.escape) {
      _dismissed = true;
      _hideNow();
      // Back to the name the card belongs to.
      if (inCard) _nameFocus?.requestFocus();
      return KeyEventResult.handled;
    }
    if (event.logicalKey != LogicalKeyboardKey.tab) {
      return KeyEventResult.ignored;
    }
    final back = HardwareKeyboard.instance.isShiftPressed;
    final target = switch ((inCard, back)) {
      (false, false) => _cardFocus.traversalDescendants.firstOrNull,
      (true, true) => _nameFocus,
      _ => null,
    };
    if (target == null) return KeyEventResult.ignored;
    target.requestFocus();
    return KeyEventResult.handled;
  }

  FocusNode? get _nameFocus => _anchorFocus.traversalDescendants.firstOrNull;

  @override
  Widget build(BuildContext context) => OverlayPortal(
    controller: _portal,
    overlayChildBuilder: (_) => CompositedTransformFollower(
      link: _link,
      showWhenUnlinked: false,
      targetAnchor: _above ? Alignment.topLeft : Alignment.bottomLeft,
      followerAnchor: _above ? Alignment.bottomLeft : Alignment.topLeft,
      offset: Offset(
        0,
        _above ? -SuperTabHoverCard._gap : SuperTabHoverCard._gap,
      ),
      child: Align(
        alignment: _above ? Alignment.bottomLeft : Alignment.topLeft,
        child: Focus(
          focusNode: _cardFocus,
          onKeyEvent: _onKey,
          child: FocusTraversalGroup(
            child: MouseRegion(
              onEnter: (_) {
                _overCard = true;
                _closeTimer?.cancel();
              },
              onExit: (_) {
                _overCard = false;
                _hideSoon();
              },
              child: switch (_facts) {
                final facts? => SuperTabIdentityCard(facts: facts),
                null => const SizedBox.shrink(),
              },
            ),
          ),
        ),
      ),
    ),
    child: CompositedTransformTarget(
      link: _link,
      child: Focus(
        focusNode: _anchorFocus,
        onKeyEvent: _onKey,
        child: MouseRegion(
          onEnter: (_) => _enterAnchor(),
          onExit: (_) {
            _overAnchor = false;
            _hideSoon();
          },
          child: widget.child,
        ),
      ),
    ),
  );
}
