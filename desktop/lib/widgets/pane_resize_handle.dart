import 'package:flutter/material.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/services.dart';

import '../state/pane_arrangement.dart';
import '../shared/theme/app_theme.dart' as grid;

/// The existing gap is the hit target. Only hover or keyboard focus reveals
/// its thin grip; pointer movement never changes the focused agent.
class PaneResizeHandle extends StatefulWidget {
  const PaneResizeHandle({
    super.key,
    required this.arrangement,
    required this.divider,
    required this.extent,
    required this.minimum,
    required this.onChanged,
    required this.onLeave,
    this.focusNode,
  });
  final PaneArrangement arrangement;
  final PaneDivider divider;
  final Size extent, minimum;
  final void Function(PaneArrangement arrangement, bool persist) onChanged;
  final VoidCallback onLeave;
  final FocusNode? focusNode;

  @override
  State<PaneResizeHandle> createState() => _PaneResizeHandleState();
}

class _PaneResizeHandleState extends State<PaneResizeHandle> {
  final _ownFocus = FocusNode(debugLabel: 'Resize panes');
  bool _hover = false, _focused = false;
  PaneArrangement? _start, _last;
  PaneDivider? _startDivider;
  FocusNode? _previousFocus;
  double _startPosition = 0;
  bool get _horizontal => widget.divider.axis == PaneResizeAxis.x;
  FocusNode get _focus => widget.focusNode ?? _ownFocus;

  PaneArrangement _resized(double delta) => widget.arrangement.resize(
    widget.divider,
    widget.divider.position + delta,
    minimum: widget.minimum,
  );

  String _value(PaneArrangement arrangement) {
    final tile = arrangement.tiles[widget.divider.before.first];
    final position = _horizontal ? tile.right : tile.bottom;
    return '${(position * 100).round()} percent';
  }

  void _step(double delta) {
    final next = _resized(delta);
    if (!identical(next, widget.arrangement)) widget.onChanged(next, true);
  }

  void _balance() => widget.onChanged(
    widget.arrangement.resize(
      widget.divider,
      widget.arrangement.balancedPosition(widget.divider),
      minimum: widget.minimum,
    ),
    true,
  );

  void _begin(DragStartDetails details) {
    _previousFocus = _focus.hasFocus
        ? null
        : FocusManager.instance.primaryFocus;
    _focus.requestFocus();
    _start = _last = widget.arrangement;
    _startDivider = widget.divider;
    _startPosition = _horizontal
        ? details.globalPosition.dx
        : details.globalPosition.dy;
  }

  void _drag(DragUpdateDetails details) {
    final start = _start, divider = _startDivider;
    if (start == null || divider == null) return;
    final extent = _horizontal ? widget.extent.width : widget.extent.height;
    if (extent <= 0) return;
    final position = _horizontal
        ? details.globalPosition.dx
        : details.globalPosition.dy;
    _last = start.resize(
      divider,
      divider.position + (position - _startPosition) / extent,
      minimum: widget.minimum,
    );
    widget.onChanged(_last!, false);
  }

  void _end(DragEndDetails _) {
    if (_start == null) return;
    _start = null;
    _startDivider = null;
    widget.onChanged(_last ?? widget.arrangement, true);
    _last = null;
    _restoreFocus();
  }

  void _restoreFocus() {
    final previous = _previousFocus;
    _previousFocus = null;
    if (_focus.hasFocus &&
        previous?.context != null &&
        previous!.canRequestFocus) {
      previous.requestFocus();
    }
  }

  void _cancel() {
    final previous = _start;
    _start = null;
    _startDivider = null;
    _last = null;
    if (previous != null) widget.onChanged(previous, true);
    _restoreFocus();
  }

  @override
  void dispose() {
    _ownFocus.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Semantics(
    label: _horizontal ? 'Resize pane columns' : 'Resize pane rows',
    value: _value(widget.arrangement),
    increasedValue: _value(_resized(.02)),
    decreasedValue: _value(_resized(-.02)),
    hint:
        'Arrow keys resize. Double-click balances. Escape returns to the pane.',
    slider: true,
    onIncrease: () => _step(.02),
    onDecrease: () => _step(-.02),
    child: Focus(
      focusNode: _focus,
      onFocusChange: (value) => setState(() => _focused = value),
      onKeyEvent: (_, event) {
        if (event is! KeyDownEvent && event is! KeyRepeatEvent) {
          return KeyEventResult.ignored;
        }
        final keyboard = HardwareKeyboard.instance;
        if (keyboard.isMetaPressed ||
            keyboard.isControlPressed ||
            keyboard.isAltPressed) {
          return KeyEventResult.ignored;
        }
        if (event.logicalKey == LogicalKeyboardKey.escape) {
          _cancel();
          widget.onLeave();
          return KeyEventResult.handled;
        }
        final decrease = _horizontal
            ? LogicalKeyboardKey.arrowLeft
            : LogicalKeyboardKey.arrowUp;
        final increase = _horizontal
            ? LogicalKeyboardKey.arrowRight
            : LogicalKeyboardKey.arrowDown;
        if (event.logicalKey != decrease && event.logicalKey != increase) {
          return KeyEventResult.ignored;
        }
        _step(
          (event.logicalKey == decrease ? -1 : 1) *
              (keyboard.isShiftPressed ? .1 : .02),
        );
        return KeyEventResult.handled;
      },
      child: MouseRegion(
        cursor: _horizontal
            ? SystemMouseCursors.resizeColumn
            : SystemMouseCursors.resizeRow,
        onEnter: (_) => setState(() => _hover = true),
        onExit: (_) => setState(() => _hover = false),
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          dragStartBehavior: DragStartBehavior.down,
          onDoubleTap: _balance,
          onHorizontalDragStart: _horizontal ? _begin : null,
          onHorizontalDragUpdate: _horizontal ? _drag : null,
          onHorizontalDragEnd: _horizontal ? _end : null,
          onHorizontalDragCancel: _horizontal ? _cancel : null,
          onVerticalDragStart: _horizontal ? null : _begin,
          onVerticalDragUpdate: _horizontal ? null : _drag,
          onVerticalDragEnd: _horizontal ? null : _end,
          onVerticalDragCancel: _horizontal ? null : _cancel,
          child: Stack(
            alignment: Alignment.center,
            children: [
              if (_hover || _focused || _start != null)
                Center(
                  child: Container(
                    width: _horizontal ? 1 : double.infinity,
                    height: _horizontal ? double.infinity : 1,
                    color: grid.AppPalette.swarmAccent.withValues(alpha: .35),
                  ),
                ),
              Center(
                child: AnimatedContainer(
                  duration: MediaQuery.disableAnimationsOf(context)
                      ? Duration.zero
                      : grid.AppMotion.hover,
                  width: _horizontal ? 3 : 36,
                  height: _horizontal ? 36 : 3,
                  decoration: BoxDecoration(
                    borderRadius: BorderRadius.circular(2),
                    color: _hover || _focused || _start != null
                        ? grid.AppPalette.swarmAccent
                        : Colors.transparent,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    ),
  );
}
