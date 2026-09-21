import 'dart:async';
import 'dart:collection';
import 'dart:typed_data';

import 'package:flutter/foundation.dart';
import 'package:xterm/xterm.dart';

/// An on-demand index of the current terminal buffer. It never reads a file,
/// queries a daemon, or sends input. Unchanged rows keep their decoded text;
/// long scans yield to the event loop, and only the selected hit owns an anchor.
class TerminalSearch extends ChangeNotifier {
  TerminalSearch(this.terminal, {CellOffset? origin}) {
    _origin = origin;
  }

  final Terminal terminal;
  String _query = '';
  bool _caseSensitive = false;
  bool _enabled = true;
  bool _disposed = false;
  bool _listening = false;
  bool _running = false;
  bool _dirty = false;
  int _generation = 0;
  int _indexedGeneration = -1;
  int _pendingStep = 0;
  Timer? _timer;
  Timer? _yieldTimer;
  Completer<void>? _yieldResume;
  Completer<void>? _settled;
  Buffer? _buffer;
  CellOffset? _origin;
  CellAnchor? _selectionAnchor;
  Map<BufferLine, _SearchLine> _lines = HashMap.identity();
  Map<BufferLine, _SearchGroup> _cache = HashMap.identity();
  List<_SearchGroup> _groups = [];
  int _count = 0;
  int _selected = -1;
  _SearchGroup? _selectedGroup;
  int _selectedInGroup = 0;

  String get query => _query;
  bool get caseSensitive => _caseSensitive;
  bool get searching => _running || _dirty || _timer != null;
  bool get hasSnapshot =>
      _indexedGeneration == _generation && identical(_buffer, terminal.buffer);
  int get count => _count;
  int get selected => _selected;
  Future<void> get settled => _settled?.future ?? Future.value();

  BufferRangeLine? get match =>
      identical(_buffer, terminal.buffer) && _selectedGroup?.valid == true
      ? _selectedGroup!.rangeAt(_selectedInGroup)
      : null;

  void setQuery(String value, {bool? caseSensitive}) {
    final sensitive = caseSensitive ?? _caseSensitive;
    if (_query == value && _caseSensitive == sensitive) return;
    _query = value;
    _caseSensitive = sensitive;
    _generation++;
    _pendingStep = 0;
    _clearResults();
    _listen(_enabled && _query.isNotEmpty);
    if (_query.isEmpty) {
      _releaseIndex();
    } else {
      _request();
    }
    notifyListeners();
  }

  /// Hidden/covered find bars retain only their query and selected location.
  /// Returning rebuilds from current output instead of indexing hidden traffic.
  void setEnabled(bool value) {
    if (_enabled == value || _disposed) return;
    _enabled = value;
    _generation++;
    _listen(value && _query.isNotEmpty);
    if (value) {
      _request();
    } else {
      _releaseIndex();
    }
  }

  void _listen(bool value) {
    if (_listening == value) return;
    _listening = value;
    if (value) {
      terminal.addListener(_onOutput);
      terminal.addResizeListener(_onResize);
    } else {
      terminal.removeListener(_onOutput);
      terminal.removeResizeListener(_onResize);
    }
  }

  void _onOutput() {
    _request();
    // Output can replace the active buffer or overwrite a highlighted row.
    // Let the view remove an invalid highlight before its next paint.
    notifyListeners();
  }

  // Resize runs during renderer layout. Defer UI notifications to the scan's
  // event-loop turn so reflow never calls setState during layout.
  void _onResize() => _request();

  void _request() {
    if (_disposed || !_enabled || _query.isEmpty) return;
    _dirty = true;
    _settled ??= Completer<void>();
    if (!_running) _timer ??= Timer(Duration.zero, () => unawaited(_scan()));
  }

