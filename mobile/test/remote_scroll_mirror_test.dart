import 'dart:async';
import 'dart:math' as math;

import 'package:flutter_test/flutter_test.dart';
import 'package:xterm/xterm.dart';
// The mirror is not exported: the phone reaches it through TerminalView, and
// what is tested here lives in it.
// ignore: implementation_imports
import 'package:xterm/src/ui/remote_scroll_mirror.dart';

/// Claude Code's fullscreen renderer as far as [RemoteScrollMirror] sees it: a
/// transcript in the top rows, moved by wheel rows and Page Up/Down (half the
/// transcript's height), with its prompt box and footer pinned below — a blank
/// row between the transcript and the box, as 2.1.309 draws it.
class _FakeClaudeCode {
  _FakeClaudeCode({int transcriptRows = 900})
    : transcript = [
        for (var n = 0; n < transcriptRows; n++)
          'message $n ${_words[n % _words.length]}',
      ] {
    terminal.resize(columns, rowCount);
    terminal.write('\x1b[?1049h');
    top = transcript.length - scrollingRows;
    draw();
  }

  static const _words = ['alpha', 'bravo', 'charlie', 'delta', 'echo'];

  static const columns = 40;
  static const rowCount = 40;
  static const scrollingRows = 33;
  static const page = scrollingRows ~/ 2;
  static const lineHeight = 10.0;

  final List<String> transcript;
  final terminal = Terminal();

  /// The transcript row shown at screen row 0.
  late int top;

  void scroll(int rows) {
    top = (top + rows).clamp(0, transcript.length - scrollingRows);
  }

  void draw() {
    final out = StringBuffer();
    for (var i = 0; i < rowCount; i++) {
      out.write('\x1b[${i + 1};1H\x1b[2K${_row(i)}');
    }
    terminal.write(out.toString());
  }

  String _row(int i) {
    if (i < scrollingRows) return transcript[top + i];
    return switch (i - scrollingRows) {
      1 || 3 => '─' * columns,
      2 => '❯ ',
      5 => '  ? for shortcuts',
      _ => '',
    };
  }
}

/// The scroll handler's side of the mirror over a link: wheel rows and page
/// keys reach the program [latency] later, and its redraw lands at once. Like
/// the handler it counts a batch answered by any write, or after 120 ms with
/// none (`TerminalScrollGestureHandler`'s `_answerWaitLimit`): on a link
/// slower than that, [idle] says so before the redraw has landed.
class _Link {
  _Link(this.claude, {this.latency = const Duration(milliseconds: 45)});

  /// From a request going out to the program's redraw landing: by default
  /// about a page key's round trip in a long session (42ms p50, measured on a
  /// phone, 2026-10-07).
  final Duration latency;

  final _FakeClaudeCode claude;
  late final RemoteScrollMirror mirror;

  var inFlight = 0;
  var pages = 0;
  var wheelRows = 0;

  /// Set once the test is done: what is still on its way lands nowhere.
  var closed = false;

  /// How many page keys went in each batch, in order.
  final pageBatches = <int>[];

  /// Batches the handler would count unanswered.
  var _unanswered = 0;
  Timer? _answerWait;

  bool get idle => _unanswered == 0;

  void _sent() {
    _unanswered++;
    _answerWait?.cancel();
    _answerWait = Timer(const Duration(milliseconds: 120), () {
      _unanswered = 0;
    });
  }

  void lines(int rows) {
    inFlight++;
    wheelRows += rows.abs();
    _sent();
    Timer(latency, () => _land(rows));
  }

  bool page(int direction, int count) {
    if (_unanswered > 0) return false;
    inFlight++;
    _sent();
    pages += count;
    pageBatches.add(count);
    Timer(latency, () => _land(direction * count * _FakeClaudeCode.page));
    return true;
  }

  void _land(int rows) {
    inFlight--;
    if (_unanswered > 0) _unanswered--;
    if (!closed) redraw(rows);
  }

  /// The program scrolled [rows] — or not at all — and drew its screen.
  void redraw([int rows = 0]) {
    claude.scroll(rows);
    claude.draw();
    mirror.frame(
      claude.terminal.buffer.lines,
      _FakeClaudeCode.rowCount,
      _FakeClaudeCode.lineHeight,
    );
  }
}

