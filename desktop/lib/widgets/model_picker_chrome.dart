/// The model picker's own furniture: the search field, the section headings, the rows and the
/// footer that closes the panel.
///
/// Kept here rather than in `pane_menu.dart` because this is ONE menu's look, not the shape every
/// pane menu shares. The find bar and the New Harness box draw their rows from `PaneMenuRow`, and
/// a model picker that wanted an avatar, a second line and a quota meter would have dragged all of
/// them somewhere they never asked to go.
///
/// Everything here is presentation and nothing here decides: what a row means, whether it can be
/// chosen, and what happens when it is are all the picker's ([GridModelPicker]).
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../models/model_mark.dart';
import '../shared/theme/app_type.dart';
import '../theme/app_theme.dart';

/// The panel's own width. Narrower than a row list, because every row here is two lines and the
/// eye reads a column better than a stripe.
const double kModelPickerWidth = 376;

/// The avatar's side, and the gutter its column occupies on every row.
const double kModelAvatarSize = 34;

/// The one inset every row's CONTENT sits at, from the edge of the box it is in: the search icon,
/// the section headings, the avatars and the footer's summary all start on this line, and the
/// counts, the quota figures and the meter all end on it. They used to sit at 16, 21, 24 and 14,
/// and a column of left edges that close together reads as a mistake rather than as a design.
const double kModelPickerInset = 12;

/// The widest a row's right-hand column may be. Stated rather than flexed: a Flexible beside the
/// Expanded title split the row in half and parked the column in the middle of it, away from the
/// edge the eye looks for a figure at.
const double kModelPickerTrailingMax = 120;

/// The same model artwork used in Models, with a brain fallback for unknown names.
class ModelAvatar extends StatelessWidget {
  const ModelAvatar({super.key, required this.label, this.child});

  final String label;
  final Widget? child;

  @override
  Widget build(BuildContext context) => Container(
    width: kModelAvatarSize,
    height: kModelAvatarSize,
    alignment: Alignment.center,
    decoration: BoxDecoration(
      color: AppColors.surface,
      borderRadius: BorderRadius.circular(9),
    ),
    child: child ?? ModelMark(model: label),
  );
}

/// The field that narrows the list. Its own widget so the panel can keep the query and rebuild
/// only the rows under it.
class ModelPickerSearch extends StatelessWidget {
  const ModelPickerSearch({
    super.key,
    required this.controller,
    required this.onChanged,
  });

  final TextEditingController controller;
  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context) => Container(
    height: 44,
    padding: const EdgeInsets.symmetric(horizontal: kModelPickerInset),
    decoration: BoxDecoration(
      color: AppColors.surface,
      borderRadius: BorderRadius.circular(10),
      border: Border.all(color: AppColors.border),
    ),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.center,
      children: [
        Icon(Icons.search, size: 16, color: AppColors.mutedStrong),
        const SizedBox(width: 9),
        Expanded(
          // ⚠️ Arrow keys belong to the LIST, not to the text.
          //
          // A text field consumes up and down for cursor movement, and it is the first thing this
          // panel focuses so a person can type straight away — which left the rows unreachable
          // from the keyboard entirely: every arrow went into the field and Enter submitted
          // nothing. `Shortcuts` nearest the focused node wins over the editing shortcuts the app
          // installs at its root, so this is where that is taken back.
          child: Shortcuts(
            shortcuts: const <ShortcutActivator, Intent>{
              SingleActivator(LogicalKeyboardKey.arrowDown): NextFocusIntent(),
              SingleActivator(LogicalKeyboardKey.arrowUp):
                  PreviousFocusIntent(),
            },
            // The nudge, and it is a nudge on purpose. The icon centres correctly in this row; the
            // text does not, because the decorator gives the field more height than the letters use
            // and hands the slack to the bottom. Several principled fixes were tried first — even
            // leading distribution, a pinned line height, sizing the box from its padding — and each
            // moved the number without closing the gap; the last one only made the box taller. What
            // is left is a measured offset, stated as one, rather than another theory dressed as a
            // layout rule. Half of it lands on the glyphs, which is why it is twice what the eye
            // asked for.
            child: Padding(
              padding: const EdgeInsets.only(top: 6),
              child: TextField(
                controller: controller,
                onChanged: onChanged,
                autofocus: true,
                // The LINE box centres correctly on its own; the glyphs inside it do not. The app's
                // sans face has a lopsided ascent and descent, and the default leading distribution
                // hands that asymmetry straight to the text — so the hint sat visibly high in a box a
                // widget test measures as perfectly centred, because a test measures the line box and
                // an eye sees the letters. Splitting the leading evenly is what puts them in the
                // middle of it.
                style: AppType.body(
                  color: AppColors.text,
                ).copyWith(leadingDistribution: TextLeadingDistribution.even),
                textAlignVertical: TextAlignVertical.center,
                cursorColor: AppColors.text,
                decoration: InputDecoration(
                  isCollapsed: true,
                  // ⚠️ EVERY border state, and `filled: false`. The app's theme gives fields a 1.5px
                  // accent `focusedBorder` and a fill of their own, and `border:` overrides neither —
                  // so a field that autofocuses the moment the panel opens drew a second, brighter box
                  // INSIDE the one around it. The box is this container's; the caret is the focus.
                  border: InputBorder.none,
                  enabledBorder: InputBorder.none,
                  focusedBorder: InputBorder.none,
                  disabledBorder: InputBorder.none,
                  errorBorder: InputBorder.none,
                  focusedErrorBorder: InputBorder.none,
                  filled: false,
                  contentPadding: EdgeInsets.zero,
                  hintText: 'Search models or machines',
                  hintStyle: AppType.body(
                    color: AppColors.muted,
                  ).copyWith(leadingDistribution: TextLeadingDistribution.even),
                ),
              ),
            ),
          ),
        ),
      ],
    ),
  );
}

