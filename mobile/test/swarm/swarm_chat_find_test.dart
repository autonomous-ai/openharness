import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/swarm_chat_find.dart';
import 'package:harness_mobile/swarm/swarm_new_message_sheet.dart'
    show swarmSearchFold;
import 'package:unorm_dart/unorm_dart.dart' as unorm;

/// Find in the open chat's model (task #2826): it lights the loaded messages
/// that match, numbers them from the newest, and steps up past the oldest
/// loaded match by reading older pages, at most 50 a search.
void main() {
  SuperTabMessage message(String id, int sequence, String text) =>
      SuperTabMessage.fromJson({
        'id': id,
        'conversationId': 'g1',
        'text': text,
        'sequence': sequence,
        'author': {'kind': 'agent', 'id': 'agent-lead', 'name': 'River'},
        'createdAt': DateTime.utc(2026, 11, 4).toIso8601String(),
      });

  /// A chat of [rows] (oldest first) whose older pages come from [page], one
  /// call each; [reads] counts them. Older rows remain while [older] says so.
  ({SwarmChatFind find, List<SuperTabMessage> rows, int Function() reads}) chat(
    List<SuperTabMessage> rows, {
    bool Function()? older,
    FutureOr<bool> Function(int page, List<SuperTabMessage> rows)? page,
  }) {
    var reads = 0;
    final find = SwarmChatFind(
      rows: () => rows,
      hasOlder: older ?? () => true,
      readOlder: () async {
        reads++;
        return page == null ? false : await page(reads, rows);
      },
    );
    addTearDown(find.dispose);
    return (find: find, rows: rows, reads: () => reads);
  }

  /// m1..m5, with m2 and m4 saying x.
  List<SuperTabMessage> five() => [
    for (var i = 1; i <= 5; i++)
      message('m$i', i, i.isEven ? 'an x here' : 'nothing'),
  ];

  /// One older page of a message that never matches, put above the others.
  bool plain(int page, List<SuperTabMessage> rows) {
    rows.insert(0, message('old$page', -page, 'nothing older'));
    return true;
  }

  test('fold', () {
    expect(swarmSearchFold('Tiếng VIỆT đồng'), 'tieng viet dong');
    expect(swarmSearchFold(unorm.nfd('Tiếng VIỆT đồng')), 'tieng viet dong');
    final c = chat([
      message('m1', 1, 'Tiếng Việt'),
      message('m2', 2, 'tiền đồng'),
    ]);
    c.find.search('tieng viet');
    expect(c.find.matches, ['m1']);
    c.find.search('DONG');
    expect(c.find.matches, ['m2']);
  });

  test('matches in loaded rows', () {
    final c = chat(five());
    c.find.search('x');
    expect(c.find.matches, ['m2', 'm4']);
    expect(c.find.matching, {'m2', 'm4'});
    expect(c.find.current, 'm4');
    expect(c.find.number, 1);
    expect(c.find.total, 2);
    expect(c.find.note, isNull);
    // Typing never reads a page.
    expect(c.reads(), 0);
  });

  test('stepping', () async {
    final c = chat(five());
    c.find.search('x');
    await c.find.older();
    expect((c.find.current, c.find.number, c.find.total), ('m2', 2, 2));
    c.find.newer();
    expect((c.find.current, c.find.number), ('m4', 1));
    // Newer than the newest stays where it is.
    c.find.newer();
    expect((c.find.current, c.find.number), ('m4', 1));
    expect(c.reads(), 0);
  });

  test('reads older pages until a match', () async {
    final c = chat(
      five(),
      page: (page, rows) {
        rows.insert(
          0,
          message('old$page', -page, page == 3 ? 'x at last' : 'nothing'),
        );
        return true;
      },
    );
    c.find.search('x');
    await c.find.older();
    expect(c.reads(), 0);
    await c.find.older();
    expect(c.reads(), 3);
    expect((c.find.current, c.find.number, c.find.total), ('old3', 3, 3));
    expect(c.find.reading, isNull);
    expect(c.find.note, isNull);
  });

  test('says how far the read-back is while it reads', () async {
    final held = <Completer<bool>>[];
    final c = chat(
      five(),
      page: (page, rows) {
        plain(page, rows);
        final read = Completer<bool>();
        held.add(read);
        return read.future;
      },
    );
    c.find.search('x');
    await c.find.older();
    final going = c.find.older();
    await Future<void>.delayed(Duration.zero);
    expect(c.find.reading, 1);
    held.last.complete(true);
    await Future<void>.delayed(Duration.zero);
    expect(c.find.reading, 2);
    c.find.clear();
    held.last.complete(true);
    await going;
  });

  test('50-page stop', () async {
    final c = chat(five(), page: plain);
    c.find.search('x');
    await c.find.older();
    await c.find.older();
    expect(c.reads(), swarmFindPages);
    expect(c.reads(), 50);
    expect(c.find.note, 'No more matches in the last 50 pages');
    expect((c.find.current, c.find.number, c.find.total), ('m2', 2, 2));
    expect(c.find.reading, isNull);
    // Up again reads nothing more for this search.
    await c.find.older();
    expect(c.reads(), 50);
    expect(c.find.note, 'No more matches in the last 50 pages');
  });

  test('chat start', () async {
    final c = chat(five(), older: () => false, page: plain);
    c.find.search('x');
    await c.find.older();
    await c.find.older();
    expect(c.reads(), 0);
    expect(c.find.note, 'No more matches in this chat');
    expect(c.find.current, 'm2');
    // Down again says nothing of the start.
    c.find.newer();
    expect(c.find.note, isNull);
  });

  test('reaching the start while reading says so', () async {
    var older = 3;
    final c = chat(
      five(),
      older: () => older > 0,
      page: (page, rows) {
        older--;
        return plain(page, rows);
      },
    );
    c.find.search('x');
    await c.find.older();
    await c.find.older();
    expect(c.reads(), 3);
    expect(c.find.note, 'No more matches in this chat');
  });

  test('failed read', () async {
    final c = chat(five(), page: (_, _) => false);
    c.find.search('x');
    await c.find.older();
    await c.find.older();
    expect(c.reads(), 1);
    expect(c.find.note, 'Couldn’t read older messages');
    expect(c.find.current, 'm2');
    expect(c.find.reading, isNull);
  });

  test('one read-back at a time', () async {
    final read = Completer<bool>();
    final c = chat(
      five(),
      page: (page, rows) {
        if (page > 1) return false;
        rows.insert(0, message('old1', -1, 'x'));
        return read.future;
      },
    );
    c.find.search('x');
    await c.find.older();
    final first = c.find.older();
    final second = c.find.older();
    await Future<void>.delayed(Duration.zero);
    expect(c.reads(), 1);
    read.complete(true);
    await Future.wait([first, second]);
    expect(c.reads(), 1);
    expect(c.find.current, 'old1');
  });

  test('blank query', () async {
    final c = chat(five(), page: plain);
    c.find.search('  ');
    expect(c.find.matches, isEmpty);
    expect(c.find.current, isNull);
    expect(c.find.number, isNull);
    await c.find.older();
    expect(c.reads(), 0);
    expect(c.find.note, isNull);
  });

  test('with no match loaded, Up reads back to the newest older one', () async {
    final c = chat(
      five(),
      page: (page, rows) {
        rows.insert(
          0,
          message('old$page', -page, page == 2 ? 'zebra' : 'nothing'),
        );
        return true;
      },
    );
    c.find.search('zebra');
    expect(c.find.total, 0);
    expect(c.find.current, isNull);
    await c.find.older();
    expect(c.reads(), 2);
    expect((c.find.current, c.find.number, c.find.total), ('old2', 1, 1));
  });

  test('a new search starts the 50 again', () async {
    final c = chat(five(), page: plain);
    c.find.search('x');
    await c.find.older();
    await c.find.older();
    expect(c.reads(), 50);
    c.find.search('nothing older');
    expect(c.find.note, isNull);
    // Its oldest loaded match is the oldest row: Up reads 50 more.
    while (c.find.number != c.find.total) {
      await c.find.older();
    }
    expect(c.reads(), 50);
    c.find.search('x');
    await c.find.older();
    await c.find.older();
    expect(c.reads(), 100);
    expect(c.find.note, 'No more matches in the last 50 pages');
  });

  test('search or clear during a read-back stops it', () async {
    final read = Completer<bool>();
    final c = chat(
      five(),
      page: (page, rows) {
        plain(page, rows);
        return page == 1 ? read.future : true;
      },
    );
    c.find.search('x');
    await c.find.older();
    final going = c.find.older();
    await Future<void>.delayed(Duration.zero);
    c.find.clear();
    expect(c.find.query, '');
    expect(c.find.matches, isEmpty);
    expect(c.find.current, isNull);
    expect(c.find.reading, isNull);
    read.complete(true);
    await going;
    expect(c.reads(), 1);
    expect(c.find.note, isNull);
    expect(c.find.current, isNull);
  });

  test('a new matching message keeps the current one', () async {
    final c = chat(five());
    c.find.search('x');
    await c.find.older();
    expect((c.find.current, c.find.number, c.find.total), ('m2', 2, 2));
    c.rows.add(message('m6', 6, 'x again'));
    c.find.refresh();
    expect((c.find.current, c.find.number, c.find.total), ('m2', 3, 3));
    // The current one gone (deleted), the newest is current.
    c.rows.removeWhere((m) => m.id == 'm2');
    c.find.refresh();
    expect((c.find.current, c.find.number, c.find.total), ('m6', 1, 2));
  });

  test('an edited message is folded again', () {
    final c = chat([message('m1', 1, 'nothing')]);
    c.find.search('x');
    expect(c.find.total, 0);
    c.rows[0] = message('m1', 1, 'now an x');
    c.find.refresh();
    expect(c.find.current, 'm1');
  });

  testWidgets('the bar: count, steps and close, each a 44-point target', (
    tester,
  ) async {
    final c = chat(five(), older: () => false);
    var closed = 0;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SwarmFindBar(find: c.find, onClose: () => closed++),
        ),
      ),
    );
    Finder key(String value) => find.byKey(ValueKey(value));
    // It takes the keyboard as it opens.
    final field = find.descendant(
      of: key('swarm-find-field'),
      matching: find.byType(EditableText),
    );
    expect(tester.widget<EditableText>(field).focusNode.hasFocus, isTrue);
    await tester.enterText(key('swarm-find-field'), 'x');
    await tester.pump();
    expect(c.find.query, 'x');
    expect(tester.widget<Text>(key('swarm-find-count')).data, '1 of 2');
    for (final button in [
      'swarm-find-older',
      'swarm-find-newer',
      'swarm-find-close',
    ]) {
      final size = tester.getSize(key(button));
      expect(size.width, greaterThanOrEqualTo(44), reason: button);
      expect(size.height, greaterThanOrEqualTo(44), reason: button);
    }
    await tester.tap(key('swarm-find-older'));
    await tester.pump();
    expect(find.text('2 of 2'), findsOneWidget);
    await tester.tap(key('swarm-find-newer'));
    await tester.pump();
    expect(find.text('1 of 2'), findsOneWidget);
    // The keyboard's search key steps older too.
    await tester.testTextInput.receiveAction(TextInputAction.search);
    await tester.pump();
    expect(find.text('2 of 2'), findsOneWidget);
    await tester.testTextInput.receiveAction(TextInputAction.search);
    await tester.pump();
    expect(find.text('No more matches in this chat'), findsOneWidget);
    await tester.enterText(key('swarm-find-field'), 'zebra');
    await tester.pump();
    expect(find.text('No matches'), findsOneWidget);
    await tester.tap(key('swarm-find-close'));
    expect(closed, 1);
  });
}
