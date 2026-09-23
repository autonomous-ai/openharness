import 'package:flutter/material.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';

import 'phone_destination.dart';
import 'phone_search_row_trailing.dart';
import 'search_result_text.dart';
import 'sheet_list.dart';

/// One result in the terminal sheet's search: what [PhoneSearchRow] says,
/// drawn as the row the sheet's tabs are drawn with — see [SheetRow].
///
/// ⚠️ **Set in the app's own face, not the terminal's.** [PhoneSearchRow] sets
/// its names in the terminal font for parity with the desktop's box, and on
/// the search page that holds. In the sheet the same agents were drawn in the
/// app's face a moment before, in the tabs these results replace — so the row
/// an agent had there is the row it keeps here, and the swap between the two
/// changes what is listed rather than how.
class SheetSearchRow extends StatelessWidget {
  const SheetSearchRow({
    super.key,
    required this.row,
    required this.terms,
    required this.openable,
    required this.first,
    required this.last,
    required this.onTap,
    this.quote,
    this.resuming = false,
    this.busy = false,
    this.onScreen = false,
  });

  final PhoneDestination row;
  final List<String> terms;

  /// Whether a tap can do anything — see [PhoneSearchRow.openable]. A row that
  /// cannot is dimmed, with the reason at its end.
  final bool openable;

  /// Whether this row opens its group, and whether it closes it.
  final bool first, last;

  final VoidCallback onTap;

  /// See [PhoneSearchRow.quote].
  final String? quote;

  /// See [PhoneSearchRow.resuming].
  final bool resuming;

  /// See [PhoneSearchRow.busy].
  final bool busy;

  /// Whether this is the agent the sheet was opened over. It wears the check,
  /// as it does in the tabs.
  final bool onScreen;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final row = this.row;
    final matches = phoneResultMatches(row, terms);
    return SheetRow(
      first: first,
      last: last,
      enabled: openable,
      selected: onScreen,
      onTap: openable && !busy ? _open : null,
      leading: _tile(row),
      title: SearchResultText(
        _title(row),
        matches: matches.where((match) => match.title),
        style: sheetRowTitleStyle(),
      ),
      subtitle: _subtitle(row, matches),
      trailing: _trailing(row),
      chevron: openable && !onScreen && !resuming,
    );
  }

  void _open() {
    // The keyboard goes away with the sheet, not a frame after it — dismissing
    // it first keeps the terminal from opening under a collapsing inset.
    FocusManager.instance.primaryFocus?.unfocus();
    onTap();
  }

  static Widget _tile(PhoneDestination row) => switch (row.kind) {
    PhoneDestinationKind.agent => SheetEngineTile(
      engine: row.engine,
      displayName: row.entry?.agent.engineDisplayName,
    ),
    PhoneDestinationKind.machine => const SheetGlyphTile('@'),
    PhoneDestinationKind.project => const SheetGlyphTile('#'),
    PhoneDestinationKind.command => const SheetGlyphTile('>'),
    PhoneDestinationKind.mode => SheetGlyphTile(_modeGlyph(row) ?? '?'),
  };

  /// A `?` row's own character — the one a tap on it puts in the field.
  static String? _modeGlyph(PhoneDestination row) {
    final glyph = row.pickerQuery?.trim();
    return glyph == null || glyph.isEmpty ? null : glyph;
  }

  /// The name as the row draws it. A `?` row's title carries its character at
  /// its head — `>  Commands` — and the tile beside it already says that.
  static String _title(PhoneDestination row) {
    final glyph = row.isMode ? _modeGlyph(row) : null;
    if (glyph == null || !row.title.startsWith(glyph)) return row.title;
    return row.title.substring(glyph.length).trimLeft();
  }

  /// The line under the name — in [PhoneSearchRow]'s own order of preference:
  /// a quote from the conversation when that is why the row is here, where
  /// the agent is when it is one, and otherwise the detail a group or a
  /// command carries.
  Widget? _subtitle(PhoneDestination row, List<PhoneFieldMatch> matches) {
    final details = matches.where((match) => !match.title);
    final quote = this.quote;
    if (quote != null) {
      return SearchResultText(
        quote,
        matches: phoneContentMatches(terms),
        style: sheetRowSubtitleStyle(),
      );
    }
    final identity = row.promptContext;
    if (identity != null) {
      return SheetPlaceLine(
        machine: identity.machine ?? row.machineLabel,
        folder: identity.project,
        branch: identity.branch,
        note: identity.leading,
        matches: details,
      );
    }
    if (row.detail.isEmpty) return null;
    return SearchResultText(
      row.detail,
      matches: details,
      style: sheetRowSubtitleStyle(),
    );
  }

  /// What the row ends in: the wait while it resumes, the word for why it will
  /// not simply open, or else — for an agent — what it is doing.
  Widget? _trailing(PhoneDestination row) {
    if (resuming) return const SheetRowSpinner();
    final badge = phoneSearchBadge(row, openable: openable);
    if (badge != null) return SheetRowNote(badge);
    final entry = row.entry;
    if (entry == null) return null;
    return SheetAgentStatus(summary: entry.summary, onScreen: onScreen);
  }
}