/// A section's heading: what the group is, in small caps, with how many rows are under it.
///
/// The count is on the right and quiet. It answers "is the thing I want even here" before the eye
/// walks the list, which matters most in the section a search has just emptied.
class ModelPickerSectionHeader extends StatelessWidget {
  const ModelPickerSectionHeader({super.key, required this.label, this.count});

  final String label;
  final int? count;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(
      kModelPickerInset,
      14,
      kModelPickerInset,
      8,
    ),
    child: Row(
      children: [
        Expanded(
          child: Text(
            label.toUpperCase(),
            style: AppType.body(color: AppColors.mutedStrong).copyWith(
              fontSize: 11,
              fontWeight: FontWeight.w700,
              letterSpacing: 0.9,
            ),
          ),
        ),
        if (count != null)
          Text(
            '$count',
            style: AppType.body(color: AppColors.muted).copyWith(fontSize: 11),
          ),
      ],
    ),
  );
}

/// One model, as two lines beside its tile.
///
/// The id leads because it is what the person is choosing; the machine or account under it is how
/// they tell two copies of the same model apart. Both were one line and one weight before, which
/// made a row of `DeepSeek-V4-Flash-0731  scholes-60001` read as a single compound name.
class ModelPickerRow extends StatelessWidget {
  const ModelPickerRow({
    super.key,
    required this.title,
    required this.subtitle,
    required this.selected,
    required this.onTap,
    this.avatar,
    this.trailing,
    this.meter,
    this.note,
    this.hint,
  });

  final String title;
  final String subtitle;
  final bool selected;
  final VoidCallback onTap;
  final Widget? avatar;

  /// The right-hand column — a quota, a state, whatever the row is worth saying.
  final Widget? trailing;

  /// 0..1, drawn as a bar under the row. Only the subscription has one.
  final double? meter;

  /// The colour the meter runs in; ignored when [meter] is null.
  final Color? note;

  /// A third line, under the subtitle, about THIS row's launch rather than
  /// about the model — whether the agent can search the web on it. Only the
  /// current row ever has one: the others are places the agent could go, about
  /// which nothing is yet known.
  final String? hint;

