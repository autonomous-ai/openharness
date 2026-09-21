import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../theme/app_theme.dart';
import 'app_menu.dart';

/// One choice in an [AppSelectField].
@immutable
class SelectOption<T> {
  const SelectOption({
    required this.value,
    required this.label,
    this.note,
    this.detail,
    this.leading,
    this.trailing,
  });

  final T value;
  final String label;

  /// A sentence UNDER the label, for a list whose labels alone do not say what
  /// picking one does.
  ///
  /// Distinct from [note], which sits beside the label and qualifies the same
  /// noun. A sentence cannot go there: the closed field is only as wide as the
  /// control, so it would arrive clipped mid-clause. Shown in the OPEN menu
  /// only, which is where it is needed — while choosing, not after.
  final String? detail;

  /// A mark shown before the label, in the row AND in the closed control — an
  /// engine's logo, a colour swatch. Built fresh per use rather than shared, so
  /// the same option can appear in both places.
  final Widget Function()? leading;

  /// A short qualifier shown after the label in quieter ink — "SF Pro" beside
  /// "System", or a warning that a saved choice is no longer installed.
  final String? note;

  /// A mark at the row's far end. Built fresh per use, like [leading].
  ///
  /// For a state that recurs down the list, where the same words on several
  /// rows read as noise. Only in the open list: the closed control shows the
  /// chosen option's [note], and a glyph there would have to explain itself
  /// with no room to.
  final Widget Function()? trailing;
}

/// A control that picks one of a list, replacing [DropdownButtonFormField].
///
/// Material's dropdown is unusable here: it renders its own popup, anchors it
/// *over* the field rather than under it, forces the panel to the field's width,
/// and comes out square-cornered and edge-to-edge no matter what `borderRadius`,
/// `elevation` or `dropdownColor` you hand it — while ignoring BOTH `menuTheme`
/// and `popupMenuTheme`, so it cannot be made to match any other menu in the
/// app. Built on [MenuAnchor] instead, it takes [AppMenu]'s panel like every
/// other menu here and its rows are the app's own [AppMenuItem].
///
/// ⚠️ There is no disabled row, deliberately. A choice that is visible but
/// silently does nothing is worse than a choice that is absent — so a caller
/// with an unavailable option should drop it from [options] rather than hope
/// for a greyed-out row. The exception worth making is the option that is
/// currently SELECTED but no longer available: that one stays, with a [note]
/// saying why, because a picker that silently forgets the user's setting is the
/// same failure wearing a different hat.
class AppSelectField<T> extends StatefulWidget {
  const AppSelectField({
    super.key,
    required this.value,
    required this.options,
    required this.onChanged,
    this.width,
    this.height = AppControl.height,
    this.trigger,
  });

  final T value;
  final List<SelectOption<T>> options;
  final ValueChanged<T> onChanged;

  /// Fixed width, so a column of these lines up on one right edge. Null lets it
  /// take whatever its parent gives.
  final double? width;
  final double height;

  /// An alternate compact trigger, such as the agent picker's More button.
  /// Selection, keyboard navigation and menu rows remain shared.
  final Widget? trigger;

  @override
  State<AppSelectField<T>> createState() => _AppSelectFieldState<T>();
}

class _AppSelectFieldState<T> extends State<AppSelectField<T>> {
  final _controller = MenuController();
  final _fieldFocus = FocusNode(debugLabel: 'Select field');
  final _optionFocus = <T, FocusNode>{};
  ({T value})? _pendingFocus;
  String _prefix = '';
  Duration? _lastTyped;
  bool _focusScheduled = false;
  bool _hovered = false;
  bool _focused = false;

  FocusNode _focusFor(T value) => _optionFocus.putIfAbsent(
    value,
    () => FocusNode(debugLabel: 'Select option'),
  );

  SelectOption<T>? get _currentOption =>
      widget.options
          .where((option) => option.value == widget.value)
          .firstOrNull ??
      widget.options.firstOrNull;

