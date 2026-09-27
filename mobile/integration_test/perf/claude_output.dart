import 'dart:math' as math;

/// Synthetic output shaped like Claude Code's, for a terminal [cols] wide.
///
/// What reaches the phone is the RAW bytes the agent wrote: the daemon reads
/// its pane through `tmux -C attach-session`, whose `%output` is the program's
/// own output, not tmux's re-rendering (`cli/src/lib/tmuxStream.ts`). Claude
/// Code draws with Ink, so a live turn is:
///
///  - a transcript that only grows — bullets, tool calls with `⎿` results,
///    red/green diffs, and prose long enough to wrap several times on a phone;
///  - under it, a live region Ink erases and redraws in place on every tick:
///    the spinner line with its timer and token count, the todo list, the
///    prompt box drawn in box-drawing characters, and the mode line.
///
/// Colours are 24-bit SGR, as Claude Code emits them; each burst is bracketed
/// by synchronized-output mode 2026 the way current versions do. Everything is
/// seeded, so two runs stream the same bytes.
class ClaudeOutput {
  ClaudeOutput({required this.cols, int seed = 26})
    : _random = math.Random(seed);

  final int cols;
  final math.Random _random;

  /// Rows in the live region — the same count as the desktop benchmark's
  /// eight-row redraw.
  static const int liveRows = 8;

  static const _reset = '\x1b[0m';
  static const _bold = '\x1b[1m';
  static const _dim = '\x1b[2m';
  static const _orange = '\x1b[38;2;215;119;87m';
  static const _gray = '\x1b[38;2;153;153;153m';
  static const _code = '\x1b[38;2;177;185;249m';
  static const _green = '\x1b[38;2;78;186;101m';
  static const _purple = '\x1b[38;2;175;135;255m';
  static const _addBg = '\x1b[48;2;34;92;43m';
  static const _delBg = '\x1b[48;2;122;41;54m';

  static const _spinner = ['·', '✢', '✳', '✶', '✻', '✽'];
  static const _verbs = [
    'Thinking',
    'Compiling',
    'Pondering',
    'Reticulating',
    'Crafting',
    'Brewing',
  ];

  static const _words = [
    'the',
    'test',
    'login',
    'flaky',
    'because',
    'session',
    'token',
    'expires',
    'before',
    'the',
    'assertion',
    'runs',
    'so',
    'I',
    'will',
    'wait',
    'for',
    'response',
    'instead',
    'of',
    'checking',
    'status',
    'immediately',
    'and',
    'the',
    'fixture',
    'now',
    'resets',
    'clock',
    'between',
    'cases',
    'which',
    'keeps',
    'retry',
    'logic',
    'honest',
    'while',
    'CI',
    'stays',
    'green',
    'refresh',
    'handler',
    'races',
    'with',
    'teardown',
    'when',
    'suite',
    'shares',
    'a',
    'server',
    'across',
    'files',
    'that',
    'was',
    'hiding',
    'real',
    'bug',
    'in',
    'middleware',
    'order',
  ];

  static const _files = [
    'src/auth/login.test.ts',
    'src/auth/session.ts',
    'src/server/middleware.ts',
    'test/fixtures/clock.ts',
    'src/api/rateLimit.ts',
  ];

  String _pick(List<String> from) => from[_random.nextInt(from.length)];

  /// A paragraph of [minWords]..[maxWords] words with an inline code span, one
  /// logical line — the terminal wraps it.
  String _prose({int minWords = 24, int maxWords = 48}) {
    final count = minWords + _random.nextInt(maxWords - minWords + 1);
    final words = [for (var i = 0; i < count; i++) _pick(_words)];
    final codeAt = _random.nextInt(count);
    words[codeAt] = '$_code`${_pick(_files)}`$_reset';
    final text = words.join(' ');
    return '${text[0].toUpperCase()}${text.substring(1)}.';
  }

  int _diffLine = 12;

