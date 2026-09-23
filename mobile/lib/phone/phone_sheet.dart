import 'dart:ui' show ImageFilter;

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/widgets/app_dialog.dart'
    show
        appDialogButtonStyle,
        kDialogControlRadius,
        kDialogVeilBlur,
        kSheetVeilOpacity,
        showAppDialog;

import 'settings_row.dart';

/// One action in a phone sheet.
class PhoneSheetAction {
  const PhoneSheetAction({
    required this.icon,
    required this.label,
    required this.onTap,
    this.destructive = false,
    this.value,
    this.valueColor,
    this.enabled = true,
    this.chevron = false,
  });

  final IconData icon;
  final String label;

  /// Run AFTER the sheet has closed — see [showPhoneSheet], which pops first and then calls this.
  /// A dialog opened from here would otherwise open behind the closing sheet.
  final VoidCallback onTap;

  final bool destructive;

  /// A quiet word at the end of the row — a machine's state, on a machine row.
  final String? value;

  /// The colour of [value]; the secondary text colour when null — what a [SettingsRow]'s value
  /// is drawn in, since the two rows now sit in the same cards.
  final Color? valueColor;

  /// False draws the row dimmed and leaves the sheet open on a tap: an offline machine is listed
  /// so its absence is not a mystery, not so it can be opened.
  final bool enabled;

  /// Ends the row with a chevron: it opens a page or a picker of its own rather than acting where
  /// it stands — Harnesses, Machines, Settings on an agent's sheet.
  ///
  /// The mark a [SettingsRow] that opens something carries, so a door reads as a door on both.
  /// Without it the doors and the actions were the same row, and nothing told them apart.
  final bool chevron;
}

/// A run of rows in a phone sheet, drawn as one card — under a caption, or with none.
class PhoneSheetSection {
  PhoneSheetSection({this.caption, required this.actions, this.maxVisible});

  /// The heading over the card. Null draws the card bare, a gap below the one before it: for a
  /// run the sheet's title already names, or for a row that has to stand apart from its
  /// neighbours — the destructive one that ends an agent's sheet.
  final String? caption;
  final List<PhoneSheetAction> actions;

  /// Rows shown before an "N more" row that reveals the rest. Null shows everything.
  final int? maxVisible;

  bool _expanded = false;

  List<PhoneSheetAction> get visible {
    final max = maxVisible;
    if (_expanded || max == null || actions.length <= max) return actions;
    return actions.take(max).toList();
  }

  int get hiddenCount => actions.length - visible.length;

  void expand() => _expanded = true;
}