/// A mirror over [link]; [fetchAhead] lets it read the screen for itself, as
/// the phone's does, and so fetch rows ahead while nobody scrolls.
RemoteScrollMirror _mirrorOf(
  WidgetTester tester,
  _Link link, {
  RemoteScrollMemory? memory,
  bool fetchAhead = false,
}) {
  final mirror = RemoteScrollMirror(
    onFrame: () {},
    requestLines: link.lines,
    requestsIdle: () => link.idle,
    cancelRequests: () => 0,
    pageKeysEnabled: () => true,
    requestPage: link.page,
    readScreen: fetchAhead
        ? () => (
            lines: link.claude.terminal.buffer.lines,
            rowCount: _FakeClaudeCode.rowCount,
            lineHeight: _FakeClaudeCode.lineHeight,
          )
        : null,
    clock: tester.binding.clock.stopwatch(),
  )..memory = memory;
  link.mirror = mirror;
  return mirror;
}

const _frame = Duration(milliseconds: 16);

/// A finger on the glass at [pixels], moving [rowsPerFrame] rows up every
/// frame for [frames] frames — then left there.
Future<void> _drag(
  WidgetTester tester,
  RemoteScrollMirror mirror,
  _FakeClaudeCode claude, {
  required double pixels,
  required int frames,
  required double rowsPerFrame,
}) async {
  final lines = claude.terminal.buffer.lines;
  const rowCount = _FakeClaudeCode.rowCount;
  const lineHeight = _FakeClaudeCode.lineHeight;
  mirror.begin(pixels, lines, rowCount, lineHeight);
  for (var f = 0; f < frames; f++) {
    await tester.pump(_frame);
    pixels -= rowsPerFrame * lineHeight;
    mirror.scrollTo(pixels, lines, rowCount, lineHeight);
  }
}

/// The finger lifted, and everything the program still has to do done.
Future<void> _lift(WidgetTester tester, RemoteScrollMirror mirror) async {
  mirror.end();
  for (var f = 0; f < 150; f++) {
    await tester.pump(_frame);
  }
}

/// The test over: [mirror] gone, and what [link] still had on its way let
/// land on nothing.
Future<void> _close(
  WidgetTester tester,
  RemoteScrollMirror mirror,
  _Link link,
) async {
  link.closed = true;
  mirror.dispose();
  await tester.pump(link.latency + const Duration(milliseconds: 150));
}

/// A slow scroll a few rows up, come to rest: where the mirror learns which
/// rows scroll, before it draws any of them.
Future<void> _learnScrollingRows(
  WidgetTester tester,
  RemoteScrollMirror mirror,
  _FakeClaudeCode claude,
) async {
  await _drag(tester, mirror, claude, pixels: 0, frames: 4, rowsPerFrame: 1);
  await _lift(tester, mirror);
}

/// Where [bestPlacing] puts [probe] when every placing is tried in turn, as
/// the mirror did before it voted: the reference it must agree with.
({int d, int agree, int share, int runnerUp})? _placingTriedEverywhere(
  List<int> probe,
  List<int> screen,
  Map<int, int> known,
  int origin,
  int lowest,
  int highest, {
  bool Function(int d)? skip,
}) {
  ({int d, int agree, int share})? best;
  var runnerUp = 0;
  for (var d = lowest; d <= highest; d++) {
    if (skip != null && skip(d)) continue;
    var agree = 0;
    var comparable = 0;
    for (final i in probe) {
      final kept = known[origin + i + d];
      if (kept == null) continue;
      comparable++;
      if (kept == screen[i]) agree++;
    }
    if (agree == 0) continue;
    final current = best;
    if (current == null || agree > current.agree) {
      if (current != null) runnerUp = math.max(runnerUp, current.agree);
      best = (d: d, agree: agree, share: comparable);
    } else {
      runnerUp = math.max(runnerUp, agree);
    }
  }
  final found = best;
  if (found == null) return null;
  return (
    d: found.d,
    agree: found.agree,
    share: found.share,
    runnerUp: runnerUp,
  );
}

({int d, int agree, int share, int runnerUp})? _vote(
  List<int> probe,
  List<int> screen,
  Map<int, int> known,
  int origin,
  int lowest,
  int highest, {
  bool Function(int d)? skip,
}) => bestPlacing(
  probe: probe,
  signatureOf: (i) => screen[i],
  bySignature: rowsBySignature(known, (signature) => signature),
  isKnown: known.containsKey,
  origin: origin,
  lowest: lowest,
  highest: highest,
  skip: skip,
);

