import 'package:flutter/widgets.dart';

import '../state/swarm_search.dart';

/// Shared keyboard scrolling for session, model, store, and help previews.
/// Scroll requests do not rebuild the search field or result rows.
class SwarmPreviewScrollController extends ScrollController {
  SwarmPreviewScrollController({
    required this.search,
    required this.lineHeight,
  }) {
    _selectedId = search.selected?.id;
    _lastPage = search.previewPage.value;
    _lastLine = search.previewLine.value;
    search.addListener(_selectionChanged);
    search.previewPage.addListener(_scrollChanged);
    search.previewLine.addListener(_scrollChanged);
  }

  final SwarmSearchController search;
  final double Function() lineHeight;
  String? _selectedId;
  int _lastPage = 0, _lastLine = 0;
  int _pendingPages = 0, _pendingLines = 0;
  bool _waitingForLayout = false, _scheduled = false, _disposed = false;
  bool _resetScroll = true;

  @override
  void attach(ScrollPosition position) {
    super.attach(position);
    _waitingForLayout = true;
    _schedule();
  }

  void _selectionChanged() {
    final id = search.selected?.id;
    if (id == _selectedId) return;
    _selectedId = id;
    _pendingPages = _pendingLines = 0;
    _resetScroll = true;
    if (positions.length == 1) jumpTo(0);
    // A selection and a scroll key may arrive before the new preview is laid
    // out. Apply pending movement against the new result's own dimensions.
    _waitingForLayout = true;
    _schedule();
  }

  void _scrollChanged() {
    final page = search.previewPage.value;
    final line = search.previewLine.value;
    _pendingPages += page - _lastPage;
    _pendingLines += line - _lastLine;
    _lastPage = page;
    _lastLine = line;
    if (!_waitingForLayout &&
        positions.length == 1 &&
        position.hasContentDimensions) {
      _apply();
    } else {
      _schedule();
    }
  }

  void _schedule() {
    if (_scheduled) return;
    _scheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_disposed) return;
      _scheduled = false;
      _waitingForLayout = false;
      _apply();
    });
  }

  void _apply() {
    if (positions.length != 1 || !position.hasContentDimensions) {
      return;
    }
    // Flutter can hand a replacement controller the previous scroll position.
    // A new search or selection must begin at the new preview's first line.
    if (_resetScroll) {
      _resetScroll = false;
      jumpTo(0);
    }
    if (_pendingPages == 0 && _pendingLines == 0) return;
    final distance =
        _pendingLines * lineHeight() +
        _pendingPages * position.viewportDimension * .8;
    _pendingPages = _pendingLines = 0;
    jumpTo(
      (position.pixels + distance).clamp(
        position.minScrollExtent,
        position.maxScrollExtent,
      ),
    );
  }

  @override
  void dispose() {
    _disposed = true;
    search.removeListener(_selectionChanged);
    search.previewPage.removeListener(_scrollChanged);
    search.previewLine.removeListener(_scrollChanged);
    super.dispose();
  }
}