/// The `⋯` menu on a phone page: a title line, then its actions in inset cards.
///
/// The desktop reaches the same actions through a right-click menu, which a phone has no gesture
/// for. One sheet rather than a menu per page: the actions differ, the shape does not.
///
/// The rows sit in cards — the Settings page's own [SettingsGroup], under its [SettingsCaption] —
/// so a sheet and the pages it opens onto read as one surface. A card is also what says which rows
/// belong together: in one flat column of equal rows, the actions ON the subject and the doors to
/// other pages looked the same, and the one row that cannot be undone sat among them like the rest.
///
/// [actions] is the first card, with no caption. Each of [sections] is a card after it — under its
/// caption, or a gap below the card before when it has none. An empty section is left out.
///
/// [titleLeading] is drawn left of the title — the engine mark, on an agent's sheet — and
/// [titleDetail] under [titleParts]: machine, folder and branch.
///
/// The page behind stands on the app's sheet veil, dimmed and blurred — see [_PhoneSheetRoute].
Future<void> showPhoneSheet(
  BuildContext context, {
  required String title,
  List<PhoneSheetAction> actions = const [],
  List<PhoneSheetSection> sections = const [],
  PhoneSheetAction? titleAction,
  List<String>? titleParts,
  Widget? titleDetail,
  Widget? titleLeading,
}) {
  assert(debugCheckHasMediaQuery(context));
  assert(debugCheckHasMaterialLocalizations(context));
  // What `showModalBottomSheet` does, with [_PhoneSheetRoute] pushed in place of its route —
  // that function has no way to take another. Every argument below is one it would pass for the
  // same call; the veil is the only difference.
  final navigator = Navigator.of(context, rootNavigator: true);
  final localizations = MaterialLocalizations.of(context);
  return navigator.push(
    _PhoneSheetRoute<void>(
      capturedThemes: InheritedTheme.capture(
        from: context,
        to: navigator.context,
      ),
      barrierLabel: localizations.scrimLabel,
      barrierOnTapHint: localizations.scrimOnTapHint(
        localizations.bottomSheetLabel,
      ),
      showDragHandle: true,
      backgroundColor: AppPalette.panelBg,
      // ⚠️ **Without this the sheet is capped at 9/16 of the screen**, which is Flutter's default and
      // is not a height anything here asked for. An agent's sheet — three cards, a caption, a two-line
      // title detail under the name — outgrows it on a normal phone, and the row that fell past the cap was
      // Settings: the column below scrolls, so nothing was broken, but a sheet that ends mid-list with
      // no bottom edge in sight reads as the whole menu rather than as a scrollable one.
      isScrollControlled: true,
      // A ceiling of its own, because `isScrollControlled` alone removes the cap altogether and lets a
      // long sheet stand up the full height of the screen — voice input's six languages would. Short of
      // the top on purpose: the gap is what says a sheet is a layer over the page rather than a page of
      // its own, and it keeps the terminal underneath recognisable while its own menu is open.
      constraints: BoxConstraints(
        maxHeight: MediaQuery.sizeOf(context).height * 0.85,
      ),
      builder: (sheetContext) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              // 20 from the edge is 4 inside the cards' own 16 — where a Settings caption stands over
              // its card — so the title reads as the heading of what follows it. A title with parts
              // (an agent's name over where it runs) is a block of its own and takes more room below.
              padding: EdgeInsets.fromLTRB(
                20,
                0,
                titleAction == null ? 20 : 8,
                titleParts == null ? 12 : 16,
              ),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (titleLeading != null) ...[
                    titleLeading,
                    const SizedBox(width: 14),
                  ],
                  Expanded(
                    child: titleParts == null
                        ? Text(
                            title,
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              color: AppPalette.textSecondary,
                              fontSize: 13,
                            ),
                          )
                        : Column(
                            mainAxisSize: MainAxisSize.min,
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              _TitleParts(parts: titleParts),
                              if (titleDetail != null) ...[
                                const SizedBox(height: 3),
                                titleDetail,
                              ],
                            ],
                          ),
                  ),
                  // [titleAction]: an icon on the title line — for something that is not about the
                  // subject of the sheet (Settings, on an agent's sheet), so it does not take a row
                  // among the actions that are. Its label is the tooltip.
                  if (titleAction != null)
                    IconButton(
                      tooltip: titleAction.label,
                      icon: Icon(
                        titleAction.icon,
                        size: 20,
                        color: AppPalette.textSecondary,
                      ),
                      visualDensity: VisualDensity.compact,
                      onPressed: () {
                        Navigator.of(sheetContext).pop();
                        titleAction.onTap();
                      },
                    ),
                ],
              ),
            ),
            // Scrolls once the rows outgrow the sheet — voice input's six languages do on a short phone —
            // and is laid out exactly like a plain column until then.
            Flexible(
              // Stateful only for [PhoneSheetSection.maxVisible]: "N more" opens the rest in place
              // rather than closing the sheet.
              child: StatefulBuilder(
                builder: (context, setSheetState) => ListView(
                  shrinkWrap: true,
                  // The cards' inset from the sheet's edge: the Settings list's own 16.
                  padding: const EdgeInsets.symmetric(horizontal: 16),
                  children: _sheetCards(
                    actions: actions,
                    sections: sections,
                    // Close first, then act: an action that opens a dialog or pushes a page must not
                    // do it underneath a sheet that is still animating out.
                    onAction: (action) {
                      Navigator.of(sheetContext).pop();
                      action.onTap();
                    },
                    // Stays open: this row reveals, it does not act.
                    onExpand: (section) => setSheetState(section.expand),
                  ),
                ),
              ),
            ),
            const SizedBox(height: 12),
          ],
        ),
      ),
    ),
  );
}

/// The route [showPhoneSheet] pushes: Material's own bottom sheet, standing on the app's sheet veil
/// rather than a flat `black54` — the page dimmed to [kSheetVeilOpacity] and blurred at
/// [kDialogVeilBlur], as it is under the search sheet.
///
/// ⚠️ **Blurred, because what is behind these sheets is usually a live terminal.** Dimmed text is
/// still text: under the flat tint its lines stayed legible — and moving — and the eye went on
/// reading them instead of the rows it opened the sheet for.
///
/// The blur rides the route's own animation on the tint's curve, so the two deepen together as the
/// sheet rises and thin together as a drag pulls it down. The route's `filter` would not: that is
/// applied at full strength from the first frame to the last, so the page would go soft before the
/// tint had begun and snap sharp only once the sheet had gone.
///
/// Everything else is [ModalBottomSheetRoute]'s own — the barrier this wraps included, with its tap
/// to dismiss and its semantics.
class _PhoneSheetRoute<T> extends ModalBottomSheetRoute<T> {
  _PhoneSheetRoute({
    required super.builder,
    required super.capturedThemes,
    required super.barrierLabel,
    required super.barrierOnTapHint,
    required super.backgroundColor,
    required super.constraints,
    required super.showDragHandle,
    required super.isScrollControlled,
  }) : super(
         modalBarrierColor: Colors.black.withValues(alpha: kSheetVeilOpacity),
       );