  Future<void> _scan() async {
    _timer = null;
    if (_disposed || !_enabled || _query.isEmpty) return;
    _running = true;
    _dirty = false;
    final generation = _generation;
    final buffer = terminal.buffer;
    final query = _query;
    final sensitive = _caseSensitive;
    final pattern = RegExp(
      RegExp.escape(query),
      caseSensitive: sensitive,
      unicode: true,
    );
    final source = [
      for (var i = 0; i < buffer.lines.length; i++) buffer.lines[i],
    ];
    final lines = HashMap<BufferLine, _SearchLine>.identity();
    final cache = HashMap<BufferLine, _SearchGroup>.identity();
    final groups = <_SearchGroup>[];
    var logical = <_SearchLine>[];
    final slice = Stopwatch()..start();
    try {
      for (var i = 0; i < source.length; i++) {
        final line = source[i];
        final cached = _lines[line];
        final snapshot = cached != null && cached.valid
            ? cached
            : _SearchLine(line);
        lines[line] = snapshot;
        logical.add(snapshot);
        if (i + 1 == source.length || !source[i + 1].isWrapped) {
          final first = logical.first.line;
          final previous = _cache[first];
          final _SearchGroup group;
          if (previous != null && previous.reuses(logical, query, sensitive)) {
            group = previous;
          } else {
            final text = logical.length == 1
                ? logical.single.text
                : logical.map((line) => line.text).join();
            final checkpoints = <int>[];
            var hits = 0;
            for (final hit in pattern.allMatches(text)) {
              if (hits % _SearchGroup.stride == 0) checkpoints.add(hit.start);
              hits++;
              if (hits % 128 == 0 && slice.elapsedMicroseconds >= 1500) {
                await _yieldScan();
                if (_disposed || generation != _generation || !_enabled) return;
                slice.reset();
              }
            }
            group = _SearchGroup(
              logical,
              query,
              sensitive,
              pattern,
              text,
              Uint32List.fromList(checkpoints),
              hits,
            );
          }
          cache[first] = group;
          if (group.count > 0 && group.valid) groups.add(group);
          logical = [];
        }
        if (slice.elapsedMicroseconds >= 1500) {
          await _yieldScan();
          if (_disposed || generation != _generation || !_enabled) return;
          slice.reset();
        }
      }
      if (_disposed || generation != _generation || !_enabled) return;
      _lines = lines;
      _cache = cache;
      _buffer = buffer;
      _indexedGeneration = generation;
      _groups = groups.where((group) => group.valid).toList(growable: false);
      _count = _groups.fold(0, (count, group) => count + group.count);
      final origin = _selectionAnchor?.attached == true
          ? _selectionAnchor!.offset
          : _origin;
      var index = 0;
      var found = false;
      if (origin != null) {
        for (final group in _groups) {
          if (group.lines.last.line.index < origin.y) {
            index += group.count;
            continue;
          }
          final hit = group.indexAtOrAfter(origin);
          index += hit;
          if (hit < group.count) {
            found = true;
            break;
          }
        }
      }
      _select(_count == 0 ? -1 : ((found ? index : 0) + _pendingStep) % _count);
      _pendingStep = 0;
    } finally {
      _running = false;
      if (!_disposed) {
        if (_dirty && _enabled && _query.isNotEmpty) {
          _request();
        } else {
          _settled?.complete();
          _settled = null;
        }
        notifyListeners();
      }
    }
  }

  void step(int delta) {
    if (_query.isEmpty || !_enabled) return;
    if (searching && !hasSnapshot) {
      _pendingStep += delta;
      return;
    }
    if (_count == 0) return;
    final target = (_selected + delta) % _count;
    var index = target;
    for (final group in _groups) {
      if (index < group.count) {
        if (!group.valid) {
          _pendingStep += delta;
          _request();
          return;
        }
        break;
      }
      index -= group.count;
    }
    _select(target);
    notifyListeners();
  }

  void _select(int index) {
    _selected = index;
    _selectedGroup = null;
    if (index < 0) return;
    for (final group in _groups) {
      if (index >= group.count) {
        index -= group.count;
        continue;
      }
      _selectedGroup = group;
      _selectedInGroup = index;
      final range = match;
      if (range != null) {
        _selectionAnchor?.dispose();
        _selectionAnchor = terminal.buffer.createAnchorFromOffset(range.begin);
        _origin = range.begin;
      }
      break;
    }
  }

  void _clearResults() {
    _groups = [];
    _count = 0;
    _selected = -1;
    _selectedGroup = null;
  }

