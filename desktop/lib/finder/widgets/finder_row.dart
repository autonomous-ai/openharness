import 'package:flutter/material.dart';

import '../../shared/theme/app_theme.dart' as grid;
import '../../theme/app_theme.dart';

/// One row of a Finder sidebar — a tree entry or a change — so both lists
/// share one height, indent, hover and selection.
class FinderRow extends StatelessWidget {
  const FinderRow({
    super.key,
    required this.icon,
    required this.label,
    required this.onTap,
    this.indent = 0,
    this.selected = false,
    this.detail,
    this.leading,
    this.trailing,
    this.labelColor,
    this.strike = false,
    this.faint = false,
  });

  static const height = 26.0;
  static const indentStep = 14.0;

  final IconData icon;
  final String label;
  final VoidCallback onTap;
  final int indent;
  final bool selected;

  /// Quieter text after the label: a changed file's folder.
  final String? detail;

  /// Before the icon: a folder's disclosure chevron.
  final Widget? leading;
  final Widget? trailing;
  final Color? labelColor;

  /// A deleted file, crossed through.
  final bool strike;

  /// An entry Git ignores: italic and quiet, as Orca draws it.
  final bool faint;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return Material(
      color: selected ? AppColors.selected : Colors.transparent,
      child: InkWell(
        // No onDoubleTap here: it would hold every single tap back until
        // the double-tap window passed. Callers that pin on a second click
        // tell it from the first by time ([FinderClickTracker]).
        onTap: onTap,
        hoverColor: AppColors.rowHover,
        child: SizedBox(
          height: height,
          child: Padding(
            padding: EdgeInsets.only(left: 8 + indent * indentStep, right: 10),
            child: Row(
              children: [
                SizedBox(width: 16, child: leading),
                Icon(
                  icon,
                  size: 14,
                  color: faint
                      ? AppColors.muted
                      : labelColor ?? AppColors.mutedStrong,
                ),
                const SizedBox(width: 6),
                // The name keeps what it needs and the folder takes what is
                // left, so every row's mark lines up at the right edge. The
                // name gets the larger share when both are long: it is what
                // the row is.
                Expanded(
                  child: Row(
                    children: [
                      Flexible(
                        flex: 3,
                        child: Text(
                          label,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style:
                              grid.AppType.label(
                                color: faint
                                    ? AppColors.muted
                                    : labelColor ?? AppColors.text,
                                fontWeight: FontWeight.w400,
                                fontStyle: faint ? FontStyle.italic : null,
                              ).copyWith(
                                decoration: strike
                                    ? TextDecoration.lineThrough
                                    : null,
                              ),
                        ),
                      ),
                      if (detail case final detail?) ...[
                        const SizedBox(width: 6),
                        Expanded(
                          flex: 2,
                          child: Text(
                            detail,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: grid.AppType.caption(color: AppColors.muted),
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
                if (trailing case final trailing?) ...[
                  const SizedBox(width: 6),
                  trailing,
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}
