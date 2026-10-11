import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';

import '../agent_messages/agent_messages.dart';
import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import 'box_chrome.dart';
import 'desktop_chrome.dart';

/// The Flutter counterpart of the AppKit tab: a centered name/status group
/// and, at its trailing edge, Agent Messages' 💬 and the close action.
///
/// At rest the name and status have the whole tab. Hovering reveals 💬 — grey
/// while Agent Messages is off, [messagesColor] while on — and ×. While agents
/// message, the caller passes a [MessagingMark] as [activity].
class DesktopWorkspaceTab extends StatefulWidget {
  const DesktopWorkspaceTab({
    super.key,
    required this.id,
    required this.label,
    required this.selected,
    required this.onSelect,
    required this.onClose,
    this.tooltip,
    this.activity,
    this.activityLabel,
    this.highlighted = false,
    this.onRename,
    this.agentMessages,
    this.messagesColor,
    this.onToggleAgentMessages,
  });

  final String id, label;
  final bool selected, highlighted;
  final VoidCallback? onSelect, onClose;
  final VoidCallback? onRename;

  /// This tab's Agent Messages, or null where a tab has none (the Store).
  final TabMessagesState? agentMessages;

  /// Agent Messages' color, for the 💬 while on: the accent blue
  /// (`AppPalette.accentOnSurface`), the design system's color for "on".
  final Color? messagesColor;
  final VoidCallback? onToggleAgentMessages;
  final String? tooltip, activityLabel;

  /// The status cell: an [ActivityMark], or a [MessagingMark] while agents
  /// message.
  final Widget? activity;

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

  // × and, left of it, 💬, inside the tab's curved body, with a dead gap
  // between them so a click just off × never toggles 💬. They show only on
  // hover; at rest the name and status have the whole tab.
  static const closeWidth = 16.0, messagesWidth = 16.0, accessoryGap = 3.0;
  static const _restingInset = grid.AppDesktop.tabShoulder + 6;
  static const _revealedInset =
      closeWidth + accessoryGap + messagesWidth + grid.AppDesktop.tabCloseInset;
  static const _statusWidth = 16.0, _indicatorGap = 6.0;

  /// What the 💬 says it does, in each state.
  static String agentMessagesTooltip(TabMessagesState state) => switch (state) {
    TabMessagesState.off => 'Agent messages off · click to turn on',
    TabMessagesState.on => 'Agent messages on · click to turn off',
    TabMessagesState.flowing => 'Agents messaging · click to turn off',
  };

  static double labelWidth(BuildContext context, String label) =>
      _measure(context, label, DesktopChrome.control());

  /// The width that shows [label] whole while hovered, when 💬 and × take
  /// their room — where a tooltip appears.
  static double naturalWidth(
    BuildContext context,
    String label, {
    bool hasActivity = false,
  }) =>
      labelWidth(context, label) +
      _restingInset +
      _revealedInset +
      (hasActivity ? _statusWidth + _indicatorGap : 0);

