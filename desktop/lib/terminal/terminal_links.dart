import 'package:xterm/xterm.dart';

const _mediaExtensions =
    r'png|jpe?g|gif|webp|avif|heic|heif|bmp|tiff?|svg|ico|'
    r'mp4|m4v|mov|webm|mkv|avi|mpe?g|ogv|3gp';
final _mediaSuffix = RegExp('\\.(?:$_mediaExtensions)\$', caseSensitive: false);
final _markdownLink = RegExp(
  r'!?\[[^\]\r\n]*\]\((<[^>\r\n]+>|(?:[^()\r\n]|\([^()\r\n]*\))+)\)',
);
final _quotedTarget = RegExp(
  r'''`([^`\r\n]+)`|"([^"\r\n]+)"|'([^'\r\n]+)'|<([^<>\r\n]+)>''',
);
final _webTarget = RegExp(r'''https?://[^\s<>`"']+''', caseSensitive: false);
final _absoluteMedia = RegExp(
  r'''(?:^|[\s(\[<='"`])((?:file://|~/|/(?!/)|[a-z]:[\\/]|\.{1,2}/)[^<>\r\n`"|]*?\.(?:''' +
      _mediaExtensions +
      r'''))(?=$|[\s)\]}>.,;:!?])''',
  caseSensitive: false,
);
final _relativeMedia = RegExp(
  r'''[^\s<>`"'()\[\]]+\.(?:''' +
      _mediaExtensions +
      r''')(?=$|[\s)\]}>.,;:!?])''',
  caseSensitive: false,
);

bool isMediaPath(String path) => _mediaSuffix.hasMatch(path);

bool _isTarget(String target) {
  final uri = Uri.tryParse(target);
  if (uri == null) return false;
  if (uri.scheme == 'http' || uri.scheme == 'https') {
    return uri.host.isNotEmpty;
  }
  if (uri.scheme == 'file') return isMediaPath(uri.path);
  // A drive letter is a file path, not a custom URI scheme.
  if (uri.hasScheme &&
      !RegExp(r'^[a-z]:[\\/]', caseSensitive: false).hasMatch(target)) {
    return false;
  }
  return isMediaPath(target);
}

String _trimWebPunctuation(String target) {
  var result = target.replaceFirst(RegExp(r'[.,;:!?]+$'), '');
  for (final pair in [('(', ')'), ('[', ']')]) {
    while (result.endsWith(pair.$2) &&
        pair.$2.allMatches(result).length > pair.$1.allMatches(result).length) {
      result = result.substring(0, result.length - 1);
    }
  }
  return result;
}

/// Finds only the target under the pointer. No file IO or scan of scrollback.
/// Markdown labels and quoted paths retain spaces; bare URLs retain queries.
String? terminalLinkInText(String text, int offset) {
  if (offset < 0 || offset >= text.length) return null;
  for (final match in _markdownLink.allMatches(text)) {
    if (offset < match.start || offset >= match.end) continue;
    var target = match[1]!;
    if (target.startsWith('<') && target.endsWith('>')) {
      target = target.substring(1, target.length - 1);
    }
    return _isTarget(target) ? target : null;
  }
  for (final match in _quotedTarget.allMatches(text)) {
    if (offset < match.start || offset >= match.end) continue;
    final target = [
      match[1],
      match[2],
      match[3],
      match[4],
    ].whereType<String>().single;
    if (_isTarget(target)) return target;
  }
  for (final match in _webTarget.allMatches(text)) {
    if (offset < match.start || offset >= match.end) continue;
    final target = _trimWebPunctuation(match[0]!);
    return offset < match.start + target.length && _isTarget(target)
        ? target
        : null;
  }
  for (final pattern in [_absoluteMedia, _relativeMedia]) {
    for (final match in pattern.allMatches(text)) {
      final target = match.groupCount == 0 ? match[0]! : match[1]!;
      final start = match.end - target.length;
      if (offset >= start && offset < match.end && _isTarget(target)) {
        return target;
      }
    }
  }
  return null;
}

