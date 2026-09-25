import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';

import 'composing_keyboard.dart';
import 'phone_search_controller.dart';
import 'sheet_list.dart';

/// The search page's whole header: one bar, with the way out inside it.
///
/// Drawn here rather than through [PhoneHeader]: the page has no title. The
/// field IS the header, because nothing else on the screen is worth the 32pt
/// line a large title would take from the results.
///
/// The way back is a chevron at the bar's leading edge rather than a "Cancel"
/// beside it. The word cost the field a fifth of the screen's width to say what
/// the edge swipe, Android's back button and the chevron every other page wears
/// already say; the chevron takes the place of the magnifier, which the hint
/// text made redundant.
///
/// The terminal's sheet draws its own — see [SheetSearchField].
class PhoneSearchField extends StatelessWidget {
  const PhoneSearchField({
    super.key,
    required this.controller,
    required this.focus,
    required this.onChanged,
    required this.onClear,
    this.onBack,
    this.autofocus = true,
    this.hintText = kPhoneSearchHint,
  });

  final TextEditingController controller;
  final FocusNode focus;
  final ValueChanged<String> onChanged;
  final VoidCallback onClear;

  /// The chevron inside the bar. Null leaves it out, for a field that is not the
  /// page's whole header — [AgentsListPage] has a [PhoneHeader] of its own above
  /// it, whose back band is the way out, and a second chevron under the first
  /// would be two ways back stacked one over the other.
  final VoidCallback? onBack;

  /// Whether the field takes the keyboard as it appears.
  ///
  /// True on [PhoneSearchPage], which exists only to be typed into. False where
  /// the field sits over a list worth reading first: raising the keyboard there
  /// would bury half of what the person opened the screen to look at.
  final bool autofocus;

  /// What the empty field says it can do.
  ///
  /// ⚠️ **It names all four kinds, and that is the point.** It used to read
  /// "Search agents", which was true and was also the whole reason nobody on the
  /// phone knew that `>`, `#`, `@` and `?` existed — the desktop teaches its
  /// modes here and only here. The controller narrows it once a mode is open
  /// ("Search projects…"), so the long form is only ever read on an empty box.
  final String hintText;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
      // The rim lives on the BOX, never on the TextField inside it — see the
      // decoration below for why the field draws no border of its own. Listening
      // to the node here is what lets the box carry the focus state instead.
      child: ListenableBuilder(
        listenable: focus,
        builder: (context, child) => AnimatedContainer(
          duration: AppMotion.hover,
          curve: AppMotion.curve,
          height: 44,
          padding: const EdgeInsets.only(right: 12),
          decoration: BoxDecoration(
            color: AppGlass.rowFill,
            borderRadius: BorderRadius.circular(AppCard.radius),
            // Focus is said once, by the rim of the box the field fills. The
            // accent is the same one the caret already uses, so the two read as
            // one state rather than as two decorations.
            border: Border.all(
              color: focus.hasFocus
                  ? AppPalette.accentOnSurface
                  : AppGlass.hair,
            ),
          ),
          child: child,
        ),
        child: Row(
          children: [
            if (onBack != null)
              _BackButton(onTap: onBack!)
            else
              // The chevron's place, so the text starts on the same vertical
              // whether or not the bar carries one.
              const SizedBox(width: 14),
            Expanded(
              child: _QueryInput(
                controller: controller,
                focus: focus,
                onChanged: onChanged,
                autofocus: autofocus,
                hintText: hintText,
                // A size down from the query's own 16pt: the hint spells out
                // four modes and has to survive a 390pt screen without
                // ellipsing the last of them.
                hintStyle: TextStyle(color: AppPalette.textFaint, fontSize: 13),
              ),
            ),
            _ClearButton(controller: controller, onTap: onClear),
          ],
        ),
      ),
    );
  }
}

/// The terminal sheet's field: iOS's own search bar — a filled box with the
/// magnifier at its head, and "Cancel" beside it while the sheet is searching.
///
/// ```
///  ┌─────────────────────────┐
///  │ ⌕  Search harnesses     │  Cancel
///  └─────────────────────────┘
/// ```
///
/// ⚠️ **Not [PhoneSearchField], though it types the same.** That one is a
/// page's header — a rimmed bar with the way back inside it. This one sits in
/// a sheet the system's own sheets are drawn like, over a list drawn like
/// iOS's grouped lists, and a rimmed Material box at the top of it was the one
/// thing on the sheet speaking another language. What is typed is set up
/// identically — both hand their text to [_QueryInput].
///
/// ⚠️ **No rim on focus.** Cancel sliding in is what says the field has the
/// keyboard — the caret and the word are iOS's own way of saying it, and a
/// ring on top of them would be the same news told twice.
///
/// The hint names harnesses and nothing else: the modes `>` `#` `@` `?` are
/// offered as chips under the field once it is focused (see
/// `terminal_search.dart`), which is room this box never had to spell them out
/// in.
class SheetSearchField extends StatelessWidget {
  const SheetSearchField({
    super.key,
    required this.controller,
    required this.focus,
    required this.onChanged,
    required this.onClear,
    required this.hintText,
    this.onCancel,
    this.cancelLabel = 'Cancel',
  });

