import 'package:flutter/material.dart';
import 'package:window_manager/window_manager.dart';

import '../core/runtime_platform.dart';
import '../core/desktop_window.dart';
import '../core/test_run.dart';
import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;

/// Windows hides the system caption, so every screen that fills the window
/// draws [WindowCaptionButtons] itself.
bool get drawsWindowCaption => RuntimePlatform.isWindows && !kUnderTest;

/// The height of the row [WindowCaptionButtons] sit in when no tab strip sets
/// one: the tab strip's own.
const double kWindowCaptionHeight = 40;

/// How far a full-width strip drawn at the very top of the window has to
/// start from the left to clear the traffic lights.
double get trafficLightClearance => RuntimePlatform.isMacOS ? 78.0 : 0.0;

/// The traffic lights' own row, as a drag handle.
///
/// Public because screens have to place their own controls clear of it: this
/// band belongs to AppKit, so a button drawn inside it renders correctly and
/// never responds. A screen that puts anything clickable near the top edge
/// offsets by this rather than by a 28 typed locally, which would be a second
/// copy of a number that must not drift.
const double windowDragBandHeight = 28;

/// The window's own strip, above everything the app draws.
///
/// ⚠️ THIS IS NOT DECORATION — IT IS WHAT GIVES THE CONTENT BELOW IT ITS INPUT
/// BACK. `TitleBarStyle.hidden` sets `titlebarAppearsTransparent` and
/// `fullSizeContentView`, which does not remove the title bar: it makes it
/// transparent and lets the content run underneath. AppKit still owns dragging
/// in that band, and once it takes a gesture it keeps it — Flutter stops
/// getting move events for it. So anything the app draws in the top ~28px can
/// be looked at but not dragged, which is why dragging a pane's header moved
/// the whole window, and why it worked in full screen: there the window has
/// nowhere to go, so the Flutter drag wins by default.
///
/// [_barHeight] is therefore a floor, not a taste: it must clear
/// [windowDragBandHeight]. The extra 4px is what the rail used to inset itself by.
class HarnessTopBar extends StatelessWidget {
  const HarnessTopBar({super.key});

  /// Zero off macOS: there the native caption bar already holds this space, and
  /// a second strip under it would be a gap with nothing in it.
  static double get height => RuntimePlatform.isMacOS ? 32.0 : 0.0;

  @override
  Widget build(BuildContext context) {
    if (!RuntimePlatform.isMacOS) return const SizedBox.shrink();
    grid.AppTheme.watch(context);
    // Drag only. The native tab strip above this bar owns the title-bar
    // double-click and zooms the window itself; DragToMoveArea's own
    // double-tap zoomed it a second time, straight back (owner, 2026-09-15:
    // "maximizes out and resizes back").
    return WindowDragArea(
      child: Container(
        height: height,
        decoration: BoxDecoration(
          color: grid.AppPalette.panelBg,
          border: Border(bottom: BorderSide(color: grid.AppGlass.hair)),
        ),
        padding: EdgeInsets.only(left: trafficLightClearance),
        alignment: Alignment.centerLeft,
        child: Text(
          'Harness',
          // Title-bar chrome, set like the native tabs beside it.
          style: grid.AppType.monoLabel(
            fontWeight: FontWeight.w600,
            color: grid.AppPalette.textSecondary,
          ),
        ),
      ),
    );
  }
}

/// A window drag handle that does not hold up the controls drawn inside it.
///
/// window_manager's own [DragToMoveArea] binds double-tap-to-maximize as well
/// as the drag, and a `DoubleTapGestureRecognizer` **holds the gesture arena**
/// for `kDoubleTapTimeout` (300ms) after the first tap comes up — it has to,
/// or it could never see a second one. Nothing else in that arena resolves
/// until it lets go, so every button inside one of those regions fires 300ms
/// after the mouse was released. That is the rail header (fold, reload,
/// filter), a pane header's close, and the update strip's Install: the whole
/// top edge of the window, which is also the part of it people click most.
///
/// The maximize gesture is worth having on a strip that holds nothing —
/// [WindowDragStrip] keeps [DragToMoveArea] for it; on macOS the native tab
/// strip zooms on double-click and [HarnessTopBar] under it only drags — and
/// is not worth 300ms on every control in the app's chrome.
class WindowDragArea extends StatelessWidget {
  const WindowDragArea({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      // Translucent, like DragToMoveArea: the drag has to be available from
      // the gaps between whatever the region draws.
      behavior: HitTestBehavior.translucent,
      // Null off the desktop, so no pan recognizer is registered at all rather
      // than one that throws the moment someone drags the chrome.
      onPanStart: hasManagedWindow
          ? (_) => windowManager.startDragging()
          : null,
      child: child,
    );
  }
}

/// A strip along the top of a screen that fills the window, so it can still be
/// dragged with the title bar gone. macOS keeps its native caption; Windows
/// hides it and draws the row itself, so both need this. Zero elsewhere.
class WindowDragStrip extends StatelessWidget {
  const WindowDragStrip({super.key});

  @override
  Widget build(BuildContext context) {
    final managedTitleRow =
        RuntimePlatform.isMacOS || RuntimePlatform.isWindows;
    return DragToMoveArea(
      child: SizedBox(
        height: managedTitleRow ? windowDragBandHeight : 0,
        width: double.infinity,
      ),
    );
  }
}