/// One logical line: a run of soft-wrapped rows, as the text they spell.
class _LogicalLine {
  final int firstRow;
  final int lastRow;
  final String text;

  /// The [_styleKey] of the cell each UTF-16 unit of [text] came from.
  final List<int> styles;

  /// UTF-16 offset of the target cell in [text], when the cell is on this line.
  final int? offset;

  const _LogicalLine(
    this.firstRow,
    this.lastRow,
    this.text,
    this.styles,
    this.offset,
  );

  int get leadingBlanks => text.length - text.trimLeft().length;

  /// Offset of the last character that is not a blank, or -1 on a blank line.
  int get lastVisible => text.trimRight().length - 1;
}

/// What makes a run of cells read as one thing: its colour and whether it is
/// underlined. Claude Code paints an address bright blue and carries that
/// paint onto the row it cut the address across, while the words around it
/// are plain — the one witness to the cut that survives the newline.
int _styleKey(BufferLine line, int x) =>
    (line.getForeground(x) << 1) |
    (line.getAttributes(x) & CellAttr.underline != 0 ? 1 : 0);

bool _underlined(int styleKey) => styleKey & 1 != 0;

/// Reconstructs the logical line through row [y] across terminal soft wraps,
/// mapping cell columns to UTF-16 offsets (wide CJK and emoji are not one code
/// unit). The bound also keeps malformed/unbroken output cheap during mouse
/// hover. [cell] is the pointer, whose offset is reported when it lands here.
_LogicalLine? _logicalLine(Terminal terminal, int y, CellOffset cell) {
  final lines = terminal.buffer.lines;
  var start = y;
  var end = y;
  while (start > 0 && lines[start].isWrapped) {
    if (y - start >= 16) return null;
    start--;
  }
  while (end + 1 < lines.length && lines[end + 1].isWrapped) {
    if (end - start >= 16) return null;
    end++;
  }
  final text = StringBuffer();
  final styles = <int>[];
  int? offset;
  for (var row = start; row <= end; row++) {
    final line = lines[row];
    var previousOffset = text.length;
    for (var x = 0; x < line.length; x++) {
      final continuation = x > 0 && line.getWidth(x - 1) == 2;
      if (cell.y == row && cell.x == x) {
        offset = continuation ? previousOffset : text.length;
      }
      if (continuation) continue;
      previousOffset = text.length;
      final codePoint = line.getCodePoint(x);
      text.writeCharCode(codePoint == 0 ? 0x20 : codePoint);
      if (text.length > 8192) return null;
      final style = _styleKey(line, x);
      while (styles.length < text.length) {
        styles.add(style);
      }
    }
  }
  return _LogicalLine(start, end, text.toString(), styles, offset);
}

/// Columns up to the last cell that is neither empty nor a space — the width
/// a row was wrapped at. Spaces after it say nothing: Claude Code pads some
/// rows (its prompt box, a list item) to the full width with them, tmux
/// repaints with them, and the cut row of a URL carries them as often as not
/// — a capture of the real thing showed both `…commandcode.ai/` at the last
/// column and `…0xkongamoto/ ` one space short of it, each followed by the
/// rest of the address on the next row.
int _visibleWidth(BufferLine line) {
  for (var x = line.length - 1; x >= 0; x--) {
    final codePoint = line.getCodePoint(x);
    if (codePoint != 0 && codePoint != 0x20) return x + line.getWidth(x);
  }
  return 0;
}

/// The widest row of the paragraph (contiguous non-blank rows) around [row].
int _paragraphWidth(Terminal terminal, int row) {
  final lines = terminal.buffer.lines;
  var widest = _visibleWidth(lines[row]);
  for (final step in [-1, 1]) {
    for (var y = row + step, seen = 0; y >= 0 && y < lines.length; y += step) {
      final width = _visibleWidth(lines[y]);
      if (width == 0 || seen++ >= _hardWrapRows * 2) break;
      if (width > widest) widest = width;
    }
  }
  return widest;
}

