import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../shortcuts/app_keymap.dart';
import '../shortcuts/keymap.dart';
import 'box_chrome.dart';

import '../shared/theme/app_type.dart';
import '../theme/app_theme.dart';
import 'engine_identity.dart';
import 'transient_menus.dart';

/// The pane header's menu, as one shape for every list that wants to look like it.
///
/// Born in the model picker and shared from here so any second list that wants this shape is
/// the same menu rather than a second drawing of it: the same overlay, the same rows, the same
/// quiet fill on the current row instead of a tick.
///
/// Shown in an OVERLAY rather than as a modal route. `showMenu` puts a full-screen modal barrier
/// under its menu, and that barrier EATS the click that dismisses it: closing the menu and then
/// clicking what you meant to click took two clicks, with the first one going nowhere. A menu is
/// not a decision you have to finish before the app will listen again. So the dismisser is a
/// translucent [Listener] instead: it receives the pointer AND reports no hit, so the overlay
/// below it — the app — is hit-tested next and gets the same event. One click closes the menu and
/// lands where it was aimed.
///
/// [onOpen] hands the caller the entry and its closer, for a menu that wants to redraw itself
/// while open or to be closed from outside; [onClose] runs once, however the menu ended.
Future<T?> showPaneMenu<T>({
  required BuildContext context,
  required RelativeRect position,
  List<Widget> Function(void Function(T?) close)? children,
  Widget Function(void Function(T?) close)? body,
  void Function(OverlayEntry entry, void Function() close)? onOpen,
  VoidCallback? onClose,
  bool Function()? shouldRestoreFocus,
  double minWidth = 340,
  double maxWidth = 540,
}) {
  assert(
    (children == null) != (body == null),
    'a pane menu is either a list of rows or one body widget, never both',
  );
  final overlayState = Overlay.of(context);
  final completer = Completer<T?>();
  final previousFocus = FocusManager.instance.primaryFocus;
  late final OverlayEntry entry;
  late final void Function() deregister;
  var closed = false;
  void close(T? choice) {
    // Guarded: a pointer-down outside and a row tap can both arrive for one gesture, and removing
    // an entry twice throws.
    if (closed) return;
    closed = true;
    deregister();
    entry.remove();
    if (previousFocus?.context?.mounted == true &&
        (shouldRestoreFocus?.call() ?? true)) {
      previousFocus!.requestFocus();
    }
    onClose?.call();
    if (!completer.isCompleted) completer.complete(choice);
  }

  // A click on the window's NATIVE tab strip is not a pointer event Flutter ever sees, so the
  // dismisser below cannot fire for it — the menu was left floating over a tab it no longer
  // belonged to. The titlebar reports its own clicks instead; see [dismissTransientMenus].
  deregister = registerTransientMenu(() => close(null));

  entry = OverlayEntry(
    builder: (context) => Stack(
      children: [
        Positioned.fill(
          child: Listener(
            behavior: HitTestBehavior.translucent,
            onPointerDown: (_) => close(null),
            child: const SizedBox.expand(),
          ),
        ),
        CustomSingleChildLayout(
          delegate: _PaneMenuPosition(position, minWidth, maxWidth),
          child: _PaneMenuFocus(
            close: () => close(null),
            // A row list sizes itself to its widest row ([IntrinsicWidth]) and scrolls as one
            // column. A BODY does neither: it is handed the menu's box and lays itself out, which
            // is what a panel with something pinned above and below a scrolling middle needs.
            child: body != null
                ? TerminalBox(child: body(close))
                : IntrinsicWidth(
                    child: TerminalBox(
                      child: SingleChildScrollView(
                        child: Padding(
                          padding: const EdgeInsets.symmetric(vertical: 6),
                          child: Column(
                            mainAxisSize: MainAxisSize.min,
                            crossAxisAlignment: CrossAxisAlignment.stretch,
                            children: children!(close),
                          ),
                        ),
                      ),
                    ),
                  ),
          ),
        ),
      ],
    ),
  );
  onOpen?.call(entry, () => close(null));
  overlayState.insert(entry);
  return completer.future;
}