  @override
  Widget buildModalBarrier() {
    final animation = this.animation!;
    return AnimatedBuilder(
      animation: animation,
      builder: (context, barrier) {
        final blur = kDialogVeilBlur * barrierCurve.transform(animation.value);
        return BackdropFilter(
          // Off while there is nothing to blur: the first frame of the way up, the last of the way
          // down.
          enabled: blur > 0,
          filter: ImageFilter.blur(sigmaX: blur, sigmaY: blur),
          child: barrier,
        );
      },
      child: super.buildModalBarrier(),
    );
  }
}

/// The body of a sheet, as cards: [actions] first, then every section that has rows.
List<Widget> _sheetCards({
  required List<PhoneSheetAction> actions,
  required List<PhoneSheetSection> sections,
  required void Function(PhoneSheetAction action) onAction,
  required void Function(PhoneSheetSection section) onExpand,
}) {
  final cards = <Widget>[];
  void addCard(List<Widget> rows, {String? caption}) {
    if (caption != null) {
      cards.add(SettingsCaption(caption));
    } else if (cards.isNotEmpty) {
      // A bare card still has to part from the one above it, or the two read as one card with a
      // seam in it — and the row set apart would not be.
      cards.add(const SizedBox(height: 16));
    }
    cards.add(SettingsGroup(children: rows));
  }

  if (actions.isNotEmpty) {
    addCard([
      for (final action in actions)
        _SheetRow(action: action, onTap: () => onAction(action)),
    ]);
  }
  for (final section in sections) {
    if (section.actions.isEmpty) continue;
    addCard([
      for (final action in section.visible)
        _SheetRow(action: action, onTap: () => onAction(action)),
      if (section.hiddenCount > 0)
        _SheetRow(
          action: PhoneSheetAction(
            icon: LucideIcons.ellipsis300,
            label: '${section.hiddenCount} more',
            onTap: () {},
          ),
          onTap: () => onExpand(section),
        ),
    ], caption: section.caption);
  }
  return cards;
}

/// A title made of named parts — an agent, then its machine — one per line.
///
/// The first part reads as the title and the rest as quieter lines under it. A long name wraps, up to
/// two lines each, and only past that is it cut with `…` — so a pathological name cannot push the
/// actions off the sheet.
class _TitleParts extends StatelessWidget {
  const _TitleParts({required this.parts});

  final List<String> parts;

  @override
  Widget build(BuildContext context) => Column(
    mainAxisSize: MainAxisSize.min,
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      for (var index = 0; index < parts.length; index++)
        Text(
          parts[index],
          maxLines: 2,
          overflow: TextOverflow.ellipsis,
          // 17 over the place lines' 13: the name is what the whole sheet is about, and it has to
          // read as the heading of the cards under it rather than as one more line among them.
          style: index == 0
              ? TextStyle(
                  color: AppPalette.textPrimary,
                  fontSize: 17,
                  fontWeight: FontWeight.w600,
                )
              : TextStyle(color: AppPalette.textSecondary, fontSize: 13),
        ),
    ],
  );
}

/// One row of a sheet's card: the icon, the label, then a value and a chevron when it has them.
///
/// On a [Material] of its own because the card under it is a painted box: an [InkWell] draws on the
/// nearest Material, which without this is the sheet's — UNDER the card's fill, where no press
/// would ever show. [SettingsRow] does the same, for the same reason.
class _SheetRow extends StatelessWidget {
  const _SheetRow({required this.action, required this.onTap});