  /// One logical transcript line. The mix repeats a turn: prompt, prose, tool
  /// calls with results, a diff, a test run.
  String transcriptLine(int index) {
    switch (index % 24) {
      case 0:
        return '$_gray> ${_pick(['fix the flaky login test', 'why does CI fail on main', 'tighten the rate limiter', 'add a retry to the session refresh'])}$_reset';
      case 1:
      case 4:
      case 8:
      case 16:
      case 22:
        return '';
      case 2:
      case 3:
      case 20:
      case 21:
        return '⏺ ${_prose()}';
      case 5:
        return '⏺ $_bold${'Read'}$_reset(${_pick(_files)})';
      case 6:
        return '  $_gray⎿  Read ${80 + _random.nextInt(300)} lines (ctrl+r to expand)$_reset';
      case 7:
        return '⏺ $_bold${'Update'}$_reset(${_pick(_files)})';
      case 9:
        return '  $_gray⎿  Updated ${_pick(_files)} with 2 additions and 1 removal$_reset';
      case 10:
        return '$_gray      ${_diffLine++}   it(\'logs in\', async () => {$_reset';
      case 11:
        return '$_delBg      ${_diffLine++} -   expect(res.status).toBe(200)$_reset';
      case 12:
        return '$_addBg      $_diffLine +   await waitFor(() => expect(res.status).toBe(200))$_reset';
      case 13:
        return '$_addBg      ${_diffLine++} +   expect(session.expiresAt).toBeGreaterThan(now())$_reset';
      case 14:
        return '$_gray      ${_diffLine++}   })$_reset';
      case 15:
        return '⏺ $_bold${'Bash'}$_reset(npm test -- ${_pick(['login', 'session', 'rateLimit'])})';
      case 17:
        return '  $_gray⎿$_reset  $_green${_bold}PASS$_reset src/auth/login.test.ts (${(2 + _random.nextDouble() * 5).toStringAsFixed(1)} s)';
      case 18:
        return '     Tests:  ${10 + _random.nextInt(30)} passed, ${10 + _random.nextInt(30)} total';
      case 19:
        return '     Time:   ${(3 + _random.nextDouble() * 9).toStringAsFixed(2)} s';
      default:
        return '⏺ ${_prose(minWords: 10, maxWords: 20)}';
    }
  }

  /// [count] transcript lines starting at [from], each ending in CRLF.
  String transcript(int from, int count) {
    final buffer = StringBuffer();
    for (var i = 0; i < count; i++) {
      buffer.write(transcriptLine(from + i));
      buffer.write('\r\n');
    }
    return buffer.toString();
  }

  /// A prose-only line for the append load: long, so it wraps 3–7 times on a
  /// phone, the shape of an answer streaming in.
  String proseLine() => '⏺ ${_prose(minWords: 28, maxWords: 60)}';

  /// Clips plain text to the row, three columns short of the edge: some of
  /// Claude's glyphs (`⏺`, `⏵`, `☐`) may take two cells in the emulator's
  /// width table, and a row that wrapped would make the region taller than
  /// the erase above it.
  String _fit(String plain) =>
      plain.length <= cols - 3 ? plain : plain.substring(0, cols - 3);

  /// The live region at tick [tick], rows joined by CRLF with no trailing
  /// newline: the cursor rests at the end of its last row, as Ink leaves it.
  String liveRegion(int tick) {
    final seconds = tick ~/ 20;
    final tokens = (tick * 7.3).round();
    final spinner = _spinner[tick % _spinner.length];
    final verb = _verbs[(tick ~/ 60) % _verbs.length];
    final width = cols - 1;
    final rows = <String>[
      '$_orange${_fit('$spinner $verb… (${seconds}s · ↓ ${(tokens / 1000).toStringAsFixed(1)}k tokens · esc to interrupt)')}$_reset',
      '$_gray${_fit('  ⎿  ☒ Read the flaky test')}$_reset',
      '$_orange${_fit('     ☐ Run the login tests again')}$_reset',
      '',
      '$_dim╭${'─' * (width - 2)}╮$_reset',
      '$_dim│$_reset > ${' ' * (width - 5)}$_dim│$_reset',
      '$_dim╰${'─' * (width - 2)}╯$_reset',
      '$_purple${_fit('  ⏵⏵ accept edits on (shift+tab to cycle)')}$_reset',
    ];
    assert(rows.length == liveRows);
    return rows.join('\r\n');
  }

  /// Ink's `eraseLines`: from the end of the region's last row, clear each row
  /// and step up, leaving the cursor at column 1 of the region's first row.
  static String get eraseLive =>
      '\r${List.filled(liveRows - 1, '\x1b[2K\x1b[1A').join()}\x1b[2K';

  static const _syncStart = '\x1b[?2026h';
  static const _syncEnd = '\x1b[?2026l';

  /// A redraw burst: the live region erased and drawn again in place — the
  /// desktop benchmark's eight-row redraw, in Claude Code's shape.
  String redrawBurst(int tick) =>
      '$_syncStart$eraseLive${liveRegion(tick)}$_syncEnd';

  /// An append burst: [lines] new transcript lines above the live region, and
  /// the region drawn again under them.
  String appendBurst(int tick, {int lines = 3}) {
    final buffer = StringBuffer(_syncStart)..write(eraseLive);
    for (var i = 0; i < lines; i++) {
      buffer
        ..write(proseLine())
        ..write('\r\n');
    }
    buffer
      ..write(liveRegion(tick))
      ..write(_syncEnd);
    return buffer.toString();
  }

  /// A keyframe's body: [historyLines] transcript lines and the live region
  /// under them, with the cursor hidden the way Claude Code keeps it.
  String keyframe(int historyLines) =>
      '\x1b[?25l${transcript(0, historyLines)}${liveRegion(0)}';
}
