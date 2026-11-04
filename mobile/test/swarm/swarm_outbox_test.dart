import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/swarm_outbox.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';

/// The person's posts on their way, each on its own (Dee, 11-01: a second
/// post never waits on the first, as in Slack).
void main() {
  test('names a sent message as the backend does', () {
    // Worked out with the backend's stableId (model.ts): sha256 over
    // JSON ["tab-1","person:acct-1","op-1"], first 24 hex.
    expect(
      superTabMessageId(
        tabId: 'tab-1',
        accountId: 'acct-1',
        operationId: 'op-1',
      ),
      '6834802bed07d0983ab744fd',
    );
  });

  SuperTabMessage row(String id) => SuperTabMessage.fromJson({
    'id': id,
    'conversationId': 'g1',
    'text': 'hi',
    'sequence': 1,
    'author': {'kind': 'person', 'id': 'acct-1', 'name': 'me'},
    'createdAt': '2026-11-01T04:12:00.000Z',
  });

  ({SwarmOutbox box, List<Completer<Object?>> answers, List<SwarmPost> taken})
  rig({Duration timeout = SwarmOutbox.defaultTimeout}) {
    final answers = <Completer<Object?>>[];
    final taken = <SwarmPost>[];
    final box = SwarmOutbox(
      request: (method, path, {body}) {
        final answer = Completer<Object?>();
        answers.add(answer);
        return answer.future;
      },
      path: '/commands',
      timeout: timeout,
      onChanged: () {},
      onTaken: taken.add,
      onRefused: (_) {},
    );
    addTearDown(box.close);
    return (box: box, answers: answers, taken: taken);
  }

  SwarmPost post(String operationId) => SwarmPost(
    body: {
      'operationId': operationId,
      'command': {'type': 'message.send', 'text': 'hi'},
    },
    messageId: 'id-$operationId',
  );

  test('a late failure of an earlier try never undoes the retry under way, '
      'and the post is told taken once', () async {
    final r = rig(timeout: const Duration(milliseconds: 10));
    final p = post('op-1');
    expect(await r.box.add(p), SwarmPostOutcome.lost);
    final again = r.box.deliver(p);
    expect(p.state, SwarmPostState.sending);

    r.answers[0].completeError(StateError('reset'));
    // A runner slower than the send timeout.
    await Future<void>.delayed(const Duration(milliseconds: 30));
    expect(p.state, SwarmPostState.sending, reason: 'the retry speaks now');

    r.answers[1].complete({'result': <String, dynamic>{}});
    expect(await again, SwarmPostOutcome.taken);
    expect(p.state, SwarmPostState.confirmed);
    expect(r.taken, [p]);
  });

  test('read back before its answer, it leaves, and its answer still tells '
      'it taken once', () async {
    final r = rig();
    final p = post('op-1');
    final going = r.box.add(p);

    expect(r.box.settle([row('id-op-1')]), isTrue);
    expect(r.box.posts, isEmpty);
    r.answers.single.complete({'result': <String, dynamic>{}});

    expect(await going, SwarmPostOutcome.taken);
    expect(r.taken, [p]);
  });

  test(
    'cleared (access lost) while on its way, its answer tells no one',
    () async {
      final r = rig();
      final p = post('op-1');
      final going = r.box.add(p);

      r.box.clear();
      r.answers.single.complete({'result': <String, dynamic>{}});

      expect(await going, SwarmPostOutcome.gone);
      expect(r.taken, isEmpty);
      expect(r.box.posts, isEmpty);
    },
  );

  test('a refusal takes it out; a rate limit leaves it to retry', () async {
    final r = rig();
    final refused = post('op-1'), limited = post('op-2');
    final a = r.box.add(refused), b = r.box.add(limited);

    r.answers[0].completeError(
      const SuperTabFailure('ARCHIVED', 'Archived.', statusCode: 409),
    );
    r.answers[1].completeError(
      const SuperTabFailure('RATE_LIMITED', 'Slow down.', statusCode: 429),
    );

    expect(await a, SwarmPostOutcome.refused);
    expect(refused.refusedBy?.code, 'ARCHIVED');
    expect(await b, SwarmPostOutcome.lost);
    expect(r.box.posts, [limited]);
    expect(r.box.unconfirmed, limited);
  });
}