  final PhoneSheetAction action;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    // ⚠️ **The danger INK, not [AppPalette.dangerFill].** The fill is darkened to carry white
    // lettering on top of it; used as the lettering itself it measured 3.4:1 on this sheet — under
    // the 4.5:1 floor, on the one row a reader most needs to read right. `colorScheme.error` is the
    // red tuned as ink on a dark surface: 4.8:1 on the card.
    final color = !action.enabled
        ? AppPalette.textFaint
        : action.destructive
        ? Theme.of(context).colorScheme.error
        : AppPalette.textPrimary;
    final value = action.value;
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: action.enabled ? onTap : null,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
          child: Row(
            children: [
              Icon(action.icon, size: 20, color: color),
              const SizedBox(width: 14),
              Expanded(
                child: Text(
                  action.label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: color,
                    fontSize: 16,
                    fontWeight: FontWeight.w500,
                  ),
                ),
              ),
              if (value != null) ...[
                const SizedBox(width: 12),
                // Capped rather than left to its own width: a value can be as
                // long as a model id, and a Row lays a non-flex child out before
                // it gives the label what is left — so an uncapped one would eat
                // the label first and then run off the end of the sheet.
                ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 150),
                  child: Text(
                    value,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    textAlign: TextAlign.end,
                    style: TextStyle(
                      color: action.valueColor ?? AppPalette.textSecondary,
                      fontSize: 14,
                    ),
                  ),
                ),
              ],
              if (action.chevron)
                Padding(
                  padding: const EdgeInsets.only(left: 4),
                  child: Transform.translate(
                    // Nudged right by the blank the glyph carries — see [kChevronInk] — so the
                    // arrow ends on the row's margin, where a label or a value would.
                    offset: const Offset(kChevronInk, 0),
                    child: Icon(
                      LucideIcons.chevronRight300,
                      size: 20,
                      color: AppPalette.textFaint,
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

/// A yes/no question before something that cannot be undone — stopping a harness, unlinking a
/// machine. Returns true only if the destructive button was the one pressed; Cancel, a tap on the
/// veil and Escape all answer no.
///
/// Laid out as the rename dialog is (`widgets/rename_agent_dialog.dart`) and on the same veil —
/// [showAppDialog]'s blur under its tint — so the app's dialogs read as one set: a heading row with
/// a mark, the sentence, then Cancel and the act side by side at a thumb's size.
///
/// [icon] is the mark, on a red tile: pass the icon of the row that asked, so the question visibly
/// continues the tap that opened it. [detail], when given, goes under the title — where the thing
/// lives, so two of the same name on two machines cannot be confused at the one step that ends one.
Future<bool> confirmPhoneAction(
  BuildContext context, {
  required String title,
  required String message,
  required String confirmLabel,
  IconData icon = LucideIcons.triangleAlert300,
  String? detail,
}) async {
  final confirmed = await showAppDialog<bool>(
    context: context,
    builder: (_) => _ConfirmDialog(
      title: title,
      message: message,
      confirmLabel: confirmLabel,
      icon: icon,
      detail: detail,
    ),
  );
  return confirmed ?? false;
}

/// [confirmPhoneAction]'s card.
class _ConfirmDialog extends StatelessWidget {
  const _ConfirmDialog({
    required this.title,
    required this.message,
    required this.confirmLabel,
    required this.icon,
    required this.detail,
  });

  final String title;
  final String message;
  final String confirmLabel;
  final IconData icon;
  final String? detail;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    // The red tuned as ink on a dark surface, for the mark. [AppPalette.dangerFill] is darkened to
    // carry white lettering, so it stays on the button — the one place that has any.
    final danger = Theme.of(context).colorScheme.error;
    final detail = this.detail;
    return Dialog(
      // 16 from a phone's edges, as the rename dialog: the sentence gets the width, up to the 360
      // the card stops at on anything wider.
      insetPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 24),
      child: Semantics(
        scopesRoute: true,
        namesRoute: true,
        explicitChildNodes: true,
        label: title,
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 360),
          child: Padding(
            padding: const EdgeInsets.all(20),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  children: [
                    Container(
                      width: 40,
                      height: 40,
                      decoration: BoxDecoration(
                        color: danger.withValues(alpha: 0.14),
                        borderRadius: BorderRadius.circular(
                          kDialogControlRadius,
                        ),
                        border: Border.all(
                          color: danger.withValues(alpha: 0.24),
                        ),
                      ),
                      child: Icon(icon, size: 20, color: danger),
                    ),
                    const SizedBox(width: 14),
                    Expanded(
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          // Never cut short: the name in it is what the question is about.
                          Text(
                            title,
                            style: TextStyle(
                              color: AppPalette.textPrimary,
                              fontSize: 17,
                              fontWeight: AppFont.semibold,
                              height: 1.3,
                            ),
                          ),
                          if (detail != null && detail.isNotEmpty) ...[
                            const SizedBox(height: 2),
                            Text(
                              detail,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(
                                color: AppPalette.textSecondary,
                                fontSize: 13,
                              ),
                            ),
                          ],
                        ],
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 16),
                Text(
                  message,
                  style: TextStyle(
                    color: AppPalette.textSecondary,
                    fontSize: 15,
                    height: 1.45,
                  ),
                ),
                const SizedBox(height: 22),
                Row(
                  children: [
                    // A neutral well, not accent text, for the reason the rename dialog's Cancel
                    // is one: blue lettering on this card is 3.0:1, and a way out does not need
                    // the accent to be found.
                    Expanded(
                      child: FilledButton(
                        style: appDialogButtonStyle(
                          background: AppSurface.recess,
                          foreground: AppPalette.textPrimary,
                        ),
                        onPressed: () => Navigator.of(context).pop(false),
                        child: const Text('Cancel'),
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: FilledButton(
                        style: appDialogButtonStyle(
                          background: AppPalette.dangerFill,
                          foreground: Colors.white,
                        ),
                        onPressed: () => Navigator.of(context).pop(true),
                        child: Text(confirmLabel),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
