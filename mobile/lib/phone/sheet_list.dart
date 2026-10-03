import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';

// The pieces the branch picker (`branch_picker_sheet.dart`) lists with: iOS's
// inset-grouped list — one card of rows with hairlines between them, a caption
// over it.

/// How far a group stands in from the sheet's sides — the field and the tab
/// pills keep the same margin, so the sheet has one left edge.
const double kSheetInset = 16;

/// A row's content, in from its card's edge.
const double _rowPadding = 12;

/// The square at the head of a row: iOS Settings' icon tile.
const double _tileSize = 29;
const double _tileGap = 12;

/// Where a row's words start, measured from the card's edge. The hairline
/// between two rows starts here too, so it runs under the words and stops
/// short of the tiles — iOS's inset separator.
const double _textInset = _rowPadding + _tileSize + _tileGap;

/// A caption's inset: the group's margin plus the row's own padding, so a
/// caption starts over the tiles rather than over the card's rounded corner.
const double kSheetCaptionInset = kSheetInset + _rowPadding;

/// The floor every row clears — two lines of text and their padding. A row
/// with only a title is padded up to it, so a group reads as evenly spaced.
const double _minRowHeight = 56;

/// The sheet's own fill: the palette's card — the fill the app's dialogs stand
/// on their veil with — a step ABOVE the terminal the sheet covers.
///
/// ⚠️ **Lifted, not darkened around.** It was the panel, the darkest step the
/// palette has — darker than the terminal itself — and under the veil (see
/// [TerminalSearchOverlay]) the two blacks met: the sheet did not read as
/// standing on anything. A darker veil only moves both further towards black
/// and barely parts them. In a dark UI a raised surface is told by being
/// LIGHTER, which is how iOS draws its own sheets.
Color get sheetFill => AppPalette.cardBg;

/// A group's rows and the search field: the sheet's fill with
/// a wash of white over it.
///
/// A wash rather than the palette's next step, because the steps are not
/// spaced alike across palettes — Graphite's card and hover are a shade
/// apart, Midnight's a clear step — and a wash lifts by the same amount on
/// every one of them.
Color get sheetRowFill => Color.alphaBlend(AppSurface.selectedFill, sheetFill);

/// A row or a chip under the finger: lighter again, as a cell highlights on
/// iOS.
Color get sheetRowPressedFill =>
    Color.alphaBlend(AppSurface.recessHover, sheetRowFill);

/// A row's name.
TextStyle sheetRowTitleStyle() =>
    TextStyle(color: AppPalette.textPrimary, fontSize: 16, height: 1.25);

/// One row of an inset group: a tile, a name with a line under it, and what
/// the row ends in.
///
/// ```
///   OTHER                                10
///  ╭──────────────────────────────────────╮
///  │ ▣  Super AI                     ◌  › │
///  │    BBB · ⑂ main · Mac mini           │
///  │    ──────────────────────────────────│
///  │ ▣  Hỏi vài câu nhiều lựa chọn     ✓  │
///  │    codex-2026-09-22 · Mac mini       │
///  ╰──────────────────────────────────────╯
/// ```
///
/// ⚠️ **Each row draws its own share of the card**, rounding the corners only
/// where it opens or closes the group ([first], [last]). A card drawn once
/// around the rows would have to be a column of every row in it, and the
/// search can list forty — a lazy list builds only the rows on screen, and
/// only if each can be drawn on its own.
class SheetRow extends StatefulWidget {
  const SheetRow({
    super.key,
    required this.leading,
    required this.title,
    required this.first,
    required this.last,
    this.subtitle,
    this.trailing,
    this.chevron = true,
    this.onTap,
    this.enabled = true,
    this.selected = false,
    this.semanticsLabel,
  });

  /// A [SheetTile] — the row's engine, or the mode it belongs to.
  final Widget leading;

  final Widget title;
  final Widget? subtitle;

  /// What the row says before its chevron: its status, or why it cannot be
  /// opened.
  final Widget? trailing;

  /// The `›` that says a tap goes somewhere. Off where it goes nowhere new —
  /// the agent already on screen — and where it adds rather than opens.
  final bool chevron;

