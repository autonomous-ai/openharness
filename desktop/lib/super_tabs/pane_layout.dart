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
  });

  static const storageKey = 'super-tab-pane-widths';
  static const leftWidth = 300.0;
  static const rightWidth = 280.0;

  /// The roster drawer's share of a narrow window at most. On a phone it filled the screen, leaving no
  /// veil to tap, so closing it was hard (owner, 2026-10-23).
  static const drawerMaxFraction = 0.7;

  /// The roster drawer's width in a window [available] wide.
  static double drawerWidth(double available) =>
      (available * drawerMaxFraction).clamp(0, rightWidth).toDouble();
  final Widget? left, right;
  final Widget center;
  final VoidCallback onLeave;
  final LocalKeyValueStore? storage;

  @override
  State<SuperTabPaneLayout> createState() => _SuperTabPaneLayoutState();
}

class _SuperTabPaneLayoutState extends State<SuperTabPaneLayout> {
  double _left = SuperTabPaneLayout.leftWidth,
      _right = SuperTabPaneLayout.rightWidth;
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
        _right = width('right', _right);
      });
    } catch (_) {
      // A missing or old preference must not prevent opening the workspace.
    }
  }

  void _save() {
    final store = widget.storage;
    if (store == null) return;
    final value = jsonEncode({'left': _left, 'right': _right});
    _writing = _writing
        .then((_) => store.write(SuperTabPaneLayout.storageKey, value))
        .catchError((Object _) {});
  }

  @override
  Widget build(BuildContext context) => LayoutBuilder(
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
          ? limit(_right, rightMin, width - centerMin - left)
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
