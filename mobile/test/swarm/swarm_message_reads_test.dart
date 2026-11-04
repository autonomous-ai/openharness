import 'dart:async';

import 'package:clock/clock.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/swarm_message_link.dart';
import 'package:harness_mobile/swarm/swarm_message_reads.dart';
import 'package:harness_mobile/swarm/swarm_reader.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';

import 'swarm_fixture.dart';

/// One message read by itself, for a quote whose original is not loaded and
/// for a message link's preview: read once, kept in memory, never in a loop,
/// and a refusal reads as gone (the desktop's `quoted` and
/// `AppLinkSwarms.read`).
void main() {
  const path = '/api/super-tabs/$tab/conversations/g1/messages?messageId=m1';
  const link = SwarmMessageLink(
    tabId: tab,
    conversationId: 'g1',
    messageId: 'm1',
  );

  Map<String, dynamic> row(
    String id, {
    String conversationId = 'g1',
    String text = 'The plan',
    Map<String, dynamic>? source,
  }) => {
    'id': id,
    'conversationId': conversationId,
    'text': text,
    'sequence': 1,
    'author': {'kind': 'agent', 'id': 'agent-lead', 'name': 'River'},
    'source': ?source,
    'createdAt': DateTime.utc(2026, 10, 27).toIso8601String(),
  };

  late FakeSwarm fake;
  late SwarmReader reader;
  late SwarmMessageReads reads;
  late int told;
  var now = DateTime.utc(2026, 11, 3, 9);

  setUp(() {
    now = DateTime.utc(2026, 11, 3, 9);
    fake = FakeSwarm();
    reader = SwarmReader(tabId: tab, accountId: me, request: fake.request);
    reads = SwarmMessageReads(kept: 3);
    told = 0;
    reads.addListener(() => told++);
  });

  tearDown(() {
    reads.dispose();
    reader.dispose();
  });

  /// [body] with the clock at [now], which a test moves.
  Future<void> at(Future<void> Function() body) =>
      withClock(Clock(() => now), body);

  /// Lets a read asked for answer.
  Future<void> answered() => Future<void>.delayed(Duration.zero);

  int asked([String of = path]) => fake.paths.where((p) => p == of).length;

  test('a message is read once, then kept within the minute', () async {
    fake.routes[path] = (_) => {
      'messages': [row('m1')],
    };
    await at(() async {
      expect(reads.read(reader, link).state, SwarmReadState.loading);
      expect(reads.read(reader, link).state, SwarmReadState.loading);
      await answered();
      final read = reads.read(reader, link);
      expect(read.state, SwarmReadState.found);
      expect(read.message!.text, 'The plan');
      now = now.add(const Duration(seconds: 59));
      expect(reads.read(reader, link).state, SwarmReadState.found);
      await answered();
    });
    expect(asked(), 1, reason: 'asked once while it was read, kept after');
    expect(told, 1);
  });

  group('a message found', () {
    Future<void> found() async {
      fake.routes[path] = (_) => {
        'messages': [row('m1')],
      };
      reads.read(reader, link);
      await answered();
    }

    test('is asked again a minute later, and shows until answered', () async {
      await at(() async {
        await found();
        now = now.add(const Duration(seconds: 59));
        reads.read(reader, link);
        await answered();
        expect(asked(), 1, reason: 'not within the minute');

        now = now.add(const Duration(seconds: 1));
        fake.routes[path] = (_) => {
          'messages': [row('m1', text: 'Edited')],
        };
        expect(reads.read(reader, link).message?.text, 'The plan');
        await answered();
        expect(asked(), 2);
        expect(reads.read(reader, link).message?.text, 'Edited');
      });
    });

    test('goes once a later read is refused or finds nothing', () async {
      final answers = <Map<String, dynamic> Function(dynamic)>[
        (_) => throw const SuperTabFailure('FORBIDDEN', 'No'),
        (_) => {'messages': <Object>[]},
      ];
      await at(() async {
        for (final answer in answers) {
          await found();
          now = now.add(const Duration(minutes: 1));
          fake.routes[path] = answer;
          reads.read(reader, link);
          await answered();
          expect(reads.read(reader, link).state, SwarmReadState.gone);
          now = now.add(const Duration(minutes: 1));
        }
      });
    });

    test('stays when a later read is not answered', () async {
      await at(() async {
        await found();
        now = now.add(const Duration(minutes: 1));
        fake.routes[path] = (_) => throw const SuperTabFailure('OFFLINE', 'No');
        reads.read(reader, link);
        await answered();
        expect(reads.read(reader, link).message?.text, 'The plan');
      });
    });
  });

  test('none read, or refused, is gone: asked again only a minute later, '
      'gone meanwhile', () async {
    var refuse = false;
    fake.routes[path] = (_) {
      if (refuse) throw const SuperTabFailure('FORBIDDEN', 'No access.');
      return {'messages': <Object>[]};
    };
    await at(() async {
      reads.read(reader, link);
      await answered();
      expect(reads.read(reader, link).state, SwarmReadState.gone);
      now = now.add(const Duration(seconds: 59));
      expect(reads.read(reader, link).state, SwarmReadState.gone);
      await answered();
      expect(asked(), 1);

      refuse = true;
      now = now.add(const Duration(seconds: 2));
      expect(
        reads.read(reader, link).state,
        SwarmReadState.gone,
        reason: 'what was answered shows while it is asked again',
      );
      await answered();
      expect(asked(), 2);
      expect(reads.read(reader, link).state, SwarmReadState.gone);
    });
  });

  test('a read that failed is failed, asked again a minute later, and found '
      'then', () async {
    var down = true;
    fake.routes[path] = (_) {
      if (down) {
        throw const SuperTabFailure('UNAVAILABLE', 'Down.', statusCode: 503);
      }
      return {
        'messages': [row('m1')],
      };
    };
    await at(() async {
      reads.read(reader, link);
      await answered();
      expect(reads.read(reader, link).state, SwarmReadState.failed);
      for (var i = 0; i < 5; i++) {
        reads.read(reader, link);
        await answered();
      }
      expect(asked(), 1, reason: 'drawn again and again, asked once');

      down = false;
      now = now.add(const Duration(minutes: 1));
      expect(reads.read(reader, link).state, SwarmReadState.failed);
      await answered();
      expect(reads.read(reader, link).state, SwarmReadState.found);
      expect(asked(), 2);
    });
  });

  test('anything thrown is failed', () async {
    fake.routes[path] = (_) => throw StateError('offline');
    reads.read(reader, link);
    await answered();
    expect(reads.read(reader, link).state, SwarmReadState.failed);
  });

  test('an answer that is not the message asked for is not taken', () async {
    fake.routes[path] = (_) => {
      'messages': [row('m2'), row('m1')],
    };
    reads.read(reader, link);
    await answered();
    expect(reads.read(reader, link).state, SwarmReadState.failed);

    fake.routes[path] = (_) => {
      'messages': [row('m1', conversationId: 'g2')],
    };
    final other = SwarmMessageReads();
    addTearDown(other.dispose);
    other.read(reader, link);
    await answered();
    expect(other.read(reader, link).state, SwarmReadState.failed);
  });

  test('a waiting notice or an update request is never shown', () async {
    for (final kind in ['delivery-hold', 'update-request']) {
      fake.routes[path] = (_) => {
        'messages': [
          row('m1', source: {'kind': kind}),
        ],
      };
      final once = SwarmMessageReads();
      addTearDown(once.dispose);
      once.read(reader, link);
      await answered();
      expect(once.read(reader, link).state, SwarmReadState.gone, reason: kind);
    }
  });

  test('a reader that lost the Swarm, or of another Swarm, reads nothing', () {
    final elsewhere = SwarmReader(
      tabId: 'tab-2',
      accountId: me,
      request: fake.request,
    );
    addTearDown(elsewhere.dispose);
    expect(reads.read(elsewhere, link).state, SwarmReadState.gone);
    reader.accessRevoked = true;
    expect(reads.read(reader, link).state, SwarmReadState.gone);
    expect(fake.paths, isEmpty);
  });

  test('what a Swarm the reader lost had read is not kept', () async {
    fake.routes[path] = (_) => {
      'messages': [row('m1')],
    };
    reads.read(reader, link);
    await answered();
    expect(reads.read(reader, link).state, SwarmReadState.found);

    reader.accessRevoked = true;
    expect(reads.read(reader, link).state, SwarmReadState.gone);
    reader.accessRevoked = false;
    expect(reads.read(reader, link).state, SwarmReadState.loading);
    await answered();
  });

  test('access read again from nothing reads the message again', () async {
    fake.routes[path] = (_) => {
      'messages': [row('m1')],
    };
    reads.read(reader, link);
    await answered();
    expect(reads.read(reader, link).state, SwarmReadState.found);

    reader.generation++;
    expect(reads.read(reader, link).state, SwarmReadState.loading);
    await answered();
    expect(reads.read(reader, link).state, SwarmReadState.found);
    expect(asked(), 2);
  });

  test(
    'an answer to a read asked before access was read again is dropped',
    () async {
      final answer = Completer<Object?>();
      fake.routes[path] = (_) => answer.future;
      reads.read(reader, link);
      await answered();
      reader.generation++;
      answer.complete({
        'messages': [row('m1')],
      });
      await answered();
      expect(told, 0);
    },
  );

  test('at most [kept] are held: the one asked for longest ago goes first', () async {
    for (final id in ['m1', 'm2', 'm3', 'm4']) {
      fake.routes['/api/super-tabs/$tab/conversations/g1/messages?messageId=$id'] =
          (_) => {
            'messages': [row(id)],
          };
    }
    SwarmMessageLink to(String id) =>
        SwarmMessageLink(tabId: tab, conversationId: 'g1', messageId: id);
    for (final id in ['m1', 'm2', 'm3']) {
      reads.read(reader, to(id));
    }
    await answered();
    // m1 asked for again: m2 is now the oldest.
    expect(reads.read(reader, to('m1')).state, SwarmReadState.found);
    reads.read(reader, to('m4'));
    await answered();
    expect(reads.read(reader, to('m1')).state, SwarmReadState.found);
    expect(reads.read(reader, to('m2')).state, SwarmReadState.loading);
    await answered();
  });

  test('an answer after the session ends tells no one', () async {
    final answer = Completer<Object?>();
    fake.routes[path] = (_) => answer.future;
    final ended = SwarmMessageReads()..addListener(() => told++);
    ended.read(reader, link);
    await answered();
    ended.dispose();
    answer.complete({
      'messages': [row('m1')],
    });
    await answered();
    expect(told, 0);
    expect(ended.read(reader, link).state, SwarmReadState.gone);
  });
}
