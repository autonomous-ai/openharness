import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../terminal/terminal_text.dart';
import '../terminal/terminal_theme.dart';
import '../terminal/terminal_theme_store.dart';

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
        action('-', 'Close Pane', onClose),
        action(
          '[]',
          zoomed ? 'Restore Pane' : 'Zoom Pane',
          onZoom,
          toggled: zoomed,
        ),
        action('x', terminal ? 'Stop Terminal' : 'Stop Harness', onDelete),
      ],
    );
  }
}