final _trailingWebTarget = RegExp(
  r'''https?://[^\s<>`"']+$''',
  caseSensitive: false,
);
// The rest of an address begins with a character an address can contain —
// and a lone dash or a `1.` is a list marker, not that.
final _continuationToken = RegExp(
  r'''^(?:[A-Za-z0-9]|[/._~%?#=&+-](?=[^\s<>`"']))[^\s<>`"']*''',
);
final _listMarker = RegExp(r'^\d+[.)]$');
final _webScheme = RegExp(r'^https?://', caseSensitive: false);

/// How many hard-wrapped rows one URL may span before giving up on it.
const _hardWrapRows = 8;

/// A cut row is as wide as the widest row of its paragraph — a hard cut fills
/// the box exactly, a word wrap leaves it short (measured per paragraph
/// because a full-width `────` divider is its own paragraph). The fallback
/// witness, for output that does not paint its addresses.
bool _cutAtBoxWidth(Terminal terminal, _LogicalLine line) {
  final width = _visibleWidth(terminal.buffer.lines[line.lastRow]);
  return width > 0 && width >= _paragraphWidth(terminal, line.lastRow);
}

/// Whether the paint on the last character of [a] runs on into the first
/// token of [b] — the cut address carrying its colour across the newline.
bool _paintContinues(_LogicalLine a, _LogicalLine b) =>
    a.lastVisible >= 0 &&
    b.leadingBlanks < b.text.length &&
    a.styles[a.lastVisible] == b.styles[b.leadingBlanks];

/// Length of the row's first token, after the indent.
int _tokenLength(_LogicalLine line) =>
    _continuationToken.firstMatch(line.text.trimLeft())?[0]!.length ?? 0;

/// A row that is one token from its indent to its end — what a row in the
/// middle of a cut address looks like, and what a tail row may look like.
bool _singleToken(_LogicalLine line) {
  final text = line.text.trim();
  return text.isNotEmpty && !text.contains(RegExp(r'\s'));
}

/// The next row's first token is URL characters that do not start a URL of
/// their own. Ink indents a list item's continuation deeper than its bullet,
/// so the indent is not compared.
bool _continuesUrl(_LogicalLine line) {
  final token = _continuationToken.firstMatch(line.text.trimLeft())?[0];
  return token != null &&
      !_webScheme.hasMatch(token) &&
      !_listMarker.hasMatch(token);
}

/// Where [text] (rows spliced so far) breaks off inside a web URL: the offset
/// the address starts at, or null. An address that closes a bracket it never
/// opened — `(https://a.example/)` at the end of a row — is finished, not cut.
int? _urlCutAt(String text) {
  final trimmed = text.trimRight();
  final match = _trailingWebTarget.firstMatch(trimmed);
  if (match == null || !_isTarget(match[0]!)) return null;
  final raw = match[0]!.replaceFirst(RegExp(r'[.,;:!?]+$'), '');
  for (final pair in [('(', ')'), ('[', ']')]) {
    if (raw.endsWith(pair.$2) &&
        pair.$2.allMatches(raw).length > pair.$1.allMatches(raw).length) {
      return null;
    }
  }
  return match.start;
}

/// The cut rows spliced back together without the box indent that follows
/// each break, or the blank cells that precede it, with the pointer's offset
/// in the result when [own] is given. Null when the pointer sat on blanks the
/// splice removed — not on the URL — or the run is absurdly long.
(String, int?)? _splice(List<_LogicalLine> joined, _LogicalLine? own) {
  final text = StringBuffer();
  int? offset;
  for (final line in joined) {
    final stripped = identical(line, joined.first) ? 0 : line.leadingBlanks;
    final segment = identical(line, joined.last)
        ? line.text.substring(stripped)
        : line.text.substring(stripped).trimRight();
    if (own != null && identical(line, own)) {
      final at = own.offset! - stripped;
      if (at < 0 || at >= segment.length) return null;
      offset = text.length + at;
    }
    text.write(segment);
    if (text.length > 8192) return null;
  }
  return (text.toString(), offset);
}

