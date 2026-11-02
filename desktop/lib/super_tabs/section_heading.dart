import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../shared/widgets/app_icon_button.dart';
import '../widgets/desktop_chrome.dart';
import '../widgets/finger_target.dart';

/// Keeps resource headings aligned whether their add action is available or not.
class SuperTabSectionHeading extends StatelessWidget {
  const SuperTabSectionHeading(
    this.title, {
    super.key,
    this.onAdd,
    this.addTooltip,
    this.trailing,
    this.actions = const [],
    this.endInset = 12,
    this.startInset,
    this.collapsed,
    this.onToggleCollapsed,
    this.titleTooltip,
  });

  final String title;
  final VoidCallback? onAdd;
  final String? addTooltip;

  /// Beside the title, before the add action: a status the heading carries, such as the Machines pill.
  final Widget? trailing;

  /// Compact actions right before the add action, each an [AppIconButton]
  /// the size of the add action itself.
  final List<Widget> actions;

  /// The space after the last action. The left sidebar passes 0 to align +
  /// with its rows' trailing disclosure controls.
  final double endInset;

  /// The space before the title; a collapsible heading's own inset when not
  /// given, else 16. The left sidebar passes [indentFor] 0 for a heading that
  /// does not collapse, to align it with the ones that do.
  final double? startInset;

  /// Whether a collapsible group's body is currently hidden. Ignored unless
  /// [onToggleCollapsed] is set.
  final bool? collapsed;

  /// Set on a heading that collapses a sidebar group; its label and an adjacent
  /// trailing chevron form one button on the left of the heading.
  final VoidCallback? onToggleCollapsed;

  /// What hovering a collapsible heading's title says: what the section
  /// shows, when its title alone does not. The chevron still says Collapse or
  /// Expand, and a screen reader hears this as the button's hint, never its
  /// name.
  final String? titleTooltip;

  /// The chevron and every action are a fixed 32 px square; the gap
  /// before the actions is 4 px; the title always keeps at least this
  /// much room, even when the trailing pill is at its widest.
  static const actionWidth = 32.0;

  /// Indentation for nested content outside the sidebar's flat navigation rows.
  static const indentStep = 16.0;

  /// Shared left inset of sidebar icon columns and section labels.
  static const _leadingInset = 4.0;

  /// The sidebar uses level 0 for every row, so names remain aligned. Higher
  /// levels remain available for other nested content.
  static double indentFor(int level) => _leadingInset + level * indentStep;

  static const _trailingGap = 4.0;

  @override
  Widget build(BuildContext context) {
    final collapsible = onToggleCollapsed != null;
    // A phone's add action is a finger's size.
    final phone = workspaceIsCompact(context);
    final addWidth = phone ? kFingerTarget : actionWidth;
    return Padding(
      padding: EdgeInsets.fromLTRB(
        startInset ?? (collapsible ? _leadingInset : 16),
        0,
        endInset,
        4,
      ),
      child: ConstrainedBox(
        constraints: const BoxConstraints(minHeight: 32),
        child: LayoutBuilder(
          builder: (context, constraints) {
            final titleStyle = DesktopChrome.metadata().copyWith(
              fontWeight: FontWeight.w600,
            );
            final titleMeasure = TextPainter(
              text: TextSpan(text: title, style: titleStyle),
              textDirection: Directionality.of(context),
              textScaler: MediaQuery.textScalerOf(context),
              maxLines: 1,
            )..layout();
            final titleWidth =
                titleMeasure.width +
                (collapsible ? AppIcons.inlineSize + _trailingGap : 0);
            titleMeasure.dispose();
            // Keep the heading readable before allowing a status pill to grow.
            // At narrow widths the pill can reduce to its icon and tooltip.
            final pillMaxWidth = trailing == null
                ? 0.0
                : (constraints.maxWidth -
                          actions.length * actionWidth -
                          (onAdd != null ? addWidth : 0) -
                          _trailingGap -
                          titleWidth)
                      .clamp(0.0, double.infinity);
            final titleLabel = Text(
              title,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: titleStyle,
            );
            return Row(
              children: [
                Expanded(
                  child: collapsible
                      ? Align(
                          alignment: Alignment.centerLeft,
                          child: Semantics(
                            button: true,
                            expanded: collapsed != true,
                            hint: titleTooltip,
                            child: Tooltip(
                              message:
                                  '${collapsed == true ? 'Expand' : 'Collapse'} $title',
                              child: InkWell(
                                onTap: onToggleCollapsed,
                                borderRadius: BorderRadius.circular(
                                  DesktopChrome.rowRadius,
                                ),
                                child: ConstrainedBox(
                                  constraints: const BoxConstraints(
                                    minHeight: 32,
                                  ),
                                  child: Row(
                                    mainAxisSize: MainAxisSize.min,
                                    children: [
                                      Flexible(
                                        child: titleTooltip == null
                                            ? titleLabel
                                            : Tooltip(
                                                message: titleTooltip,
                                                excludeFromSemantics: true,
                                                child: titleLabel,
                                              ),
                                      ),
                                      const SizedBox(width: _trailingGap),
                                      Icon(
                                        collapsed == true
                                            ? AppIcons.chevronRight
                                            : AppIcons.chevronDown,
                                        size: AppIcons.inlineSize,
                                        color: DesktopChrome.muted,
                                      ),
                                    ],
                                  ),
                                ),
                              ),
                            ),
                          ),
                        )
                      : titleLabel,
                ),
                if (trailing != null) ...[
                  ConstrainedBox(
                    constraints: BoxConstraints(maxWidth: pillMaxWidth),
                    child: trailing!,
                  ),
                  const SizedBox(width: _trailingGap),
                ],
                ...actions,
                if (onAdd != null)
                  fingerTarget(
                    enabled: phone,
                    AppIconButton(
                      icon: AppIcons.plus,
                      tooltip: addTooltip ?? title,
                      onPressed: onAdd,
                    ),
                  ),
              ],
            );
          },
        ),
      ),
    );
  }
}
