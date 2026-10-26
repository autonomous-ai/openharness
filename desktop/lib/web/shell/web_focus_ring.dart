import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:xterm/xterm.dart' show TerminalView;

import '../../shared/theme/app_theme.dart' as grid;

/// The browser's keyboard focus ring: the design system's accent outline
/// around the control a key moved focus to (Tab, or an arrow in a list or
/// menu), whatever widget draws that control. Audit finding P8.
///
/// Many of the web's controls draw no focus of their own (the sign-in pair on
/// purpose: a ring on the one holding focus at rest made it read as the bigger
/// button, owner 2026-10-01), so the ring shows only once a key has moved focus,
/// and the next click or touch puts it away. It never surrounds a terminal,
/// which takes Tab for itself. It follows its control through scrolling and
/// into dialogs, and draws nothing it could be clicked through: it ignores
/// pointers.
class WebFocusRing extends StatefulWidget {
  const WebFocusRing({super.key, required this.child});

  final Widget child;

  /// How far outside its control the outline is drawn, and how thick it is.
  static const gap = 2.0, width = 2.0;

  @override
  State<WebFocusRing> createState() => _WebFocusRingState();
}

class _WebFocusRingState extends State<WebFocusRing> {
  /// Whether a key moved focus since the last click or touch.
  bool _keyboard = false;

  /// Where the ring is drawn; null draws none.
  Rect? _rect;

  bool _watching = false;

  @override
  void initState() {
    super.initState();
    HardwareKeyboard.instance.addHandler(_onKey);
    GestureBinding.instance.pointerRouter.addGlobalRoute(_onPointer);
    FocusManager.instance.addListener(_place);
    FocusManager.instance.addHighlightModeListener(_onHighlightMode);
    grid.AppTheme.brightness.addListener(_place);
  }

  @override
  void dispose() {
    HardwareKeyboard.instance.removeHandler(_onKey);
    GestureBinding.instance.pointerRouter.removeGlobalRoute(_onPointer);
    FocusManager.instance.removeListener(_place);
    FocusManager.instance.removeHighlightModeListener(_onHighlightMode);
    grid.AppTheme.brightness.removeListener(_place);
    super.dispose();
  }

  bool _onKey(KeyEvent event) {
    if (event is! KeyUpEvent && _movesFocus(event.logicalKey)) {
      _keyboard = true;
      // Focus moves while the key is handled; read where it landed after.
      WidgetsBinding.instance.addPostFrameCallback((_) => _place());
    }
    return false;
  }

  static bool _movesFocus(LogicalKeyboardKey key) =>
      key == LogicalKeyboardKey.tab ||
      key == LogicalKeyboardKey.arrowUp ||
      key == LogicalKeyboardKey.arrowDown ||
      key == LogicalKeyboardKey.arrowLeft ||
      key == LogicalKeyboardKey.arrowRight;

  void _onHighlightMode(FocusHighlightMode _) => _place();

  void _onPointer(PointerEvent event) {
    if (event is! PointerDownEvent || !_keyboard) return;
    _keyboard = false;
    _place();
  }

  /// The focused control's outline, or null when none should be drawn.
  Rect? _target() {
    if (!_keyboard ||
        FocusManager.instance.highlightMode != FocusHighlightMode.traditional) {
      return null;
    }
    final focus = FocusManager.instance.primaryFocus;
    // A scope holds focus when no control does (a page or dialog with nothing focused).
    if (focus == null || focus is FocusScopeNode) return null;
    final context = focus.context;
    if (context == null || !context.mounted) return null;
    if (context.widget is TerminalView ||
        context.findAncestorWidgetOfExactType<TerminalView>() != null) {
      return null;
    }
    final rect = focus.rect;
    if (rect.isEmpty) return null;
    return rect.inflate(WebFocusRing.gap + WebFocusRing.width / 2);
  }

  void _place() {
    if (!mounted) return;
    final rect = _target();
    if (rect != _rect) setState(() => _rect = rect);
    _follow();
  }

  /// While the ring is up, read its control's place again after every frame:
  /// a list scrolling or a dialog opening moves the control without moving
  /// focus. It asks for no frames of its own.
  void _follow() {
    if (_rect == null || _watching) return;
    _watching = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _watching = false;
      _place();
    });
  }

  @override
  Widget build(BuildContext context) {
    final rect = _rect;
    final dark = grid.AppTheme.brightness.value == Brightness.dark;
    return Stack(
      textDirection: TextDirection.ltr,
      children: [
        widget.child,
        if (rect != null)
          Positioned.fromRect(
            key: const Key('web-focus-ring'),
            rect: rect,
            child: IgnorePointer(
              child: DecoratedBox(
                decoration: BoxDecoration(
                  border: Border.all(
                    color: dark
                        ? grid.AppDesktop.focusDark
                        : grid.AppPalette.accent,
                    width: WebFocusRing.width,
                  ),
                  borderRadius: BorderRadius.circular(8),
                ),
              ),
            ),
          ),
      ],
    );
  }
}
