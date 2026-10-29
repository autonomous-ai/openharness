import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';

import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/swarm_read_marks.dart';
import 'package:harness_mobile/swarm/swarm_reader.dart';

import '../voice_fakes.dart' show MemoryKeyValueStore;
import 'swarm_fixture.dart';

/// How far the person has read each chat on this phone, as each Desktop
/// computer keeps it, and as the server keeps it once it can (#2131): a chat
/// is unread while its newest message is past the higher of the two marks.
/// Unread is drawn as the chat's name in bold (design system: Unread).
void main() {
  const work = 'group-work';
  const key = 'swarm_read_marks.$me.$tab';

  /// A Swarm whose first read holds the Lead's chat and a work chat at
  /// [workAt], and whose change reads answer [next] when set.
  ({
    FakeSwarm swarm,
    SwarmReader reader,
    SwarmReadMarks marks,
    MemoryKeyValueStore store,
  })
  rig({int workAt = 4, int leadAt = 2, MemoryKeyValueStore? store}) {
    final swarm = FakeSwarm();
    swarm.routes['/api/super-tabs/$tab/parts'] = (_) => firstLoad(
      groups: [groupData(work, title: 'Work', lastMessageSequence: workAt)],
    )..['groups'][0]['data']['lastMessageSequence'] = leadAt;
    swarm.routes['/api/super-tabs/$tab/changes'] = (_) => changes(cursor: 'c2');
    swarm.routes['/api/super-tabs/$tab/conversations/'] = (body) => {
      'sequence': body!['sequence'],
    };
    final reader = SwarmReader(
      tabId: tab,
      accountId: me,
      request: swarm.request,
    );
    store ??= MemoryKeyValueStore();
    final marks = SwarmReadMarks(
      reader,
      store: store,
      saveAfter: Duration.zero,
    );
    addTearDown(() {
      marks.dispose();
      reader.dispose();
    });
    return (swarm: swarm, reader: reader, marks: marks, store: store);
  }

  SuperTabConversation chat(SwarmReader reader, String id) =>
      reader.snapshot!.conversation(id)!;

  /// A change read in which [id] moved on to [sequence].
  void moveOn(FakeSwarm swarm, String id, int sequence, {int version = 9}) =>
      swarm.routes['/api/super-tabs/$tab/changes'] = (_) => changes(
        cursor: 'c3',
        groups: [
          part(
            id,
            version,
            groupData(id, title: 'Work', lastMessageSequence: sequence),
          ),
        ],
      );

  List<({String path, Object? sequence})> markWrites(FakeSwarm swarm) => [
    for (final call in swarm.calls)
      if (call.method == 'POST' && call.path.endsWith('/read'))
        (path: call.path, sequence: call.body?['sequence']),
  ];

  test('the first read on a phone counts what is already there as read, '
      'and a later message makes the chat unread', () async {
    final r = rig();
    await r.reader.refresh();
    await settle();

    expect(r.marks.unread(chat(r.reader, work)), isFalse);
    expect(r.marks.unread(chat(r.reader, leadChat)), isFalse);

    moveOn(r.swarm, work, 6);
    await r.reader.refresh();
    await settle();

    expect(r.marks.unread(chat(r.reader, work)), isTrue);
    expect(r.marks.unread(chat(r.reader, leadChat)), isFalse);
  });

  test('a chat read through its newest message is read again, and the '
      'mark goes to the server', () async {
    final r = rig();
    await r.reader.refresh();
    await settle();
    moveOn(r.swarm, work, 6);
    await r.reader.refresh();
    await settle();
    var told = 0;
    r.marks.addListener(() => told++);

    r.marks.markRead(work, 6);
    await settle();

    expect(r.marks.unread(chat(r.reader, work)), isFalse);
    expect(told, greaterThan(0));
    expect(markWrites(r.swarm), [
      (path: '/api/super-tabs/$tab/conversations/$work/read', sequence: 6),
    ]);
  });

  test('a mark no higher than the one held is neither kept nor sent', () async {
    final r = rig();
    await r.reader.refresh();
    await settle();
    r.marks.markRead(work, 6);
    await settle();
    var told = 0;
    r.marks.addListener(() => told++);

    r.marks
      ..markRead(work, 6)
      ..markRead(work, 5);
    await settle();

    expect(told, 0);
    expect(markWrites(r.swarm).map((w) => w.sequence), [6]);
  });

  test('a server without read marks refuses the send; the phone\'s own mark '
      'still keeps the chat read, and the next mark is tried again', () async {
    final r = rig();
    r.swarm.routes.remove('/api/super-tabs/$tab/conversations/');
    await r.reader.refresh();
    await settle();
    moveOn(r.swarm, work, 6);
    await r.reader.refresh();
    await settle();

    r.marks.markRead(work, 6);
    await settle();
    expect(r.marks.unread(chat(r.reader, work)), isFalse);

    moveOn(r.swarm, work, 8, version: 10);
    await r.reader.refresh();
    await settle();
    expect(r.marks.unread(chat(r.reader, work)), isTrue);
    r.marks.markRead(work, 8);
    await settle();

    expect(r.marks.unread(chat(r.reader, work)), isFalse);
    expect(markWrites(r.swarm).map((w) => w.sequence), [6, 8]);
  });

  test("the server's mark (#2131) counts: the higher of the server's and "
      "the phone's", () async {
    final r = rig();
    await r.reader.refresh();
    await settle();
    moveOn(r.swarm, work, 9);
    await r.reader.refresh();
    await settle();
    expect(r.marks.unread(chat(r.reader, work)), isTrue);

    // Read to 9 on a Desktop computer: the server's marks say so.
    r.reader.snapshot = SuperTabSnapshot.fromJson({
      ...headData(),
      'people': [person(me)],
      'agents': <Object>[],
      'conversations': [
        groupData(leadChat, lastMessageSequence: 2),
        groupData(work, lastMessageSequence: 9),
      ],
      'readMarks': {work: 9},
    });

    expect(r.reader.snapshot!.readMarks, {work: 9});
    expect(r.marks.unread(chat(r.reader, work)), isFalse);
  });

  test('marks outlive the app: read back from the phone, and the first-read '
      'rule does not apply again', () async {
    final first = rig();
    await first.reader.refresh();
    await settle();
    first.marks.markRead(work, 4);
    await settle();
    expect(jsonDecode(first.store.values[key]!), {
      'marks': {work: 4, leadChat: 2},
    });

    // Started again later, after a message came.
    final again = rig(workAt: 7, store: first.store);
    await again.reader.refresh();
    await settle();

    expect(again.marks.unread(chat(again.reader, work)), isTrue);
    expect(again.marks.unread(chat(again.reader, leadChat)), isFalse);
  });

  test('nothing is unread until the phone has read its marks back', () async {
    final store = _SlowStore();
    final swarm = FakeSwarm();
    swarm.routes['/api/super-tabs/$tab/parts'] = (_) =>
        firstLoad(groups: [groupData(work, lastMessageSequence: 7)]);
    final reader = SwarmReader(
      tabId: tab,
      accountId: me,
      request: swarm.request,
    );
    final marks = SwarmReadMarks(
      reader,
      store: store,
      saveAfter: Duration.zero,
    );
    addTearDown(() {
      marks.dispose();
      reader.dispose();
    });
    await reader.refresh();
    await settle();

    expect(marks.unread(chat(reader, work)), isFalse);

    store.answer(
      jsonEncode({
        'marks': {work: 3},
      }),
    );
    await settle();

    expect(marks.unread(chat(reader, work)), isTrue);
  });

  test('the Home kept from before is no first read: it starts no marks and '
      'draws nothing unread', () async {
    final store = MemoryKeyValueStore();
    final swarm = FakeSwarm();
    final reader = SwarmReader(
      tabId: tab,
      accountId: me,
      request: swarm.request,
    );
    final marks = SwarmReadMarks(
      reader,
      store: store,
      saveAfter: Duration.zero,
    );
    addTearDown(() {
      marks.dispose();
      reader.dispose();
    });
    // The inbox draws the Home kept before any read ([SwarmInbox]).
    final kept = SwarmReader(tabId: tab, accountId: me, request: swarm.request);
    addTearDown(kept.dispose);
    swarm.routes['/api/super-tabs/$tab/parts'] = (_) =>
        firstLoad(groups: [groupData(work, lastMessageSequence: 5)]);
    await kept.refresh();
    reader.snapshot = kept.snapshot;
    await settle();

    expect(store.values[key], isNull);
    expect(marks.unread(chat(reader, work)), isFalse);
  });

  test('losing access forgets the marks on the phone too', () async {
    final r = rig();
    await r.reader.refresh();
    await settle();
    r.marks.markRead(work, 4);
    await settle();
    expect(r.store.values[key], isNotNull);

    r.reader.revoke();
    await settle();

    expect(r.store.values[key], isNull);
  });

  test('marks are kept for at most a bound of chats, those the Swarm no '
      'longer reads going first', () async {
    final store = MemoryKeyValueStore()
      ..values[key] = jsonEncode({
        'marks': {
          for (var i = 0; i < SwarmReadMarks.kept + 5; i++) 'gone-$i': 1,
        },
      });
    final r = rig(store: store);
    await r.reader.refresh();
    await settle();
    r.marks.markRead(work, 4);
    await settle();

    final kept = (jsonDecode(store.values[key]!)['marks'] as Map).keys;
    expect(kept, hasLength(SwarmReadMarks.kept));
    expect(kept, contains(work));
  });

  test(
    "a snapshot reads the server's marks, and none from an older server",
    () {
      final state = {
        ...headData(),
        'people': [person(me)],
        'agents': <Object>[],
        'conversations': [groupData(work, lastMessageSequence: 4)],
      };
      expect(
        SuperTabSnapshot.fromJson({
          ...state,
          'readMarks': {work: 4, 'bad': 'x'},
        }).readMarks,
        {work: 4},
      );
      expect(SuperTabSnapshot.fromJson(state).readMarks, isEmpty);
    },
  );
}

/// A store whose read answers only when told.
class _SlowStore extends MemoryKeyValueStore {
  final _pending = <void Function(String?)>[];

  @override
  Future<String?> read(String key) {
    final answer = Completer<String?>();
    _pending.add(answer.complete);
    return answer.future;
  }

  void answer(String? value) {
    for (final pending in _pending) {
      pending(value);
    }
    _pending.clear();
  }
}