  /// The name's left edge and width: centered with its status, and when
  /// revealed moved left only as far as 💬 and × need, then shortened. A name
  /// with room never moves.
  static (double, double) titleLayout({
    required double tabWidth,
    required double labelWidth,
    required bool hasActivity,
    required bool revealed,
  }) {
    final status = hasActivity ? _statusWidth + _indicatorGap : 0.0;
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

  /// One of the tab's trailing controls: shown, it takes the pointer, focus
  /// and semantics; hidden, it keeps its place and none of them.
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
    final quietOpacity = MediaQuery.highContrastOf(context) ? .7 : .45;
    // Windows reserves Meta+W for Widgets, so a tab's close action must stay
    // visible without a hover (the fork's Windows tab contract); elsewhere the
    // close stays hover-revealed as upstream designed.
    final pinClose =
        !kIsWeb && defaultTargetPlatform == TargetPlatform.windows;
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
    final messages = widget.agentMessages;
    final messagesOn = messages != null && messages != TabMessagesState.off;
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
            builder: (context, constraints) {
              final revealed = enabled && _hovered;
              final hasActivity = widget.activity != null;
              final (groupLeft, labelWidth) = DesktopWorkspaceTab.titleLayout(
                tabWidth: constraints.maxWidth,
                labelWidth: DesktopWorkspaceTab.labelWidth(
                  context,
                  widget.label,
                ),
                hasActivity: hasActivity,
                revealed: revealed || pinClose,
              );
              return Stack(
                children: [
                  Positioned.fill(
                    child: Semantics(
                      button: true,
                      enabled: enabled,
                      label: [widget.label, ?widget.activityLabel].join(', '),
                      onTap: widget.onSelect,
                      customSemanticsActions: {
                        if (widget.onClose != null)
                          const CustomSemanticsAction(label: 'Close tab'):
                              widget.onClose!,
                        if (messages != null &&
                            widget.onToggleAgentMessages != null)
                          CustomSemanticsAction(
                            label: messagesOn
                                ? 'Turn Agent Messages off'
                                : 'Turn Agent Messages on',
                          ): widget.onToggleAgentMessages!,
                      },
                      child: FocusableActionDetector(
                        enabled: enabled,
                        onShowFocusHighlight: (value) =>
                            setState(() => _focused = value),
                        actions: {
                          ActivateIntent: CallbackAction<ActivateIntent>(
                            onInvoke: (_) {
                              widget.onSelect?.call();
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
                                      style: DesktopChrome.control(color: ink),
                                    ),
                                  ),
                                ),
                                if (widget.activity case final activity?)
                                  Positioned(
                                    left:
                                        groupLeft +
                                        labelWidth +
                                        DesktopWorkspaceTab._indicatorGap,
                                    width: DesktopWorkspaceTab._statusWidth,
                                    top: 0,
                                    bottom: 0,
                                    child: Center(child: activity),
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
                    child: Row(
                      children: [
                        _accessory(
                          visible: messages != null && revealed,
                          width: DesktopWorkspaceTab.messagesWidth,
                          child: messages == null
                              ? const SizedBox.shrink()
                              : _AgentMessagesButton(
                                  key: ValueKey(
                                    'tab-agent-messages:${widget.id}',
                                  ),
                                  state: messages,
                                  onPressed: widget.onToggleAgentMessages,
                                  style: messagesOn
                                      ? _accessoryStyle(
                                          widget.messagesColor ?? foreground,
                                          MediaQuery.highContrastOf(context)
                                              ? 1
                                              : .85,
                                        )
                                      : _accessoryStyle(
                                          foreground,
                                          quietOpacity,
                                        ),
                                ),
                        ),
                        const SizedBox(width: DesktopWorkspaceTab.accessoryGap),
                        _accessory(
                          visible: revealed || pinClose,
                          width: DesktopWorkspaceTab.closeWidth,
                          child: IconButton(
                            key: ValueKey('tab-close:${widget.id}'),
                            tooltip: 'Close tab',
                            onPressed: widget.onClose,
                            padding: EdgeInsets.zero,
                            constraints: const BoxConstraints.tightFor(
                              width: DesktopWorkspaceTab.closeWidth,
                              height: 32,
                            ),
                            style: _accessoryStyle(foreground, quietOpacity),
                            icon: const Icon(
                              AppIcons.close,
                              size: AppIcons.closeSize,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              );
            },
          ),
        ),
      ),
    );
    if (widget.tooltip case final tooltip? when tooltip.isNotEmpty) {
      tab = Tooltip(message: tooltip, excludeFromSemantics: true, child: tab);
    }
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      excludeFromSemantics: true,
      onTap: widget.onSelect,
      child: MouseRegion(
        cursor: enabled ? SystemMouseCursors.click : SystemMouseCursors.basic,
        onEnter: (_) => setState(() => _hovered = true),
        onExit: (_) => setState(() => _hovered = false),
        child: tab,
      ),
    );
  }
}

/// Agent Messages' 💬: grey while off, in its color while on. Its tooltip says
/// what a click does.
class _AgentMessagesButton extends StatelessWidget {
  const _AgentMessagesButton({
    super.key,
    required this.state,
    required this.onPressed,
    required this.style,
  });

  final TabMessagesState state;
  final VoidCallback? onPressed;
  final ButtonStyle style;

  @override
  Widget build(BuildContext context) {
    final tooltip = DesktopWorkspaceTab.agentMessagesTooltip(state);
    // One node that says what it is and whether it is on; the tooltip's
    // sentence is its hint, not a second label.
    return Semantics(
      container: true,
      button: true,
      toggled: state != TabMessagesState.off,
      label: 'Agent Messages',
      hint: tooltip,
      onTap: onPressed,
      excludeSemantics: true,
      child: Tooltip(
        message: tooltip,
        excludeFromSemantics: true,
        child: IconButton(
          onPressed: onPressed,
          padding: EdgeInsets.zero,
          constraints: const BoxConstraints.tightFor(
            width: DesktopWorkspaceTab.messagesWidth,
            height: 32,
          ),
          style: style,
          icon: const Icon(AppIcons.messagesSquare, size: 13),
        ),
      ),
    );
  }
}