  final TextEditingController controller;
  final FocusNode focus;
  final ValueChanged<String> onChanged;
  final VoidCallback onClear;
  final String hintText;

  /// The word [onCancel] wears: "Cancel" while it ends a search, "Close" while
  /// it closes the sheet.
  final String cancelLabel;

  /// "Cancel", beside the box. Null leaves it out.
  ///
  /// Set for as long as the sheet is searching: it ends the SEARCH — results
  /// out, tabs back — and leaves the sheet up. It slides in as it is set and
  /// out as it is cleared, the box giving it room as it comes; see
  /// [_CancelButton].
  final VoidCallback? onCancel;

  /// The box's height — `UISearchBar`'s, a size under a row's so the field
  /// reads as part of the sheet's chrome rather than as its first row.
  static const double _height = 36;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Padding(
      // Close under the grip, and closer still to what follows: the pills and
      // the chips under it bring 6pt of their own, so the two gaps land level.
      padding: const EdgeInsets.fromLTRB(16, 6, 16, 4),
      child: Row(
        children: [
          Expanded(
            child: GestureDetector(
              // The magnifier is part of the box, and a tap on it is a tap on
              // the field — the TextField itself only reaches from the hint on.
              onTap: focus.requestFocus,
              child: Container(
                height: _height,
                padding: const EdgeInsets.symmetric(horizontal: 8),
                decoration: BoxDecoration(
                  // The rows' own fill: iOS fills its search field with the
                  // same lift over the sheet as the cells below it, so the
                  // box reads as part of the list it searches.
                  color: sheetRowFill,
                  borderRadius: BorderRadius.circular(10),
                ),
                child: Row(
                  children: [
                    Icon(
                      LucideIcons.search,
                      size: 16,
                      color: AppPalette.textSecondary,
                    ),
                    const SizedBox(width: 6),
                    Expanded(
                      child: _QueryInput(
                        controller: controller,
                        focus: focus,
                        onChanged: onChanged,
                        // The sheet is opened to read its tabs, and focus is
                        // what trades them for the results.
                        autofocus: false,
                        hintText: hintText,
                        // The query's own size, and ink a step under it: the
                        // hint is one short phrase here, and iOS draws its
                        // placeholder bright enough to be read at a glance.
                        hintStyle: TextStyle(
                          color: AppPalette.textSecondary,
                          fontSize: 16,
                        ),
                      ),
                    ),
                    _ClearButton(controller: controller, onTap: onClear),
                  ],
                ),
              ),
            ),
          ),
          _CancelButton(onTap: onCancel, label: cancelLabel),
        ],
      ),
    );
  }
}

/// "Cancel" — see [SheetSearchField.onCancel].
///
/// ⚠️ **Kept built while it leaves, and dead while it does.** The word has to
/// be on screen to be seen sliding out; taken down with the search, the box
/// would jump back to its full width over a gap. And the tap that ended the
/// search must not land on it a second time on the way out.
class _CancelButton extends StatelessWidget {
  const _CancelButton({required this.onTap, required this.label});

  final VoidCallback? onTap;
  final String label;