/// Position against the actual overlay, including panes beside the left edge
/// and short windows. Long model catalogs scroll inside the available height.
class _PaneMenuPosition extends SingleChildLayoutDelegate {
  const _PaneMenuPosition(this.position, this.minWidth, this.maxWidth);
  final RelativeRect position;
  final double minWidth, maxWidth;

  @override
  BoxConstraints getConstraintsForChild(BoxConstraints constraints) {
    final width = math.max(0.0, constraints.maxWidth - 16);
    return BoxConstraints(
      minWidth: math.min(minWidth, width),
      maxWidth: math.min(maxWidth, width),
      maxHeight: math.max(0, constraints.maxHeight - 16),
    );
  }

  @override
  Offset getPositionForChild(Size size, Size childSize) => Offset(
    (size.width - position.right - childSize.width).clamp(
      8,
      math.max(8, size.width - childSize.width - 8),
    ),
    position.top.clamp(8, math.max(8, size.height - childSize.height - 8)),
  );

  @override
  bool shouldRelayout(_PaneMenuPosition oldDelegate) =>
      position != oldDelegate.position ||
      minWidth != oldDelegate.minWidth ||
      maxWidth != oldDelegate.maxWidth;
}

class _PaneMenuFocus extends StatefulWidget {
  const _PaneMenuFocus({required this.close, required this.child});
  final VoidCallback close;
  final Widget child;

  @override
  State<_PaneMenuFocus> createState() => _PaneMenuFocusState();
}

class _PaneMenuFocusState extends State<_PaneMenuFocus> {
  final _scope = FocusScopeNode(debugLabel: 'Pane model menu');

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _scope.nextFocus();
    });
  }

  @override
  void dispose() {
    _scope.dispose();
    super.dispose();
  }

  KeyEventResult _key(FocusNode node, KeyEvent event) {
    if (event is KeyUpEvent) return KeyEventResult.ignored;
    final keyboard = HardwareKeyboard.instance;
    if (keyboard.isMetaPressed ||
        keyboard.isAltPressed ||
        keyboard.isControlPressed) {
      return KeyEventResult.ignored;
    }
    if (event.logicalKey == LogicalKeyboardKey.escape) {
      widget.close();
      return KeyEventResult.handled;
    }
    if (event.logicalKey == LogicalKeyboardKey.arrowDown) {
      _scope.nextFocus();
      return KeyEventResult.handled;
    }
    if (event.logicalKey == LogicalKeyboardKey.arrowUp) {
      _scope.previousFocus();
      return KeyEventResult.handled;
    }
    return KeyEventResult.ignored;
  }

  @override
  Widget build(BuildContext context) {
    return KeymapRegion(
      contextKind: KeymapContext.picker,
      child: FocusScope(
        node: _scope,
        autofocus: true,
        onKeyEvent: _key,
        child: FocusTraversalGroup(child: widget.child),
      ),
    );
  }
}

