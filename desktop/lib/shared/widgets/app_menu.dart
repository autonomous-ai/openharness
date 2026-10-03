import 'dart:math' as math;

import 'package:harness/shared/theme/app_icons.dart';
import 'package:flutter/material.dart';

import '../theme/app_theme.dart';

/// Menu choices use the system UI face; technical values can supply their own
/// style. Compact and roomy variants change padding and icon spacing.
@immutable
class AppMenuRowMetrics {
  const AppMenuRowMetrics({required this.iconSize, required this.padding});

  double get fontSize => AppType.bodySize;
  double get noteSize => AppType.captionSize;
  final double iconSize;
  final EdgeInsets padding;

  /// Round line metrics up before adding padding, so panels reserve enough
  /// room for the line. The extra two pixels are the row border;
  /// app_select_field_test checks the result against actual layout.
  double get extent =>
      math.max(iconSize, (fontSize * 1.2).ceilToDouble()) +
      padding.vertical +
      2;

  /// What a row with a [AppMenuItem.detail] line lays out at instead.
  ///
  /// [extent] plus the second line's own box — [noteSize] × 1.25, rounded up
  /// the same way a line box rounds, plus the 2px that separates the two lines.
  /// Stated rather than derived at the call site for the same reason [extent]
  /// is: a panel sized by arithmetic that disagrees with the layout by half a
  /// pixel per row wears a scrollbar it does not need.
  double get detailExtent =>
      math.max(
        iconSize,
        (fontSize * 1.2).ceilToDouble() + (noteSize * 1.25).ceilToDouble() + 2,
      ) +
      padding.vertical +
      2;

  /// A context menu's row: the macOS control scale.
  static const compact = AppMenuRowMetrics(
    iconSize: 16,
    padding: EdgeInsets.symmetric(horizontal: 9, vertical: 8),
  );

  /// A picker's row has more padding, with the same font as a context menu.
  static const roomy = AppMenuRowMetrics(
    iconSize: 18,
    padding: EdgeInsets.symmetric(horizontal: 11, vertical: 10),
  );
}

/// Shared by menu rows and pickers that reserve space before laying them out.
double get kMenuRowExtent => AppMenuRowMetrics.compact.extent;
// (kept as the compact row's extent; see AppMenuRowMetrics.compact.extent)

/// One row in an [AppMenu] panel.
///
/// The panel itself is no longer built here: it lives on [AppMenu] in
/// `app_theme.dart`, and `menuTheme` hands it to every `MenuAnchor` in the app,
/// so a menu that passes no style gets the same surface as one that does. The
/// hand-written `appMenuStyle()` this file used to export was the second of four
/// disagreeing recipes — see that class.
///
/// Adds subject marks, qualifiers and detail lines to the same selection
/// treatment supplied by the app's ordinary MenuItemButton theme.
class AppMenuItem extends StatefulWidget {
  const AppMenuItem({
    super.key,
    this.icon,
    required this.label,
    required this.onPressed,
    this.danger = false,
    this.selected = false,
    this.note,
    this.detail,
    this.leading,
    this.trailing,
    this.focusNode,
    this.metrics = AppMenuRowMetrics.compact,
    this.textStyle,
  });

  /// The leading glyph. Null for a row in a list that PICKS one of several — the
  /// slot is still reserved, so labels line up whether a row is ticked or not.
  final IconData? icon;
  final String label;

  /// A quieter qualifier after the label — a face name beside "System". Set
  /// apart by ink rather than by a separator character, so it reads as an aside
  /// instead of as part of the name.
  final String? note;

  /// A mark at the row's far end, after [note] — a state the row has rather
  /// than a word about it.
  ///
  /// For a fact that repeats down a list, where the same short phrase on every
  /// other row turns the column into noise the eye has to re-read. A glyph is
  /// scanned once. Give it a [Tooltip]: a mark carries no meaning to a reader
  /// meeting it for the first time, and there is nowhere else in a menu row to
  /// put the sentence.
  final Widget? trailing;
  final FocusNode? focusNode;

  /// A quiet SECOND LINE under the label, for a row whose label alone does not
  /// say what picking it does — "Most tokens read in the last 24h" under
  /// "Input tokens", "That, plus…" under a role.
  ///
  /// Distinct from [note], which sits *beside* the label and qualifies the same
  /// noun ("System — SF Pro"). A sentence cannot go there: a menu is as wide as
  /// its button, and the qualifier would arrive clipped to its first three
  /// words. So this row grows a line instead of the panel growing a column.
  ///
  /// It makes the row taller, which is why a caller that has to SIZE a panel
  /// asks [AppMenuRowMetrics.detailExtent] rather than [AppMenuRowMetrics.extent].
  final String? detail;

