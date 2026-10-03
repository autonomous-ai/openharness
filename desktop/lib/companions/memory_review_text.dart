import 'package:flutter/material.dart';

/// A lesson can be approved after every line has been visible in the viewer.
/// Reading a long lesson may take several scrolls; an off-screen card is not a receipt.
class MemoryReviewText extends StatefulWidget {
  const MemoryReviewText({
    super.key,
    required this.text,
    required this.style,
    required this.viewport,
    required this.scroll,
    required this.onRead,
  });
  final String text;
  final TextStyle style;
  final GlobalKey viewport;
  final ScrollController scroll;
  final VoidCallback onRead;
  @override
  State<MemoryReviewText> createState() => _MemoryReviewTextState();
}

class _MemoryReviewTextState extends State<MemoryReviewText> {
  late final _lines = widget.text.split('\n');
  late final _keys = [for (final _ in _lines) GlobalKey()];
  final _seen = <int>{};
  final _coverage = <int, List<(double, double)>>{};
  bool _scheduled = false, _read = false;
  @override
  void initState() {
    super.initState();
    widget.scroll.addListener(_schedule);
  }

  void _schedule() {
    if (_scheduled || _read) return;
    _scheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _scheduled = false;
      if (!mounted || _read) return;
      final view = widget.viewport.currentContext?.findRenderObject();
      if (view is! RenderBox || !view.attached || !view.hasSize) return;
      final window = Offset.zero & MediaQuery.sizeOf(context);
      final visible = (view.localToGlobal(Offset.zero) & view.size).intersect(
        window,
      );
      for (var i = 0; i < _keys.length; i++) {
        if (_seen.contains(i)) continue;
        final box = _keys[i].currentContext?.findRenderObject();
        if (box is! RenderBox || !box.attached || !box.hasSize) continue;
        final rect = box.localToGlobal(Offset.zero) & box.size;
        if (!rect.overlaps(visible) ||
            rect.left < visible.left - 1 ||
            rect.right > visible.right + 1) {
          continue;
        }
        // A wrapped paragraph may be taller than the viewport at larger text
        // sizes. Remember the portions actually shown, including any gaps.
        final start = ((visible.top - rect.top) / rect.height).clamp(0.0, 1.0);
        final end = ((visible.bottom - rect.top) / rect.height).clamp(0.0, 1.0);
        final ranges = _coverage.putIfAbsent(i, () => []);
        ranges.add((start, end));
        ranges.sort((a, b) => a.$1.compareTo(b.$1));
        final merged = <(double, double)>[];
        for (final range in ranges) {
          if (merged.isEmpty || range.$1 > merged.last.$2 + .001) {
            merged.add(range);
          } else if (range.$2 > merged.last.$2) {
            merged[merged.length - 1] = (merged.last.$1, range.$2);
          }
        }
        _coverage[i] = merged;
        if (merged.length == 1 &&
            merged.first.$1 <= .001 &&
            merged.first.$2 >= .999) {
          _seen.add(i);
          _coverage.remove(i);
        }
      }
      if (_seen.length == _lines.length) {
        _read = true;
        widget.onRead();
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    _schedule();
    return SelectionArea(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (var i = 0; i < _lines.length; i++)
            Text(
              _lines[i].isEmpty ? ' ' : _lines[i],
              key: _keys[i],
              style: widget.style,
            ),
        ],
      ),
    );
  }

  @override
  void dispose() {
    widget.scroll.removeListener(_schedule);
    super.dispose();
  }
}
