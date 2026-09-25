import 'package:flutter/material.dart';

/// Shared text emphasis for tabs, status links, symbols, models, and pane close.
/// Builders keep their layout fixed while drawing emphasized text. Only the
/// selected tab has a fill; hovering preserves the surface underneath.
class WorkspaceBarControl extends StatefulWidget {
  const WorkspaceBarControl({
    super.key,
    required this.label,
    required this.builder,
    this.selectedBackground,
    this.tooltip,
    this.foreground,
    this.selected,
    this.onPressed,
  });

  final String label;
  final String? tooltip;
  final Color? selectedBackground;
  final Color? foreground;
  final bool? selected;
  final Widget Function(BuildContext context, bool emphasized) builder;
  final VoidCallback? onPressed;

  @override
  State<WorkspaceBarControl> createState() => _WorkspaceBarControlState();
}

class _WorkspaceBarControlState extends State<WorkspaceBarControl> {
  bool _hovered = false, _focused = false, _pressed = false;

  @override
  Widget build(BuildContext context) {
    final enabled = widget.onPressed != null;
    final active = enabled && (_hovered || _focused || _pressed);
    Widget content = widget.builder(context, active);
    if (widget.foreground case final foreground?) {
      content = DefaultTextStyle.merge(
        style: TextStyle(
          color: foreground.withValues(alpha: enabled ? .75 : .28),
        ),
        child: content,
      );
    }
    if (widget.selected == true && widget.selectedBackground != null) {
      content = ColoredBox(color: widget.selectedBackground!, child: content);
    }
    final control = Semantics(
      button: true,
      enabled: enabled,
      selected: widget.selected,
      label: widget.label,
      onTap: widget.onPressed,
      child: MouseRegion(
        onEnter: (_) => setState(() => _hovered = true),
        onExit: (_) => setState(() => _hovered = false),
        child: FocusableActionDetector(
          enabled: enabled,
          mouseCursor: enabled
              ? SystemMouseCursors.click
              : SystemMouseCursors.basic,
          onFocusChange: (value) => setState(() => _focused = value),
          actions: {
            ActivateIntent: CallbackAction<ActivateIntent>(
              onInvoke: (_) {
                widget.onPressed?.call();
                return null;
              },
            ),
          },
          child: GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTap: widget.onPressed,
            onTapDown: enabled ? (_) => setState(() => _pressed = true) : null,
            onTapUp: (_) => setState(() => _pressed = false),
            onTapCancel: () => setState(() => _pressed = false),
            child: ExcludeSemantics(child: content),
          ),
        ),
      ),
    );
    final hint = widget.tooltip?.trim();
    return hint == null || hint.isEmpty
        ? control
        : Tooltip(
            message: hint,
            excludeFromSemantics: true,
            waitDuration: const Duration(milliseconds: 700),
            child: control,
          );
  }
}

/// The numeric prefix is navigation, not a different name worth repeating.
String? workspaceTabTooltip(
  String label,
  String name, {
  required bool clipped,
}) {
  final visibleName = label.replaceFirst(RegExp(r'^\d+:'), '').trim();
  final hint = [
    if (clipped) label,
    if (name.trim().isNotEmpty && name.trim() != visibleName && name != label)
      name,
  ].join('\n');
  return hint.isEmpty ? null : hint;
}
