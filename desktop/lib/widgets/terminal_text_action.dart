import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../terminal/terminal_text.dart';
import '../terminal/terminal_theme.dart';
import '../terminal/terminal_theme_store.dart';

/// A named terminal action: brackets, one text row, and a flat focus highlight.
class TerminalTextAction extends StatelessWidget {
  const TerminalTextAction({
    super.key,
    required this.label,
    required this.onPressed,
    this.focusNode,
    this.overArtwork = false,
  });
  final String label;
  final VoidCallback onPressed;
  final FocusNode? focusNode;
  final bool overArtwork;

  @override
  Widget build(BuildContext context) {
    TerminalFontScope.watch(context);
    grid.AppTheme.watch(context);
    return ValueListenableBuilder(
      valueListenable: terminalThemeStore,
      builder: (context, _, _) {
        final theme = terminalThemeFor(
          grid.AppTheme.palette.value,
          terminalThemeStore.value,
        );
        final cell = terminalCellSizeOf(context);
        return TextButton(
          focusNode: focusNode,
          onPressed: onPressed,
          style:
              TextButton.styleFrom(
                foregroundColor: overArtwork ? Colors.white : theme.foreground,
                backgroundColor: overArtwork
                    ? const Color(0xcc242424)
                    : Colors.transparent,
                textStyle: terminalContentStyle(),
                padding: EdgeInsets.symmetric(horizontal: cell.width),
                minimumSize: Size.zero,
                tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                shape: const RoundedRectangleBorder(),
                splashFactory: NoSplash.splashFactory,
              ).copyWith(
                overlayColor: WidgetStateProperty.resolveWith(
                  (states) =>
                      states.any(
                        {
                          WidgetState.hovered,
                          WidgetState.focused,
                          WidgetState.pressed,
                        }.contains,
                      )
                      ? theme.selection.withValues(alpha: .5)
                      : Colors.transparent,
                ),
              ),
          child: SizedBox(
            height: cell.height,
            child: Text('[ $label ]', semanticsLabel: label),
          ),
        );
      },
    );
  }
}