  /// A subject's mark, such as its agent logo. Replaces [icon] in the fixed
  /// leading slot. The trailing check never displaces this identity.
  final Widget? leading;

  /// Which of the two row sizes this is. Defaults to a context menu's; a picker
  /// passes [AppMenuRowMetrics.roomy].
  final AppMenuRowMetrics metrics;
  final TextStyle? textStyle;

  /// This row is the current choice.
  ///
  /// Marked THREE ways, never by one: an accent wash, a heavier label, and a
  /// tick in the trailing slot. Colour alone fails anyone who cannot separate
  /// these two greys, and a tick alone is easy to miss in a long list.
  final bool selected;

  final VoidCallback onPressed;

  /// Red at rest for a destructive action. Active rows retain the common
  /// white-on-blue selection so pointer and keyboard feedback remain legible.
  final bool danger;

  @override
  State<AppMenuItem> createState() => _AppMenuItemState();
}

class _AppMenuItemState extends State<AppMenuItem> {
  bool _hovered = false;
  bool _focused = false;

  @override
  Widget build(BuildContext context) {
    // Lives in the MenuAnchor's overlay, so it watches for itself.
    AppTheme.watch(context);
    final error = Theme.of(context).colorScheme.error;
    final active = _hovered || _focused;
    final tint = active
        ? AppDesktop.onSelection
        : widget.danger
        ? error
        : AppPalette.textSecondary;
    // Keep the identity column even when a row has no mark.
    final glyph = widget.icon;

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
      child: Material(
        color: Colors.transparent,
        borderRadius: BorderRadius.circular(AppDesktop.rowRadius),
        child: InkWell(
          focusNode: widget.focusNode,
          onTap: widget.onPressed,
          onHover: (hovered) => setState(() => _hovered = hovered),
          onFocusChange: (focused) => setState(() => _focused = focused),
          mouseCursor: SystemMouseCursors.click,
          borderRadius: BorderRadius.circular(AppDesktop.rowRadius),
          hoverColor: Colors.transparent,
          focusColor: Colors.transparent,
          splashFactory: NoSplash.splashFactory,
          child: Ink(
            decoration: BoxDecoration(
              color: active
                  ? AppDesktop.selection
                  : widget.selected
                  ? AppSurface.accentWash
                  : Colors.transparent,
              borderRadius: BorderRadius.circular(AppDesktop.rowRadius),
            ),
            padding: widget.metrics.padding,
            child: Row(
              children: [
                // Fixed slot: these glyphs differ in width, and without it every
                // label would start at a slightly different column — and a
                // ticked row would sit a few pixels off an unticked one.
                SizedBox(
                  width: widget.metrics.iconSize,
                  child: widget.leading != null
                      ? IconTheme.merge(
                          data: IconThemeData(
                            color: tint,
                            size: widget.metrics.iconSize,
                          ),
                          child: widget.leading!,
                        )
                      : (glyph == null
                            ? null
                            : Icon(
                                glyph,
                                size: widget.metrics.iconSize,
                                color: tint,
                              )),
                ),
                const SizedBox(width: 9),
                Flexible(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        widget.label,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: (widget.textStyle ?? AppType.body()).copyWith(
                          color: active
                              ? AppDesktop.onSelection
                              : widget.danger
                              ? error
                              : AppPalette.textPrimary,
                          height: 1.2,
                          fontWeight: widget.selected
                              ? AppFont.medium
                              : AppFont.regular,
                        ),
                      ),
                      if (widget.detail case final detail?) ...[
                        const SizedBox(height: 2),
                        Text(
                          detail,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: AppType.caption(
                            color: active
                                ? AppDesktop.selectionDetail
                                : AppPalette.textSecondary,
                            height: 1.25,
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
                if (widget.note != null) ...[
                  const SizedBox(width: 8),
                  Flexible(
                    child: Text(
                      widget.note!,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: AppType.body(
                        color: active
                            ? AppDesktop.selectionDetail
                            : AppPalette.textSecondary,
                        height: 1.2,
                      ),
                    ),
                  ),
                ],
                if (widget.trailing != null) ...[
                  const SizedBox(width: 8),
                  widget.trailing!,
                ],
                if (widget.selected) ...[
                  const SizedBox(width: 12),
                  Icon(
                    AppIcons.check,
                    size: widget.metrics.iconSize,
                    color: tint,
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// The rule that sets a destructive row apart from the ordinary ones.
class AppMenuDivider extends StatelessWidget {
  const AppMenuDivider({super.key});

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 5),
      child: Divider(height: 1, thickness: 1, color: AppPalette.divider),
    );
  }
}
