import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;

import 'package:xterm/xterm.dart';

/// What runs behind the benchmark's terminal: the phone's input goes in, what
/// it draws comes out — Claude Code's fullscreen renderer, faked in the app or
/// real on a Mac.
abstract class ScrollProgram {
  String get name;

  /// Starts drawing into [terminal], already laid out at the phone's grid.
  Future<void> start(Terminal terminal);

  /// Bytes the phone sent: wheel reports, Page Up/Down, keys.
  void input(String data);

  void dispose();

  Map<String, Object?> describe();
}

/// Claude Code 2.1.309's fullscreen renderer as far as a scroll sees it, in the
/// app: a transcript scrolled by wheel reports and Page Up/Down, redrawn whole
/// in a synchronized update, across a link [oneWay] long each way.
///
/// What it copies, as `RemoteScrollMirror` and the scroll handler record it:
///
/// - a wheel event after a pause of over 40 ms scrolls one row; each one closer
///   than that to the last 0.3 of a row more, up to 6, floored;
/// - the first wheel event after a turn is dropped;
/// - Page Up/Down scroll half the transcript's height at once;
/// - scrolled, the prompt of the rows on screen is pinned to row 0 once it has
///   scrolled off, and a "Jump to bottom" line covers the transcript's last row;
/// - under the transcript a blank row, the prompt box between two rules, a blank
///   row and the mode line (read off a live 2.1.309 pane's layout);
/// - a redraw takes [draw] (50–150 ms for a page in a long session), at most one
///   every 16 ms, and inputs arriving meanwhile join it.
class FakeClaudeCode implements ScrollProgram {
  FakeClaudeCode({
    this.oneWay = const Duration(milliseconds: 30),
    this.draw = const Duration(milliseconds: 40),
    this.transcriptMessages = 400,
    this.seed = 7,
  });

  final Duration oneWay;
  final Duration draw;
  final int transcriptMessages;
  final int seed;

  late Terminal _terminal;
  int _cols = 0;
  int _rows = 0;
  List<String> _transcript = const [];

  /// For each transcript row, the transcript row of the prompt it answers.
  List<int> _promptOf = const [];

  /// Rows scrolled up from the bottom.
  int _offset = 0;
  int _lastDirection = 0;
  double _step = 1;
  final _clock = Stopwatch()..start();
  int _lastWheelMs = -1 << 30;
  int _lastDrawMs = -1 << 30;
  Timer? _drawTimer;
  bool _disposed = false;
  String _pending = '';

  int wheels = 0;
  int pages = 0;
  int redraws = 0;

  @override
  String get name => 'fake';

  /// Rows between the screen last delivered and the transcript's newest row,
  /// and its oldest: where a scroll has to stop, as a native list stops at its
  /// ends. Of the screen the phone has, not of a redraw still on its way.
  int get rowsBelow => _shownOffset;
  int get rowsAbove => _maxOffset - _shownOffset;
  int _shownOffset = 0;

  int get _transcriptRows => _rows - 6;

  int get _maxOffset => math.max(0, _transcript.length - _transcriptRows);

  @override
  Future<void> start(Terminal terminal) async {
    _terminal = terminal;
    _layout(terminal.viewWidth, terminal.viewHeight);
    terminal.onResize = (cols, rows, _, _) {
      _layout(cols, rows);
      _scheduleDraw();
    };
    terminal.write('\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[?25l');
    _render();
  }

