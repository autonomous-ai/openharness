import 'package:flutter/material.dart';

/// The same flat target for tabs, status links, symbols, model labels, and pane close actions.
/// Callers size the child to `workspaceBarControlHeight` and supply only hints
/// that add information to the visible label.
class WorkspaceBarControl extends StatefulWidget {
  const WorkspaceBarControl({
    super.key,
    required this.label,
    required this.selection,
    required this.child,
    this.tooltip,
    this.foreground,
    this.selected,
    this.onPressed,
  });

  final String label;
  final String? tooltip;
  final Color selection;
  final Color? foreground;
  final bool? selected;
  final Widget child;
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
    Widget content = widget.child;
    if (widget.foreground case final foreground?) {
      content = DefaultTextStyle.merge(
        style: TextStyle(
          color: foreground.withValues(
            alpha: !enabled
                ? .28
                : active
                ? 1
                : .75,
          ),
        ),
        child: content,
      );
    }
    if (widget.selected == true) {
      content = ColoredBox(color: widget.selection, child: content);
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
            child: ExcludeSemantics(
              child: Stack(
                alignment: Alignment.center,
                children: [
                  content,
                  if (active && widget.selected != true)
                    Positioned.fill(
                      child: IgnorePointer(
                        child: ColoredBox(
                          color: widget.selection.withValues(alpha: .5),
                        ),
                      ),
                    ),
                ],
              ),
            ),
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
