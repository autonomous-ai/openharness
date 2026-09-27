/// Styled text for sample mode's terminals: runs of characters with an SGR style, wrapped to a
/// pane's width and written out as the escape sequences a real CLI would send.
///
/// ⚠️ **Wrapped HERE, never by the terminal.** Every screen a sample harness draws is redrawn in
/// place — the cursor walks back up over its live region and repaints it — and that walk counts
/// lines. A line the emulator wrapped by itself would be two rows where the count says one, and the
/// repaint would land a row low. So nothing longer than [SampleText.fit] columns is ever written.
library;

/// One run of text in one style. [style] is the SGR parameter list (`1`, `2;36`, `38;5;174`),
/// empty for the terminal's default.
class Span {
  const Span(this.text, [this.style = '']);

  final String text;
  final String style;

  /// Columns this run takes. Every glyph the sample writes is one column wide; a person's own
  /// words may not be, and then a line is only wrapped a little early.
  int get width => text.runes.length;
}

/// SGR parameter lists the samples use, named for what they draw.
abstract final class Sgr {
  static const bold = '1';
  static const dim = '2';
  static const red = '31';
  static const green = '32';
  static const yellow = '33';
  static const magenta = '35';
  static const cyan = '36';
  static const gray = '38;5;246';

  /// Claude Code's own orange — its spinner and its mark.
  static const claude = '38;5;174';

  /// A diff's removed and added lines: the colour on a tinted ground, as Claude Code draws them.
  static const removed = '38;5;217;48;5;52';
  static const added = '38;5;151;48;5;22';
}

abstract final class SampleText {
  /// The widest line ever written to a pane [cols] wide — one short of it, so a line never sits
  /// in the last column, where an emulator holds a pending wrap that a repaint has to reason about.
  static int fit(int cols) => cols < 2 ? 1 : cols - 1;

  /// [spans] as one physical line: each run in its style, and the style reset after it.
  static String ansi(List<Span> spans) {
    final out = StringBuffer();
    for (final span in spans) {
      if (span.text.isEmpty) continue;
      if (span.style.isEmpty) {
        out.write(span.text);
      } else {
        out
          ..write('\x1b[${span.style}m')
          ..write(span.text)
          ..write('\x1b[0m');
      }
    }
    return out.toString();
  }

  static int widthOf(List<Span> spans) =>
      spans.fold(0, (total, span) => total + span.width);

  /// [text] cut to [width] columns, ending in `…` when it was cut.
  static String clip(String text, int width) {
    final runes = text.runes.toList();
    if (runes.length <= width) return text;
    if (width <= 1) return '…';
    return '${String.fromCharCodes(runes.take(width - 1))}…';
  }

  /// [spans] cut to [width] columns — for a line that must stay ONE line, like a box's border.
  static List<Span> clipSpans(List<Span> spans, int width) {
    final out = <Span>[];
    var left = width;
    for (final span in spans) {
      if (left <= 0) break;
      if (span.width <= left) {
        out.add(span);
        left -= span.width;
      } else {
        out.add(Span(clip(span.text, left), span.style));
        left = 0;
      }
    }
    return out;
  }

  /// [spans] padded with spaces to exactly [width] columns (cut when longer).
  static List<Span> pad(List<Span> spans, int width) {
    final clipped = clipSpans(spans, width);
    final gap = width - widthOf(clipped);
    return gap <= 0 ? clipped : [...clipped, Span(' ' * gap)];
  }

  /// Word-wraps [spans] into lines no wider than [width], the first starting with [first] and
  /// every later one with [rest] — a CLI's bullet, then the hanging indent under it.
  ///
  /// A word longer than a whole line is broken where the line ends, as a terminal would.
  static List<String> wrap(
    List<Span> spans,
    int width, {
    List<Span> first = const [],
    List<Span> rest = const [],
  }) {
    final lines = <String>[];
    var line = <Span>[...first];
    var used = widthOf(first);
    var lineStart = used;
    final restWidth = widthOf(rest);
    // A line that the indent alone fills would never take a character.
    if (width <= restWidth || width <= used) width = restWidth + used + 8;
    // Whether the line being filled is a wrapped one, whose leading spaces are the wrap's.
    var continued = false;

    void breakLine() {
      lines.add(ansi(line));
      line = <Span>[...rest];
      used = restWidth;
      lineStart = used;
      continued = true;
    }

    // Spaces wait for the word after them: a line never ends in the spaces a break swallowed.
    Span? gap;

    for (final (blank, word) in _words(spans)) {
      if (blank) {
        if (continued && used == lineStart) continue;
        final space = word.single;
        gap = Span(
          '${gap?.text ?? ''}${space.text}',
          gap?.style ?? space.style,
        );
        continue;
      }
      final length = widthOf(word);
      final spaces = gap?.width ?? 0;
      if (used + spaces + length <= width) {
        if (gap != null) line.add(gap);
        used += spaces;
        gap = null;
        line.addAll(word);
        used += length;
        continue;
      }
      if (used > lineStart && length <= width - restWidth) {
        gap = null;
        breakLine();
        line.addAll(word);
        used += length;
        continue;
      }
      // Too long for any line: broken wherever the line runs out — after the space before it,
      // which stays where there is room for it and a character after it.
      if (gap != null && used + spaces < width) {
        line.add(gap);
        used += spaces;
      }
      gap = null;
      for (final piece in word) {
        var runes = piece.text.runes.toList();
        while (runes.isNotEmpty) {
          final room = width - used;
          if (room <= 0) {
            breakLine();
            continue;
          }
          final take = runes.length < room ? runes.length : room;
          line.add(Span(String.fromCharCodes(runes.take(take)), piece.style));
          used += take;
          runes = runes.sublist(take);
        }
      }
    }
    if (used > lineStart || lines.isEmpty) lines.add(ansi(line));
    return lines;
  }

  static final _tokenPattern = RegExp(r'\s+|\S+');

  /// [spans] as runs of spaces and words, each word whole even where its styles change inside
  /// it — `(+4 -1)` drawn in three colours is still two words, and neither is broken.
  static List<(bool, List<Span>)> _words(List<Span> spans) {
    final words = <(bool, List<Span>)>[];
    for (final span in spans) {
      for (final match in _tokenPattern.allMatches(span.text)) {
        final token = match.group(0)!;
        final blank = token.trim().isEmpty;
        final piece = Span(token, span.style);
        if (!blank && words.isNotEmpty && !words.last.$1) {
          words.last.$2.add(piece);
        } else {
          words.add((blank, [piece]));
        }
      }
    }
    return words;
  }
}
