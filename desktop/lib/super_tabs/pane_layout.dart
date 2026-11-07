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
    this.rightFixed = false,
    this.over,
  });

  static const storageKey = 'super-tab-pane-widths';
  static const leftWidth = 300.0;
  static const rightWidth = 280.0;

  /// A thread's default width (Scholes, 10-31). Its reply box's Also send
  /// shares the send row with New session only from about 410px; here it
  /// takes its own line under the box, in full (11-03). [rightWidth] stays
  /// the narrowest the pane goes.
  static const threadWidth = 340.0;

  /// The Board's floor: the room it keeps while text scaling widens the
  /// side panes.
  static const boardFloor = 280.0;

  /// Under this the centre pane has no room for a header, let alone cards.
  static const _centerFloor = 160.0;

  /// The Desktop's right pane, the Tasks pane: a fixed width, the middle taking the rest (River, Swarm v3).
  static const boardRightWidth = 340.0;

  /// Two Board columns: what the fixed layout's middle keeps while the side
  /// panes can give, the left pane first, then the Tasks pane down to
  /// [rightWidth]. At 900 the middle showed one and a half columns (#4211).
  static const boardCenterWidth = 560.0;

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

  /// The right pane is [rightDefault] wide, narrower only to keep [boardCenterWidth] in the middle: no divider, and
  /// a width saved earlier is not used.
  final bool rightFixed;

  /// Drawn over the left and centre panes, leaving the right one as it is:
  /// the picture viewer beside an open thread, as in Slack (Huy, 11-04).
  final Widget? over;

  @override
  State<SuperTabPaneLayout> createState() => _SuperTabPaneLayoutState();
}

class _SuperTabPaneLayoutState extends State<SuperTabPaneLayout> {
  static const _leftBase = 180.0;
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
        // A width the person chose is saved with that mark and kept
        // exactly, 280 included. Builds before the mark saved the right
        // pane's default (280, also the minimum) with any divider move: an
        // unmarked 280 reads as no choice, so a thread opens at its own width.
        final right = width('right', -1);
        final chosen = value is Map && value['rightChosen'] == true;
        if (right > 0 && (chosen || right != SuperTabPaneLayout.rightWidth)) {
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
    final right = _right;
    final value = jsonEncode({
      'left': _left,
      if (right != null) ...{'right': right, 'rightChosen': true},
    });
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
      final fixed = widget.rightFixed;
      final centerMin = math.min(
        math.max(
          scale.scale(360),
          fixed ? SuperTabPaneLayout.boardCenterWidth : 0,
        ),
        width,
      );
      // Text scaling widens the side panes only while the Board keeps its
      // floor: the chat's scaled minimum gives back first, down to its own
      // 420, then projects, down to 180 (reviews of #3863). The centre then
      // yields before either side pane: a side's minimum wins over the room
      // the centre's own preference asks for.
      var leftMin = hasLeft ? scale.scale(_leftBase) : 0.0;
      var rightMin = hasRight
          ? scale.scale(SuperTabPaneLayout.rightWidth)
          : 0.0;
      var short =
          leftMin +
          rightMin +
          math.min(SuperTabPaneLayout.boardFloor, width) -
          width;
      if (hasRight && short > 0) {
        final give = math.min(short, rightMin - SuperTabPaneLayout.rightWidth);
        rightMin -= give;
        short -= give;
      }
      if (hasLeft && short > 0) {
        leftMin -= math.min(short, leftMin - _leftBase);
      }
      double limit(double value, double floor, double ceiling) =>
          value.clamp(floor, math.max(floor, ceiling)).toDouble();
      // A fixed right pane keeps its width until the left pane is at its
      // minimum: the left pane gives back first.
      final left = hasLeft
          ? math.min(
              width,
              limit(
                _left,
                leftMin,
                width -
                    centerMin -
                    (fixed
                        ? math.max(rightMin, widget.rightDefault)
                        : rightMin),
              ),
            )
          : 0.0;
      final right = hasRight
          ? math.min(
              width - left,
              limit(
                fixed ? widget.rightDefault : _right ?? widget.rightDefault,
                rightMin,
                width - centerMin - left,
              ),
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
                // A centre squeezed under what any Board needs draws
                // nothing rather than overflowing into its neighbours.
                child: width - left - right < SuperTabPaneLayout._centerFloor
                    ? const SizedBox.shrink()
                    : widget.center,
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
                  // A fixed right pane has no divider to drag.
                  if (!widget.rightFixed || (hasLeft && index == 0))
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
          if (widget.over case final over?)
            Positioned(
              left: 0,
              top: 0,
              bottom: 0,
              width: width - right,
              child: over,
            ),
        ],
      );
    },
  );
}