void main() {
  group('bestPlacing', () {
    test('places a screen exactly where trying every placing does', () {
      final random = math.Random(20261023);
      var placed = 0;
      for (var round = 0; round < 400; round++) {
        // Few distinct texts, so rows repeat and placings tie — as a
        // transcript's rules, blank-ish rows and repeated output do.
        final texts = 1 + random.nextInt(12);
        final from = random.nextInt(400) - 200;
        final count = random.nextInt(400);
        final known = <int, int>{
          for (var row = from; row < from + count; row++)
            if (random.nextInt(6) != 0) row: random.nextInt(texts),
        };
        final screenRows = 5 + random.nextInt(36);
        final origin = random.nextInt(200) - 100;
        final screen = [
          for (var i = 0; i < screenRows; i++) random.nextInt(texts),
        ];
        // Half the time the screen shows rows that are known, here and there
        // drawn over, as a scroll's frame does.
        if (random.nextBool() && count > 0) {
          final at = from + random.nextInt(count) - origin;
          for (var i = 0; i < screenRows; i++) {
            final kept = known[origin + i + at];
            if (kept != null && random.nextInt(8) != 0) screen[i] = kept;
          }
        }
        final probe = [
          for (var i = 0; i < screenRows; i++)
            if (random.nextInt(4) != 0) i,
        ];
        if (probe.isEmpty || known.isEmpty) continue;
        final knownMin = known.keys.reduce(math.min) - origin;
        final knownMax = known.keys.reduce(math.max) - origin;
        final reach = random.nextInt(60);
        final skip = random.nextBool() ? (int d) => d.abs() <= reach : null;
        final lowest = knownMin - probe.last;
        final highest = knownMax - probe.first;
        final expected = _placingTriedEverywhere(
          probe,
          screen,
          known,
          origin,
          lowest,
          highest,
          skip: skip,
        );
        expect(
          _vote(probe, screen, known, origin, lowest, highest, skip: skip),
          expected,
          reason: 'round $round',
        );
        if (expected != null) placed++;
      }
      // The comparison means something only if most rounds placed a screen.
      expect(placed, greaterThan(300));
    });

    test('a tie goes to the lowest placing, the other is the runner-up', () {
      // Rows 0..3 say A B A B: a screen showing A B fits at 0 and at 2.
      final known = {0: 1, 1: 2, 2: 1, 3: 2};
      expect(_vote([0, 1], [1, 2], known, 0, -1, 3), (
        d: 0,
        agree: 2,
        share: 2,
        runnerUp: 2,
      ));
      // Placings left out are neither best nor runner-up.
      expect(_vote([0, 1], [1, 2], known, 0, -1, 3, skip: (d) => d == 0), (
        d: 2,
        agree: 2,
        share: 2,
        runnerUp: 0,
      ));
    });

    test('counts as share the probe rows that land on a known row', () {
      // Row 5 is a hole: the screen's second row lands on it at d=4.
      final known = {4: 7, 6: 9, 7: 3};
      expect(_vote([0, 1, 2], [7, 8, 9], known, 0, 2, 7), (
        d: 4,
        agree: 2,
        share: 2,
        runnerUp: 0,
      ));
    });

    test('is null when no placing agrees, or nothing is probed', () {
      final known = {0: 1, 1: 2};
      expect(_vote([0, 1], [5, 6], known, 0, -1, 1), isNull);
      expect(_vote(const [], const [], known, 0, 0, 1), isNull);
      // The only agreeing placing is outside the range asked about.
      expect(_vote([0], [2], known, 0, 2, 5), isNull);
      // No range at all.
      expect(_vote([0], [1], known, 0, 1, 0), isNull);
    });
  });

  group('RemoteScrollMirror over Claude Code', () {
    testWidgets('a fast fling into rows not yet seen sends the next page before the '
        'finger reaches their edge', (tester) async {
      final claude = _FakeClaudeCode();
      final link = _Link(claude);
      final mirror = _mirrorOf(tester, link);
      await _learnScrollingRows(tester, mirror, claude);
      expect(mirror.top, 0);
      expect(mirror.bottom, _FakeClaudeCode.scrollingRows - 1);

      // A flick of ~310 rows a second for a second: faster than wheel rows
      // bring rows in, so the screen keeps up only while pages arrive ahead of
      // the finger.
      final pagesBefore = link.pages;
      final startedAt = mirror.display;
      await _drag(
        tester,
        mirror,
        claude,
        pixels: 0,
        frames: 60,
        rowsPerFrame: 5,
      );
      final moved = startedAt - mirror.display;

      // A page goes as the last one lands, not once the finger has caught up
      // with it: 19 pages, the screen 290 rows behind a finger at 300. Sent
      // only at the edge, each page waited for the finger to get there and then
      // held the screen for its round trip: 12 pages, 200 rows.
      expect(link.pages - pagesBefore, greaterThanOrEqualTo(16));
      expect(moved, greaterThanOrEqualTo(260));
      // Every row drawn is the program's own row there.
      for (var s = mirror.top; s <= mirror.bottom; s++) {
        final row = mirror.display.round() + s;
        expect(
          mirror.rowAt(row)?.getText().trimRight(),
          claude.transcript[claude.transcript.length -
              _FakeClaudeCode.scrollingRows +
              row],
          reason: 'document row $row',
        );
      }

      await _lift(tester, mirror);
      await _close(tester, mirror, link);
    });

    testWidgets('a new emulator takes back the rows read before, placed where the '
        'program has moved to, without asking for them again', (tester) async {
      final claude = _FakeClaudeCode();
      final memory = RemoteScrollMemory();
      final firstLink = _Link(claude);
      final first = _mirrorOf(tester, firstLink, memory: memory);
      await _learnScrollingRows(tester, first, claude);
      // Read 60 rows back, and stay there.
      await _drag(
        tester,
        first,
        claude,
        pixels: 0,
        frames: 30,
        rowsPerFrame: 2,
      );
      await _lift(tester, first);
      // Where the screen came to rest, rows above where it started.
      final rested = -first.display.round();
      firstLink.closed = true;
      first.dispose();

      // The program moved on meanwhile; a keyframe brings a new emulator.
      claude.scroll(5);
      claude.draw();
      final link = _Link(claude);
      final second = _mirrorOf(tester, link, memory: memory);
      second.begin(
        0,
        claude.terminal.buffer.lines,
        _FakeClaudeCode.rowCount,
        _FakeClaudeCode.lineHeight,
      );

      // Rows above the screen are drawn at once: the program's own rows there.
      var above = 0;
      for (var row = -1; ; row--) {
        final line = second.rowAt(row);
        if (line == null) break;
        expect(
          line.getText().trimRight(),
          claude.transcript[claude.top + row],
          reason: 'row $row above the screen',
        );
        above++;
      }
      // And below it, every row read on the way up: down to the newest, less
      // the 5 the program has moved on since.
      var below = 0;
      for (var row = _FakeClaudeCode.scrollingRows; ; row++) {
        final line = second.rowAt(row);
        if (line == null) break;
        expect(
          line.getText().trimRight(),
          claude.transcript[claude.top + row],
          reason: 'row $row below the screen',
        );
        below++;
      }
      expect(rested, greaterThan(20));
      expect(above, greaterThan(0));
      expect(below, rested - 5);
      expect(link.wheelRows, 0);
      expect(link.pages, 0);

      await _lift(tester, second);
      await _close(tester, second, link);
    });

    testWidgets('an agent nobody has scrolled fetches the rows above while it is '
        'quiet, its scrolling rows read off the prompt box', (tester) async {
      final claude = _FakeClaudeCode();
      final link = _Link(claude);
      final mirror = _mirrorOf(tester, link, fetchAhead: true);
      final newest = claude.top;
      // The program draws once, then is quiet: no scroll has taught the mirror
      // anything.
      link.redraw();
      for (var f = 0; f < 250; f++) {
        await tester.pump(_frame);
      }

      expect(link.pages, greaterThan(0));
      // The rows read off the prompt box: all above it but the first and the
      // one over the box's rule — widened to every row that moved with them.
      expect(mirror.top, 0);
      expect(mirror.bottom, _FakeClaudeCode.scrollingRows - 1);
      // Hundreds of rows above the screen are known, as the program showed
      // them, and the program is back on the screen's row.
      for (final row in [-1, -100, -350]) {
        expect(
          mirror.rowAt(row)?.getText().trimRight(),
          claude.transcript[newest + row],
          reason: 'document row $row',
        );
      }
      expect(claude.top, newest);
      expect(mirror.isActive, isFalse);

      // The first scroll is drawn from them at once, nothing to learn first.
      mirror.begin(
        0,
        claude.terminal.buffer.lines,
        _FakeClaudeCode.rowCount,
        _FakeClaudeCode.lineHeight,
      );
      expect(mirror.isActive, isTrue);
      await _lift(tester, mirror);
      await _close(tester, mirror, link);
    });

    testWidgets(
      'fetching ahead never blanks a row of the screen nobody scrolled',
      (tester) async {
        final claude = _FakeClaudeCode();
        final link = _Link(claude);
        final mirror = _mirrorOf(tester, link, fetchAhead: true);
        final newest = claude.top;
        link.redraw();
        // Every frame while it fetches and comes back: each row that scrolls
        // is drawn — from the document — as the screen showed it.
        var checked = 0;
        for (var f = 0; f < 250; f++) {
          await tester.pump(_frame);
          if (!mirror.isActive) continue;
          expect(mirror.display, 0);
          for (var s = mirror.top; s <= mirror.bottom; s++) {
            expect(
              mirror.rowAt(s)?.getText().trimRight(),
              claude.transcript[newest + s],
              reason: 'screen row $s, ${f * 16} ms in',
            );
          }
          checked++;
        }
        expect(checked, greaterThan(50));
        await _close(tester, mirror, link);
      },
    );

    testWidgets(
      'rows already known are crossed several pages at a time, every frame '
      'placed',
      (tester) async {
        final claude = _FakeClaudeCode();
        final link = _Link(claude);
        final mirror = _mirrorOf(tester, link, fetchAhead: true);
        final newest = claude.top;
        link.redraw();
        for (var f = 0; f < 250; f++) {
          await tester.pump(_frame);
        }
        // Coming back from fetching ahead, the program crossed what it fetched.
        expect(link.pageBatches.where((count) => count > 1), isNotEmpty);
        expect(link.pageBatches.every((count) => count <= 3), isTrue);

        // A flick over them: the program follows several pages at a time, and
        // the screen keeps with the finger the whole way.
        final batchesBefore = link.pageBatches.length;
        await _drag(
          tester,
          mirror,
          claude,
          pixels: 0,
          frames: 40,
          rowsPerFrame: 6,
        );
        expect(
          link.pageBatches.skip(batchesBefore).where((count) => count > 1),
          isNotEmpty,
        );
        expect(mirror.display, closeTo(-240, 1));
        for (var s = mirror.top; s <= mirror.bottom; s++) {
          final row = mirror.display.round() + s;
          expect(
            mirror.rowAt(row)?.getText().trimRight(),
            claude.transcript[newest + row],
            reason: 'document row $row',
          );
        }
        await _lift(tester, mirror);
        await _close(tester, mirror, link);
      },
    );

    testWidgets(
      'scrolled up and back past the newest row, the program is left on it',
      (tester) async {
        final claude = _FakeClaudeCode();
        final link = _Link(claude);
        final mirror = _mirrorOf(tester, link);
        final newest = claude.top;
        // Up a few rows from the newest one, then down past it.
        link.redraw();
        await tester.pump(const Duration(seconds: 1));
        await _drag(
          tester,
          mirror,
          claude,
          pixels: 0,
          frames: 6,
          rowsPerFrame: 1,
        );
        await _lift(tester, mirror);
        expect(claude.top, lessThan(newest));
        await _drag(
          tester,
          mirror,
          claude,
          pixels: 0,
          frames: 12,
          rowsPerFrame: -1,
        );
        await _lift(tester, mirror);
        expect(claude.top, newest);
        expect(mirror.isActive, isFalse);
        await _close(tester, mirror, link);
      },
    );

    testWidgets(
      'over a slow link the program is left on the row the screen rests on',
      (tester) async {
        final claude = _FakeClaudeCode();
        // A phone on a cellular link: a redraw 250 ms after its request.
        final link = _Link(claude, latency: const Duration(milliseconds: 250));
        final mirror = _mirrorOf(tester, link);
        final newest = claude.top;
        link.redraw();
        await tester.pump(const Duration(seconds: 1));
        for (var drag = 0; drag < 3; drag++) {
          await _drag(
            tester,
            mirror,
            claude,
            pixels: 0,
            frames: 10,
            rowsPerFrame: 1,
          );
          // Held a moment, then lifted with no fling.
          await tester.pump(const Duration(milliseconds: 150));
          await _lift(tester, mirror);
          expect(mirror.isActive, isFalse);
          // Where the screen rests is where the program is: nothing of what it
          // was asked is still to land and move it on.
          expect(
            claude.top - newest,
            mirror.display.round(),
            reason: 'drag $drag',
          );
          await tester.pump(const Duration(seconds: 1));
          expect(
            claude.top - newest,
            mirror.display.round(),
            reason: 'drag $drag',
          );
        }
        await _close(tester, mirror, link);
      },
    );

    testWidgets(
      'a drag that catches the last scroll still gliding moves the rows as '
      'far as the finger, frame for frame',
      (tester) async {
        final claude = _FakeClaudeCode();
        final link = _Link(claude);
        final mirror = _mirrorOf(tester, link, fetchAhead: true);
        link.redraw();
        // Rows above fetched ahead, so the drags below cross only rows known.
        for (var f = 0; f < 250; f++) {
          await tester.pump(_frame);
        }
        final lines = claude.terminal.buffer.lines;
        const rowCount = _FakeClaudeCode.rowCount;
        const lineHeight = _FakeClaudeCode.lineHeight;
        // A flick, let go moving: the screen glides on towards its row.
        var pixels = 0.0;
        mirror.begin(pixels, lines, rowCount, lineHeight);
        for (var f = 0; f < 6; f++) {
          await tester.pump(_frame);
          pixels -= 6 * lineHeight;
          mirror.scrollTo(pixels, lines, rowCount, lineHeight);
        }
        mirror.end();
        // Caught mid-glide by the next drag, 4 rows a frame: the rows go with
        // the finger from its first move — what the glide had left is taken in
        // within a few frames, and from then on the screen is where the finger
        // has it, not a spring's v/ω behind.
        mirror.begin(pixels, lines, rowCount, lineHeight);
        final startedAt = mirror.display;
        final behind = <double>[];
        for (var f = 0; f < 20; f++) {
          await tester.pump(_frame);
          pixels -= 4 * lineHeight;
          mirror.scrollTo(pixels, lines, rowCount, lineHeight);
          behind.add((mirror.display - startedAt) - (-4.0 * (f + 1)));
        }
        for (final rows in behind.skip(8)) {
          expect(rows.abs(), lessThan(0.5), reason: 'behind $behind');
        }
        await _lift(tester, mirror);
        await _close(tester, mirror, link);
      },
    );

    testWidgets(
      'a program still drawing does not have its rows read off the prompt '
      'box: its first scroll learns them',
      (tester) async {
        final claude = _FakeClaudeCode();
        final link = _Link(claude);
        final mirror = _mirrorOf(tester, link);
        // A frame just now — at work, a spinner over the box would be taken
        // for content.
        link.redraw();
        mirror.begin(
          0,
          claude.terminal.buffer.lines,
          _FakeClaudeCode.rowCount,
          _FakeClaudeCode.lineHeight,
        );
        expect(mirror.bottom, -1);
        expect(mirror.isActive, isFalse);
        await _lift(tester, mirror);
        await _close(tester, mirror, link);
      },
    );

    testWidgets(
      'a long read back keeps the rows around the screen and lets go of '
      'those far behind it',
      (tester) async {
        final claude = _FakeClaudeCode(transcriptRows: 8000);
        final link = _Link(claude);
        final mirror = _mirrorOf(tester, link);
        await _learnScrollingRows(tester, mirror, claude);

        await _drag(
          tester,
          mirror,
          claude,
          pixels: 0,
          frames: 1000,
          rowsPerFrame: 6,
        );
        final shown = mirror.display.round();
        // Further back than the rows kept either side of the screen (2,000)
        // and a screen: the rows read first are gone.
        expect(shown, lessThan(-4100));
        expect(mirror.rowAt(0), isNull);
        expect(mirror.rowAt(mirror.top + 10), isNull);
        // Those on the screen and within reach below it are kept, as read.
        final bottomRow =
            claude.transcript.length - _FakeClaudeCode.scrollingRows;
        for (final row in [
          shown + mirror.top,
          shown + mirror.bottom,
          shown + mirror.bottom + 1500,
        ]) {
          expect(
            mirror.rowAt(row)?.getText().trimRight(),
            claude.transcript[bottomRow + row],
            reason: 'document row $row',
          );
        }

        await _lift(tester, mirror);
        await _close(tester, mirror, link);
      },
    );
  });
}