  @override
  void didUpdateWidget(AppSelectField<T> oldWidget) {
    super.didUpdateWidget(oldWidget);
    final values = widget.options.map((option) => option.value).toSet();
    var lostFocus = false;
    for (final value in _optionFocus.keys.toList()) {
      if (values.contains(value)) continue;
      final node = _optionFocus.remove(value)!;
      lostFocus |= node.hasFocus || _pendingFocus?.value == value;
      node.dispose();
    }
    if (!_controller.isOpen || !lostFocus) return;
    _prefix = '';
    _lastTyped = null;
    final next = _currentOption;
    if (next == null) {
      _controller.close();
    } else {
      _focusOption(next);
    }
  }

  @override
  void dispose() {
    _fieldFocus.dispose();
    for (final node in _optionFocus.values) {
      node.dispose();
    }
    super.dispose();
  }

  void _open() {
    if (widget.options.isEmpty || _controller.isOpen) return;
    _prefix = '';
    _lastTyped = null;
    _controller.open();
    // Unopened controls need no per-option focus nodes. Mount them with the
    // menu, including any match typed before its first frame.
    setState(() {});
    _focusOption(_currentOption!, afterLayout: true);
  }

  void _focusOption(SelectOption<T> option, {bool afterLayout = false}) {
    _pendingFocus = (value: option.value);
    final node = _focusFor(option.value);
    if (!afterLayout &&
        !_focusScheduled &&
        node.parent != null &&
        node.context?.mounted == true) {
      node.requestFocus();
      Scrollable.ensureVisible(node.context!);
      return;
    }
    // Opening and typing can happen before the menu's first frame. Keep the
    // newest match, rather than restoring the old selection after it mounts.
    if (_focusScheduled) return;
    _focusScheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _focusScheduled = false;
      if (!mounted || !_controller.isOpen) return;
      final pending = _pendingFocus;
      if (pending == null) return;
      final node = _optionFocus[pending.value];
      if (node?.context == null) return;
      node!.requestFocus();
      Scrollable.ensureVisible(node.context!);
    });
  }

  int get _highlightedIndex {
    final focused = widget.options.indexWhere(
      (option) => _optionFocus[option.value]?.hasPrimaryFocus == true,
    );
    if (focused >= 0) return focused;
    final pending = _pendingFocus;
    return pending == null
        ? -1
        : widget.options.indexWhere((option) => option.value == pending.value);
  }

  void _choose(SelectOption<T> option) {
    _controller.close();
    _fieldFocus.requestFocus();
    if (option.value != widget.value) widget.onChanged(option.value);
  }

  KeyEventResult _typeAhead(FocusNode _, KeyEvent event) {
    if (!_controller.isOpen || event is KeyUpEvent) {
      return KeyEventResult.ignored;
    }
    final keyboard = HardwareKeyboard.instance;
    if (keyboard.isMetaPressed ||
        keyboard.isControlPressed ||
        keyboard.isAltPressed) {
      return KeyEventResult.ignored;
    }
    if (!keyboard.isShiftPressed) {
      if (event.logicalKey == LogicalKeyboardKey.escape) {
        _controller.close();
        _fieldFocus.requestFocus();
        return KeyEventResult.handled;
      }
      if (event.logicalKey == LogicalKeyboardKey.enter ||
          event.logicalKey == LogicalKeyboardKey.numpadEnter) {
        final index = _highlightedIndex;
        if (index >= 0) _choose(widget.options[index]);
        return KeyEventResult.handled;
      }
    }
    final text = event.character?.toLowerCase();
    if (text == null ||
        text.isEmpty ||
        text.runes.any((r) => r < 32 || r == 127)) {
      _prefix = '';
      return KeyEventResult.ignored;
    }
    if (_lastTyped == null ||
        event.timeStamp < _lastTyped! ||
        event.timeStamp - _lastTyped! > const Duration(seconds: 1)) {
      _prefix = '';
    }
    if (text == ' ' && _prefix.isEmpty) return KeyEventResult.ignored;
    _lastTyped = event.timeStamp;
    final continuing = _prefix.isNotEmpty && _prefix != text;
    _prefix = continuing ? _prefix + text : text;
    final current = _highlightedIndex;
    final start = current < 0 ? 0 : current + (continuing ? 0 : 1);
    for (var offset = 0; offset < widget.options.length; offset++) {
      final option = widget.options[(start + offset) % widget.options.length];
      if (option.label.trimLeft().toLowerCase().startsWith(_prefix)) {
        _focusOption(option);
        break;
      }
    }
    return KeyEventResult.handled;
  }

  Widget _typingRegion(Widget child, {Key? key}) => Focus(
    key: key,
    canRequestFocus: false,
    skipTraversal: true,
    onKeyEvent: _typeAhead,
    child: child,
  );

  /// How tall this panel may draw.
  ///
  /// ⚠️ NOT [AppControl.menuMaxHeight]. That token's 240 is for a menu that
  /// opens UPWARD and places itself by summing the height it is about to take;
  /// this one hangs below its field, so it is free to be as tall as its own
  /// list. Left at 240, a seven-item picker overflowed by five pixels and grew
  /// a scrollbar to show them — furniture that says "there is more here" when
  /// there is not.
  ///
  /// The ceiling is still real: past it a long list scrolls instead of running
  /// off the window.
  double get _panelHeight => math.min(
    // A row with a detail line is TALLER, and the difference has to be counted
    // per row rather than assumed for all of them: a list where only some
    // options carry a sentence would otherwise be measured wrong in whichever
    // direction the guess went, and a panel that disagrees with its layout by a
    // few pixels wears a scrollbar it does not need.
    widget.options.fold<double>(
          0,
          (total, option) =>
              total +
              (option.detail == null
                  ? AppMenuRowMetrics.roomy.extent
                  : AppMenuRowMetrics.roomy.detailExtent),
        ) +
        AppMenu.panelPadding.vertical,
    _maxPanelHeight,
  );

  static const double _maxPanelHeight = 380;

  /// A floor under the panel's width, on top of the field's own.
  ///
  /// A field can be narrow — the font picker's is 188 — while its list holds
  /// names that are not. The panel is where the choosing happens, so it is
  /// allowed to be wider than the box it drops out of; the reverse, a panel
  /// narrower than its control, is what reads as an unrelated box.
  static const double _minPanelWidth = 240;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final selected = widget.options.where((o) => o.value == widget.value);
    final current = selected.isEmpty ? null : selected.first;

    // The panel is measured against the FIELD, not against its own contents: a
    // menu narrower than the control it drops out of reads as an unrelated box
    // that happened to open nearby. `widget.width` covers a fixed-size field;
    // the incoming constraint covers one that fills its parent — the case in a
    // dialog, and the one that was missed.
    return LayoutBuilder(
      builder: (context, constraints) => _anchor(
        current,
        widget.width ??
            (constraints.maxWidth.isFinite ? constraints.maxWidth : null),
      ),
    );
  }

  Widget _anchor(SelectOption<T>? current, double? panelWidth) {
    return MenuAnchor(
      controller: _controller,
      childFocusNode: _fieldFocus,
      onClose: () {
        _prefix = '';
        _lastTyped = null;
        _pendingFocus = null;
      },
      // Below the control, by the app's one menu gap — and the panel takes its
      // fill, rim and radius from [AppMenu], the app's single panel recipe.
      alignmentOffset: const Offset(0, AppControl.menuGap),
      // ⚠️ The width is set on the ROWS, not with `MenuStyle.minimumSize`.
      //
      // `minimumSize` does widen the panel, but `MenuAnchor` lays its children
      // out loose, so the rows keep their intrinsic width and sit in a wider box
      // — measured at 173 inside a panel asked for 240, which reads as a menu
      // with a mysterious margin down one side. Sizing the row makes the panel
      // follow it, and the hover pill then spans the width a person is aiming
      // at.
      style: AppMenu.style(maxHeight: _panelHeight),
      menuChildren: [
        for (final option in widget.options)
          _typingRegion(
            SizedBox(
              width: math.max(panelWidth ?? 0, _minPanelWidth),
              child: AppMenuItem(
                // No glyph of its own: the leading slot belongs to the tick,
                // and stays empty (not a blank checkbox) on rows without it.
                // `selected` also carries the wash and the heavier label, so the
                // choice is marked three ways rather than by a tick alone.
                // A picker's list, not a context menu's: this menu IS the
                // control, it is read down rather than glanced at, and it is the
                // only place these choices are ever shown.
                metrics: AppMenuRowMetrics.roomy,
                focusNode: _controller.isOpen ? _focusFor(option.value) : null,
                selected: option.value == widget.value,
                label: option.label,
                note: option.note,
                detail: option.detail,
                leading: option.leading?.call(),
                trailing: option.trailing?.call(),
                onPressed: () => _choose(option),
              ),
            ),
            key: ValueKey(option.value),
          ),
      ],
      builder: (context, controller, _) => _typingRegion(
        MouseRegion(
          cursor: SystemMouseCursors.click,
          onEnter: (_) => setState(() => _hovered = true),
          onExit: (_) => setState(() => _hovered = false),
          child: CallbackShortcuts(
            bindings: {
              const SingleActivator(LogicalKeyboardKey.arrowDown): _open,
              const SingleActivator(LogicalKeyboardKey.arrowUp): _open,
            },
            child: InkWell(
              focusNode: _fieldFocus,
              onFocusChange: (value) => setState(() => _focused = value),
              onTap: () => controller.isOpen ? controller.close() : _open(),
              splashFactory: NoSplash.splashFactory,
              hoverColor: Colors.transparent,
              focusColor: Colors.transparent,
              borderRadius: BorderRadius.circular(AppControl.radius),
              child: AnimatedContainer(
                duration: AppMotion.hover,
                curve: AppMotion.curve,
                width: widget.width,
                height: widget.height,
                padding: const EdgeInsets.only(left: 10, right: 8),
                decoration: BoxDecoration(
                  color: _hovered || _focused || controller.isOpen
                      ? AppSurface.recessHover
                      : AppSurface.recess,
                  borderRadius: BorderRadius.circular(AppControl.radius),
                  border: Border.all(
                    color: _focused
                        ? AppPalette.accentOnSurface
                        : Colors.transparent,
                  ),
                ),
                child:
                    widget.trigger ??
                    Row(
                      children: [
                        Expanded(
                          child: Row(
                            children: [
                              if (current?.leading != null) ...[
                                current!.leading!(),
                                const SizedBox(width: 8),
                              ],
                              Flexible(
                                child: Text(
                                  current?.label ?? '—',
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: TextStyle(
                                    fontFamily: AppFont.sans,
                                    fontFamilyFallback: AppFont.sansFallback,
                                    fontSize: AppControl.fontSize,
                                    fontWeight: AppControl.fontWeight,
                                    letterSpacing: AppFont.trackingFor(
                                      AppControl.fontSize,
                                    ),
                                    color: AppPalette.textPrimary,
                                  ),
                                ),
                              ),
                              if (current?.note != null) ...[
                                const SizedBox(width: 8),
                                Flexible(
                                  child: Text(
                                    current!.note!,
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    style: TextStyle(
                                      fontFamily: AppFont.sans,
                                      fontFamilyFallback: AppFont.sansFallback,
                                      fontSize: 11.5,
                                      color: AppPalette.textFaint,
                                    ),
                                  ),
                                ),
                              ],
                            ],
                          ),
                        ),
                        const SizedBox(width: 6),
                        Icon(
                          Icons.expand_more_rounded,
                          size: AppControl.iconSize,
                          color: _hovered || controller.isOpen
                              ? AppPalette.textPrimary
                              : AppPalette.textSecondary,
                        ),
                      ],
                    ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
