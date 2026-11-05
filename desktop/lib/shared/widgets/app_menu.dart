import 'dart:async';
import 'dart:math' as math;

import 'package:harness/shared/theme/app_icons.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../theme/app_theme.dart';

/// Menu choices use the system UI face; technical values can supply their own
/// style. Compact and roomy variants change padding and icon spacing.
@immutable
class AppMenuRowMetrics {
  const AppMenuRowMetrics({required this.iconSize, required this.padding});

  double get fontSize => AppType.bodySize;
  double get noteSize => AppType.captionSize;
  final double iconSize;
  final EdgeInsets padding;

  /// Round line metrics up before adding padding, so panels reserve enough
  /// room for the line. The extra two pixels are the row border;
  /// app_select_field_test checks the result against actual layout.
  double get extent =>
      math.max(iconSize, (fontSize * 1.2).ceilToDouble()) +
      padding.vertical +
      2;

  /// What a row with a [AppMenuItem.detail] line lays out at instead.
  ///
  /// [extent] plus the second line's own box — [noteSize] × 1.25, rounded up
  /// the same way a line box rounds, plus the 2px that separates the two lines.
  /// Stated rather than derived at the call site for the same reason [extent]
  /// is: a panel sized by arithmetic that disagrees with the layout by half a
  /// pixel per row wears a scrollbar it does not need.
  double get detailExtent =>
      math.max(
        iconSize,
        (fontSize * 1.2).ceilToDouble() + (noteSize * 1.25).ceilToDouble() + 2,
      ) +
      padding.vertical +
      2;

  /// A context menu's row: the macOS control scale, with the New Harness
  /// agent chooser's 10-point sides — the one row recipe every dropdown in the
  /// app now shares (owner, 2026-11-03).
  static const compact = AppMenuRowMetrics(
    iconSize: 16,
    padding: EdgeInsets.symmetric(horizontal: 10, vertical: 6),
  );

  /// Between the leading glyph's slot and the label: the agent chooser's 10.
  static const double leadingGap = 10;

  /// A picker's row has more padding, with the same font as a context menu.
  static const roomy = AppMenuRowMetrics(
    iconSize: 18,
    padding: EdgeInsets.symmetric(horizontal: 11, vertical: 10),
  );
}

/// Shared by menu rows and pickers that reserve space before laying them out.
double get kMenuRowExtent => AppMenuRowMetrics.compact.extent;
// (kept as the compact row's extent; see AppMenuRowMetrics.compact.extent)

/// One row in an [AppMenu] panel.
///
/// The panel itself is no longer built here: it lives on [AppMenu] in
/// `app_theme.dart`, and `menuTheme` hands it to every `MenuAnchor` in the app,
/// so a menu that passes no style gets the same surface as one that does. The
/// hand-written `appMenuStyle()` this file used to export was the second of four
/// disagreeing recipes — see that class.
///
/// Adds subject marks, qualifiers and detail lines to the same selection
/// treatment supplied by the app's ordinary MenuItemButton theme.
class AppMenuItem extends StatefulWidget {
  const AppMenuItem({
    super.key,
    this.icon,
    required this.label,
    required this.onPressed,
    this.danger = false,
    this.selected = false,
    this.note,
    this.detail,
    this.leading,
    this.trailing,
    this.focusNode,
    this.metrics = AppMenuRowMetrics.compact,
    this.textStyle,
    this.leadingSlot,
    this.autofocus = false,
    this.closesMenu = true,
    this.highlighted = false,
  });

  /// Inside an [AppDropdown], close the whole dropdown — through any
  /// [AppSubmenuItem] above it — before [onPressed] runs. Off for the row that
  /// opens a submenu, which stays open.
  final bool closesMenu;

  /// Draw the row as if the pointer were on it: a submenu row while its submenu
  /// is open and the pointer has moved into it.
  final bool highlighted;

  /// Take focus as the panel opens — the current choice in a picker, so the
  /// arrow keys start from it.
  final bool autofocus;

