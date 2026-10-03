import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import 'desktop_chrome.dart';

/// Named workspace actions use the same rounded desktop buttons as dialogs.
class TerminalTextAction extends StatelessWidget {
  const TerminalTextAction({
    super.key,
    required this.label,
    required this.onPressed,
    this.focusNode,
    this.overArtwork = false,
    this.padding,
  });
  final String label;
  final VoidCallback? onPressed;
  final FocusNode? focusNode;
  final bool overArtwork;
  final EdgeInsetsGeometry? padding;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final foreground = overArtwork ? Colors.white : DesktopChrome.foreground;
    return TextButton(
      focusNode: focusNode,
      onPressed: onPressed,
      style: TextButton.styleFrom(
        foregroundColor: foreground,
        disabledForegroundColor: foreground.withValues(alpha: .38),
        backgroundColor: overArtwork
            ? const Color(0xcc303030)
            : foreground.withValues(alpha: .07),
        side: BorderSide(color: foreground.withValues(alpha: .14)),
        shape: const StadiumBorder(),
        minimumSize: const Size(0, 32),
        padding: (padding ?? EdgeInsets.zero).add(
          const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
        ),
        textStyle: DesktopChrome.text(size: 13),
        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        splashFactory: NoSplash.splashFactory,
      ),
      child: Text(label),
    );
  }
}