  Future<void> _yieldScan() {
    final resume = Completer<void>();
    _yieldResume = resume;
    _yieldTimer = Timer(Duration.zero, () {
      _yieldTimer = null;
      _yieldResume = null;
      resume.complete();
    });
    return resume.future;
  }

  void _releaseIndex() {
    _yieldTimer?.cancel();
    _yieldTimer = null;
    final resume = _yieldResume;
    _yieldResume = null;
    resume?.complete();
    _timer?.cancel();
    _timer = null;
    _dirty = false;
    _lines.clear();
    _cache.clear();
    _clearResults();
    if (!_running) {
      _settled?.complete();
      _settled = null;
    }
  }

  @override
  void dispose() {
    _disposed = true;
    _generation++;
    _listen(false);
    _releaseIndex();
    _selectionAnchor?.dispose();
    _selectionAnchor = null;
    _settled?.complete();
    _settled = null;
    super.dispose();
  }
}

class _SearchLine {
  _SearchLine(this.line)
    : version = line.textVersion,
      wrapped = line.isWrapped,
      text = line.getText();
  final BufferLine line;
  final int version;
  final bool wrapped;
  final String text;
  bool get valid =>
      line.attached && line.textVersion == version && line.isWrapped == wrapped;

  int cellAt(int offset) {
    if (offset <= 0) return 0;
    var chars = 0;
    var end = 0;
    for (var x = 0; x < line.length; x++) {
      final code = line.getCodePoint(x);
      if (code == 0 && x > 0 && line.getWidth(x - 1) == 2) continue;
      chars += code > 0xffff ? 2 : 1;
      end = x + (line.getWidth(x) > 1 ? line.getWidth(x) : 1);
      if (chars >= offset) break;
    }
    return end;
  }
}

class _SearchGroup {
  _SearchGroup(
    this.lines,
    this.query,
    this.sensitive,
    this.pattern,
    this.text,
    this.checkpoints,
    this.count,
  ) {
    var offset = 0;
    starts = [
      for (final line in lines) (offset += line.text.length) - line.text.length,
    ];
  }
  // One integer per 64 matches, rather than a range/anchor for every character
  // in a very repetitive log. Selecting a hit examines at most 64 candidates.
  static const stride = 64;
  final List<_SearchLine> lines;
  final String query;
  final bool sensitive;
  final RegExp pattern;
  final String text;
  final Uint32List checkpoints;
  final int count;
  late final List<int> starts;
  bool get valid {
    for (var i = 0; i < lines.length; i++) {
      if (!lines[i].valid ||
          (i > 0 && lines[i].line.index != lines[i - 1].line.index + 1)) {
        return false;
      }
    }
    return true;
  }

  bool reuses(List<_SearchLine> other, String value, bool caseSensitive) =>
      query == value && sensitive == caseSensitive && listEquals(lines, other);

  int indexAtOrAfter(CellOffset origin) {
    var row = 0;
    while (row < lines.length && lines[row].line.index < origin.y) {
      row++;
    }
    if (row == lines.length) return count;
    final textOffset =
        starts[row] +
        (lines[row].line.index == origin.y
            ? lines[row].line.getText(0, origin.x).length
            : 0);
    var low = 0;
    var high = checkpoints.length - 1;
    while (low < high) {
      final middle = (low + high + 1) ~/ 2;
      if (checkpoints[middle] <= textOffset) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    var index = low * stride;
    for (final hit in pattern.allMatches(text, checkpoints[low])) {
      if (hit.start >= textOffset) return index;
      index++;
    }
    return count;
  }

  BufferRangeLine rangeAt(int index) {
    final hit = pattern
        .allMatches(text, checkpoints[index ~/ stride])
        .skip(index % stride)
        .first;
    return BufferRangeLine(
      _cellAt(hit.start, end: false),
      _cellAt(hit.end, end: true),
    );
  }

  CellOffset _cellAt(int offset, {required bool end}) {
    var low = 0;
    var high = lines.length - 1;
    while (low < high) {
      final middle = (low + high + 1) ~/ 2;
      if (starts[middle] < offset || (!end && starts[middle] == offset)) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    return CellOffset(
      lines[low].cellAt(offset - starts[low]),
      lines[low].line.index,
    );
  }
}
