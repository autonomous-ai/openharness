import 'package:flutter_test/flutter_test.dart';

import 'package:harness_mobile/swarm/swarm_asks.dart';
import 'package:harness_mobile/swarm/swarm_read_marks.dart';
import 'package:harness_mobile/swarm/swarm_reader.dart';
import 'package:harness_mobile/swarm/swarm_unread.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// A project's row on Home reads as the desktop's sidebar row
/// (project_sidebar.dart `_row`, #2427, #2638): bold only for its own chat, a
/// person's message there past the reader's mark or a tag of theirs there.
/// Agents' progress in its tasks or its chat never keeps it bold, so a
/// project read on any device stops showing as unread (Dee, 11-05, #3268).
void main() {
  /// The project chat with its newest main-stream message at [main], the
  /// newest of them a person wrote at [person].
  Map<String, dynamic> lead({required int main, int person = 0}) => {
    ...groupData(
      leadChat,
      title: 'Mobile',
      agentIds: ['agent-lead'],
      leadId: 'agent-lead',
      lastMessageSequence: main,
    ),
    'lastMainSequence': main,
    'lastPersonSequence': person,
  };

  /// A task whose agents posted through [main], no person among them.
  Map<String, dynamic> busyTask(String id, {required int main}) => {
    ...groupData(id, title: 'Fix login', lastMessageSequence: main),
    'lastMainSequence': main,
  };

  Map<String, dynamic> tag(String id, String conversationId, int sequence) => {
    'id': id,
    'messageSequence': sequence,
    'projectId': project,
    'projectName': 'Mobile',
    'conversationId': conversationId,
    'conversationTitle': 'Mobile',
    'messageId': 'msg-$id',
    'leadName': 'River',
    'text': 'Look',
    'createdAt': '2026-11-05T01:00:00.000Z',
  };

  /// The phone reading a Swarm whose first load holds [groups] and the
  /// server's [readMarks] from every device of the reader.
  Future<({FakeSwarm swarm, SwarmReader reader, SwarmAsks asks})> rig({
    List<Map<String, dynamic>> groups = const [],
    Map<String, int> readMarks = const {},
    List<Map<String, dynamic>> tags = const [],
  }) async {
    final swarm = FakeSwarm();
    final derived = {
      'mentionsWaiting': tags.length,
      'decisionsWaiting': 0,
      'readMarks': readMarks,
    };
    swarm.routes['/api/super-tabs/$tab/parts'] = (_) =>
        firstLoad(groups: groups, derived: derived);
    swarm.routes['/api/super-tabs/$tab/changes'] = (_) =>
        changes(cursor: 'c2', derived: {'mentionsWaiting': tags.length});
    swarm.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
      'mentions': tags,
    };
    swarm.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
      'decisions': <Object>[],
    };
    swarm.routes['/api/super-tabs/$tab/conversations/'] = (body) => {
      'sequence': body!['sequence'],
    };
    final reader = SwarmReader(
      tabId: tab,
      accountId: me,
      request: swarm.request,
    );
    final marks = reader.readMarks = SwarmReadMarks(reader, store: null);
    final asks = SwarmAsks(reader);
    addTearDown(() {
      asks.dispose();
      marks.dispose();
      reader.dispose();
    });
    await reader.refresh();
    await settle();
    return (swarm: swarm, reader: reader, asks: asks);
  }

  /// A poll in which [groups] moved and the server's marks [readMarks] moved.
  Future<void> poll(
    ({FakeSwarm swarm, SwarmReader reader, SwarmAsks asks}) r, {
    required int version,
    List<Map<String, dynamic>> groups = const [],
    Map<String, int> readMarks = const {},
  }) async {
    r.swarm.routes['/api/super-tabs/$tab/changes'] = (_) => changes(
      cursor: 'c$version',
      derived: {if (readMarks.isNotEmpty) 'readMarks': readMarks},
      groups: [for (final g in groups) part(g['id'] as String, version, g)],
    );
    await r.reader.refresh();
    await settle();
  }

  SwarmProjectNews? row(
    ({FakeSwarm swarm, SwarmReader reader, SwarmAsks asks}) r,
  ) => swarmProjectNews(r.reader, r.asks)[project];

  bool bold(({FakeSwarm swarm, SwarmReader reader, SwarmAsks asks}) r) =>
      row(r)?.bold ?? false;

  test('reading a project on Desktop clears its row on the phone after the '
      'next poll, while its tasks keep getting agent posts', () async {
    final r = await rig(
      groups: [busyTask('g1', main: 2)],
      readMarks: {leadChat: 1, 'g1': 2},
    );
    // A person wrote in the project chat; an agent posts in its task.
    await poll(
      r,
      version: 20,
      groups: [lead(main: 4, person: 4), busyTask('g1', main: 6)],
    );
    expect(bold(r), isTrue, reason: "Dee hasn't read the person's message");

    // Desktop read the project chat: the server's mark comes in a poll.
    await poll(r, version: 21, readMarks: {leadChat: 4});

    expect(bold(r), isFalse);
    expect(row(r)?.tags ?? 0, 0);
  });

  test(
    'a project read on Desktop before the phone opens is not bold on its '
    'first load, though its tasks and its chat have agent posts since',
    () async {
      final r = await rig(
        groups: [lead(main: 9, person: 4), busyTask('g1', main: 7)],
        readMarks: {leadChat: 4, 'g1': 2},
      );

      expect(bold(r), isFalse);
    },
  );

  test('reading it on the phone clears it there and sends the mark Desktop '
      'reads', () async {
    final r = await rig(
      groups: [busyTask('g1', main: 2)],
      readMarks: {leadChat: 1, 'g1': 2},
    );
    await poll(
      r,
      version: 20,
      groups: [lead(main: 5, person: 4), busyTask('g1', main: 6)],
    );
    expect(bold(r), isTrue);

    r.reader.readMarks!.markRead(leadChat, 5);
    await settle();

    expect(bold(r), isFalse);
    expect(
      r.swarm.calls.where(
        (c) =>
            c.method == 'POST' &&
            c.path == '/api/super-tabs/$tab/conversations/$leadChat/read' &&
            c.body?['sequence'] == 5,
      ),
      hasLength(1),
      reason: "the server's mark, which Desktop's row reads",
    );

    // A whole changed group and an older server mark must not undo the
    // phone's read while that write is still reaching other devices.
    await poll(
      r,
      version: 21,
      groups: [lead(main: 9, person: 4)],
      readMarks: {leadChat: 4},
    );
    expect(bold(r), isFalse);
  });

  test(
    'whole changed groups retain the person counter after a remote read',
    () async {
      final r = await rig(readMarks: {leadChat: 4});
      await poll(r, version: 20, groups: [lead(main: 9, person: 7)]);
      expect(bold(r), isTrue);

      // The server returns changed groups whole, including the latest agent
      // message, together with Desktop's read through the person's message.
      await poll(
        r,
        version: 21,
        groups: [lead(main: 10, person: 7)],
        readMarks: {leadChat: 7},
      );
      expect(bold(r), isFalse);

      // Opening that same point sends nothing: it is already read on the
      // server. The row must already be quiet (#2950).
      r.reader.readMarks!.markRead(leadChat, 7);
      await settle();
      expect(bold(r), isFalse);
      expect(r.swarm.calls.where((c) => c.method == 'POST'), isEmpty);
    },
  );

  test(
    'thread-only replies and tags do not make the project chat unread',
    () async {
      final r = await rig(
        groups: [
          {...lead(main: 4, person: 4), 'lastMessageSequence': 12},
        ],
        readMarks: {leadChat: 4},
        tags: [
          {...tag('thread-tag', leadChat, 12), 'threadId': 'thread-root'},
        ],
      );
      expect(bold(r), isFalse);
      expect(row(r)?.tags ?? 0, 0);
    },
  );

  test("an agent's post in the project chat does not bold it; a person's "
      'does', () async {
    final r = await rig(readMarks: {leadChat: 1});
    await poll(r, version: 20, groups: [lead(main: 6, person: 1)]);
    expect(bold(r), isFalse);

    await poll(r, version: 21, groups: [lead(main: 7, person: 7)]);
    expect(bold(r), isTrue);
  });

  test('a muted project chat is never bold', () async {
    final r = await rig(readMarks: {leadChat: 1});
    r.swarm.routes['/api/super-tabs/$tab/changes'] = (_) => changes(
      cursor: 'c20',
      groups: [part(leadChat, 20, lead(main: 7, person: 7))],
      derived: {
        'chatSettings': {leadChat: 'muted'},
      },
    );
    await r.reader.refresh();
    await settle();

    expect(bold(r), isFalse);
  });

  test(
    'a tag of hers in the project chat keeps it bold with its count',
    () async {
      final r = await rig(
        groups: [lead(main: 5, person: 1)],
        readMarks: {leadChat: 4},
        tags: [tag('t1', leadChat, 5)],
      );

      expect(row(r), (bold: true, tags: 1, hasWaitingTag: true));
    },
  );

  test('a tag in a task leaves the row quiet but listed under Unread and '
      'Mentions', () async {
    final r = await rig(
      groups: [busyTask('g1', main: 5)],
      readMarks: {leadChat: 0, 'g1': 4},
      tags: [tag('t1', 'g1', 5)],
    );

    expect(row(r), (bold: false, tags: 0, hasWaitingTag: true));
  });
}
