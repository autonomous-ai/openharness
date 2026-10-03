import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../shortcuts/app_keymap.dart';
import '../shortcuts/keymap.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/theme/app_type.dart';
import '../theme/app_theme.dart';
import 'desktop_chrome.dart';
import 'engine_identity.dart';
import 'transient_menus.dart';

/// The pane header's menu, as one shape for every list that wants to look like it.
///
/// Model choices and Find options share desktop chrome without changing their
/// pane's terminal styling or the overlay's interaction contract.
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
///
/// [focusFirst] highlights the first row as the menu opens, for a menu a key opened: Return takes
/// it. A menu a click opened passes false — the pointer picks the row, and arrows still start at
/// the first one.
Future<T?> showPaneMenu<T>({
  required BuildContext context,
  required RelativeRect position,
  List<Widget> Function(void Function(T?) close)? children,
  Widget Function(void Function(T?) close)? body,
  void Function(OverlayEntry entry, void Function() close)? onOpen,
  VoidCallback? onClose,
  bool Function()? shouldRestoreFocus,
  bool focusFirst = true,
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
            focusFirst: focusFirst,
            // A row list sizes itself to its widest row ([IntrinsicWidth]) and scrolls as one
            // column. A BODY does neither: it is handed the menu's box and lays itself out, which
            // is what a panel with something pinned above and below a scrolling middle needs.
            child: body != null
                ? _PaneMenuSurface(child: body(close))
                : IntrinsicWidth(
                    child: _PaneMenuSurface(
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

class _PaneMenuSurface extends StatelessWidget {
  const _PaneMenuSurface({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final highContrast = MediaQuery.highContrastOf(context);
    return Material(
      key: const ValueKey('pane-menu-surface'),
      color: grid.AppMenu.fill,
      surfaceTintColor: Colors.transparent,
      elevation: grid.AppMenu.elevation,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(grid.AppMenu.panelRadius),
        side: BorderSide(
          color: highContrast
              ? DesktopChrome.foreground.withValues(alpha: .55)
              : grid.AppMenu.rim,
        ),
      ),
      clipBehavior: Clip.antiAlias,
      child: DefaultTextStyle.merge(
        style: DesktopChrome.control(),
        child: child,
      ),
    );
  }
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
  const _PaneMenuFocus({
    required this.close,
    required this.focusFirst,
    required this.child,
  });
  final VoidCallback close;
  final bool focusFirst;
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
      if (!mounted) return;
      // Either way the menu takes the keyboard — Escape and the arrows are
      // its own — but only [focusFirst] lights a row before one is asked for.
      widget.focusFirst ? _scope.nextFocus() : _scope.requestFocus();
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
        // Scrolling can move rows above a pinned search field. Keep keyboard
        // order tied to the list, not those temporary screen coordinates.
        child: FocusTraversalGroup(
          policy: WidgetOrderTraversalPolicy(),
          child: widget.child,
        ),
      ),
    );
  }
}

/// One inset action in the compact menu. Its child owns the row's content.
Widget paneMenuItem({
  required VoidCallback onTap,
  Widget? child,
  Widget Function(BuildContext context, bool active)? builder,
}) => Padding(
  padding: const EdgeInsets.symmetric(horizontal: kPaneMenuInset),
  child: PaneMenuAction(onPressed: onTap, builder: builder, child: child),
);

/// A blue active row is separate from the stored choice. Content builders use
/// the active ink; chosen models carry a checkmark without a competing rim.
class PaneMenuAction extends StatefulWidget {
  const PaneMenuAction({
    super.key,
    required this.onPressed,
    this.child,
    this.builder,
    this.selected,
  }) : assert((child == null) != (builder == null));

  final VoidCallback onPressed;
  final Widget? child;
  final Widget Function(BuildContext context, bool active)? builder;
  final bool? selected;

  @override
  State<PaneMenuAction> createState() => _PaneMenuActionState();
}

class _PaneMenuActionState extends State<PaneMenuAction> {
  final _states = WidgetStatesController();

  @override
  void dispose() {
    _states.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return ValueListenableBuilder(
      valueListenable: _states,
      builder: (context, states, _) {
        final active =
            states.contains(WidgetState.focused) ||
            states.contains(WidgetState.hovered) ||
            states.contains(WidgetState.pressed);
        return TextButton(
          statesController: _states,
          onPressed: widget.onPressed,
          style: TextButton.styleFrom(
            foregroundColor: active
                ? grid.AppDesktop.onSelection
                : DesktopChrome.foreground,
            backgroundColor: active
                ? grid.AppDesktop.selection
                : widget.selected == true
                ? grid.AppSurface.accentWash
                : Colors.transparent,
            minimumSize: const Size(0, DesktopChrome.controlHeight),
            padding: EdgeInsets.zero,
            alignment: Alignment.centerLeft,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(grid.AppDesktop.rowRadius),
            ),
            side: const BorderSide(color: Colors.transparent, width: 1.5),
            textStyle: DesktopChrome.control(),
            enabledMouseCursor: SystemMouseCursors.click,
            tapTargetSize: MaterialTapTargetSize.shrinkWrap,
            splashFactory: NoSplash.splashFactory,
            overlayColor: Colors.transparent,
          ),
          child: Semantics(
            selected: widget.selected,
            child: widget.builder?.call(context, active) ?? widget.child!,
          ),
        );
      },
    );
  }
}

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
