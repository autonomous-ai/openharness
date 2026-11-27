import 'package:flutter_test/flutter_test.dart';
import 'package:harness/browser/browser_tiles.dart';

/// What decides whether an agent's Browser tile is wanted, for this run.
void main() {
  test('a browser that is on wants its tile; one closed while it ran waits '
      'for its next start', () {
    final tiles = BrowserTiles();
    expect(tiles.sync('m', 'a', on: false), isFalse);
    expect(tiles.sync('m', 'a', on: true), isTrue);
    tiles.closed('m', 'a', on: true);
    expect(tiles.sync('m', 'a', on: true), isFalse);
    expect(tiles.sync('m', 'a', on: false), isFalse);
    expect(tiles.sync('m', 'a', on: true), isTrue);
  });

  test('opened by hand, a tile stays wanted with its browser off', () {
    final tiles = BrowserTiles()..opened('m', 'a');
    expect(tiles.sync('m', 'a', on: false), isTrue);
    tiles.closed('m', 'a', on: false);
    expect(tiles.sync('m', 'a', on: false), isFalse);
  });

  test('a Change agent carries the notes; a gone agent drops them', () {
    final tiles = BrowserTiles()
      ..opened('m', 'a')
      ..move('m', 'a', 'b');
    expect(tiles.sync('m', 'a', on: false), isFalse);
    expect(tiles.sync('m', 'b', on: false), isTrue);
    tiles.forget('m', 'b');
    expect(tiles.sync('m', 'b', on: false), isFalse);
  });

  test('at most capacity notes are kept, the oldest going first', () {
    final tiles = BrowserTiles();
    for (var i = 0; i <= BrowserTiles.capacity; i++) {
      tiles.opened('m', 'a$i');
    }
    expect(tiles.sync('m', 'a0', on: false), isFalse);
    expect(tiles.sync('m', 'a1', on: false), isTrue);
    expect(tiles.sync('m', 'a${BrowserTiles.capacity}', on: false), isTrue);
  });
}
