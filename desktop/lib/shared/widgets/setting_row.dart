import 'package:flutter/material.dart';

import '../theme/app_theme.dart';

/// One setting: a title and a line of detail on the left, its control on the
/// right.
///
/// The shape every preference in this app is stated in. It began private inside
/// Appearance ▸ Typography and moved here the moment Settings ▸ Terminal needed
/// the same row — two panes inventing their own answer to "what does a setting
/// look like" is exactly how the Terminal pane ended up wearing raw Material
/// while the one beside it wore the design system.
class SettingRow extends StatelessWidget {
  const SettingRow({
    super.key,
    required this.title,
    this.detail,
    required this.control,
    this.controlSemanticLabel,
    this.footer,
    this.alignTop = false,
    this.badge,
  });

  final String title;
  final String? detail;
  final Widget control;

  /// Purpose of a single otherwise unlabeled control, such as a switch.
  ///
  /// Opt in only when [control] has one action. Rows containing several fields
  /// or buttons keep their separate labels and actions instead of merging them.
  final String? controlSemanticLabel;

  /// Guidance or feedback that belongs inside this setting's block.
  final Widget? footer;

  /// Align taller controls with the title; compact controls stay centered.
  final bool alignTop;

  /// A small tag after the title, such as `New`. Null draws the title alone.
  final String? badge;

  /// Fixed, so every control on this screen lines up on one right edge.
  static const double controlWidth = 188;

  /// Below this the control drops under the text and takes the full width.
  /// Squeezing it instead is what used to push it out past the row's own edge.
  static const double _stackBelow = controlWidth + 20 + 130;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final text = Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        if (badge case final badge?)
          Row(
            children: [
              Flexible(
                child: Text(
                  title,
                  style: Theme.of(context).textTheme.titleSmall,
                ),
              ),
              const SizedBox(width: 6),
              _Badge(badge),
            ],
          )
        else
          Text(title, style: Theme.of(context).textTheme.titleSmall),
        if (detail case final detail?) ...[
          const SizedBox(height: 2),
          Text(detail, style: Theme.of(context).textTheme.bodySmall),
        ],
      ],
    );
    final labeledControl = controlSemanticLabel == null
        ? control
        : Semantics(label: controlSemanticLabel, child: control);

    return Container(
      // A raised block: fill plus a soft lift, no rim. The same recipe the rest
      // of the app gives a row you can act on, so a setting here sits at the
      // same height as a row anywhere else.
      decoration: detail == null
          ? null
          : BoxDecoration(
              color: AppGlass.surfaceFill,
              borderRadius: BorderRadius.circular(14),
              boxShadow: AppGlass.cardShadow,
            ),
      padding: detail == null
          ? const EdgeInsets.symmetric(vertical: 8)
          : const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          LayoutBuilder(
            builder: (context, constraints) =>
                constraints.maxWidth <
                    MediaQuery.textScalerOf(context).scale(_stackBelow)
                ? Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      text,
                      const SizedBox(height: 10),
                      labeledControl,
                    ],
                  )
                : Row(
                    crossAxisAlignment: alignTop
                        ? CrossAxisAlignment.start
                        : CrossAxisAlignment.center,
                    children: [
                      Expanded(child: text),
                      const SizedBox(width: 20),
                      labeledControl,
                    ],
                  ),
          ),
          if (footer case final footer?) ...[const SizedBox(height: 8), footer],
        ],
      ),
    );
  }
}

class _Badge extends StatelessWidget {
  const _Badge(this.text);

  final String text;

  @override
  Widget build(BuildContext context) => DecoratedBox(
    decoration: BoxDecoration(
      color: AppPalette.warn.withValues(alpha: 0.12),
      borderRadius: BorderRadius.circular(4),
    ),
    child: Padding(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
      child: Text(text, style: AppType.caption(color: AppPalette.warn)),
    ),
  );
}
