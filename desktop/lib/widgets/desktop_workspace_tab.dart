import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter/services.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_menu.dart';
import '../state/workspace_chrome.dart';
import 'box_chrome.dart';
import 'desktop_chrome.dart';

/// The Flutter counterpart of the AppKit tab: a centered name/status group
/// and, at its trailing edge, the close action.
///
/// At rest the name and status have the whole tab; hovering reveals ×.
/// Holding Command replaces the status with the tab's shortcut, as before.
/// Agent Messages has nothing on a tab: traffic between its agents shows nothing,
/// since messages arrive when they arrive, and its on/off is Settings ▸
/// Experimental's. The 💬 that sat beside × was easy to hit by mistake and turned
/// the tab off, failing a message that was waiting (owner, 2026-10-12).
///
/// A tab shared with other accounts (1c) shows a two-person mark and its
/// harness count after the name; the name gives way first, the count never.
/// Right-click (or the context-menu key, or the "Tab options" accessibility
/// action) opens the menu the native tab has: Invite People…, Show Agent
/// Messages, Stop Sharing Tab, Move Here, Leave Tab — each row only where its
/// callback is given. A host whose [WorkspaceChrome.menuOnEveryTab] is on (the
/// web) gives every tab that menu, with Rename Tab… first and Close Tab last.
class DesktopWorkspaceTab extends StatefulWidget {
  const DesktopWorkspaceTab({
    super.key,
    required this.id,
    required this.label,
    required this.selected,
    required this.showShortcuts,
    required this.onSelect,
    required this.onClose,
    this.tooltip,
    this.activity,
    this.activityLabel,
    this.highlighted = false,
    this.onRename,
    this.shortcutHint,
    this.sharedCount,
    this.onInvitePeople,
    this.onShowAgentMessages,
    this.onStopSharing,
    this.onMoveHere,
    this.onLeave,
    this.onPauseNewWork,
    this.newWorkPaused = false,
  });

  final String id, label;
  final bool selected, highlighted;
  final ValueListenable<bool> showShortcuts;
  final VoidCallback? onSelect, onClose;
  final VoidCallback? onRename;
  final VoidCallback? onPauseNewWork;
  final bool newWorkPaused;
  final String? shortcutHint, tooltip, activityLabel;

  /// The status cell: an [ActivityMark].
  final Widget? activity;

  /// How many harnesses the shared tab holds; null for an unshared tab.
  final int? sharedCount;

  /// The tab menu's rows; a null callback leaves its row out.
  final VoidCallback? onInvitePeople,
      onShowAgentMessages,
      onStopSharing,
      onMoveHere,
      onLeave;

  /// What the shared mark says to a screen reader: "shared tab, 7 harnesses".
  static String sharedLabel(int count) =>
      'shared tab, $count ${count == 1 ? 'harness' : 'harnesses'}';

  static const _sharedIconSize = 13.0, _sharedIconGap = 3.0;

  static TextStyle _sharedStyle({Color? color}) =>
      DesktopChrome.metadata(color: color);

  /// The mark and count's width; 0 for an unshared tab.
  static double sharedWidth(BuildContext context, int? count) => count == null
      ? 0
      : _sharedIconSize +
            _sharedIconGap +
            _measure(context, '$count', _sharedStyle());

  static double _measure(BuildContext context, String text, TextStyle style) {
    final painter = TextPainter(
      text: TextSpan(text: text, style: style),
      textDirection: Directionality.of(context),
      textScaler: MediaQuery.textScalerOf(context),
      maxLines: 1,
    )..layout();
    final width = painter.width;
    painter.dispose();
    return width;
  }

  // × inside the tab's curved body, shown only on hover; at rest the name and
  // status have the whole tab. The pane close button's square target
  // ([grid.AppDesktop.tabCloseSize]): 16pt was easy to click by mistake
  // (owner, 2026-10-12).
  static const closeWidth = grid.AppDesktop.tabCloseSize;
  static const _restingInset = grid.AppDesktop.tabShoulder + 6;
  static const _revealedInset = closeWidth + grid.AppDesktop.tabCloseInset;
  static const _statusWidth = 16.0, _indicatorGap = 6.0;

