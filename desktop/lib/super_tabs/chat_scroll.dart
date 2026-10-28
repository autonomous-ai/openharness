import 'package:flutter/rendering.dart';
import 'package:flutter/widgets.dart';

/// A chat's scroll: what the reader looks at never moves by itself.
///
/// Rows change height after they are laid out (a receipt line moves to the
/// newest own message or grows a note, a picture or code block finishes,
/// a page of older messages arrives above). A list keeps its offset, so all
/// of that would slide the rows on screen. Instead, at every layout the
/// first visible row is kept where it was, and a reader at the very end
/// stays at the end. Both happen during layout, before anything is painted.
class SuperTabChatScroll extends ScrollController {
  SuperTabChatScroll({required this.rows});

  /// The list's rows that are built, by message id.
  final Iterable<MapEntry<String, BuildContext>> Function() rows;

  @override
  ScrollPosition createScrollPosition(
    ScrollPhysics physics,
    ScrollContext context,
    ScrollPosition? oldPosition,
  ) => _AnchoredPosition(
    rows: rows,
    physics: physics,
    context: context,
    initialPixels: initialScrollOffset,
    keepScrollOffset: keepScrollOffset,
    oldPosition: oldPosition,
    debugLabel: debugLabel,
  );
}

class _AnchoredPosition extends ScrollPositionWithSingleContext {
  _AnchoredPosition({
    required this.rows,
    required super.physics,
    required super.context,
    super.initialPixels,
    super.keepScrollOffset,
    super.oldPosition,
    super.debugLabel,
  });

  final Iterable<MapEntry<String, BuildContext>> Function() rows;

  // The first visible row and its top within the content, as last laid out.
  ({String messageId, double top})? _anchor;
  // Where the last finished layout left the view.
  double? _settledPixels, _settledMax;

  bool get _wasAtEnd =>
      _settledPixels != null && _settledPixels! >= _settledMax! - .5;

  @override
  void correctBy(double correction) {
    // The list moved every row and the view together: nothing on screen
    // moved, so the kept place moves with them.
    super.correctBy(correction);
    if (_anchor case final anchor?) {
      _anchor = (messageId: anchor.messageId, top: anchor.top + correction);
    }
    if (_settledPixels != null) _settledPixels = _settledPixels! + correction;
  }

  @override
  bool applyContentDimensions(double minScrollExtent, double maxScrollExtent) {
    final target = _keptPixels(maxScrollExtent);
    if (target != null && (target - pixels).abs() > .5) {
      correctPixels(target);
      return false;
    }
    if (!super.applyContentDimensions(minScrollExtent, maxScrollExtent)) {
      return false;
    }
    _settledPixels = pixels;
    _settledMax = maxScrollExtent;
    _anchor = _firstVisible();
    return true;
  }

  /// Where the view belongs now, or null to leave it.
  double? _keptPixels(double maxScrollExtent) {
    // Only the content changed since the reader was at the end.
    if (_wasAtEnd &&
        pixels == _settledPixels &&
        maxScrollExtent != _settledMax) {
      return maxScrollExtent;
    }
    final anchor = _anchor;
    if (anchor == null) return null;
    final edge = _rowEdges()[anchor.messageId]?.at;
    if (edge == null) return null;
    // Measured in the content, so the reader's own scrolling never counts:
    // only the rows between it and the list's dividing row changing does.
    final now = pixels + edge;
    if ((now - anchor.top).abs() <= .5) return null;
    _anchor = (messageId: anchor.messageId, top: now);
    return pixels + now - anchor.top;
  }

  /// The row at the top of the view, by the edge [_rowEdges] measures.
  ({String messageId, double top})? _firstVisible() {
    ({String messageId, double at})? first;
    for (final MapEntry(key: id, value: edge) in _rowEdges().entries) {
      final better = switch (edge) {
        // Above the dividing row (only in view when the view's top is):
        // the row whose bottom is the first below the top of the view.
        (above: true, :final at) =>
          pixels < 0 && at > 0 && (first == null || at < first.at),
        // Below it: the row containing the top of the view, else the
        // highest one in it.
        (above: false, :final at) =>
          pixels >= 0 &&
              (first == null ||
                  (at <= 0 ? first.at > 0 || at > first.at : at < first.at)),
      };
      if (better) first = (messageId: id, at: edge.at);
    }
    return first == null
        ? null
        : (messageId: first.messageId, top: pixels + first.at);
  }

  /// Each laid-out row's edge facing the list's dividing row, within the
  /// view: a row below it by its top, one above by its bottom. Nothing
  /// here reads a row's size, which only its list may during layout.
  Map<String, ({bool above, double at})> _rowEdges() {
    final edges = <String, ({bool above, double at})>{};
    for (final MapEntry(key: id, value: row) in rows()) {
      if (!row.mounted) continue;
      final box = row.findRenderObject();
      if (box is! RenderBox || !box.attached) continue;
      final viewport = RenderAbstractViewport.maybeOf(box);
      if (viewport is! RenderViewportBase || viewport.offset != this) continue;
      // The row's item in its list, laid out and not only kept alive.
      RenderObject item = box;
      while (item.parent != null &&
          item.parent is! RenderSliverMultiBoxAdaptor) {
        item = item.parent!;
      }
      final list = item.parent, data = item.parentData;
      if (list is! RenderSliverMultiBoxAdaptor ||
          item is! RenderBox ||
          data is! SliverMultiBoxAdaptorParentData ||
          data.keptAlive ||
          data.layoutOffset == null) {
        continue;
      }
      final listTop = MatrixUtils.transformPoint(
        list.getTransformTo(viewport),
        Offset.zero,
      ).dy;
      final position = list.childMainAxisPosition(item);
      if (list.constraints.growthDirection == GrowthDirection.forward) {
        final inItem = box.localToGlobal(Offset.zero, ancestor: item).dy;
        edges[id] = (above: false, at: listTop + position + inItem);
      } else {
        // The row closes its item: its bottom is the item's.
        edges[id] = (
          above: true,
          at: listTop + list.geometry!.paintExtent - position,
        );
      }
    }
    return edges;
  }
}
