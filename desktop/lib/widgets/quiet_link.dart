import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;

/// A way on that is words, not a box: Skip and Continue with email on the
/// sign-in step, and Continue with email on the sign-in screen, where the
/// buttons above it are the ones the screen is asking for.
///
/// Not a [TextButton]: the theme gives those a rim and a fill of their own,
/// which made the quiet way in read as one more button (seen in the real
/// window, 2026-10-11). It has no padding at its sides, so a caller can set it
/// on another control's edge. Hover and the keyboard light the words; the
/// keyboard underlines them too, having no pointer to show where it is.
class QuietLink extends StatefulWidget {
  const QuietLink({super.key, required this.label, required this.onPressed});

  final String label;
  final VoidCallback? onPressed;

  @override
  State<QuietLink> createState() => _QuietLinkState();
}

class _QuietLinkState extends State<QuietLink> {
  var _hovered = false;
  var _focused = false;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final enabled = widget.onPressed != null;
    final active = enabled && (_hovered || _focused);
    return Semantics(
      button: true,
      enabled: enabled,
      child: InkWell(
        onTap: widget.onPressed,
        onHover: (hovered) => setState(() => _hovered = hovered),
        onFocusChange: (focused) => setState(() => _focused = focused),
        mouseCursor: enabled
            ? SystemMouseCursors.click
            : SystemMouseCursors.basic,
        borderRadius: BorderRadius.circular(4),
        hoverColor: Colors.transparent,
        focusColor: Colors.transparent,
        highlightColor: Colors.transparent,
        splashFactory: NoSplash.splashFactory,
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 8),
          child: Text(
            widget.label,
            maxLines: 1,
            softWrap: false,
            overflow: TextOverflow.ellipsis,
            style:
                grid.AppType.label(
                  color: active
                      ? grid.AppPalette.textPrimary
                      : grid.AppPalette.textSecondary,
                ).copyWith(
                  decoration: enabled && _focused
                      ? TextDecoration.underline
                      : null,
                ),
          ),
        ),
      ),
    );
  }
}