/// One selectable row of a pane menu.
///
/// The hover is the SAME rectangle as the selected fill — inset by [kPaneMenuInset] and rounded
/// the same — so a row looks like one thing whether the pointer is on it or the choice is. An
/// InkWell around the whole item painted edge to edge and square, over a selected fill that was
/// neither, and the two reading as different shapes made the current row look like the odd one
/// out.
///
/// Same SHAPE, one fill. The fill belongs to the CHOSEN row and to nothing else: focus paints
/// none at all (it is a keyboard position, not a decision) and hover paints the weaker
/// [AppColors.rowHover], which moves with the pointer and so can never be mistaken for where the
/// agent is. A tick was tried and taken out again — the fill is the whole signal, and a second one
/// beside it was a column every row paid for.
/// ⚠️ The cursor is STATED, in both places that can answer for it. A pane menu is drawn in an
/// overlay above a terminal, and what a person sees while hovering a row was whatever the surface
/// underneath asked for — an arrow over rows that are the whole point of the menu. `InkWell` carries
/// a clickable cursor of its own in principle, and in this app it was not what reached the screen;
/// the control that OPENS this menu needed both annotations before a hand appeared, and these rows
/// need the same. The cursor a person sees is the innermost annotation under the pointer, so the
/// MouseRegion covers the row and the InkWell answers for its own ink.
Widget paneMenuItem({required VoidCallback onTap, required Widget child}) =>
    Padding(
      padding: const EdgeInsets.symmetric(horizontal: kPaneMenuInset),
      child: MouseRegion(
        cursor: SystemMouseCursors.click,
        child: InkWell(
          onTap: onTap,
          mouseCursor: SystemMouseCursors.click,
          borderRadius: BorderRadius.circular(kPaneMenuRowRadius),
          // ⚠️ STATED, all three. Left to the Material default the hover landed close enough to
          // the selected fill to be indistinguishable, so the row under the pointer and the row
          // the agent is actually on looked equally chosen — two highlights, one menu. The
          // palette has always had a weaker tone for exactly this ([AppColors.rowHover]); the
          // menu simply never asked for it. Splash and highlight go transparent because an ink
          // ripple is a THIRD fill on the same rectangle, and it lingers after the tap.
          hoverColor: AppColors.rowHover,
          splashColor: Colors.transparent,
          highlightColor: Colors.transparent,
          // ⚠️ The one that actually put two highlights on screen. The menu moves focus to its
          // FIRST row as it opens (`_PaneMenuFocus`, so Enter activates something), and an InkWell
          // paints focus with a fill of its own — so the top row was lit before the pointer moved
          // and the agent's real row was lit too. Focus is a keyboard position, not a choice; only
          // the chosen row is filled.
          focusColor: Colors.transparent,
          child: child,
        ),
      ),
    );

/// A line that states something rather than offering it — no hover, no tap.
Widget paneMenuEmpty(String text) => Padding(
  padding: const EdgeInsets.fromLTRB(
    kPaneMenuInset + kPaneMenuRowPadding,
    5,
    kPaneMenuInset + kPaneMenuRowPadding,
    6,
  ),
  child: Text(text, style: AppType.body(color: AppColors.textSoft)),
);

/// A section label. Non-interactive and short, so the groups read as groups rather than as
/// entries someone failed to make clickable.
///
/// A rule used to run from the label to the menu's edge to make a heading read as a line that
/// divides. [caption], when given, is a second line UNDER the label — a specific name under a
/// heading that is a plain sentence ("Models shared with you" / "autonomous.ai"). It used to sit
/// on the same line as the label, joined by a middot ("Local · your machines"), which read as two
/// half-sentences forced together rather than as one heading and one detail under it.
Widget paneMenuHeader(String label, {String? caption}) => Padding(
  // The row's margin plus its internal padding, so a header sits directly above the text it
  // heads rather than a few pixels to either side of it.
  padding: const EdgeInsets.fromLTRB(
    kPaneMenuInset + kPaneMenuRowPadding,
    6,
    kPaneMenuInset + kPaneMenuRowPadding,
    3,
  ),
  child: Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Text(
        label,
        style: AppType.caption(
          fontWeight: FontWeight.w600,
          letterSpacing: .3,
          color: AppColors.mutedStrong,
        ),
      ),
      if (caption != null)
        Padding(
          padding: const EdgeInsets.only(top: 2),
          child: Text(
            caption,
            style: AppType.caption(color: AppColors.textSoft),
          ),
        ),
    ],
  ),
);

