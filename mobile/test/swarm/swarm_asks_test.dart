import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/logging/app_log.dart';
import 'package:harness_mobile/swarm/swarm_asks.dart';
import 'package:harness_mobile/swarm/swarm_reader.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';

import 'swarm_fixture.dart';

/// What the Swarm asks of the reader: decisions to answer and the Lead's tags
/// (backend superTabs/decisions.ts and mentions.ts). Read only while the
/// Swarm's own counts say there is something, as the desktop does.
void main() {
  Map<String, dynamic> decisionRow(
    String id, {
    String question = 'Ship it?',
    List<String> options = const ['Yes', 'No'],
    int recommended = 0,
  }) => {
    'id': id,
    'batchId': 'batch-1',
    'projectId': project,
    'projectName': 'Mobile',
    'conversationId': 'g1',
    'conversationTitle': 'Fix login',
    'askerName': 'River',
    'question': question,
    'options': options,
    'recommended': recommended,
    'unblocks': 'The release',
    'createdAt': '2026-10-27T01:00:00.000Z',
  };

  Map<String, dynamic> mentionRow(String id, {String text = 'Look'}) => {
    'id': id,
    'projectId': project,
    'projectName': 'Mobile',
    'conversationId': 'g1',
    'conversationTitle': 'Fix login',
    'messageId': 'msg-$id',
    'leadName': 'River',
    'text': text,
    'createdAt': '2026-10-27T01:00:00.000Z',
  };

  /// A Swarm whose reads say [decisions] and [mentions] are waiting.
  ({FakeSwarm swarm, SwarmReader reader, SwarmAsks asks}) rig({
    int decisions = 0,
    int mentions = 0,
  }) {
    final swarm = FakeSwarm();
    var derived = {'decisionsWaiting': decisions, 'mentionsWaiting': mentions};
    swarm.routes['/api/super-tabs/$tab/parts'] = (_) =>
        firstLoad(derived: derived);
    swarm.routes['/api/super-tabs/$tab/changes'] = (_) =>
        changes(cursor: 'c2', derived: derived);
    final reader = SwarmReader(
      tabId: tab,
      accountId: me,
      request: swarm.request,
    );
    final asks = SwarmAsks(reader);
    addTearDown(() {
      asks.dispose();
      reader.dispose();
    });
    return (swarm: swarm, reader: reader, asks: asks);
  }

  test('a Swarm with nothing waiting reads its lists only with its first '
      'load', () async {
    final r = rig();

    await r.reader.refresh();
    await settle();
    await r.reader.refresh();
    await settle();

    expect(r.swarm.paths, [
      '/api/super-tabs/$tab/parts',
      '/api/super-tabs/$tab/decisions?state=open',
      '/api/super-tabs/$tab/mentions?state=waiting',
      '/api/super-tabs/$tab/changes?cursor=c1',
    ]);
    expect(r.asks.decisions, isEmpty);
    expect(r.asks.mentions, isEmpty);
  });

  // Read after the first load, they waited a round trip through the
  // computer behind the whole 1.3 MB Swarm (Mira's iPhone 14 numbers).
  test('decisions and tags are read alongside the first load, once', () async {
    final r = rig(decisions: 1);
    final load = Completer<Object?>();
    r.swarm.routes['/api/super-tabs/$tab/parts'] = (_) => load.future;
    r.swarm.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
      'decisions': [decisionRow('d1')],
    };
    r.swarm.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
      'mentions': <Object>[],
    };

    final reading = r.reader.refresh();
    await settle();
    expect(
      r.swarm.paths,
      containsAll([
        '/api/super-tabs/$tab/decisions?state=open',
        '/api/super-tabs/$tab/mentions?state=waiting',
      ]),
    );
    expect(r.asks.decisions, isEmpty, reason: 'not before the Swarm is read');
    expect(r.asks.loading, isTrue);

    load.complete(
      firstLoad(derived: {'decisionsWaiting': 1, 'mentionsWaiting': 0}),
    );
    await reading;
    await settle();

    expect(r.asks.decisions.single.id, 'd1');
    expect(r.asks.loading, isFalse);
    expect(r.swarm.paths.where((p) => p.contains('decisions')), hasLength(1));
  });

  test(
    'asks read alongside a first load that failed are never shown',
    () async {
      final r = rig(decisions: 1);
      var failing = true;
      var open = [decisionRow('d-old')];
      r.swarm.routes['/api/super-tabs/$tab/parts'] = (_) => failing
          ? throw const SuperTabFailure('MACHINE_UNAVAILABLE', 'No computer.')
          : firstLoad(derived: {'decisionsWaiting': 1, 'mentionsWaiting': 0});
      r.swarm.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
        'decisions': open,
      };
      r.swarm.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
        'mentions': <Object>[],
      };
      final shown = <String>[];
      r.asks.addListener(() => shown.addAll(r.asks.decisions.map((d) => d.id)));
      await r.reader.refresh();
      await settle();

      failing = false;
      open = [decisionRow('d-new')];
      await r.reader.refresh();
      await settle();

      expect(shown, isNot(contains('d-old')));
      expect(r.asks.decisions.single.id, 'd-new');
    },
  );

  test('asks read alongside the first load that disagree with its counts '
      'are read again, not shown', () async {
    final r = rig();
    var open = [decisionRow('d1'), decisionRow('d2')];
    r.swarm.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
      'decisions': open,
    };
    r.swarm.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
      'mentions': <Object>[],
    };
    final load = Completer<Object?>();
    r.swarm.routes['/api/super-tabs/$tab/parts'] = (_) => load.future;
    final shown = <String>[];
    r.asks.addListener(() => shown.addAll(r.asks.decisions.map((d) => d.id)));

    final reading = r.reader.refresh();
    await settle();
    // d1 answered elsewhere between the two answers: the Swarm counts one.
    open = [decisionRow('d2')];
    load.complete(
      firstLoad(derived: {'decisionsWaiting': 1, 'mentionsWaiting': 0}),
    );
    await reading;
    await settle();

    expect(shown, isNot(contains('d1')));
    expect(r.asks.decisions.single.id, 'd2');
    expect(r.swarm.paths.where((p) => p.contains('decisions')), hasLength(2));
  });

  group('loading', () {
    test('until decisions and tags are read, then not', () async {
      final r = rig(decisions: 1);
      final open = Completer<Object?>();
      r.swarm.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) =>
          open.future;
      r.swarm.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
        'mentions': <Object>[],
      };
      expect(r.asks.loading, isTrue, reason: 'nothing is read yet');

      await r.reader.refresh();
      await settle();
      expect(r.reader.snapshot, isNotNull);
      expect(r.asks.loading, isTrue, reason: 'the Swarm is read, not its asks');

      var told = 0;
      r.asks.addListener(() => told++);
      open.complete({
        'decisions': [decisionRow('d1')],
      });
      await settle();

      expect(r.asks.loading, isFalse);
      expect(told, 1);
    });

    test('ends with the first load when nothing waits', () async {
      final r = rig();
      var told = 0;
      r.asks.addListener(() => told++);

      await r.reader.refresh();
      await settle();

      expect(r.asks.loading, isFalse);
      expect(told, 1, reason: 'Home hears that loading ended');
    });

    test('ends when the read of the asks fails, with its error', () async {
      final r = rig(decisions: 1);
      r.swarm.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) =>
          throw const SuperTabFailure('MACHINE_UNAVAILABLE', 'No computer.');
      r.swarm.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
        'mentions': <Object>[],
      };

      await r.reader.refresh();
      await settle();

      expect(r.asks.loading, isFalse);
      expect(r.asks.error, isNotNull);
    });

    test('goes in the log once, however many reads of the asks fail', () async {
      final before = appLog;
      final log = _Log();
      appLog = log;
      addTearDown(() => appLog = before);
      final r = rig(decisions: 1);
      final failure = const SuperTabFailure('INTERNAL', 'Broken');
      r.swarm.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) =>
          throw failure;
      r.swarm.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
        'mentions': <Object>[],
      };

      await r.reader.refresh();
      await settle();
      await r.reader.refresh();
      await settle();

      expect(r.asks.error, isNotNull);
      expect(log.errors, [failure]);
    });

    test('ends when the Swarm itself could not be read', () async {
      final r = rig();
      r.swarm.routes['/api/super-tabs/$tab/parts'] = (_) =>
          throw const SuperTabFailure('MACHINE_UNAVAILABLE', 'No computer.');

      await r.reader.refresh();
      await settle();

      expect(r.reader.error, isNotNull);
      expect(r.asks.loading, isFalse);
    });

    test('starts again while a Swarm read again in full has its asks read '
        'again', () async {
      final r = rig(decisions: 1);
      Object? open = {
        'decisions': [decisionRow('d1')],
      };
      r.swarm.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => open;
      r.swarm.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
        'mentions': <Object>[],
      };
      await r.reader.refresh();
      await settle();
      expect(r.asks.loading, isFalse);

      final again = Completer<Object?>();
      open = again.future;
      r.swarm.routes['/api/super-tabs/$tab/changes'] = (_) => {'reload': true};
      await r.reader.refresh();
      await settle();
      expect(r.asks.decisions, isEmpty);
      expect(r.asks.loading, isTrue);

      again.complete({
        'decisions': [decisionRow('d1')],
      });
      await settle();
      expect(r.asks.loading, isFalse);
      expect(r.asks.decisions.single.id, 'd1');
    });

    test('is not while the reader may no longer read the Swarm', () async {
      final r = rig();
      r.reader.revoke();

      expect(r.asks.loading, isFalse);
    });
  });

  test(
    'open decisions and waiting tags are read when the counts say so',
    () async {
      final r = rig(decisions: 1, mentions: 1);
      r.swarm.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
        'decisions': [
          decisionRow(
            'd1',
            options: ['Offline mode', 'Work offline'],
            recommended: 1,
          ),
        ],
      };
      r.swarm.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
        'mentions': [mentionRow('m1', text: 'Can you check the copy?')],
      };

      await r.reader.refresh();
      await settle();

      final decision = r.asks.decisions.single;
      expect(decision.question, 'Ship it?');
      expect(decision.options, ['Offline mode', 'Work offline']);
      expect(decision.recommended, 1);
      expect(decision.askerName, 'River');
      expect(decision.conversationId, 'g1');
      expect(r.asks.mentions.single.text, 'Can you check the copy?');
    },
  );

  test('a backend from before decisions has none to show', () async {
    final r = rig(decisions: 1);
    r.swarm.routes['/api/super-tabs/$tab/decisions'] = (_) =>
        throw const SuperTabFailure('NOT_FOUND', 'Not found.', statusCode: 404);

    await r.reader.refresh();
    await settle();

    expect(r.asks.decisions, isEmpty);
    expect(r.asks.error, isNull);
  });

  test('a failed read is tried again at the next read of the Swarm, '
      'even one that changed nothing', () async {
    final r = rig(decisions: 1);
    var failing = true;
    r.swarm.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => failing
        ? throw const SuperTabFailure('MACHINE_UNAVAILABLE', 'No computer.')
        : {
            'decisions': [decisionRow('d1')],
          };
    r.swarm.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
      'mentions': <Object>[],
    };
    await r.reader.refresh();
    await settle();
    expect(r.asks.decisions, isEmpty);
    expect(r.asks.error, isNotNull);

    failing = false;
    await r.reader.refresh();
    await settle();

    expect(r.asks.decisions.single.id, 'd1');
    expect(r.asks.error, isNull);
  });

  test('while an ask waits, a read that moves only the last-change time '
      'reads the asks again', () async {
    final r = rig(decisions: 1);
    var open = [decisionRow('d1')];
    r.swarm.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
      'decisions': open,
    };
    r.swarm.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
      'mentions': <Object>[],
    };
    await r.reader.refresh();
    await settle();
    expect(r.asks.decisions.single.id, 'd1');

    // d1 answered on the desktop and d2 asked: the count stays at one.
    open = [decisionRow('d2')];
    r.swarm.routes['/api/super-tabs/$tab/changes'] = (_) => changes(
      cursor: 'c3',
      derived: {'decisionsWaiting': 1, 'mentionsWaiting': 0},
      lastChangedAt: 300,
    );
    await r.reader.refresh();
    await settle();

    expect(r.asks.decisions.single.id, 'd2');
  });

  // Each such read notified, and the inbox rebuilt Home with it, several
  // times a poll (audit of 44d284f65, item 4; Jasper's item 5).
  test('asks read back as they were notify nothing, and stay the same '
      'objects', () async {
    final r = rig(decisions: 1, mentions: 1);
    r.swarm.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
      'decisions': [decisionRow('d1')],
    };
    r.swarm.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
      'mentions': [mentionRow('m1')],
    };
    await r.reader.refresh();
    await settle();
    final decisions = r.asks.decisions, mentions = r.asks.mentions;
    var notifies = 0;
    r.asks.addListener(() => notifies++);

    r.swarm.routes['/api/super-tabs/$tab/changes'] = (_) => changes(
      cursor: 'c3',
      derived: {'decisionsWaiting': 1, 'mentionsWaiting': 1},
      lastChangedAt: 300,
    );
    await r.reader.refresh();
    await settle();
    await r.asks.load();

    expect(r.swarm.paths.where((p) => p.contains('decisions')), hasLength(3));
    expect(notifies, 0);
    expect(r.asks.decisions, same(decisions));
    expect(r.asks.mentions, same(mentions));
  });

  test('a changed ask is told, even with the same ids', () async {
    final r = rig(decisions: 1);
    var question = 'Ship it?';
    r.swarm.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
      'decisions': [decisionRow('d1', question: question)],
    };
    r.swarm.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
      'mentions': <Object>[],
    };
    await r.reader.refresh();
    await settle();
    var notifies = 0;
    r.asks.addListener(() => notifies++);

    question = 'Ship it today?';
    await r.asks.load();

    expect(notifies, 1);
    expect(r.asks.decisions.single.question, 'Ship it today?');
  });

  test(
    'a Swarm the reader may no longer read keeps none of its asks',
    () async {
      final r = rig(decisions: 1);
      r.swarm.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
        'decisions': [decisionRow('d1')],
      };
      r.swarm.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
        'mentions': <Object>[],
      };
      await r.reader.refresh();
      await settle();
      expect(r.asks.decisions, hasLength(1));

      const refused = SuperTabFailure(
        'FORBIDDEN',
        'Not yours.',
        statusCode: 403,
      );
      r.swarm.routes['/api/super-tabs/$tab/changes'] = (_) => throw refused;
      r.swarm.routes['/api/super-tabs/$tab/parts'] = (_) => throw refused;
      await r.reader.refresh();
      await settle();

      expect(r.reader.accessRevoked, isTrue);
      expect(r.asks.decisions, isEmpty);
    },
  );

  test(
    'asks read before a full read of the Swarm are never shown after it',
    () async {
      final r = rig(decisions: 1);
      final before = Completer<Object?>();
      Object? open = before.future;
      r.swarm.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => open;
      r.swarm.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
        'mentions': <Object>[],
      };
      await r.reader.refresh();
      await settle();
      final shown = <List<String>>[];
      r.asks.addListener(
        () => shown.add([for (final d in r.asks.decisions) d.id]),
      );

      // The person left the chat d1 was asked in; the Swarm is read again
      // in full, and still has one decision for them elsewhere.
      open = {
        'decisions': [decisionRow('d2')],
      };
      r.swarm.routes['/api/super-tabs/$tab/changes'] = (_) => {'reload': true};
      await r.reader.refresh();
      before.complete({
        'decisions': [decisionRow('d1')],
      });
      await settle();

      expect(shown.expand((ids) => ids), isNot(contains('d1')));
      expect([for (final d in r.asks.decisions) d.id], ['d2']);
    },
  );

  test('answering sends the choice once, then reads again', () async {
    final r = rig(decisions: 1);
    var open = [decisionRow('d1')];
    r.swarm.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
      'decisions': open,
    };
    r.swarm.routes['/api/super-tabs/$tab/commands'] = (_) {
      open = [];
      return {'result': <String, dynamic>{}};
    };
    await r.reader.refresh();
    await settle();

    final answered = await r.asks.answer(r.asks.decisions.single, 1);

    expect(answered, isTrue);
    final sent = r.swarm.calls.singleWhere((c) => c.method == 'POST');
    expect(sent.body!['operationId'], isA<String>());
    expect(sent.body!['command'], {
      'type': 'decision.answer',
      'decisionId': 'd1',
      'choice': 1,
    });
    expect(r.asks.decisions, isEmpty);
    expect(r.asks.answering, isEmpty);
  });

  test('a refused answer keeps the decision and says so', () async {
    final r = rig(decisions: 1);
    r.swarm.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
      'decisions': [decisionRow('d1')],
    };
    r.swarm.routes['/api/super-tabs/$tab/commands'] = (_) =>
        throw const SuperTabFailure('MACHINE_UNAVAILABLE', 'No computer.');
    await r.reader.refresh();
    await settle();

    final answered = await r.asks.answer(r.asks.decisions.single, 0);

    expect(answered, isFalse);
    expect(r.asks.decisions.single.id, 'd1');
    expect(r.asks.error, 'Could not send your answer. Try again.');
  });

  /// The backend's commands route as it treats answers: one answer per
  /// decision, and a receipt per operation that replays its reply.
  ({List<Map<String, dynamic>> sent, void Function() loseReplies}) answers(
    FakeSwarm swarm,
    List<Map<String, dynamic>> Function() open,
    void Function() answered,
  ) {
    final sent = <Map<String, dynamic>>[];
    final receipts = <String>{};
    var lose = false;
    swarm.routes['/api/super-tabs/$tab/commands'] = (body) {
      sent.add(body!);
      final operation = body['operationId'] as String;
      if (!receipts.contains(operation)) {
        if (open().isEmpty) {
          throw const SuperTabFailure(
            'DECISION_ANSWERED',
            'This decision is already answered.',
            statusCode: 409,
          );
        }
        receipts.add(operation);
        answered();
      }
      if (lose) {
        lose = false;
        throw const SuperTabFailure('MACHINE_UNAVAILABLE', 'No computer.');
      }
      return {'result': <String, dynamic>{}};
    };
    return (sent: sent, loseReplies: () => lose = true);
  }

  test('an answer taken whose reply was lost is sent again as the same answer, '
      'and no other is offered meanwhile', () async {
    final r = rig(decisions: 1);
    var open = [decisionRow('d1')];
    r.swarm.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
      'decisions': open,
    };
    final backend = answers(r.swarm, () => open, () => open = []);
    await r.reader.refresh();
    await settle();
    final decision = r.asks.decisions.single;

    backend.loseReplies();
    expect(await r.asks.answer(decision, 1), isFalse);
    expect(r.asks.unconfirmed(decision), 1);

    expect(await r.asks.answer(decision, 0), isTrue);

    expect(backend.sent, hasLength(2));
    expect(
      {for (final body in backend.sent) body['operationId']},
      hasLength(1),
      reason: 'the retry is the same command, so its receipt answers it',
    );
    expect(
      [for (final body in backend.sent) (body['command'] as Map)['choice']],
      [1, 1],
    );
    expect(r.asks.unconfirmed(decision), isNull);
    expect(r.asks.decisions, isEmpty);
    expect(r.asks.error, isNull);
  });

  test('an answer to a decision answered already reads it back', () async {
    final r = rig(decisions: 1);
    var open = [decisionRow('d1')];
    r.swarm.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
      'decisions': open,
    };
    answers(r.swarm, () => open, () => open = []);
    await r.reader.refresh();
    await settle();
    final decision = r.asks.decisions.single;
    open = []; // Answered on another device meanwhile.

    await r.asks.answer(decision, 0);

    expect(r.asks.decisions, isEmpty);
    expect(r.asks.unconfirmed(decision), isNull);
    expect(r.asks.error, isNull);
  });

  test('done with a tag sends it once, then reads again', () async {
    final r = rig(mentions: 1);
    var waiting = [mentionRow('m1')];
    r.swarm.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
      'mentions': waiting,
    };
    r.swarm.routes['/api/super-tabs/$tab/commands'] = (_) {
      waiting = [];
      return {'result': <String, dynamic>{}};
    };
    await r.reader.refresh();
    await settle();

    expect(await r.asks.done(r.asks.mentions.single), isTrue);

    expect(r.swarm.commands.single, {
      'type': 'mention.done',
      'mentionId': 'm1',
    });
    expect(r.asks.mentions, isEmpty);
  });

  // Mira's run on the owner's iPhone, 2026-10-27: Done on a tag took 10
  // seconds to register, with no sign the tap counted.
  test('Done shows at once, and the tag goes the moment it is confirmed, '
      'before the list is read again', () async {
    final r = rig(mentions: 1);
    r.swarm.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
      'mentions': [mentionRow('m1')],
    };
    await r.reader.refresh();
    await settle();
    final confirmed = Completer<Object?>();
    r.swarm.routes['/api/super-tabs/$tab/commands'] = (_) => confirmed.future;
    final tag = r.asks.mentions.single;

    final done = r.asks.done(tag);
    await settle();
    expect(r.asks.finishing(tag), isTrue);

    // The list the backend reads back still has it for a moment.
    confirmed.complete({'result': <String, dynamic>{}});
    expect(await done, isTrue);

    expect(r.asks.finishing(tag), isFalse);
    expect(r.asks.mentions, isEmpty);
    await r.asks.load();
    expect(r.asks.mentions, isEmpty);
  });

  test(
    'a Done that fails says so on that tag alone, and the tag stays',
    () async {
      final r = rig(decisions: 1, mentions: 1);
      r.swarm.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
        'decisions': [decisionRow('d1')],
      };
      r.swarm.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
        'mentions': [mentionRow('m1')],
      };
      await r.reader.refresh();
      await settle();
      r.swarm.routes['/api/super-tabs/$tab/commands'] = (_) =>
          throw const SuperTabFailure('MACHINE_UNAVAILABLE', 'No computer.');
      final tag = r.asks.mentions.single;

      expect(await r.asks.done(tag), isFalse);

      expect(r.asks.finishing(tag), isFalse);
      expect(r.asks.notDone(tag), 'Not marked done. Try again.');
      expect(r.asks.mentions.single.id, 'm1');
      expect(r.asks.error, isNull, reason: 'the decision shows no error of it');
    },
  );

  test(
    'a new ask that arrives later is news; the ones there at first are not',
    () async {
      final r = rig(decisions: 1);
      var open = [decisionRow('d1')];
      r.swarm.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
        'decisions': open,
      };
      final news = <String>[];
      r.asks.onArrived = (item) => news.add(item.id);
      await r.reader.refresh();
      await settle();
      expect(news, isEmpty);

      open = [decisionRow('d1'), decisionRow('d2', question: 'Name?')];
      r.swarm.routes['/api/super-tabs/$tab/changes'] = (_) => changes(
        cursor: 'c3',
        derived: {'decisionsWaiting': 2, 'mentionsWaiting': 0},
      );
      await r.reader.refresh();
      await settle();

      expect(news, ['d2']);
    },
  );
}

class _Log implements AppLog {
  final errors = <Object?>[];

  @override
  void record(
    AppLogLevel level,
    String category,
    String message, {
    Object? error,
    StackTrace? stackTrace,
  }) => errors.add(error);
}