/// The empty part of a caption row the app draws itself.
///
/// Drags the window and, like a system caption, restores or maximises it on a
/// double click. It sits BEHIND the row's controls rather than around them, so
/// it never joins the gesture arena under a button ([WindowDragArea] explains
/// why that costs 300 ms).
class WindowCaptionDragArea extends StatelessWidget {
  const WindowCaptionDragArea({super.key});

  @override
  Widget build(BuildContext context) {
    if (!hasManagedWindow) return const SizedBox.expand();
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onPanStart: (_) => windowManager.startDragging(),
      onDoubleTap: () async {
        if (await windowManager.isMaximized()) {
          await windowManager.unmaximize();
        } else {
          await windowManager.maximize();
        }
      },
      child: const SizedBox.expand(),
    );
  }
}

/// Minimise, restore and close for a window whose caption the app draws.
///
/// Windows hides the system caption and puts its buttons at the end of the
/// workspace tab strip, so the tabs, the app's controls and the window's own
/// controls share the one row every other Windows app uses. Sized like
/// Windows draws them: 46 wide, the row's full height, the close button filled
/// red only under the pointer.
class WindowCaptionButtons extends StatefulWidget {
  const WindowCaptionButtons({super.key, required this.height});

  /// The row's height, so the buttons fill it edge to edge.
  final double height;

  static const double buttonWidth = 46;

  @override
  State<WindowCaptionButtons> createState() => _WindowCaptionButtonsState();
}

class _WindowCaptionButtonsState extends State<WindowCaptionButtons>
    with WindowListener {
  bool _maximized = false;

  @override
  void initState() {
    super.initState();
    windowManager.addListener(this);
    windowManager.isMaximized().then((value) {
      if (mounted) setState(() => _maximized = value);
    });
  }

  @override
  void dispose() {
    windowManager.removeListener(this);
    super.dispose();
  }

  @override
  void onWindowMaximize() => setState(() => _maximized = true);

  @override
  void onWindowUnmaximize() => setState(() => _maximized = false);

  @override
  Widget build(BuildContext context) => SizedBox(
    height: widget.height,
    child: Row(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _CaptionButton(
          key: const ValueKey('windows-window-minimize'),
          label: 'Minimize',
          icon: AppIcons.minus,
          onPressed: windowManager.minimize,
        ),
        _CaptionButton(
          key: const ValueKey('windows-window-maximize'),
          label: _maximized ? 'Restore' : 'Maximize',
          icon: _maximized ? AppIcons.copy : AppIcons.square,
          onPressed: () => _maximized
              ? windowManager.unmaximize()
              : windowManager.maximize(),
        ),
        _CaptionButton(
          key: const ValueKey('windows-window-close'),
          label: 'Close',
          icon: AppIcons.close,
          close: true,
          onPressed: windowManager.close,
        ),
      ],
    ),
  );
}

class _CaptionButton extends StatefulWidget {
  const _CaptionButton({
    super.key,
    required this.label,
    required this.icon,
    required this.onPressed,
    this.close = false,
  });

  final String label;
  final IconData icon;
  final VoidCallback onPressed;
  final bool close;

  @override
  State<_CaptionButton> createState() => _CaptionButtonState();
}

class _CaptionButtonState extends State<_CaptionButton> {
  bool _hovered = false;

  @override
  Widget build(BuildContext context) {
    final hovered = _hovered;
    final close = widget.close;
    final background = hovered
        ? (close ? const Color(0xffc42b1c) : grid.AppSurface.hoverFill)
        : Colors.transparent;
    final foreground = hovered && close
        ? Colors.white
        : grid.AppPalette.textPrimary;
    return Semantics(
      button: true,
      label: widget.label,
      onTap: widget.onPressed,
      child: Tooltip(
        message: widget.label,
        excludeFromSemantics: true,
        waitDuration: const Duration(milliseconds: 500),
        child: MouseRegion(
          cursor: SystemMouseCursors.click,
          onEnter: (_) => setState(() => _hovered = true),
          onExit: (_) => setState(() => _hovered = false),
          child: FocusableActionDetector(
            mouseCursor: SystemMouseCursors.click,
            onShowFocusHighlight: (value) => setState(() => _hovered = value),
            actions: {
              ActivateIntent: CallbackAction<ActivateIntent>(
                onInvoke: (_) {
                  widget.onPressed();
                  return null;
                },
              ),
            },
            child: GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: widget.onPressed,
              child: Container(
                width: WindowCaptionButtons.buttonWidth,
                color: background,
                alignment: Alignment.center,
                child: ExcludeSemantics(
                  child: Icon(widget.icon, size: 12, color: foreground),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// A screen that takes the whole window — sign-in, first-run setup — with a
/// drag strip laid over its top edge.
///
/// Overlaid rather than stacked above, so the screen's own centring does not
/// shift by half a strip; these screens centre a card and draw nothing at the
/// top that the lights could cover.
class FullWindowScreen extends StatelessWidget {
  const FullWindowScreen({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Stack(
      children: [
        Positioned.fill(child: child),
        const Positioned(top: 0, left: 0, right: 0, child: WindowDragStrip()),
        if (drawsWindowCaption)
          const Positioned(
            top: 0,
            right: 0,
            child: WindowCaptionButtons(height: kWindowCaptionHeight),
          ),
      ],
    );
  }
}