  /// Keep the fixed leading column even with no [icon] or [leading], so labels
  /// line up with rows that carry a glyph. Null asks the [AppDropdown]: kept
  /// when any row in the list has a glyph, dropped when none does, where the
  /// empty column would only push every label off to the right.
  final bool? leadingSlot;

  /// The leading glyph. Null for a row in a list that PICKS one of several — the
  /// slot is still reserved, so labels line up whether a row is ticked or not.
  final IconData? icon;
  final String label;

  /// A quieter qualifier after the label — a face name beside "System". Set
  /// apart by ink rather than by a separator character, so it reads as an aside
  /// instead of as part of the name.
  final String? note;

  /// A mark at the row's far end, after [note] — a state the row has rather
  /// than a word about it.
  ///
  /// For a fact that repeats down a list, where the same short phrase on every
  /// other row turns the column into noise the eye has to re-read. A glyph is
  /// scanned once. Give it a [Tooltip]: a mark carries no meaning to a reader
  /// meeting it for the first time, and there is nowhere else in a menu row to
  /// put the sentence.
  final Widget? trailing;
  final FocusNode? focusNode;

  /// A quiet SECOND LINE under the label, for a row whose label alone does not
  /// say what picking it does — "Most tokens read in the last 24h" under
  /// "Input tokens", "That, plus…" under a role.
  ///
  /// Distinct from [note], which sits *beside* the label and qualifies the same
  /// noun ("System — SF Pro"). A sentence cannot go there: a menu is as wide as
  /// its button, and the qualifier would arrive clipped to its first three
  /// words. So this row grows a line instead of the panel growing a column.
  ///
  /// It makes the row taller, which is why a caller that has to SIZE a panel
  /// asks [AppMenuRowMetrics.detailExtent] rather than [AppMenuRowMetrics.extent].
  final String? detail;

  /// A subject's mark, such as its agent logo. Replaces [icon] in the fixed
  /// leading slot. The trailing check never displaces this identity.
  final Widget? leading;

  /// Which of the two row sizes this is. Defaults to a context menu's; a picker
  /// passes [AppMenuRowMetrics.roomy].
  final AppMenuRowMetrics metrics;
  final TextStyle? textStyle;

  /// This row is the current choice.
  ///
  /// Marked THREE ways, never by one: an accent wash, a heavier label, and a
  /// tick in the trailing slot. Colour alone fails anyone who cannot separate
  /// these two greys, and a tick alone is easy to miss in a long list.
  final bool selected;

  /// Null draws the row disabled: muted ink, no hover fill, no hand cursor,
  /// and it cannot take focus — an offline machine in a machine picker.
  final VoidCallback? onPressed;

  /// Red at rest for a destructive action. Active rows retain the common
  /// white-on-blue selection so pointer and keyboard feedback remain legible.
  final bool danger;

  /// The width [rows] need to show all they say on one line, so a panel of
  /// short rows has no empty side. Null when that can't be known: no rows, or a
  /// [trailing] widget, whose width only its own layout decides.
  static double? fitWidth(BuildContext context, Iterable<AppMenuItem> rows) {
    final list = rows.toList();
    if (list.isEmpty || list.any((row) => row.trailing != null)) return null;
    final scaler = MediaQuery.textScalerOf(context);
    final direction = Directionality.of(context);
    double line(String text, TextStyle style) {
      final painter = TextPainter(
        text: TextSpan(text: text, style: style),
        textDirection: direction,
        textScaler: scaler,
        maxLines: 1,
      )..layout();
      final width = painter.width;
      painter.dispose();
      return width;
    }

    var widest = 0.0;
    for (final row in list) {
      // At the chosen row's heavier weight, so choosing one never clips it.
      var text = line(
        row.label,
        (row.textStyle ?? AppType.body()).copyWith(fontWeight: AppFont.medium),
      );
      if (row.detail case final detail?) {
        text = math.max(text, line(detail, AppType.caption()));
      }
      if (row.note case final note?) {
        text += 8 + line(note, AppType.body());
      }
      widest = math.max(widest, text);
    }
    final metrics = list.first.metrics;
    final glyphs = list.any(
      (row) =>
          row.icon != null || row.leading != null || row.leadingSlot == true,
    );
    final tick = list.any((row) => row.selected);
    return (widest +
            12 + // The row's own 6 either side.
            metrics.padding.horizontal +
            (glyphs ? metrics.iconSize + AppMenuRowMetrics.leadingGap : 0) +
            (tick ? 12 + metrics.iconSize : 0))
        .ceilToDouble();
  }

