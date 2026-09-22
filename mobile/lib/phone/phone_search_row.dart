import 'package:flutter/material.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';

import 'phone_destination.dart';
import 'phone_prompt_context.dart';
import 'phone_search_row_trailing.dart';
import 'search_result_text.dart';

/// One result: the name, and under it where the thing lives.
///
/// The desktop's `_SearchRowContent` in its `stacked` form, which is not a
/// concession — the desktop stacks whenever its result column is under 700px
/// (`swarm_switcher.dart`), and a phone always is. Everything else is the
/// desktop's: the name set in the terminal's own face, and under it the identity
/// line drawn as segments with their own glyphs rather than written out as
/// `Codex · work · box`.
///
/// ⚠️ **No leading mark and no trailing age.** Both were the phone's own, and
/// both are what made the two lists look like different features. The engine is
/// said by `>_ Claude` at the head of the identity line, exactly where the
/// desktop says it; a machine or a project says its kind in its own detail.
class PhoneSearchRow extends StatefulWidget {
  const PhoneSearchRow({
    super.key,
    required this.row,
    required this.terms,
    required this.now,
    required this.openable,
    required this.onTap,
    this.quote,
    this.resuming = false,
  });

  final PhoneDestination row;
  final List<String> terms;

  /// One clock for the whole list, so two rows built a frame apart cannot
  /// disagree about what a row says. Only reached for on a row that cannot be
  /// opened — see [PhoneSearchTrailing].
  final DateTime now;

  /// Whether a tap can do anything — the controller's `canSubmit`. A row that
  /// cannot is dimmed with the reason on its trailing edge rather than hidden:
  /// an agent whose terminal has gone is still the answer to "where did it go".
  final bool openable;

  final VoidCallback onTap;

  /// Whether this row's agent is being brought back right now, so the trailing
  /// edge spins instead of repeating `Stopped` at somebody already waiting.
  final bool resuming;

  /// The line of session content that explains a row nothing else on it would:
  /// see [phoneContentSnippet]. Replaces the identity line when there is one,
  /// because a row matched on something said in its conversation has nothing on
  /// it that says why.
  final String? quote;

  @override
  State<PhoneSearchRow> createState() => _PhoneSearchRowState();
}

class _PhoneSearchRowState extends State<PhoneSearchRow> {
  bool _pressed = false;

  void _press(bool pressed) {
    if (!widget.openable || _pressed == pressed) return;
    setState(() => _pressed = pressed);
  }

  void _open() {
    // The keyboard goes away with the screen, not a frame after it — dismissing
    // it first keeps the push from animating over a collapsing inset.
    FocusManager.instance.primaryFocus?.unfocus();
    widget.onTap();
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final row = widget.row;
    final matches = phoneResultMatches(row, widget.terms);
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTapDown: (_) => _press(true),
      onTapUp: (_) => _press(false),
      onTapCancel: () => _press(false),
      onTap: widget.openable ? _open : null,
      child: AnimatedContainer(
        duration: AppMotion.press,
        curve: AppMotion.curve,
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 9),
        decoration: BoxDecoration(
          // No resting fill. The desktop's picker has none either: forty rows
          // each in their own box is a wall rather than a list.
          color: _pressed ? AppGlass.rowFill : Colors.transparent,
          borderRadius: BorderRadius.circular(AppCard.radius),
        ),
        child: Opacity(
          opacity: widget.openable ? 1 : 0.55,
          child: Row(
            children: [
              Expanded(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    SearchResultText(
                      row.title,
                      matches: matches.where((match) => match.title),
                      style: phoneBoxMonoStyle(
                        size: 14,
                        color: AppPalette.textPrimary,
                        weight: FontWeight.w500,
                      ),
                    ),
                    const SizedBox(height: 3),
                    _detail(row, matches),
                  ],
                ),
              ),
              PhoneSearchTrailing(
                row: row,
                openable: widget.openable,
                resuming: widget.resuming,
                now: widget.now,
              ),
            ],
          ),
        ),
      ),
    );
  }

  /// The identity line, or what stands in for it.
  ///
  /// Three cases, in the desktop's own order of preference: a quote from the
  /// conversation when that is why the row is here, the drawn identity when the
  /// row has one, and otherwise the plain detail a group or a command carries.
  Widget _detail(PhoneDestination row, List<PhoneFieldMatch> matches) {
    final quote = widget.quote;
    if (quote != null) {
      return SearchResultText(
        quote,
        matches: phoneContentMatches(widget.terms),
        style: phoneBoxMonoStyle(size: 12, color: AppPalette.textFaint),
      );
    }
    final identity = row.promptContext;
    if (identity != null) {
      return PhonePromptContextView(
        contextData: identity,
        matches: matches.where((match) => !match.title),
      );
    }
    if (row.detail.isEmpty) return const SizedBox.shrink();
    return SearchResultText(
      row.detail,
      matches: matches.where((match) => !match.title),
      style: phoneBoxMonoStyle(size: 12, color: AppPalette.textFaint),
    );
  }
}