/// One row of a pane menu: a title, an optional mark before it ([engine]'s mark or any
/// [leading]), a short [detail] after it, a right-aligned [status], and a [subtitle] under it
/// inside the same fill. The current row carries a quiet fill — subtle on purpose: one row in the
/// menu is already the current one, and a mark loud enough to announce that would compete with
/// the thing a person opened the menu to read.
class PaneMenuRow extends StatelessWidget {
  final bool selected;
  final String? engine;
  final Widget? leading;
  final String title;
  final String detail;
  final String? status;
  final String? subtitle;

  const PaneMenuRow({
    super.key,
    required this.selected,
    required this.title,
    this.engine,
    this.leading,
    this.detail = '',
    this.status,
    this.subtitle,
  });

  @override
  Widget build(BuildContext context) {
    // Trailing metadata, as its own bounded column. Bounded rather than flexible: a `Flexible`
    // here has a flex of ONE, so the row's spare width was split evenly between the title and
    // every metadata field beside it — which put the account column a third of the way across a
    // subscription row and a machine column halfway across a model row, three columns at three
    // different offsets down one menu. What each field actually wants is its own width, at the
    // right-hand edge, with the title absorbing the slack.
    Widget meta(String text) => ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: kPaneMenuMetaMaxWidth),
      child: Text(
        text,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: AppType.mono(color: AppColors.mutedStrong),
      ),
    );
    final row = Row(
      children: [
        // The mark is the row's own, and rows without one do NOT reserve its width. A gutter on
        // every row would line up the handful of rows that carry a logo by indenting every row
        // that does not — the same trade the tick column was removed for, and the same answer.
        if (engine != null) ...[
          EngineMark(engine: engine, size: kPaneMenuMarkSize),
          const SizedBox(width: 7),
        ] else if (leading != null) ...[
          leading!,
          const SizedBox(width: 7),
        ],
        // The title takes the slack, so every metadata column lands at the right-hand edge.
        Expanded(
          child: Text(
            title,
            overflow: TextOverflow.ellipsis,
            // Regular, stated by the style rather than inherited: a PopupMenuItem's default text
            // style is heavier than this menu wants, which read as every row being emphasised.
            style: AppType.mono(color: AppColors.text),
          ),
        ),
        if (detail.isNotEmpty) ...[const SizedBox(width: 12), meta(detail)],
        if (status != null) ...[const SizedBox(width: 12), meta(status!)],
      ],
    );
    return Container(
      // No margin of its own: the inset is the item's (see [paneMenuItem]), so that the hover the
      // item paints and the fill this row paints are one and the same rectangle.
      padding: const EdgeInsets.symmetric(
        horizontal: kPaneMenuRowPadding,
        vertical: 5,
      ),
      decoration: selected
          ? BoxDecoration(
              color: AppColors.selected,
              borderRadius: BorderRadius.circular(kPaneMenuRowRadius),
            )
          : null,
      // The subtitle sits INSIDE the fill, under the title: it is about this row, and a sentence
      // hanging below the highlight would read as belonging to the next one.
      child: subtitle == null
          ? row
          : Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                row,
                Padding(
                  padding: const EdgeInsets.only(top: 2),
                  child: Text(
                    subtitle!,
                    overflow: TextOverflow.ellipsis,
                    style: AppType.body(color: AppColors.textSoft),
                  ),
                ),
              ],
            ),
    );
  }
}

/// The row's own inset from the menu edge, and the padding inside its highlight. A section header
/// carries their SUM as a left inset, so header text sits exactly above the row text it heads.
const double kPaneMenuInset = 6;
const double kPaneMenuRowPadding = 8;

/// A row's leading mark, when it has one. Not reserved on rows that do not.
const double kPaneMenuMarkSize = 14;

/// How wide one trailing metadata column may grow before it ellipsizes.
///
/// A cap rather than a flex share: the menu itself is capped, and a field allowed to take half of
/// it would crowd out the thing the row is actually named after. Past this the account, the
/// machine or the quota loses its tail — never the model's id.
const double kPaneMenuMetaMaxWidth = 168;

/// One radius for the hover and the selected fill: they are the same shape.
const double kPaneMenuRowRadius = 5;