  void _layout(int cols, int rows) {
    if (cols == _cols && rows == _rows) return;
    _cols = cols;
    _rows = rows;
    final rowsOut = <String>[];
    final promptOf = <int>[];
    final random = math.Random(seed);
    var prompt = 0;
    for (var m = 0; m < transcriptMessages; m++) {
      if (m % 6 == 0) {
        prompt = rowsOut.length;
        for (final row in _wrap('> ${_sentence(random, 8)} (message $m)')) {
          rowsOut.add('\x1b[38;2;153;153;153m$row\x1b[0m');
          promptOf.add(prompt);
        }
      } else if (m % 6 == 3) {
        rowsOut.add('\x1b[38;2;78;186;101m⏺\x1b[0m Update(lib/file_$m.dart)');
        promptOf.add(prompt);
        for (var d = 0; d < 4; d++) {
          final add = d.isEven;
          rowsOut.add(
            '${add ? '\x1b[48;2;34;92;43m' : '\x1b[48;2;122;41;54m'}'
            '${_fit('  ${40 + d} ${add ? '+' : '-'} ${_sentence(random, 5)}')}'
            '\x1b[0m',
          );
          promptOf.add(prompt);
        }
      } else {
        final lines = _wrap(
          '⏺ ${_sentence(random, 12 + random.nextInt(30))}'
          ' (row $m)',
        );
        for (final row in lines) {
          rowsOut.add(row);
          promptOf.add(prompt);
        }
      }
      rowsOut.add('');
      promptOf.add(prompt);
    }
    _transcript = rowsOut;
    _promptOf = promptOf;
    _offset = _offset.clamp(0, _maxOffset);
  }

  static const _words = [
    'the',
    'mirror',
    'scroll',
    'phone',
    'row',
    'frame',
    'page',
    'program',
    'finger',
    'screen',
    'redraw',
    'Claude',
    'wheel',
    'transcript',
    'fling',
    'native',
    'smooth',
    'edge',
    'document',
    'placed',
    'held',
    'answer',
  ];

  String _sentence(math.Random random, int words) =>
      [for (var w = 0; w < words; w++) _words[random.nextInt(_words.length)]]
          .join(' ');

  String _fit(String text) =>
      text.length > _cols ? text.substring(0, _cols) : text.padRight(_cols);

  List<String> _wrap(String text) {
    final rows = <String>[];
    var line = '';
    for (final word in text.split(' ')) {
      if (line.isEmpty) {
        line = word;
      } else if (line.length + 1 + word.length <= _cols - 2) {
        line = '$line $word';
      } else {
        rows.add(line);
        line = '  $word';
      }
    }
    if (line.isNotEmpty) rows.add(line);
    return rows;
  }

  /// Back to the newest row at once, as a freshly opened agent shows it.
  void scrollToBottom() {
    _offset = 0;
    _render();
  }

  @override
  void input(String data) {
    Timer(oneWay, () {
      if (_disposed) return;
      _receive(data);
    });
  }

  static final _sgrMouse = RegExp(r'\x1b\[<(\d+);(\d+);(\d+)([Mm])');

  void _receive(String data) {
    _pending += data;
    var changed = false;
    while (_pending.isNotEmpty) {
      final mouse = _sgrMouse.matchAsPrefix(_pending);
      if (mouse != null) {
        final button = int.parse(mouse.group(1)!);
        if (button == 64) changed |= _wheel(1);
        if (button == 65) changed |= _wheel(-1);
        _pending = _pending.substring(mouse.end);
        continue;
      }
      if (_pending.startsWith('\x1b[5~')) {
        changed |= _page(1);
        _pending = _pending.substring(4);
        continue;
      }
      if (_pending.startsWith('\x1b[6~')) {
        changed |= _page(-1);
        _pending = _pending.substring(4);
        continue;
      }
      // A sequence still arriving waits for the rest; anything else is a key
      // the benchmark never sends.
      if (_pending.startsWith('\x1b') && _pending.length < 16) break;
      _pending = _pending.substring(1);
    }
    if (changed) _scheduleDraw();
  }

  /// [direction] 1 scrolls up, towards older rows.
  bool _wheel(int direction) {
    wheels++;
    final now = _clock.elapsedMilliseconds;
    if (_lastDirection != 0 && direction != _lastDirection) {
      _lastDirection = direction;
      _lastWheelMs = now;
      _step = 1;
      return false;
    }
    _lastDirection = direction;
    _step = now - _lastWheelMs > 40 ? 1 : math.min(6, _step + 0.3);
    _lastWheelMs = now;
    return _scrollBy(direction * _step.floor());
  }

  bool _page(int direction) {
    pages++;
    return _scrollBy(direction * (_transcriptRows ~/ 2));
  }

  bool _scrollBy(int rows) {
    final next = (_offset + rows).clamp(0, _maxOffset);
    if (next == _offset) return false;
    _offset = next;
    return true;
  }

  void _scheduleDraw() {
    if (_drawTimer != null) return;
    final now = _clock.elapsedMilliseconds;
    final at = math.max(now + draw.inMilliseconds, _lastDrawMs + 16);
    _drawTimer = Timer(Duration(milliseconds: at - now), () {
      _drawTimer = null;
      if (_disposed) return;
      _lastDrawMs = _clock.elapsedMilliseconds;
      final frame = _frame();
      final offset = _offset;
      Timer(oneWay, () {
        if (_disposed) return;
        _terminal.write(frame);
        _shownOffset = offset;
      });
    });
  }

  void _render() {
    _terminal.write(_frame());
    _shownOffset = _offset;
  }

  String _frame() {
    redraws++;
    final rows = _transcriptRows;
    final first = _transcript.length - rows - _offset;
    final out = StringBuffer('\x1b[?2026h');
    for (var i = 0; i < _rows; i++) {
      out.write('\x1b[${i + 1};1H\x1b[0m\x1b[2K');
      if (i < rows) {
        final index = first + i;
        if (_offset > 0 && i == 0) {
          final prompt = _promptOf[math.max(0, index)];
          if (prompt < index) {
            out.write(
              '\x1b[38;2;153;153;153m${_plain(_transcript[prompt])}\x1b[0m',
            );
            continue;
          }
        }
        if (_offset > 0 && i == rows - 1) {
          out.write('\x1b[38;2;177;185;249m  ↓ Jump to bottom\x1b[0m');
          continue;
        }
        if (index >= 0) out.write(_transcript[index]);
      } else {
        // A blank row, the prompt box, a blank row and the mode line, as
        // 2.1.309 lays them out under the transcript.
        out.write(switch (i - rows) {
          1 || 3 => '\x1b[38;2;80;80;80m${'─' * _cols}\x1b[0m',
          2 => '❯ ',
          5 => '\x1b[38;2;175;135;255m  ⏵⏵ accept edits on\x1b[0m',
          _ => '',
        });
      }
    }
    out.write('\x1b[?2026l');
    return out.toString();
  }

  static String _plain(String styled) =>
      styled.replaceAll(RegExp(r'\x1b\[[0-9;]*m'), '');

  @override
  void dispose() {
    _disposed = true;
    _drawTimer?.cancel();
  }

  @override
  Map<String, Object?> describe() => {
    'program': name,
    'oneWayMs': oneWay.inMilliseconds,
    'drawMs': draw.inMilliseconds,
    'transcriptRows': _transcript.length,
    'grid': '${_cols}x$_rows',
    'wheels': wheels,
    'pages': pages,
    'redraws': redraws,
  };
}

/// The real Claude Code, run on a Mac by `claude_bridge.py` in a pseudo
/// terminal at the phone's grid. The phone listens on [port]; the bridge
/// connects to it — nothing on the Mac listens — and holds every byte
/// [extraDelayMs] each way, to stand in for the relay.
class LiveClaudeCode implements ScrollProgram {
  LiveClaudeCode(this.port, {this.extraDelayMs = 0});

  final int port;
  final int extraDelayMs;

  ServerSocket? _server;
  Socket? _socket;
  int bytesIn = 0;
  int bytesOut = 0;
  Duration? connectTook;

  @override
  String get name => 'live';

  @override
  Future<void> start(Terminal terminal) async {
    final watch = Stopwatch()..start();
    final server = await ServerSocket.bind(
      InternetAddress.anyIPv6,
      port,
      v6Only: false,
    );
    _server = server;
    final addresses = [
      for (final interface in await NetworkInterface.list(
        includeLinkLocal: true,
      ))
        for (final address in interface.addresses)
          '${interface.name}=${address.address}',
    ];
    // Read by whoever starts the bridge: where to reach this phone.
    // ignore: avoid_print
    print(
      '[scroll] waiting for claude_bridge.py on port $port · '
      '${addresses.join(' ')}',
    );
    final socket = await server.first.timeout(const Duration(minutes: 4));
    await server.close();
    _server = null;
    socket.setOption(SocketOption.tcpNoDelay, true);
    connectTook = watch.elapsed;
    _socket = socket;
    socket.add(
      utf8.encode(
        '${terminal.viewWidth} ${terminal.viewHeight} $extraDelayMs\n',
      ),
    );
    socket
        .map((chunk) {
          bytesIn += chunk.length;
          return chunk;
        })
        .cast<List<int>>()
        .transform(const Utf8Decoder(allowMalformed: true))
        .listen(terminal.write, onError: (_) {}, cancelOnError: true);
  }

  @override
  void input(String data) {
    final bytes = utf8.encode(data);
    bytesOut += bytes.length;
    _socket?.add(bytes);
  }

  @override
  void dispose() {
    _server?.close();
    _socket?.destroy();
    _socket = null;
  }

  @override
  Map<String, Object?> describe() => {
    'program': name,
    'port': port,
    'extraDelayMsEachWay': extraDelayMs,
    'connectMs': connectTook?.inMilliseconds,
    'bytesIn': bytesIn,
    'bytesOut': bytesOut,
  };
}