  /// Whether this row opens its group, and whether it closes it.
  final bool first, last;

  final VoidCallback? onTap;

  /// False dims the row's content — never its card, which would leave a hole
  /// in the group — for a row a tap cannot open.
  final bool enabled;

  /// The row whose agent is already on screen.
  final bool selected;

  /// Read in place of what the row says, for a row whose words only make
  /// sense to somebody looking at the rest of the sheet.
  final String? semanticsLabel;

  @override
  State<SheetRow> createState() => _SheetRowState();
}

class _SheetRowState extends State<SheetRow> {
  bool _pressed = false;

  void _press(bool pressed) {
    if (widget.onTap == null || _pressed == pressed) return;
    setState(() => _pressed = pressed);
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    const corner = Radius.circular(AppCard.radius);
    final subtitle = widget.subtitle;
    final trailing = widget.trailing;
    return Semantics(
      container: true,
      button: widget.onTap != null,
      selected: widget.selected,
      label: widget.semanticsLabel,
      excludeSemantics: widget.semanticsLabel != null,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTapDown: (_) => _press(true),
        onTapUp: (_) => _press(false),
        onTapCancel: () => _press(false),
        onTap: widget.onTap,
        child: AnimatedContainer(
          duration: AppMotion.press,
          curve: AppMotion.curve,
          constraints: const BoxConstraints(minHeight: _minRowHeight),
          decoration: BoxDecoration(
            // A cell highlights under the finger and does not move — the
            // group is one card, and a row shrinking inside it would tear it.
            color: _pressed ? sheetRowPressedFill : sheetRowFill,
            borderRadius: BorderRadius.vertical(
              top: widget.first ? corner : Radius.zero,
              bottom: widget.last ? corner : Radius.zero,
            ),
          ),
          child: Stack(
            alignment: AlignmentDirectional.centerStart,
            children: [
              Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: _rowPadding,
                  vertical: 8,
                ),
                child: Opacity(
                  opacity: widget.enabled ? 1 : 0.55,
                  child: Row(
                    children: [
                      widget.leading,
                      const SizedBox(width: _tileGap),
                      Expanded(
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            widget.title,
                            if (subtitle != null) ...[
                              const SizedBox(height: 2),
                              subtitle,
                            ],
                          ],
                        ),
                      ),
                      if (trailing != null) ...[
                        const SizedBox(width: 10),
                        trailing,
                      ],
                      if (widget.chevron) ...[
                        const SizedBox(width: 6),
                        Icon(
                          LucideIcons.chevronRight500,
                          size: 16,
                          color: AppPalette.textFaint,
                        ),
                      ],
                    ],
                  ),
                ),
              ),
              if (!widget.first)
                PositionedDirectional(
                  top: 0,
                  start: _textInset,
                  end: 0,
                  child: Container(
                    // One device pixel, whatever the screen: iOS's hairline.
                    // A logical point is three of them on a phone, which reads
                    // as a rule drawn between rows rather than a seam.
                    height: 1 / MediaQuery.devicePixelRatioOf(context),
                    color: AppGlass.hair,
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

/// The square at the head of a row, iOS Settings' icon tile.
class SheetTile extends StatelessWidget {
  const SheetTile({super.key, required this.child, this.fill});

  final Widget child;

  /// Null draws the tile's content bare — the `+` of a row that adds.
  final Color? fill;

  @override
  Widget build(BuildContext context) => SizedBox.square(
    dimension: _tileSize,
    child: DecoratedBox(
      decoration: BoxDecoration(
        color: fill,
        borderRadius: BorderRadius.circular(7),
      ),
      child: Center(child: child),
    ),
  );
}

/// A row's quiet word at its end — `Stopped`, `Offline` — iOS's detail text.
class SheetRowNote extends StatelessWidget {
  const SheetRowNote(this.text, {super.key});

  final String text;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Text(
      text,
      maxLines: 1,
      style: TextStyle(color: AppPalette.textSecondary, fontSize: 14),
    );
  }
}
