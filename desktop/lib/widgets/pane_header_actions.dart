import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../terminal/terminal_text.dart';
import '../terminal/terminal_theme.dart';
import '../terminal/terminal_theme_store.dart';

/// Reveals only this header's controls, not those of the whole pane or grid.
class PaneHeaderHover extends StatefulWidget {
  const PaneHeaderHover({super.key, required this.child});

  final Widget child;

  @override
  State<PaneHeaderHover> createState() => _PaneHeaderHoverState();
}

class _PaneHeaderHoverState extends State<PaneHeaderHover> {
  bool _hovered = false;

  void _hover(bool value) {
    if (_hovered != value) setState(() => _hovered = value);
  }

  @override
  Widget build(BuildContext context) => MouseRegion(
    onEnter: (_) => _hover(true),
    onExit: (_) => _hover(false),
    child: _PaneHeaderHoverScope(hovered: _hovered, child: widget.child),
  );
}

class _PaneHeaderHoverScope extends InheritedWidget {
  const _PaneHeaderHoverScope({required this.hovered, required super.child});

  final bool hovered;

  @override
  bool updateShouldNotify(_PaneHeaderHoverScope oldWidget) =>
      hovered != oldWidget.hovered;
}

/// Three quiet terminal characters: close this view, zoom, and stop its harness.
class PaneHeaderActions extends StatelessWidget {
  const PaneHeaderActions({
    super.key,
    required this.zoomed,
    this.onZoom,
    this.onDelete,
    this.onClose,
    this.details,
    this.trailing,
    this.modelPicker,
    this.terminal = false,
  });

  final bool zoomed, terminal;
  final VoidCallback? onZoom, onDelete, onClose;
  final Widget? details, trailing, modelPicker;

  /// Two columns per control, including the space around a single character.
  static double widthOf(BuildContext context) =>
      terminalCellSizeOf(context).width * 6;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final cell = terminalCellSizeOf(context);
    final theme = terminalThemeFor(
      grid.AppTheme.palette.value,
      terminalThemeStore.value,
    );
    Widget action(
      String symbol,
      String label,
      VoidCallback? callback, {
      bool? toggled,
    }) => Tooltip(
      message: label,
      child: Semantics(
        label: label,
        button: true,
        enabled: callback != null,
        toggled: toggled,
        child: TextButton(
          onPressed: callback,
          style: ButtonStyle(
            fixedSize: WidgetStatePropertyAll(
              Size(cell.width * 2, cell.height * 2),
            ),
            minimumSize: const WidgetStatePropertyAll(Size.zero),
            padding: const WidgetStatePropertyAll(EdgeInsets.zero),
            tapTargetSize: MaterialTapTargetSize.shrinkWrap,
            visualDensity: VisualDensity.standard,
            textStyle: WidgetStatePropertyAll(terminalContentStyle()),
            shape: const WidgetStatePropertyAll(RoundedRectangleBorder()),
            foregroundColor: WidgetStateProperty.resolveWith((states) {
              if (states.contains(WidgetState.disabled)) {
                return theme.foreground.withValues(alpha: .2);
              }
              if (states.contains(WidgetState.hovered) ||
                  states.contains(WidgetState.focused)) {
                return theme.foreground;
              }
              return theme.foreground.withValues(alpha: .55);
            }),
            overlayColor: WidgetStatePropertyAll(
              theme.foreground.withValues(alpha: .08),
            ),
          ),
          child: ExcludeSemantics(child: Text(symbol)),
        ),
      ),
    );
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (modelPicker != null) Flexible(child: modelPicker!),
        if (details != null || trailing != null)
          Flexible(
            child: Row(
              key: const ValueKey('pane-header-details'),
              mainAxisSize: MainAxisSize.min,
              children: [
                if (details != null) Flexible(child: details!),
                ?trailing,
              ],
            ),
          ),
        _HoverControls(
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              action('-', 'Close Pane', onClose),
              action(
                '[]',
                zoomed ? 'Restore Pane' : 'Zoom Pane',
                onZoom,
                toggled: zoomed,
              ),
              action(
                'x',
                terminal ? 'Stop Terminal' : 'Stop Harness',
                onDelete,
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class _HoverControls extends StatefulWidget {
  const _HoverControls({required this.child});

  final Widget child;

  @override
  State<_HoverControls> createState() => _HoverControlsState();
}

class _HoverControlsState extends State<_HoverControls> {
  bool _focused = false;

  @override
  Widget build(BuildContext context) {
    final header = context
        .dependOnInheritedWidgetOfExactType<_PaneHeaderHoverScope>();
    final visible = (header?.hovered ?? true) || _focused;
    return Focus(
      canRequestFocus: false,
      onFocusChange: (focused) => setState(() => _focused = focused),
      child: IgnorePointer(
        ignoring: !visible,
        child: Opacity(
          key: const ValueKey('pane-header-controls'),
          opacity: visible ? 1 : 0,
          alwaysIncludeSemantics: true,
          child: widget.child,
        ),
      ),
    );
  }
}
