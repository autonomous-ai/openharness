/// The model picker's own furniture: the search field, the section headings, the rows and the
/// footer that closes the panel.
///
/// Model-specific content stays here; the surface and focusable actions share
/// the desktop menu treatment in `pane_menu.dart`.
///
/// Everything here is presentation and nothing here decides: what a row means, whether it can be
/// chosen, and what happens when it is are all the picker's ([GridModelPicker]).
library;

import 'package:harness/shared/theme/app_icons.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../models/model_mark.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../theme/app_theme.dart';
import 'desktop_chrome.dart';
import 'pane_menu.dart';
import 'resting_section.dart' show kUnavailableOpacity;

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
      borderRadius: BorderRadius.circular(DesktopChrome.controlRadius),
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
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final highContrast = MediaQuery.highContrastOf(context);
    final border = OutlineInputBorder(
      borderRadius: BorderRadius.circular(DesktopChrome.controlRadius),
      borderSide: BorderSide(
        color: highContrast
            ? DesktopChrome.foreground.withValues(alpha: .55)
            : DesktopChrome.rim,
      ),
    );
    return ConstrainedBox(
      constraints: const BoxConstraints(minHeight: 40),
      // The existing list-navigation shortcuts stay nearest the editor.
      child: Shortcuts(
        shortcuts: const <ShortcutActivator, Intent>{
          SingleActivator(LogicalKeyboardKey.arrowDown): NextFocusIntent(),
          SingleActivator(LogicalKeyboardKey.arrowUp): PreviousFocusIntent(),
        },
        child: TextField(
          controller: controller,
          onChanged: onChanged,
          autofocus: true,
          style: DesktopChrome.control(),
          textAlignVertical: TextAlignVertical.center,
          cursorColor: DesktopChrome.accent,
          decoration: InputDecoration(
            hintText: 'Search models or machines',
            hintStyle: DesktopChrome.control(color: DesktopChrome.muted),
            prefixIcon: Icon(
              AppIcons.search,
              size: 16,
              color: DesktopChrome.muted,
            ),
            prefixIconConstraints: const BoxConstraints(
              minWidth: 36,
              minHeight: 36,
            ),
            isDense: true,
            filled: true,
            fillColor: DesktopChrome.field,
            border: border,
            enabledBorder: border,
            focusedBorder: border.copyWith(
              borderSide: BorderSide(
                color: DesktopChrome.focusRing,
                width: grid.AppDesktop.focusWidth,
              ),
            ),
            contentPadding: const EdgeInsets.symmetric(
              horizontal: 12,
              vertical: 10,
            ),
          ),
        ),
      ),
    );
  }
}

/// A section's name and the number of visible models it contains.
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
      16,
      kModelPickerInset,
      8,
    ),
    child: Row(
      children: [
        Expanded(
          child: Text(
            label,
            style: DesktopChrome.metadata().copyWith(
              fontWeight: FontWeight.w500,
            ),
          ),
        ),
        if (count != null) Text('$count', style: DesktopChrome.metadata()),
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
    this.dimmed = false,
  });

  final String title;
  final String subtitle;
  final bool selected;
  final VoidCallback onTap;
  final Widget? avatar;

  /// Greyed: a row the picker still offers but that will not answer right now — every computer
  /// serving it seems offline. Still a choice; what picking it does is the picker's to decide.
  final bool dimmed;

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
    grid.AppTheme.watch(context);
    return PaneMenuAction(
      onPressed: onTap,
      selected: selected,
      builder: (context, active) {
        final row = Row(
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            if (avatar != null) ...[
              dimmed
                  ? Opacity(opacity: kUnavailableOpacity, child: avatar)
                  : avatar!,
              const SizedBox(width: 11),
            ],
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Tooltip(
                    message: title,
                    child: Text(
                      title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style:
                          DesktopChrome.control(
                            color: active
                                ? grid.AppDesktop.onSelection
                                : dimmed
                                ? DesktopChrome.muted
                                : DesktopChrome.foreground,
                            medium: true,
                          ).copyWith(
                            fontWeight: selected
                                ? FontWeight.w600
                                : FontWeight.w500,
                          ),
                    ),
                  ),
                  if (subtitle.isNotEmpty) ...[
                    const SizedBox(height: 2),
                    Text(
                      subtitle,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: DesktopChrome.metadata(
                        color: active ? grid.AppDesktop.onSelection : null,
                      ),
                    ),
                  ],
                  if (hint != null) ...[
                    const SizedBox(height: 2),
                    // Two lines: "<computer> seems offline — its models come back when it does" is
                    // longer than a row is wide, and cut short it no longer says when.
                    Text(
                      hint!,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: DesktopChrome.metadata(
                        color: active ? grid.AppDesktop.onSelection : null,
                      ),
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
                child: active
                    ? ColorFiltered(
                        colorFilter: const ColorFilter.mode(
                          grid.AppDesktop.onSelection,
                          BlendMode.srcIn,
                        ),
                        child: trailing!,
                      )
                    : trailing!,
              ),
            ],
            const SizedBox(width: 8),
            SizedBox(
              width: 16,
              child: selected
                  ? Icon(
                      AppIcons.check,
                      size: 16,
                      color: active
                          ? grid.AppDesktop.onSelection
                          : DesktopChrome.foreground,
                    )
                  : null,
            ),
          ],
        );
        return Padding(
          padding: const EdgeInsets.symmetric(
            horizontal: kModelPickerInset,
            vertical: 8,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              row,
              if (meter != null) ...[
                const SizedBox(height: 8),
                ClipRRect(
                  borderRadius: BorderRadius.circular(3),
                  child: LinearProgressIndicator(
                    value: meter!.clamp(0, 1),
                    minHeight: 5,
                    backgroundColor: active
                        ? grid.AppDesktop.onSelection.withValues(alpha: .2)
                        : AppColors.border,
                    valueColor: AlwaysStoppedAnimation(
                      active
                          ? grid.AppDesktop.onSelection
                          : note ?? AppColors.accent,
                    ),
                  ),
                ),
              ],
            ],
          ),
        );
      },
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
    child: LayoutBuilder(
      builder: (context, constraints) {
        final count = Text(
          summary,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: DesktopChrome.metadata(),
        );
        final action = DesktopPill(
          label: actionLabel,
          icon: AppIcons.layoutGrid,
          onPressed: onAction,
          tooltip: actionLabel,
        );
        // At larger text sizes the action needs its own line so its label stays
        // readable. Both remain pinned while the model list scrolls above them.
        if (constraints.maxWidth <
            MediaQuery.textScalerOf(context).scale(300)) {
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              count,
              const SizedBox(height: DesktopChrome.controlGap),
              Align(alignment: Alignment.centerRight, child: action),
            ],
          );
        }
        // Flexible content pushed apart retains the shared left/right edges.
        return Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Flexible(child: count),
            const SizedBox(width: 12),
            Flexible(child: action),
          ],
        );
      },
    ),
  );
}
