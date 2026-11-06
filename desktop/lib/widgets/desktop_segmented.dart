import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import 'desktop_chrome.dart';

/// One choice of a [DesktopSegmented].
class DesktopSegment<T> {
  const DesktopSegment({
    required this.value,
    required this.label,
    this.key,
    this.tooltip,
  });

  final T value;
  final String label;
  final Key? key;
  final String? tooltip;
}

/// A pick-one control: its choices sit side by side in one rounded track, and
/// the chosen one is raised in it, as a macOS segmented control. Use it where
/// separate pills would read as separate actions (the Tasks view's Board,
/// List and Members).
class DesktopSegmented<T> extends StatelessWidget {
  const DesktopSegmented({
    super.key,
    required this.segments,
    required this.selected,
    required this.onChanged,
  });

  final List<DesktopSegment<T>> segments;
  final T selected;
  final ValueChanged<T> onChanged;

  static const _inset = 2.0;
  static const _radius = DesktopChrome.controlRadius;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final ink = DesktopChrome.foreground;
    return Semantics(
      container: true,
      child: Container(
        height: DesktopChrome.controlHeight,
        padding: const EdgeInsets.all(_inset),
        decoration: BoxDecoration(
          color: ink.withValues(alpha: .055),
          borderRadius: BorderRadius.circular(_radius),
          border: Border.all(
            color: ink.withValues(alpha: .09),
            width: grid.AppDesktop.focusWidth,
          ),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            for (final segment in segments)
              _SegmentButton(
                segment: segment,
                selected: segment.value == selected,
                onPressed: () => onChanged(segment.value),
              ),
          ],
        ),
      ),
    );
  }
}

class _SegmentButton<T> extends StatelessWidget {
  const _SegmentButton({
    required this.segment,
    required this.selected,
    required this.onPressed,
  });

  final DesktopSegment<T> segment;
  final bool selected;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final ink = DesktopChrome.foreground;
    final button = TextButton(
      key: segment.key,
      onPressed: onPressed,
      style: TextButton.styleFrom(
        foregroundColor: selected ? ink : DesktopChrome.muted,
        backgroundColor: selected
            ? ink.withValues(alpha: .13)
            : Colors.transparent,
        enabledMouseCursor: SystemMouseCursors.click,
        minimumSize: Size.zero,
        padding: const EdgeInsets.symmetric(horizontal: 10),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(
            DesktopSegmented._radius - DesktopSegmented._inset,
          ),
        ),
        textStyle: DesktopChrome.control(medium: selected),
        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        splashFactory: NoSplash.splashFactory,
      ),
      child: Text(segment.label, maxLines: 1),
    );
    final control = Semantics(selected: selected, button: true, child: button);
    final tooltip = segment.tooltip;
    return tooltip == null
        ? control
        : Tooltip(message: tooltip, child: control);
  }
}