  static TextStyle _hintStyle({Color? color}) =>
      DesktopChrome.metadata(color: color).copyWith(
        fontFamilyFallback: [...grid.AppType.sansFallback, 'Apple Symbols'],
      );

  static double indicatorWidth(
    BuildContext context,
    String? hint, {
    required bool hasActivity,
  }) => math
      .max(
        hasActivity ? _statusWidth : 0.0,
        hint == null || hint.isEmpty
            ? 0.0
            : _measure(context, hint, _hintStyle()),
      )
      .clamp(0.0, 72.0);

  static double labelWidth(BuildContext context, String label) =>
      _measure(context, label, DesktopChrome.control());

  /// The width that shows [label] whole while hovered, when × takes its room
  /// — where a tooltip appears.
  static double naturalWidth(
    BuildContext context,
    String label, {
    bool hasActivity = false,
    String? shortcutHint,
    int? sharedCount,
  }) =>
      labelWidth(context, label) +
      _restingInset +
      _revealedInset +
      (sharedCount == null
          ? 0
          : sharedWidth(context, sharedCount) + _indicatorGap) +
      ((hasActivity || (shortcutHint?.isNotEmpty ?? false))
          ? indicatorWidth(context, shortcutHint, hasActivity: hasActivity) +
                _indicatorGap
          : 0);

  /// The name's left edge and width: centered with its status, and when
  /// revealed moved left only as far as × needs, then shortened. A name with
  /// room never moves.
  static (double, double) titleLayout({
    required double tabWidth,
    required double labelWidth,
    required bool hasActivity,
    required bool revealed,
    double indicatorWidth = _statusWidth,
    double sharedWidth = 0,
  }) {
    final status =
        (hasActivity ? indicatorWidth + _indicatorGap : 0.0) +
        (sharedWidth > 0 ? sharedWidth + _indicatorGap : 0.0);
    final right = revealed ? _revealedInset : _restingInset;
    final width = math.min(
      labelWidth,
      math.max(0.0, tabWidth - _restingInset - right - status),
    );
    final group = width + status;
    final left = math.max(
      _restingInset,
      math.min((tabWidth - group) / 2, tabWidth - right - group),
    );
    return (left, width);
  }

  /// Tabs share the available width, then scroll at their readable minimum.
  static double widthForStrip(double availableWidth, int tabCount) {
    if (tabCount == 0) return 0;
    return math.min(
      availableWidth,
      (availableWidth / tabCount)
          .clamp(grid.AppDesktop.tabMinWidth, grid.AppDesktop.tabMaxWidth)
          .floorToDouble(),
    );
  }

  @override
  State<DesktopWorkspaceTab> createState() => _DesktopWorkspaceTabState();
}

class _DesktopWorkspaceTabState extends State<DesktopWorkspaceTab> {
  bool _hovered = false, _focused = false;
  final _menu = MenuController();