/// Whether every break in [joined] is a cut, judged by the witness the head
/// row offers. An address painted differently from the words before it is
/// followed by its paint: each next row must open in the same paint, and a
/// row that opens in plain text is the next sentence, however wide the row
/// above was. An address in the same paint as its sentence has only the box
/// width to go on.
bool _cutThroughout(Terminal terminal, List<_LogicalLine> joined) {
  final head = joined.first;
  final urlStart = _urlCutAt(head.text);
  if (urlStart == null) return false;
  final urlStyle = head.styles[head.lastVisible];
  var before = urlStart - 1;
  while (before >= 0 && head.text[before] == ' ') {
    before--;
  }
  final painted = before >= 0
      ? head.styles[before] != urlStyle
      : _underlined(urlStyle) || urlStyle != head.styles[0];
  for (var i = 0; i + 1 < joined.length; i++) {
    final cut = painted
        ? _paintContinues(joined[i], joined[i + 1])
        : _cutAtBoxWidth(terminal, joined[i]);
    if (!cut) return false;
  }
  return true;
}

/// Finds the target under [cell]. A web URL that the program on the other end
/// hard-wrapped across rows is read whole, from whichever row the pointer is
/// on; everything else is confined to the logical line, as separate output
/// lines are separate things (a path is never assembled from two of them).
///
/// A TUI cuts a long address at its box width and carries the rest onto the
/// next row with its own newline — what Claude Code (Ink, `wrap-ansi` with
/// `hard: true`) does. A terminal soft wrap is already joined by
/// [_logicalLine]; this is the break it cannot see, and it is inferred: from
/// the paint on the address when there is any, else from the row's width.
String? terminalLinkAt(Terminal terminal, CellOffset cell) {
  final lines = terminal.buffer.lines;
  if (cell.y < 0 ||
      cell.y >= lines.length ||
      cell.x < 0 ||
      cell.x >= lines[cell.y].length) {
    return null;
  }
  // An OSC 8 hyperlink names its target outright — Claude Code prints a
  // markdown link `[!125](https://…)` as just `!125` and hides the address
  // there — so it wins over anything read off the visible text.
  final hyperlink = lines[cell.y].getHyperlink(cell.x);
  if (hyperlink != null) {
    final uri = Uri.tryParse(hyperlink);
    if (uri != null &&
        (uri.scheme == 'http' || uri.scheme == 'https') &&
        uri.host.isNotEmpty) {
      return hyperlink;
    }
  }
  final own = _logicalLine(terminal, cell.y, cell);
  if (own == null || own.offset == null) return null;
  final single = terminalLinkInText(own.text, own.offset!);

  // Which way the rest of the address lies is read off the pointer: on the
  // row's opening token it may be a carried tail, so look above; on an
  // address the row breaks off in, look below. A row that is one token from
  // indent to end may be the middle of one, and is followed both ways.
  bool mayJoin(_LogicalLine a, _LogicalLine b) =>
      _continuesUrl(b) &&
      (_paintContinues(a, b) || _cutAtBoxWidth(terminal, a));

  final joined = [own];
  final at = own.offset!;
  final cutAt = _urlCutAt(own.text);
  final onOpeningToken =
      at >= own.leadingBlanks && at < own.leadingBlanks + _tokenLength(own);
  if (onOpeningToken && _continuesUrl(own)) {
    while (joined.first.firstRow > 0 && joined.length < _hardWrapRows) {
      final previous = _logicalLine(terminal, joined.first.firstRow - 1, cell);
      if (previous == null || !mayJoin(previous, joined.first)) break;
      // Above a carried row sits either the row the address starts on or
      // another row of nothing but address; anything else ends the search.
      final head = _urlCutAt(previous.text) != null;
      if (!head && !_singleToken(previous)) break;
      joined.insert(0, previous);
      if (head) break;
    }
  }
  if ((cutAt != null && at >= cutAt) || _singleToken(own)) {
    while (joined.last.lastRow + 1 < lines.length) {
      final next = _logicalLine(terminal, joined.last.lastRow + 1, cell);
      if (next == null ||
          !mayJoin(joined.last, next) ||
          _urlCutAt(_splice(joined, null)?.$1 ?? '') == null) {
        break;
      }
      // Past the bound the address is unknowable, and a fragment of it would
      // open the wrong page — no link is the honest answer.
      if (joined.length >= _hardWrapRows) return null;
      joined.add(next);
      // The row the address ends on has words after it; nothing follows.
      if (!_singleToken(next)) break;
    }
  }
  if (joined.length == 1 || !_cutThroughout(terminal, joined)) return single;

  final spliced = _splice(joined, own);
  if (spliced == null) return single;
  final (text, offset) = spliced;
  if (offset == null) return single;
  final target = terminalLinkInText(text, offset);
  if (target == null) return single;
  final scheme = Uri.tryParse(target)?.scheme;
  return scheme == 'http' || scheme == 'https' ? target : single;
}