  @override
  State<AppMenuItem> createState() => _AppMenuItemState();
}

class _AppMenuItemState extends State<AppMenuItem> {
  bool _hovered = false;
  bool _focused = false;

  VoidCallback? get _onTap {
    final action = widget.onPressed;
    if (action == null || !widget.closesMenu) return action;
    final root = _AppMenuRoot.maybeOf(context);
    if (root == null) return action;
    return () {
      root.close();
      // After the frame, as MenuItemButton does: the menu has handed focus
      // back to what held it before, so an action that opens a dialog or
      // moves focus starts from there.
      WidgetsBinding.instance.addPostFrameCallback((_) {
        FocusManager.instance.applyFocusChangesIfNeeded();
        action();
      });
    };
  }

  @override
  Widget build(BuildContext context) {
    // Lives in the MenuAnchor's overlay, so it watches for itself.
    AppTheme.watch(context);
    final error = Theme.of(context).colorScheme.error;
    final enabled = widget.onPressed != null;
    final active = enabled && (_hovered || _focused || widget.highlighted);
    final tint = active
        ? AppDesktop.onSelection
        : !enabled
        ? AppPalette.textSecondary.withValues(alpha: .6)
        : widget.danger
        ? error
        : AppPalette.textSecondary;
    // Keep the identity column even when a row has no mark.
    final glyph = widget.icon;

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
      child: Material(
        color: Colors.transparent,
        borderRadius: BorderRadius.circular(AppDesktop.rowRadius),
        child: InkWell(
          focusNode: widget.focusNode,
          autofocus: widget.autofocus && enabled,
          onTap: _onTap,
          onHover: (hovered) => setState(() => _hovered = hovered),
          onFocusChange: (focused) => setState(() => _focused = focused),
          mouseCursor: enabled
              ? SystemMouseCursors.click
              : SystemMouseCursors.basic,
          borderRadius: BorderRadius.circular(AppDesktop.rowRadius),
          hoverColor: Colors.transparent,
          focusColor: Colors.transparent,
          splashFactory: NoSplash.splashFactory,
          child: Ink(
            decoration: BoxDecoration(
              color: active
                  ? AppDesktop.selection
                  : widget.selected
                  ? AppSurface.accentWash
                  : Colors.transparent,
              borderRadius: BorderRadius.circular(AppDesktop.rowRadius),
            ),
            padding: widget.metrics.padding,
            child: Row(
              children: [
                // Fixed slot: these glyphs differ in width, and without it every
                // label would start at a slightly different column — and a
                // ticked row would sit a few pixels off an unticked one.
                if ((widget.leadingSlot ??
                        _AppMenuRoot.glyphsOf(context) ??
                        true) ||
                    widget.leading != null ||
                    glyph != null) ...[
                  SizedBox(
                    width: widget.metrics.iconSize,
                    child: widget.leading != null
                        ? IconTheme.merge(
                            data: IconThemeData(
                              color: tint,
                              size: widget.metrics.iconSize,
                            ),
                            child: widget.leading!,
                          )
                        : (glyph == null
                              ? null
                              : Icon(
                                  glyph,
                                  size: widget.metrics.iconSize,
                                  color: tint,
                                )),
                  ),
                  const SizedBox(width: AppMenuRowMetrics.leadingGap),
                ],
                // The label and its note take the row's slack, so a trailing
                // mark or a check always lands on the end edge, whatever the
                // label's length: the one column a reader's eye can run down.
                Expanded(
                  child: Row(
                    children: [
                      Flexible(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Text(
                              widget.label,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              strutStyle: widget.textStyle == null
                                  ? AppType.controlStrut(height: 1.2)
                                  : null,
                              style: (widget.textStyle ?? AppType.body())
                                  .copyWith(
                                    color: active
                                        ? AppDesktop.onSelection
                                        : !enabled
                                        ? AppPalette.textSecondary
                                        : widget.danger
                                        ? error
                                        : AppPalette.textPrimary,
                                    height: 1.2,
                                    fontWeight: widget.selected
                                        ? AppFont.medium
                                        : AppFont.regular,
                                  ),
                            ),
                            if (widget.detail case final detail?) ...[
                              const SizedBox(height: 2),
                              Text(
                                detail,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: AppType.caption(
                                  color: active
                                      ? AppDesktop.selectionDetail
                                      : AppPalette.textSecondary,
                                  height: 1.25,
                                ),
                              ),
                            ],
                          ],
                        ),
                      ),
                      if (widget.note != null) ...[
                        const SizedBox(width: 8),
                        Flexible(
                          child: Text(
                            widget.note!,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: AppType.body(
                              color: active
                                  ? AppDesktop.selectionDetail
                                  : AppPalette.textSecondary,
                              height: 1.2,
                            ),
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
                if (widget.trailing != null) ...[
                  const SizedBox(width: 8),
                  widget.trailing!,
                ],
                if (widget.selected) ...[
                  const SizedBox(width: 12),
                  Icon(
                    AppIcons.check,
                    size: widget.metrics.iconSize,
                    color: tint,
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

/// The search at the head of a long menu: one look wherever a list grows past
/// what can be read at a glance ([AppDropdown], [AppSelectField]), and the New
/// Harness agent picker's: a glyph and a line of text over a rule, no box.
class AppMenuSearchField extends StatelessWidget {
  const AppMenuSearchField({
    super.key,
    required this.controller,
    required this.focusNode,
    required this.onChanged,
    required this.onKeyEvent,
    this.fieldKey = const Key('app-menu-search'),
    this.textStyle,
  });

  final TextEditingController controller;
  final FocusNode focusNode;
  final ValueChanged<String> onChanged;
  final FocusOnKeyEventCallback onKeyEvent;
  final Key fieldKey;
  final TextStyle? textStyle;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Focus(
      canRequestFocus: false,
      skipTraversal: true,
      onKeyEvent: onKeyEvent,
      child: Container(
        margin: const EdgeInsets.only(bottom: 5),
        // With the panel's top padding, one row's height.
        padding: const EdgeInsets.fromLTRB(16, 1, 16, 5),
        decoration: BoxDecoration(
          border: Border(bottom: BorderSide(color: AppDesktop.rim)),
        ),
        child: Row(
          children: [
            Icon(AppIcons.search, size: 16, color: AppPalette.textFaint),
            const SizedBox(width: AppMenuRowMetrics.leadingGap),
            Expanded(
              child: TextField(
                key: fieldKey,
                controller: controller,
                focusNode: focusNode,
                style: textStyle ?? AppType.body(color: AppPalette.textPrimary),
                autocorrect: false,
                enableSuggestions: false,
                decoration: InputDecoration(
                  hintText: 'Search',
                  hintStyle: AppType.body(color: AppPalette.textFaint),
                  isDense: true,
                  isCollapsed: true,
                  constraints: const BoxConstraints(),
                  contentPadding: EdgeInsets.zero,
                  border: InputBorder.none,
                  enabledBorder: InputBorder.none,
                  focusedBorder: InputBorder.none,
                  filled: false,
                ),
                onChanged: onChanged,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// The app's one dropdown: the panel, its rows, their width, the search head
/// and what happens on a pick. Every menu states its rows and nothing else.
///
/// The width is set on each ROW, never with `MenuStyle.minimumSize`: rows laid
/// out loose keep their own width, so a panel asked for 220 drew 129 and its
/// marks missed each other.
///
/// Past [searchAfter] rows the panel opens on a search field, matching a row's
/// label, detail and note. Headings and dividers step aside during a search.
///
/// [AppMenuItem] rows close the whole dropdown before they act. Anything else
/// among [children] (a heading, an [AppMenuDivider]) is drawn as it is.
class AppDropdown extends StatefulWidget {
  const AppDropdown({
    super.key,
    required this.children,
    this.controller,
    this.width = defaultWidth,
    this.maxHeight = 480,
    this.style,
    this.alignment,
    this.alignmentOffset = const Offset(0, AppControl.menuGap),
    this.childFocusNode,
    this.consumeOutsideTap = true,
    this.searchAfter = defaultSearchAfter,
    this.header,
    this.searchScope,
    this.onOpen,
    this.onClose,
    this.builder,
    this.child,
  });

  static const double defaultWidth = 240;

  /// The narrowest a panel of short rows gets.
  static const double minFitWidth = 140;

  /// A list longer than this is hunted through, not read.
  static const int defaultSearchAfter = 8;

  final List<Widget> children;
  final MenuController? controller;

  /// The panel's widest. Short rows ask for less ([AppMenuItem.fitWidth]); a
  /// panel with a [header], a search, or anything but rows and dividers among
  /// [children] is this wide.
  final double width;
  final double maxHeight;

  /// The panel's style before placement; [AppMenu.style] at [maxHeight] when
  /// null.
  final MenuStyle? style;
  final AlignmentGeometry? alignment;
  final Offset alignmentOffset;
  final FocusNode? childFocusNode;
  final bool consumeOutsideTap;
  final int searchAfter;

  /// Fixed above the search field and the rows, whatever a search leaves: a
  /// tab row, for a panel that swaps its rows ([AppTabPill]).
  final Widget? header;

  /// What the rows are of. A change clears the search: the query was for other
  /// rows.
  final Object? searchScope;
  final VoidCallback? onOpen;
  final VoidCallback? onClose;
  final MenuAnchorChildBuilder? builder;
  final Widget? child;

  @override
  State<AppDropdown> createState() => _AppDropdownState();
}

/// One tab in a row of tabs: its name in a pill, filled while selected. Always
/// as wide as its selected weight, so choosing a tab does not move the others.
class AppTabPill extends StatelessWidget {
  const AppTabPill({
    super.key,
    this.tapKey,
    required this.label,
    required this.selected,
    required this.onTap,
  });

  /// The clickable part's key, for a caller that finds or taps the tab itself.
  final Key? tapKey;
  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    TextStyle style(bool medium, Color color) => AppType.body(
      color: color,
      height: 1.25,
      fontWeight: medium ? AppFont.medium : AppFont.regular,
    );
    final widest = TextPainter(
      text: TextSpan(text: label, style: style(true, AppPalette.textPrimary)),
      textDirection: Directionality.of(context),
      textScaler: MediaQuery.textScalerOf(context),
      maxLines: 1,
    )..layout();
    final width = widest.width.ceilToDouble();
    widest.dispose();
    return Material(
      color: selected ? AppSurface.selectedFill : Colors.transparent,
      borderRadius: BorderRadius.circular(AppDesktop.rowRadius),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        key: tapKey,
        onTap: onTap,
        hoverColor: AppSurface.hoverFill,
        child: Semantics(
          selected: selected,
          button: true,
          child: Padding(
            padding: const EdgeInsets.symmetric(
              horizontal: AppDesktop.controlGap,
              vertical: AppDesktop.menuInset,
            ),
            child: SizedBox(
              width: width,
              child: Text(
                label,
                textAlign: TextAlign.center,
                maxLines: 1,
                strutStyle: AppType.controlStrut(),
                style: style(
                  selected,
                  selected ? AppPalette.textPrimary : AppPalette.textSecondary,
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _AppDropdownState extends State<AppDropdown> {
  MenuController? _own;
  final _searchFocus = FocusNode(debugLabel: 'Dropdown search');
  final _searchText = TextEditingController();
  final _pointer = _AppMenuPointer();
  String _query = '';

  MenuController get _controller =>
      widget.controller ?? (_own ??= MenuController());

  @override
  void dispose() {
    _pointer.dispose();
    _searchFocus.dispose();
    _searchText.dispose();
    super.dispose();
  }

  @override
  void didUpdateWidget(AppDropdown oldWidget) {
    super.didUpdateWidget(oldWidget);
    // The rows changed under the query (another tab): it no longer applies.
    if (oldWidget.searchScope != widget.searchScope) {
      _searchText.clear();
      _query = '';
    }
  }

  /// The menu row inside [widget], through the wrappers a menu puts around one:
  /// a key, a tooltip, a size, a semantics node.
  static AppMenuItem? _rowIn(Widget widget) => switch (widget) {
    AppMenuItem() => widget,
    KeyedSubtree(:final child) => _rowIn(child),
    Tooltip(:final child?) => _rowIn(child),
    ProxyWidget(:final child) => _rowIn(child),
    SingleChildRenderObjectWidget(:final child?) => _rowIn(child),
    _ => null,
  };

  bool _matches(AppMenuItem row, String needle) =>
      row.label.toLowerCase().contains(needle) ||
      (row.detail?.toLowerCase().contains(needle) ?? false) ||
      (row.note?.toLowerCase().contains(needle) ?? false);

  List<AppMenuItem> get _rows => [
    for (final child in widget.children) ?_rowIn(child),
  ];

  bool get _searching => _rows.length > widget.searchAfter;

  /// As wide as the rows ask, from all of them rather than a search's few, so
  /// the panel holds still while its list changes.
  double _panelWidth(BuildContext context) {
    final onlyRows = widget.children.every(
      (child) => child is AppMenuDivider || _rowIn(child) != null,
    );
    if (widget.header != null || _searching || !onlyRows) return widget.width;
    final fit = AppMenuItem.fitWidth(context, _rows);
    if (fit == null) return widget.width;
    return math.min(widget.width, math.max(fit, AppDropdown.minFitWidth));
  }

  KeyEventResult _searchKeys(FocusNode node, KeyEvent event) {
    if (event is KeyUpEvent || !_controller.isOpen) {
      return KeyEventResult.ignored;
    }
    final key = event.logicalKey;
    if (key == LogicalKeyboardKey.escape) {
      _controller.close();
      return KeyEventResult.handled;
    }
    if (key == LogicalKeyboardKey.enter ||
        key == LogicalKeyboardKey.numpadEnter) {
      final needle = _query.toLowerCase();
      final first = _rows
          .where((row) => row.onPressed != null && _matches(row, needle))
          .firstOrNull;
      if (first != null) {
        _rootOf(context).close();
        first.onPressed!();
      }
      return KeyEventResult.handled;
    }
    if (key == LogicalKeyboardKey.arrowDown) {
      node.nextFocus();
      return KeyEventResult.handled;
    }
    return KeyEventResult.ignored;
  }

  MenuController _rootOf(BuildContext context) =>
      _AppMenuRoot.maybeOf(context) ?? _controller;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final root = _rootOf(context);
    final needle = _query.toLowerCase();
    final searching = _searching;
    final glyphs = _rows.any((row) => row.icon != null || row.leading != null);
    final shown = needle.isEmpty
        ? widget.children
        : [
            for (final child in widget.children)
              if (_rowIn(child) case final row? when _matches(row, needle))
                child,
          ];
    final base = widget.style ?? AppMenu.style(maxHeight: widget.maxHeight);
    final width = _panelWidth(context);
    return MenuAnchor(
      controller: _controller,
      childFocusNode: widget.childFocusNode,
      consumeOutsideTap: widget.consumeOutsideTap,
      alignmentOffset: widget.alignmentOffset,
      style: widget.alignment == null
          ? base
          : base.copyWith(alignment: widget.alignment),
      onOpen: () {
        if (_searching) {
          WidgetsBinding.instance.addPostFrameCallback((_) {
            if (mounted && _controller.isOpen) _searchFocus.requestFocus();
          });
        }
        widget.onOpen?.call();
      },
      onClose: () {
        if (_query.isNotEmpty) {
          _searchText.clear();
          if (mounted) setState(() => _query = '');
        }
        widget.onClose?.call();
      },
      menuChildren: [
        if (widget.header case final header?)
          SizedBox(width: width, child: header),
        if (searching)
          SizedBox(
            width: width,
            child: AppMenuSearchField(
              controller: _searchText,
              focusNode: _searchFocus,
              onKeyEvent: _searchKeys,
              onChanged: (value) => setState(() => _query = value.trim()),
            ),
          ),
        if (needle.isNotEmpty && shown.isEmpty)
          SizedBox(
            width: width,
            height: kMenuRowExtent,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: Align(
                alignment: AlignmentDirectional.centerStart,
                child: Text(
                  'No matches',
                  style: AppType.body(color: AppPalette.textSecondary),
                ),
              ),
            ),
          ),
        for (final (index, child) in shown.indexed)
          SizedBox(
            width: width,
            // The pointer arriving on a row tells the submenu row beside it to
            // let go ([AppSubmenuItem]).
            child: MouseRegion(
              onEnter: (_) => _pointer.enter(index),
              child: _AppMenuRow(
                index: index,
                pointer: _pointer,
                child: _AppMenuRoot(
                  controller: root,
                  glyphs: glyphs,
                  child: child,
                ),
              ),
            ),
          ),
      ],
      builder: widget.builder,
      child: widget.child,
    );
  }
}

/// An [AppMenuItem] that opens its own [AppDropdown] beside its panel.
///
/// The app's one submenu. Pointing at the row opens it, a click toggles it. It
/// is placed from the row's measured edge, [gap] clear of the panel, with its
/// first row level with this one; [MenuAnchor] flips it when the window has no
/// room.
class AppSubmenuItem extends StatefulWidget {
  const AppSubmenuItem({
    super.key,
    this.itemKey,
    required this.label,
    required this.menuChildren,
    this.controller,
    this.icon,
    this.trailing,
    this.leadingSlot,
    this.focusNode,
    this.style,
    this.width = AppDropdown.defaultWidth,
    this.onOpen,
    this.onClose,
  });

  /// The row's own key, for a caller that finds or taps the row itself.
  final Key? itemKey;
  final String label;
  final List<Widget> menuChildren;

  /// The row's focus, for a caller that moves the keys to it.
  final FocusNode? focusNode;

  /// Supplied when the caller coordinates several submenus (closes the others
  /// in [onOpen]); otherwise the item keeps its own.
  final MenuController? controller;
  final IconData? icon;
  final Widget? trailing;
  final bool? leadingSlot;

  /// The submenu panel's style before placement; [AppMenu.style] by default.
  final MenuStyle? style;
  final double width;
  final VoidCallback? onOpen;
  final VoidCallback? onClose;

  /// The air between the two panels' rims.
  static const double gap = 2;

  @override
  State<AppSubmenuItem> createState() => _AppSubmenuItemState();
}

class _AppSubmenuItemState extends State<AppSubmenuItem> {
  /// How long a sibling row may hold the pointer before the submenu lets go:
  /// the time a hand needs to cut a corner on its way into the submenu, as
  /// macOS and Slack allow.
  static const _grace = Duration(milliseconds: 120);

  MenuController? _own;
  bool _open = false;
  Timer? _letGo;
  _AppMenuRow? _row;

  MenuController get _controller =>
      widget.controller ?? (_own ??= MenuController());

  void _openMenu() {
    _letGo?.cancel();
    if (!_controller.isOpen) _controller.open();
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final row = _AppMenuRow.maybeOf(context);
    if (row?.pointer == _row?.pointer) {
      _row = row;
      return;
    }
    _row?.pointer.removeListener(_pointerMoved);
    row?.pointer.addListener(_pointerMoved);
    _row = row;
  }

  @override
  void dispose() {
    _letGo?.cancel();
    _row?.pointer.removeListener(_pointerMoved);
    super.dispose();
  }

  /// The pointer arrived on a row of the panel. On this row it stays; on
  /// another, the submenu closes unless the pointer reaches it first.
  void _pointerMoved() {
    final row = _row;
    if (row == null) return;
    if (row.pointer.row == row.index) {
      _letGo?.cancel();
      return;
    }
    if (!_controller.isOpen) return;
    _letGo ??= Timer(_grace, () {
      _letGo = null;
      if (mounted && _controller.isOpen) _controller.close();
    });
  }

  @override
  Widget build(BuildContext context) {
    return AppDropdown(
      controller: _controller,
      style: widget.style,
      width: widget.width,
      consumeOutsideTap: false,
      alignment: AlignmentDirectional.topEnd,
      alignmentOffset: Offset(AppSubmenuItem.gap, -AppMenu.panelPadding.top),
      onOpen: () {
        setState(() => _open = true);
        widget.onOpen?.call();
      },
      onClose: () {
        _letGo?.cancel();
        _letGo = null;
        if (mounted) setState(() => _open = false);
        widget.onClose?.call();
      },
      children: [
        // Reaching the submenu ends the grace.
        for (final child in widget.menuChildren)
          MouseRegion(onEnter: (_) => _letGo?.cancel(), child: child),
      ],
      child: MouseRegion(
        onHover: (_) => _openMenu(),
        child: AppMenuItem(
          key: widget.itemKey,
          focusNode: widget.focusNode,
          icon: widget.icon,
          label: widget.label,
          trailing: widget.trailing,
          leadingSlot: widget.leadingSlot,
          highlighted: _open,
          closesMenu: false,
          onPressed: () =>
              _controller.isOpen ? _controller.close() : _controller.open(),
        ),
      ),
    );
  }
}

/// Which row of a panel the pointer last arrived on.
class _AppMenuPointer extends ChangeNotifier {
  int? row;

  void enter(int index) {
    row = index;
    notifyListeners();
  }
}

/// A row's place in its panel, handed down so a submenu row can tell when the
/// pointer is on a sibling.
class _AppMenuRow extends InheritedWidget {
  const _AppMenuRow({
    required this.index,
    required this.pointer,
    required super.child,
  });

  final int index;
  final _AppMenuPointer pointer;

  static _AppMenuRow? maybeOf(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<_AppMenuRow>();

  @override
  bool updateShouldNotify(_AppMenuRow old) =>
      index != old.index || pointer != old.pointer;
}

/// The top menu of an [AppDropdown] chain, handed down to its rows.
class _AppMenuRoot extends InheritedWidget {
  const _AppMenuRoot({
    required this.controller,
    required this.glyphs,
    required super.child,
  });

  final MenuController controller;

  /// Whether any row in this list carries a glyph ([AppMenuItem.leadingSlot]).
  final bool glyphs;

  static MenuController? maybeOf(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<_AppMenuRoot>()?.controller;

  static bool? glyphsOf(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<_AppMenuRoot>()?.glyphs;

  @override
  bool updateShouldNotify(_AppMenuRoot old) =>
      controller != old.controller || glyphs != old.glyphs;
}

/// The rule that sets a destructive row apart from the ordinary ones.
class AppMenuDivider extends StatelessWidget {
  const AppMenuDivider({super.key});

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 5),
      child: Divider(height: 1, thickness: 1, color: AppPalette.divider),
    );
  }
}
