import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/chat_find.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:unorm_dart/unorm_dart.dart' as unorm;

SuperTabMessage _message(int sequence, String text) =>
    SuperTabMessage.fromJson({
      'id': 'm$sequence',
      'conversationId': 'g1',
      'sequence': sequence,
      'text': text,
      'author': {'kind': 'person', 'id': 'tony', 'name': 'Tony'},
    });

/// A chat whose older pages are read one at a time, as the view reads them.
class _Chat {
  _Chat(this.rows, {List<List<SuperTabMessage>>? older}) : older = older ?? [];

  final List<SuperTabMessage> rows;
  final List<List<SuperTabMessage>> older;
  int reads = 0;
  bool fails = false;
  Completer<void>? hold;

  late final find = SuperTabChatFind(
    rows: () => rows,
    hasOlder: () => older.isNotEmpty,
    readOlder: () async {
      reads++;
      await hold?.future;
      if (fails) return false;
      rows.insertAll(0, older.removeLast());
      return true;
    },
  );
}

void main() {
  test('case and accents fold, Vietnamese included', () {
    expect(superTabFindFold('Tiếng VIỆT đồng Đà'), 'tieng viet dong da');
    // The same words typed with combining marks fold the same.
    expect(superTabFindFold(unorm.nfd('Tiếng Việt')), 'tieng viet');
  });

  test('matches in the loaded rows, numbered from the newest', () {
    final chat = _Chat([
      for (var i = 1; i <= 5; i++)
        _message(i, i.isEven ? 'Tiếng Việt $i' : 'other $i'),
    ]);
    chat.find.search('tieng viet');
    expect(chat.find.matches, ['m2', 'm4']);
    expect(chat.find.current, 'm4');
    expect(chat.find.number, 1);
    expect(chat.find.total, 2);
  });

  test('stepping goes older and back newer', () async {
    final chat = _Chat([
      for (var i = 1; i <= 5; i++) _message(i, i.isEven ? 'x' : 'y'),
    ]);
    chat.find.search('x');
    await chat.find.older();
    expect((chat.find.current, chat.find.number), ('m2', 2));
    chat.find.newer();
    expect((chat.find.current, chat.find.number), ('m4', 1));
    // The newest match is as new as it goes.
    chat.find.newer();
    expect(chat.find.current, 'm4');
  });

  test('up reads older pages until one has a match', () async {
    final chat = _Chat(
      [_message(100, 'found here'), _message(101, 'nothing')],
      older: [
        [_message(1, 'found long ago')],
        [_message(2, 'quiet')],
        [_message(3, 'quiet')],
      ],
    );
    chat.find.search('FOUND');
    expect(chat.find.total, 1);
    await chat.find.older();
    expect(chat.reads, 3);
    expect(chat.find.current, 'm1');
    expect(chat.find.number, 2);
    expect(chat.find.note, isNull);
    expect(chat.find.reading, isNull);
  });

  test('a search reads at most 50 older pages', () async {
    final chat = _Chat(
      [_message(1000, 'found')],
      older: [
        for (var page = 0; page < 60; page++) [_message(page + 1, 'quiet')],
      ],
    );
    chat.find.search('found');
    await chat.find.older();
    expect(chat.reads, superTabFindPages);
    expect(superTabFindPages, 50);
    expect(chat.find.note, 'No more matches in the last 50 pages');
    expect(chat.find.current, 'm1000');
    // Up again reads nothing more for this search.
    await chat.find.older();
    expect(chat.reads, 50);
  });

  test('a new search may read 50 pages again', () async {
    final chat = _Chat(
      [_message(1000, 'found')],
      older: [
        for (var page = 0; page < 120; page++) [_message(page + 1, 'quiet')],
      ],
    );
    chat.find.search('found');
    await chat.find.older();
    chat.find.search('foun');
    expect(chat.find.note, isNull);
    await chat.find.older();
    expect(chat.reads, 100);
  });

  test('at the start of the chat it says so and reads nothing', () async {
    final chat = _Chat([_message(1, 'found'), _message(2, 'found')]);
    chat.find.search('found');
    await chat.find.older();
    expect(chat.find.current, 'm1');
    await chat.find.older();
    expect(chat.reads, 0);
    expect(chat.find.note, 'No more matches in this chat');
  });

  test('a failed read says so and stops', () async {
    final chat = _Chat(
      [_message(10, 'found')],
      older: [
        [_message(1, 'found')],
      ],
    )..fails = true;
    chat.find.search('found');
    await chat.find.older();
    expect(chat.reads, 1);
    expect(chat.find.note, 'Couldn’t read older messages');
    expect(chat.find.current, 'm10');
  });

  test('one read-back at a time', () async {
    final chat = _Chat(
      [_message(10, 'found')],
      older: [
        [_message(1, 'found')],
      ],
    )..hold = Completer();
    chat.find.search('found');
    final first = chat.find.older();
    final second = chat.find.older();
    // The page on its way is counted, as the phone counts it.
    expect(chat.find.reading, 1);
    chat.hold!.complete();
    await Future.wait([first, second]);
    expect(chat.reads, 1);
    expect(chat.find.current, 'm1');
  });

  test('a new search stops a read-back under way', () async {
    final chat = _Chat(
      [_message(10, 'a')],
      older: [
        for (var page = 0; page < 5; page++) [_message(page + 1, 'quiet')],
      ],
    )..hold = Completer();
    chat.find.search('a');
    final back = chat.find.older();
    chat.find.clear();
    chat.hold!.complete();
    await back;
    expect(chat.reads, 1);
    expect(chat.find.query, '');
    expect(chat.find.current, isNull);
    expect(chat.find.reading, isNull);
  });

  test('disposing it stops a read-back under way', () async {
    final chat = _Chat(
      [_message(10, 'a')],
      older: [
        for (var page = 0; page < 5; page++) [_message(page + 1, 'quiet')],
      ],
    )..hold = Completer();
    chat.find.search('a');
    final back = chat.find.older();
    chat.find.dispose();
    chat.hold!.complete();
    await back;
    expect(chat.reads, 1);
  });

  test('down stops a read-back under way', () async {
    final chat = _Chat(
      [_message(9, 'a'), _message(10, 'a')],
      older: [
        [_message(1, 'a')],
      ],
    );
    chat.find.search('a');
    await chat.find.older();
    expect(chat.find.current, 'm9');
    chat.hold = Completer();
    final back = chat.find.older();
    chat.find.newer();
    chat.hold!.complete();
    await back;
    expect(chat.reads, 1);
    expect(chat.find.current, 'm10');
    expect(chat.find.reading, isNull);
  });

  test('a blank query matches nothing and reads nothing', () async {
    final chat = _Chat(
      [_message(1, '  ')],
      older: [
        [_message(0, 'x')],
      ],
    );
    chat.find.search('   ');
    expect(chat.find.total, 0);
    await chat.find.older();
    expect(chat.reads, 0);
  });

  test('a new matching message keeps the current one', () async {
    final chat = _Chat([_message(1, 'x'), _message(2, 'x')]);
    chat.find.search('x');
    await chat.find.older();
    expect((chat.find.current, chat.find.number), ('m1', 2));
    chat.rows.add(_message(3, 'x again'));
    chat.find.refresh();
    expect(
      (chat.find.current, chat.find.number, chat.find.total),
      ('m1', 3, 3),
    );
  });
}
