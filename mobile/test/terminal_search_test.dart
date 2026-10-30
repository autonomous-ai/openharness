// The desktop's `test/terminal_search_test.dart`, against the phone's copy of the search.
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/terminal/terminal_search.dart';
import 'package:xterm/xterm.dart';

void main() {
  test(
    'next match is immediate while unchanged results refresh with live output',
    () async {
      final terminal = Terminal()..resize(30, 5);
      terminal.write('first marker\r\nsecond marker\r\n');
      final search = TerminalSearch(terminal);
      addTearDown(search.dispose);
      search.setQuery('marker');
      await search.settled;
      expect(search.selected, 0);
      terminal.write('progress continues');
      expect(search.searching, isTrue);
      search.step(1);
      expect(search.selected, 1);
      expect(search.match!.begin, const CellOffset(7, 1));
      await search.settled;
      expect(search.selected, 1);
      expect(terminal.buffer.getText(search.match), 'marker');
    },
  );

  test('literal find spans soft wrapping, respects hard lines, and maps wide Unicode cells', () async {
    final terminal = Terminal(maxLines: 100)..resize(8, 3);
    terminal.write('A界🙂 error[1]\r\nnext error[1]\r\n');
    final search = TerminalSearch(terminal);
    addTearDown(search.dispose);
    search.setQuery('error[1]');
    await search.settled;
    expect(search.count, 2);
    expect(terminal.buffer.getText(search.match), 'error[1]');
    expect(search.match!.begin, const CellOffset(6, 0));
    search.step(1);
    expect(terminal.buffer.getText(search.match), 'error[1]');
    search.step(1);
    expect(search.selected, 0);
    search.step(-1);
    expect(search.selected, 1);
    search.setQuery('界🙂');
    await search.settled;
    expect(search.count, 1);
    expect(
      search.match,
      BufferRangeLine(const CellOffset(1, 0), const CellOffset(5, 0)),
    );
    search.setQuery('[1]next');
    await search.settled;
    expect(search.count, 0);
    search.setQuery('ERROR[1]');
    await search.settled;
    expect(search.count, 2);
    search.setQuery('ERROR[1]', caseSensitive: true);
    await search.settled;
    expect(search.count, 0);
  });

  test(
    'cursor-created gaps and non-ASCII case folding retain correct cells',
    () async {
      final terminal = Terminal()..resize(30, 4);
      terminal.write('\x1b[1;4HÄpfel\x1b[1;12Hregion');
      final search = TerminalSearch(terminal);
      addTearDown(search.dispose);
      search.setQuery('äPFEL   region');
      await search.settled;
      expect(search.count, 1);
      expect(search.match!.begin, const CellOffset(3, 0));
      expect(search.match!.end, const CellOffset(17, 0));
    },
  );

  test('output updates, erasure, buffer switches and reflow refresh without transport input', () async {
    final sent = <String>[];
    final terminal = Terminal(maxLines: 100, onOutput: sent.add)..resize(12, 4);
    terminal.write('one marker\r\ntwo marker\r\n');
    final search = TerminalSearch(terminal);
    addTearDown(search.dispose);
    search.setQuery('marker');
    await search.settled;
    search.step(1);
    final anchor = terminal.buffer.createAnchorFromOffset(search.match!.begin);
    addTearDown(anchor.dispose);
    terminal.write('three marker\r\n');
    await search.settled;
    expect(search.count, 3);
    expect(search.match!.begin, anchor.offset);
    terminal.resize(7, 4);
    await search.settled;
    expect(search.count, 3);
    expect(search.match!.begin, anchor.offset);
    expect(terminal.buffer.getText(search.match), 'marker');
    terminal.write('\x1b[?1049hAlternate marker');
    expect(search.match, isNull);
    await search.settled;
    expect(search.count, 1);
    terminal.write('\x1b[2J');
    expect(search.match, isNull);
    await search.settled;
    expect(search.count, 0);
    terminal.write('\x1b[?1049l');
    await search.settled;
    expect(search.count, 3);
    expect(sent, isEmpty);
  });

  test('a long repeating wrapped line counts every match without an anchor per result', () async {
    final terminal = Terminal(maxLines: 1000)..resize(100, 5);
    terminal.write('a' * 50000);
    final search = TerminalSearch(terminal, origin: const CellOffset(70, 490));
    addTearDown(search.dispose);
    search.setQuery('a');
    await search.settled;
    expect(search.count, 50000);
    expect(search.selected, 49070);
    expect(search.match!.begin, const CellOffset(70, 490));
    search.step(50000 - 49070 - 1);
    expect(search.selected, 49999);
    search.step(1);
    expect(search.selected, 0);
    var anchors = 0;
    terminal.buffer.lines.forEach((line) => anchors += line.anchors.length);
    expect(anchors, 1);
  });

  test('hidden and disposed searches leave no output listener or retained match anchors', () async {
    final terminal = Terminal(maxLines: 50)..resize(20, 3);
    terminal.write('old marker\r\n');
    final baseline = terminal.listeners.length;
    final search = TerminalSearch(terminal);
    expect(terminal.listeners.length, baseline);
    search.setQuery('marker');
    await search.settled;
    expect(terminal.listeners.length, baseline + 1);
    search.setEnabled(false);
    expect(terminal.listeners.length, baseline);
    expect(search.count, 0);
    terminal.write('new marker\r\n');
    search.setEnabled(true);
    await search.settled;
    expect(search.count, 2);
    search.dispose();
    expect(terminal.listeners.length, baseline);
    terminal.buffer.lines.forEach((line) => expect(line.anchors, isEmpty));
  });

  test('a new query wins over an in-flight scan and scrollback eviction drops old hits', () async {
    final terminal = Terminal(maxLines: 500)..resize(80, 4);
    terminal.write('old marker\r\n' * 450);
    final search = TerminalSearch(terminal);
    addTearDown(search.dispose);
    search.setQuery('old');
    await Future<void>.delayed(Duration.zero);
    search.setQuery('new');
    terminal.write('new marker\r\n' * 510);
    await search.settled;
    expect(search.query, 'new');
    expect(search.count, 499);
    expect(terminal.buffer.getText(search.match), 'new');
    search.setQuery('old');
    await search.settled;
    expect(search.count, 0);
    search.setQuery('');
    expect(terminal.listeners, isEmpty);
  });
}
