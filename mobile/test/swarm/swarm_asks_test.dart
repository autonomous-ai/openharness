import 'package:flutter_test/flutter_test.dart';
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

  test('a Swarm with nothing waiting reads no lists', () async {
    final r = rig();

    await r.reader.refresh();
    await settle();

    expect(r.swarm.paths, ['/api/super-tabs/$tab/parts']);
    expect(r.asks.decisions, isEmpty);
    expect(r.asks.mentions, isEmpty);
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