  @override
  Widget build(BuildContext context) {
    final row = Row(
      crossAxisAlignment: CrossAxisAlignment.center,
      children: [
        if (avatar != null) ...[avatar!, const SizedBox(width: 11)],
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                title,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: AppType.body(color: AppColors.text)
                    .copyWith(fontWeight: FontWeight.w600, fontSize: 13.5),
              ),
              if (subtitle.isNotEmpty) ...[
                const SizedBox(height: 2),
                Text(
                  subtitle,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: AppType.mono(color: AppColors.mutedStrong),
                ),
              ],
              if (hint != null) ...[
                const SizedBox(height: 2),
                Text(
                  hint!,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: AppType.body(color: AppColors.muted)
                      .copyWith(fontSize: 11.5),
                ),
              ],
            ],
          ),
        ),
        if (trailing != null) ...[
          const SizedBox(width: 12),
          // Capped, not flexed — see [kModelPickerTrailingMax]. The cap is also what keeps a quota
          // column from overflowing the row at a large text size in a small window.
          ConstrainedBox(
            constraints: const BoxConstraints(
              maxWidth: kModelPickerTrailingMax,
            ),
            child: trailing!,
          ),
        ],
      ],
    );
    // No tick. The fill and its border are the mark, and a tick beside a quota figure crowded the
    // one thing on the row worth reading. A screen reader is told in words instead.
    return Semantics(
      selected: selected,
      child: MouseRegion(
        cursor: SystemMouseCursors.click,
        child: InkWell(
          onTap: onTap,
          mouseCursor: SystemMouseCursors.click,
          borderRadius: BorderRadius.circular(11),
          hoverColor: AppColors.rowHover,
          // Focus is a keyboard position, not a decision, and the panel focuses something the moment
          // it opens; painting it would light a row the person never pointed at.
          focusColor: Colors.transparent,
          splashColor: Colors.transparent,
          highlightColor: Colors.transparent,
          child: Container(
            padding: const EdgeInsets.symmetric(
              horizontal: kModelPickerInset,
              vertical: 9,
            ),
            decoration: BoxDecoration(
              color: selected ? AppColors.selected : null,
              borderRadius: BorderRadius.circular(11),
              border: selected
                  ? Border.all(color: AppColors.accent.withValues(alpha: 0.45))
                  : null,
            ),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                row,
                if (meter != null) ...[
                  const SizedBox(height: 9),
                  ClipRRect(
                    borderRadius: BorderRadius.circular(3),
                    child: LinearProgressIndicator(
                      value: meter!.clamp(0, 1),
                      minHeight: 5,
                      backgroundColor: AppColors.border,
                      valueColor: AlwaysStoppedAnimation(
                        note ?? AppColors.accent,
                      ),
                    ),
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

/// The bar that closes the panel: what the list adds up to, and the one action that is not a
/// choice among the rows.
class ModelPickerFooter extends StatelessWidget {
  const ModelPickerFooter({
    super.key,
    required this.summary,
    required this.actionLabel,
    required this.onAction,
  });

  final String summary;
  final String actionLabel;
  final VoidCallback onAction;

  @override
  Widget build(BuildContext context) => Container(
    // The summary starts on the content line the rows above it use; the button's box ends on the
    // line their boxes end on, and sits as far from the panel's bottom as from its side.
    padding: const EdgeInsets.fromLTRB(12 + kModelPickerInset, 12, 12, 12),
    decoration: BoxDecoration(
      border: Border(top: BorderSide(color: AppColors.border)),
    ),
    child: Row(
      // ⚠️ Both halves Flexible and pushed apart, never Expanded + Flexible. That pair splits the
      // row down the middle and leaves the button at the START of its half, stranded short of
      // the right edge. Flexible still gives each half a fair share when a large text size means
      // they cannot both have everything they want.
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: [
        Flexible(
          child: Text(
            summary,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: AppType.body(color: AppColors.muted).copyWith(fontSize: 12),
          ),
        ),
        const SizedBox(width: 12),
        Flexible(
          child: MouseRegion(
            cursor: SystemMouseCursors.click,
            child: InkWell(
              onTap: onAction,
              mouseCursor: SystemMouseCursors.click,
              borderRadius: BorderRadius.circular(9),
              hoverColor: AppColors.rowHover,
              focusColor: Colors.transparent,
              splashColor: Colors.transparent,
              highlightColor: Colors.transparent,
              child: Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: 14,
                  vertical: 9,
                ),
                decoration: BoxDecoration(
                  color: AppColors.surface,
                  borderRadius: BorderRadius.circular(9),
                  border: Border.all(color: AppColors.border),
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(
                      Icons.grid_view_rounded,
                      size: 15,
                      color: AppColors.textSoft,
                    ),
                    const SizedBox(width: 8),
                    // Flexible: at a large text size the summary and the action cannot both have
                    // everything they want, and a fixed label overflowed a small window.
                    Flexible(
                      child: Text(
                        actionLabel,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: AppType.body(
                          color: AppColors.text,
                        ).copyWith(fontSize: 12.5, fontWeight: FontWeight.w600),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ],
    ),
  );
}