  static const Duration _slide = Duration(milliseconds: 250);

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final onTap = this.onTap;
    return TweenAnimationBuilder<double>(
      tween: Tween(end: onTap == null ? 0 : 1),
      duration: _slide,
      curve: Curves.easeOutCubic,
      builder: (context, shown, child) => shown == 0
          ? const SizedBox.shrink()
          : ClipRect(
              child: Align(
                // Pinned by its LEFT edge to the room the box gives up, so the
                // word arrives from the right-hand edge of the screen and
                // leaves the same way.
                alignment: Alignment.centerLeft,
                widthFactor: shown,
                child: Opacity(opacity: shown, child: child),
              ),
            ),
      child: Semantics(
        button: true,
        enabled: onTap != null,
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: onTap,
          child: Padding(
            // Padding, not a gap: the space between the box and the word is
            // part of the word's target.
            padding: const EdgeInsets.only(left: 12),
            child: SizedBox(
              height: SheetSearchField._height,
              child: Center(
                child: Text(
                  label,
                  maxLines: 1,
                  style: TextStyle(
                    // The accent the caret already wears: the word belongs to
                    // the state the caret is in, and goes with it. Regular
                    // weight, as the system's own Cancel is — it is a way out,
                    // not the thing the sheet is for.
                    color: AppPalette.accentOnSurface,
                    fontSize: 16,
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// The bar's full height and a thumb's width, not the glyph's: the chevron sits
/// against the bar's rounded edge, where a miss is the easiest to make.
class _BackButton extends StatelessWidget {
  const _BackButton({required this.onTap});

  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Semantics(
      button: true,
      label: 'Back',
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: onTap,
        child: SizedBox(
          width: 40,
          height: 44,
          child: Icon(
            LucideIcons.chevronLeft300,
            size: 22,
            color: AppPalette.textPrimary,
          ),
        ),
      ),
    );
  }
}

class _QueryInput extends StatelessWidget {
  const _QueryInput({
    required this.controller,
    required this.focus,
    required this.onChanged,
    required this.autofocus,
    required this.hintText,
    required this.hintStyle,
  });

  final TextEditingController controller;
  final FocusNode focus;
  final ValueChanged<String> onChanged;
  final bool autofocus;
  final String hintText;

  /// The hint's size and ink, which is the one thing the two fields that
  /// share this input disagree on — see the call sites for why each is sized
  /// as it is.
  final TextStyle hintStyle;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return TextField(
      controller: controller,
      focusNode: focus,
      autofocus: autofocus,
      onChanged: onChanged,
      // The list is already filtered by the time a key is released; there is
      // nothing left for the return key to submit, so it stays a plain "done"
      // that drops the keyboard and leaves the results up.
      textInputAction: TextInputAction.search,
      onSubmitted: (_) => focus.unfocus(),
      // Composing stays on — or Telex types `thoi tiet` for `thời tiết`. See
      // [ComposingKeyboard]; with autocorrect on, iOS would also start curling
      // quotes and joining dashes, which a query means literally.
      autocorrect: ComposingKeyboard.autocorrect,
      enableSuggestions: ComposingKeyboard.enableSuggestions,
      smartDashesType: SmartDashesType.disabled,
      smartQuotesType: SmartQuotesType.disabled,
      // Agent names are ids as often as sentences — `Dijkstra-visualization.html`
      // — and a capital forced onto the first letter of one is a wrong query.
      textCapitalization: TextCapitalization.none,
      // With the decoration's padding zeroed below, the field is exactly one line
      // tall inside its box (44pt on the page, 36 in the sheet); this is what
      // centres that line on the chevron or magnifier beside it instead of
      // letting it sit on the box's top edge.
      textAlignVertical: TextAlignVertical.center,
      style: TextStyle(color: AppPalette.textPrimary, fontSize: 16),
      cursorColor: AppPalette.accentOnSurface,
      decoration: InputDecoration(
        isDense: true,
        // ⚠️ **Every** border state, not just `border`.
        //
        // `border` alone is the wrong half of the fix: it is the fallback, and
        // the app's `inputDecorationTheme` fills the named states in —
        // `focusedBorder` is a 1.5px accent outline at [AppControl.radius] (8).
        // This box is [AppCard.radius] (12), so focusing drew a second, tighter
        // blue rectangle INSIDE the rim. Naming each state is what keeps the
        // theme from reaching past `border`.
        border: InputBorder.none,
        enabledBorder: InputBorder.none,
        focusedBorder: InputBorder.none,
        errorBorder: InputBorder.none,
        focusedErrorBorder: InputBorder.none,
        disabledBorder: InputBorder.none,
        // The theme also fills these, and both would draw on top of the box: a
        // `surfaceContainerHighest` fill over the box's own, and Material's
        // phone-sized padding over the box's height.
        filled: false,
        contentPadding: EdgeInsets.zero,
        constraints: const BoxConstraints(),
        hintText: hintText,
        hintStyle: hintStyle,
      ),
    );
  }
}

/// Only once there is something to clear: a button that does nothing on an
/// empty field is a button people learn to skip.
class _ClearButton extends StatelessWidget {
  const _ClearButton({required this.controller, required this.onTap});

  final TextEditingController controller;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return ValueListenableBuilder(
      valueListenable: controller,
      builder: (context, value, _) => value.text.isEmpty
          ? const SizedBox.shrink()
          : Semantics(
              button: true,
              label: 'Clear',
              child: GestureDetector(
                behavior: HitTestBehavior.opaque,
                onTap: onTap,
                child: Padding(
                  // Padding, not size: the glyph stays small while the target
                  // reaches a thumb.
                  padding: const EdgeInsets.only(left: 8),
                  child: Icon(
                    LucideIcons.circleX300,
                    size: 18,
                    color: AppPalette.textFaint,
                  ),
                ),
              ),
            ),
    );
  }
}
