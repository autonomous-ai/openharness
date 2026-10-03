import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';

import 'composing_keyboard.dart';

/// A field over a list it filters — the All harnesses page and the branch picker: one rimmed bar,
/// the rim lit while it has the keyboard, and a clear button once there is something to clear.
///
/// ⚠️ **It never takes the keyboard on the way in.** Both lists are worth reading before anything
/// is typed — most repositories have a handful of branches and the answer is on screen already —
/// and a keyboard raised as the page appears would bury half of what the person opened it to see.
class PhoneSearchField extends StatelessWidget {
  const PhoneSearchField({
    super.key,
    required this.controller,
    required this.focus,
    required this.onChanged,
    required this.onClear,
    required this.hintText,
  });

  final TextEditingController controller;
  final FocusNode focus;
  final ValueChanged<String> onChanged;
  final VoidCallback onClear;

  /// What the empty field says it searches.
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
            const SizedBox(width: 14),
            Expanded(
              child: _QueryInput(
                controller: controller,
                focus: focus,
                onChanged: onChanged,
                hintText: hintText,
              ),
            ),
            _ClearButton(controller: controller, onTap: onClear),
          ],
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
    required this.hintText,
  });

  final TextEditingController controller;
  final FocusNode focus;
  final ValueChanged<String> onChanged;
  final String hintText;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return TextField(
      controller: controller,
      focusNode: focus,
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
      // tall inside its 44pt box; this is what centres that line in the box
      // instead of letting it sit on the box's top edge.
      textAlignVertical: TextAlignVertical.center,
      // ⚠️ The face the placeholder and every row under it are in — the terminal's. Left to
      // TextField, what is typed took the theme's sans and the query changed typeface the moment
      // the first key landed.
      style: TextStyle(
        fontFamily: DefaultTextStyle.of(context).style.fontFamily,
        fontFamilyFallback: DefaultTextStyle.of(context)
            .style
            .fontFamilyFallback,
        color: AppPalette.textPrimary,
        fontSize: 16,
      ),
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
        // A size down from the query's own 16pt. Set when the hint spelled out
        // four modes on a 390pt screen, and kept.
        hintStyle: TextStyle(color: AppPalette.textSecondary, fontSize: 13),
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
