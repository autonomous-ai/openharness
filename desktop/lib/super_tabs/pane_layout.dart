import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../core/local_key_value_store.dart';
import '../state/pane_arrangement.dart';
import '../widgets/desktop_chrome.dart';
import '../widgets/pane_resize_handle.dart';

/// Navigation and people keep their preferred widths as the window changes;
/// the conversation takes the remaining space. Resizing never replaces a pane.
class SuperTabPaneLayout extends StatefulWidget {
  const SuperTabPaneLayout({
    super.key,
    required this.center,
    required this.onLeave,
    this.left,
    this.right,
    this.storage,
    this.rightDefault = rightWidth,
  });

  static const storageKey = 'super-tab-pane-widths';
  static const leftWidth = 300.0;
  static const rightWidth = 280.0;

  /// A thread's default width (Scholes, 10-31): room for its reply box's
  /// options on one row ("New session" and "Also to chat"). [rightWidth]
  /// stays the narrowest the pane goes.
  static const threadWidth = 340.0;

  /// The roster drawer's share of a narrow window at most. On a phone it filled the screen, leaving no
  /// veil to tap, so closing it was hard (owner, 2026-10-23).
  static const drawerMaxFraction = 0.7;

  /// The roster drawer's width in a window [available] wide, at most [max]
  /// (a thread's drawer passes [threadWidth]).
  static double drawerWidth(double available, {double max = rightWidth}) =>
      (available * drawerMaxFraction).clamp(0, max).toDouble();
  final Widget? left, right;

  final Widget center;
  final VoidCallback onLeave;
  final LocalKeyValueStore? storage;

  /// The right pane's width until a person sets one by its divider (that
  /// width, saved, wins): [threadWidth] while it shows a thread.
  final double rightDefault;

  @override
  State<SuperTabPaneLayout> createState() => _SuperTabPaneLayoutState();
}

class _SuperTabPaneLayoutState extends State<SuperTabPaneLayout> {
  double _left = SuperTabPaneLayout.leftWidth;
  // Null until a person sets it, or it is restored: the right pane then
  // takes the widget's default for what it shows.
  double? _right;
  int _edit = 0;
  Future<void> _writing = Future.value();

  @override
  void initState() {
    super.initState();
    unawaited(_restore());
  }

  @override
  void didUpdateWidget(SuperTabPaneLayout oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.storage != widget.storage) unawaited(_restore());
  }

  Future<void> _restore() async {
    final edit = ++_edit, store = widget.storage;
    try {
      final raw = await store?.read(SuperTabPaneLayout.storageKey);
      if (!mounted || edit != _edit || raw == null) return;
      final value = jsonDecode(raw);
      double width(String key, double fallback) =>
          value is Map &&
              value[key] is num &&
              (value[key] as num).isFinite &&
              (value[key] as num) > 0
          ? (value[key] as num).toDouble()
          : fallback;
      setState(() {
        _left = width('left', _left);
        // Builds before 10-31 saved the right pane's default with any
        // divider move: 280 is that default (and the minimum), so it reads as
        // no choice and a thread still opens at its own width.
        final right = width('right', -1);
        if (right > 0 && right != SuperTabPaneLayout.rightWidth) {
          _right = right;
        }
      });
    } catch (_) {
      // A missing or old preference must not prevent opening the workspace.
    }
  }

  void _save() {
    final store = widget.storage;
    if (store == null) return;
    final value = jsonEncode({'left': _left, 'right': ?_right});
    _writing = _writing
        .then((_) => store.write(SuperTabPaneLayout.storageKey, value))
        .catchError((Object _) {});
  }

  @override
  Widget build(BuildContext context) => _panes();

  Widget _panes() => LayoutBuilder(
    builder: (context, constraints) {
      final width = constraints.maxWidth;
      final scale = MediaQuery.textScalerOf(context);
      final hasLeft = widget.left != null, hasRight = widget.right != null;
      final centerMin = math.min(scale.scale(360), width);
      final leftMin = hasLeft ? scale.scale(180) : 0.0;
      final rightMin = hasRight ? scale.scale(280) : 0.0;
      double limit(double value, double floor, double ceiling) => value
          .clamp(math.min(floor, ceiling), math.max(0, ceiling))
          .toDouble();
      final left = hasLeft
          ? limit(_left, leftMin, width - centerMin - rightMin)
          : 0.0;
      final right = hasRight
          ? limit(
              _right ?? widget.rightDefault,
              rightMin,
              width - centerMin - left,
            )
          : 0.0;
      final arrangement = PaneArrangement([
        if (hasLeft) Rect.fromLTRB(0, 0, left / width, 1),
        Rect.fromLTRB(left / width, 0, 1 - right / width, 1),
        if (hasRight) Rect.fromLTRB(1 - right / width, 0, 1, 1),
      ]);
      return Stack(
        fit: StackFit.expand,
        children: [
          Row(
            children: [
              if (hasLeft)
                SizedBox(
                  key: const ValueKey('super-left-pane'),
                  width: left,
                  child: widget.left,
                ),
              Expanded(
                key: const ValueKey('super-center-pane'),
                child: widget.center,
              ),
              if (hasRight)
                SizedBox(
                  key: const ValueKey('super-right-pane'),
                  width: right,
                  child: widget.right,
                ),
            ],
          ),
          for (final (index, divider) in arrangement.dividers.indexed)
            Positioned(
              left: divider.position * width - 4,
              top: 0,
              bottom: 0,
              width: 8,
              child: Stack(
                fit: StackFit.expand,
                children: [
                  Center(
                    child: SizedBox(
                      width: 1,
                      height: double.infinity,
                      child: ColoredBox(color: DesktopChrome.rim),
                    ),
                  ),
                  PaneResizeHandle(
                    key: ValueKey(
                      'super-resize-${hasLeft && index == 0 ? 'left' : 'right'}',
                    ),
                    arrangement: arrangement,
                    divider: divider,
                    extent: constraints.biggest,
                    minimum: Size(
                      math.min(
                            leftMin == 0 ? rightMin : leftMin,
                            rightMin == 0 ? leftMin : rightMin,
                          ) /
                          width,
                      0,
                    ),
                    onLeave: widget.onLeave,
                    onChanged: (next, persist) {
                      ++_edit;
                      setState(() {
                        if (hasLeft && index == 0) {
                          _left = limit(
                            next.tiles.first.width * width,
                            leftMin,
                            width - centerMin - right,
                          );
                        } else {
                          _right = limit(
                            next.tiles.last.width * width,
                            rightMin,
                            width - centerMin - left,
                          );
                        }
                      });
                      if (persist) _save();
                    },
                  ),
                ],
              ),
            ),
        ],
      );
    },
  );
}