  /// The host's [WorkspaceChrome.menuOnEveryTab]: Desktop leaves it off, so
  /// only a tab with sharing rows has a menu there.
  bool _everyTab = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _everyTab = WorkspaceChrome.of(context).menuOnEveryTab;
    _syncBrowserMenu();
  }

  bool get _hasMenu =>
      (_everyTab && (widget.onRename != null || widget.onClose != null)) ||
      widget.onPauseNewWork != null ||
      widget.onInvitePeople != null ||
      widget.onShowAgentMessages != null ||
      widget.onStopSharing != null ||
      widget.onMoveHere != null ||
      widget.onLeave != null;

  /// In a browser, its own context menu would open over the tab menu on a
  /// right-click. It is off only while the pointer is over a tab that has a
  /// menu, so a right-click anywhere else (a terminal, a text field) keeps the
  /// browser's Copy and Paste.
  bool _browserMenuOff = false;

  void _syncBrowserMenu() {
    final off = kIsWeb && _hovered && _hasMenu && mounted;
    if (off == _browserMenuOff) return;
    _browserMenuOff = off;
    unawaited(
      off
          ? BrowserContextMenu.disableContextMenu()
          : BrowserContextMenu.enableContextMenu(),
    );
  }

  @override
  void didUpdateWidget(DesktopWorkspaceTab oldWidget) {
    super.didUpdateWidget(oldWidget);
    _syncBrowserMenu();
  }

  @override
  void dispose() {
    if (_browserMenuOff) {
      _browserMenuOff = false;
      unawaited(BrowserContextMenu.enableContextMenu());
    }
    super.dispose();
  }

  void _openMenu([Offset? position]) {
    if (_hasMenu && widget.onSelect != null) _menu.open(position: position);
  }

  /// The tab menu's rows, in the native tab menu's order.
  List<Widget> _menuRows() {
    Widget row(String key, String label, VoidCallback? onPressed) =>
        AppMenuItem(
          key: ValueKey('tab-menu:$key:${widget.id}'),
          label: label,
          onPressed: () {
            _menu.close();
            onPressed!();
          },
        );
    return [
      if (widget.onRename != null &&
          (_everyTab || widget.onPauseNewWork != null))
        row('rename', 'Rename Tab…', widget.onRename),
      if (widget.onPauseNewWork != null)
        row(
          'pause',
          widget.newWorkPaused ? 'Resume new work' : 'Pause new work',
          widget.onPauseNewWork,
        ),
      if (widget.onInvitePeople != null)
        row('invite', 'Invite People…', widget.onInvitePeople),
      if (widget.onShowAgentMessages != null)
        row('messages', 'Show Agent Messages', widget.onShowAgentMessages),
      if (widget.onStopSharing != null)
        row('stop', 'Stop Sharing Tab', widget.onStopSharing),
      if (widget.onMoveHere != null)
        row('move', 'Move Here', widget.onMoveHere),
      if (widget.onLeave != null) row('leave', 'Leave Tab', widget.onLeave),
      if (_everyTab && widget.onClose != null)
        row('close', 'Close Tab', widget.onClose),
    ];
  }

  /// The tab's trailing control: shown, it takes the pointer, focus and
  /// semantics; hidden, it keeps its place and none of them.
  Widget _accessory({
    required bool visible,
    required double width,
    required Widget child,
  }) => SizedBox(
    width: width,
    child: Center(
      child: IgnorePointer(
        ignoring: !visible,
        child: ExcludeFocus(
          excluding: !visible,
          child: ExcludeSemantics(
            excluding: !visible,
            child: Opacity(opacity: visible ? 1 : 0, child: child),
          ),
        ),
      ),
    ),
  );

  /// A quiet glyph that takes full ink on hover, focus and press.
  ButtonStyle _accessoryStyle(Color foreground, double resting) =>
      IconButton.styleFrom(
        backgroundColor: Colors.transparent,
        overlayColor: Colors.transparent,
        side: BorderSide.none,
        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
      ).copyWith(
        animationDuration: Duration.zero,
        foregroundColor: WidgetStateProperty.resolveWith(
          (states) => foreground.withValues(
            alpha:
                states.any(
                  (state) =>
                      state == WidgetState.hovered ||
                      state == WidgetState.focused ||
                      state == WidgetState.pressed,
                )
                ? 1
                : resting,
          ),
        ),
      );

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final enabled = widget.onSelect != null;
    // The × is full ink at rest, as the pane's (AppIcons.closeInk).
    const quietOpacity = AppIcons.closeInk;
    final focusVisible = _focused || widget.highlighted;
    // Workspace palettes can stay dark beside light app surfaces. Match the
    // native tab bar's ink to its own surface, independent of terminal colors.
    final foreground = grid.AppTheme.surfacePalette.foreground;
    final muted = foreground.withValues(alpha: .65);
    final fill = widget.selected
        ? grid.AppPalette.swarmWelcome
        : _hovered
        ? foreground.withValues(alpha: .06)
        : Colors.transparent;
    final ink = enabled
        ? widget.selected || _hovered || focusVisible
              ? foreground
              : muted
        : foreground.withValues(alpha: .38);
    Widget tab = Padding(
      padding: const EdgeInsets.only(top: grid.AppDesktop.tabTopInset),
      child: DecoratedBox(
        decoration: ShapeDecoration(
          color: fill,
          shape: DesktopTabBorder(
            side: focusVisible
                ? BorderSide(color: DesktopChrome.focusRing)
                : BorderSide.none,
          ),
        ),
        child: Semantics(
          container: true,
          explicitChildNodes: true,
          selected: widget.selected,
          child: LayoutBuilder(
            builder: (context, constraints) => ValueListenableBuilder(
              valueListenable: widget.showShortcuts,
              builder: (context, showHints, _) {
                final revealed = enabled && _hovered;
                final showHint =
                    enabled &&
                    showHints &&
                    (widget.shortcutHint?.isNotEmpty ?? false);
                final hasActivity = widget.activity != null || showHint;
                final indicator = DesktopWorkspaceTab.indicatorWidth(
                  context,
                  showHint ? widget.shortcutHint : null,
                  hasActivity: widget.activity != null,
                );
                final shared = widget.sharedCount;
                final sharedWidth = DesktopWorkspaceTab.sharedWidth(
                  context,
                  shared,
                );
                final sharedSpace = shared == null
                    ? 0.0
                    : sharedWidth + DesktopWorkspaceTab._indicatorGap;
                final (groupLeft, labelWidth) = DesktopWorkspaceTab.titleLayout(
                  tabWidth: constraints.maxWidth,
                  labelWidth: DesktopWorkspaceTab.labelWidth(
                    context,
                    widget.label,
                  ),
                  hasActivity: hasActivity,
                  revealed: revealed,
                  indicatorWidth: indicator,
                  sharedWidth: sharedWidth,
                );
                return Stack(
                  children: [
                    Positioned.fill(
                      child: Semantics(
                        button: true,
                        enabled: enabled,
                        label: [
                          widget.label,
                          if (shared != null)
                            DesktopWorkspaceTab.sharedLabel(shared),
                          ?widget.activityLabel,
                        ].join(', '),
                        onTap: widget.onSelect,
                        customSemanticsActions: {
                          if (widget.onClose != null)
                            const CustomSemanticsAction(label: 'Close tab'):
                                widget.onClose!,
                          if (_hasMenu && enabled)
                            const CustomSemanticsAction(label: 'Tab options'):
                                _openMenu,
                        },
                        child: FocusableActionDetector(
                          enabled: enabled,
                          onShowFocusHighlight: (value) =>
                              setState(() => _focused = value),
                          shortcuts: _hasMenu
                              ? const {
                                  SingleActivator(
                                    LogicalKeyboardKey.contextMenu,
                                  ): _TabMenuIntent(),
                                  SingleActivator(
                                    LogicalKeyboardKey.f10,
                                    shift: true,
                                  ): _TabMenuIntent(),
                                }
                              : const {},
                          actions: {
                            ActivateIntent: CallbackAction<ActivateIntent>(
                              onInvoke: (_) {
                                widget.onSelect?.call();
                                return null;
                              },
                            ),
                            _TabMenuIntent: CallbackAction<_TabMenuIntent>(
                              onInvoke: (_) {
                                _openMenu();
                                return null;
                              },
                            ),
                          },
                          child: GestureDetector(
                            behavior: HitTestBehavior.opaque,
                            onTap: widget.onSelect,
                            onDoubleTap: widget.onRename,
                            child: ExcludeSemantics(
                              child: Stack(
                                children: [
                                  Positioned(
                                    left: groupLeft,
                                    width: labelWidth,
                                    top: 0,
                                    bottom: 0,
                                    child: Center(
                                      child: Text(
                                        widget.label,
                                        key: ValueKey('tab-label:${widget.id}'),
                                        textAlign: TextAlign.center,
                                        maxLines: 1,
                                        overflow: TextOverflow.ellipsis,
                                        style: DesktopChrome.control(
                                          color: ink,
                                        ),
                                      ),
                                    ),
                                  ),
                                  if (shared != null)
                                    Positioned(
                                      key: ValueKey('tab-shared:${widget.id}'),
                                      left:
                                          groupLeft +
                                          labelWidth +
                                          DesktopWorkspaceTab._indicatorGap,
                                      width: sharedWidth,
                                      top: 0,
                                      bottom: 0,
                                      child: Row(
                                        children: [
                                          Icon(
                                            AppIcons.users,
                                            size: DesktopWorkspaceTab
                                                ._sharedIconSize,
                                            color: ink,
                                          ),
                                          const SizedBox(
                                            width: DesktopWorkspaceTab
                                                ._sharedIconGap,
                                          ),
                                          Text(
                                            '$shared',
                                            maxLines: 1,
                                            softWrap: false,
                                            style:
                                                DesktopWorkspaceTab._sharedStyle(
                                                  color: ink,
                                                ),
                                          ),
                                        ],
                                      ),
                                    ),
                                  if (hasActivity)
                                    Positioned(
                                      left:
                                          groupLeft +
                                          labelWidth +
                                          sharedSpace +
                                          DesktopWorkspaceTab._indicatorGap,
                                      width: indicator,
                                      top: 0,
                                      bottom: 0,
                                      child: Center(
                                        child: showHint
                                            ? Text(
                                                widget.shortcutHint!,
                                                key: ValueKey(
                                                  'tab-shortcut:${widget.id}',
                                                ),
                                                maxLines: 1,
                                                overflow: TextOverflow.ellipsis,
                                                style:
                                                    DesktopWorkspaceTab._hintStyle(
                                                      color: ink,
                                                    ),
                                              )
                                            : widget.activity,
                                      ),
                                    ),
                                ],
                              ),
                            ),
                          ),
                        ),
                      ),
                    ),
                    Positioned(
                      right: grid.AppDesktop.tabCloseInset,
                      top: 0,
                      bottom: 0,
                      child: _accessory(
                        visible: revealed,
                        width: DesktopWorkspaceTab.closeWidth,
                        child: IconButton(
                          key: ValueKey('tab-close:${widget.id}'),
                          tooltip: 'Close tab',
                          onPressed: widget.onClose,
                          padding: EdgeInsets.zero,
                          constraints: const BoxConstraints.tightFor(
                            width: DesktopWorkspaceTab.closeWidth,
                            height: DesktopWorkspaceTab.closeWidth,
                          ),
                          style: _accessoryStyle(foreground, quietOpacity),
                          icon: const Icon(
                            AppIcons.close,
                            size: AppIcons.closeSize,
                          ),
                        ),
                      ),
                    ),
                  ],
                );
              },
            ),
          ),
        ),
      ),
    );
    if (widget.tooltip case final tooltip? when tooltip.isNotEmpty) {
      tab = Tooltip(message: tooltip, excludeFromSemantics: true, child: tab);
    }
    tab = GestureDetector(
      behavior: HitTestBehavior.opaque,
      excludeFromSemantics: true,
      onTap: widget.onSelect,
      onSecondaryTapDown: _hasMenu && enabled
          ? (details) => _openMenu(details.localPosition)
          : null,
      child: MouseRegion(
        cursor: enabled ? SystemMouseCursors.click : SystemMouseCursors.basic,
        onEnter: (_) {
          setState(() => _hovered = true);
          _syncBrowserMenu();
        },
        onExit: (_) {
          setState(() => _hovered = false);
          _syncBrowserMenu();
        },
        child: tab,
      ),
    );
    // Always the anchor, menu or not: a tab whose share arrives keeps its
    // subtree (and keyboard focus); [_openMenu] opens nothing without rows.
    return MenuAnchor(controller: _menu, menuChildren: _menuRows(), child: tab);
  }
}

/// Opens the tab menu from the keyboard.
class _TabMenuIntent extends Intent {
  const _TabMenuIntent();
}