/// One row's run of cells, [start] to [end] inclusive, that opens a link.
typedef TerminalLinkSpan = ({int row, int start, int end});

/// The cells that open [target], walked out from [cell] — what a hover
/// underlines. An OSC 8 link is exactly the cells that carry it; a link read
/// off the text is the run of cells [terminalLinkAt] resolves to [target],
/// followed onto the rows above and below when it reaches their edge (a
/// wrapped address continues at the next row's indent).
List<TerminalLinkSpan> terminalLinkSpans(
  Terminal terminal,
  CellOffset cell,
  String target,
) {
  final lines = terminal.buffer.lines;
  if (cell.y < 0 || cell.y >= lines.length) return const [];
  final osc8 = lines[cell.y].getHyperlink(cell.x) == target;
  bool hit(int x, int y) => osc8
      ? lines[y].getHyperlink(x) == target
      : terminalLinkAt(terminal, CellOffset(x, y)) == target;
  TerminalLinkSpan? walk(int y, int x) {
    if (y < 0 || y >= lines.length || x < 0 || !hit(x, y)) return null;
    final width = lines[y].length;
    var start = x;
    var end = x;
    while (start > 0 && hit(start - 1, y)) {
      start--;
    }
    while (end + 1 < width && hit(end + 1, y)) {
      end++;
    }
    return (row: y, start: start, end: end);
  }

  int firstVisible(BufferLine line) {
    for (var x = 0; x < line.length; x++) {
      final codePoint = line.getCodePoint(x);
      if (codePoint != 0 && codePoint != 0x20) return x;
    }
    return line.length;
  }

  final own = walk(cell.y, cell.x);
  if (own == null) return const [];
  final spans = [own];
  var head = own;
  while (spans.length < _hardWrapRows &&
      head.start <= firstVisible(lines[head.row])) {
    final above = head.row - 1;
    if (above < 0) break;
    final span = walk(above, _visibleWidth(lines[above]) - 1);
    if (span == null) break;
    spans.insert(0, span);
    head = span;
  }
  var tail = own;
  while (spans.length < _hardWrapRows * 2 &&
      tail.end >= _visibleWidth(lines[tail.row]) - 1) {
    final below = tail.row + 1;
    if (below >= lines.length) break;
    final span = walk(below, firstVisible(lines[below]));
    if (span == null) break;
    spans.add(span);
    tail = span;
  }
  return spans;
}
