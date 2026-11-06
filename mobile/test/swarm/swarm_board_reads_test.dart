import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/swarm_reader.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';

import 'swarm_fixture.dart';

/// The two reads the Board needs beyond the Swarm's state (task #3821): the
/// open Buddy proposals of a project, and its closed conversations back to the
/// Shipped window. Both keep Desktop's bounds (`SuperTabController.readProposals`
/// and `readClosedShipped`), so the phone adds no more load on the backend.
void main() {
  final proposalsPath = '/api/super-tabs/$tab/proposals?projectId=$project';
  final dormant = '/api/super-tabs/$tab/groups?dormant=1&projectId=$project';

  Map<String, dynamic> proposalRow(String id, {int at = 1}) => {
    'messageId': id,
    'title': 'Proposal $id',
    'personId': 'person-ken',
    'priority': 'P2',
    'at': at,
  };

  /// A Swarm whose project chat is at a sequence [move] changes: the next change read says so.
  ({FakeSwarm swarm, SwarmReader reader, void Function(int) move}) rig() {
    final swarm = FakeSwarm();
    var sequence = 3;
    Map<String, dynamic> lead() => part(
      leadChat,
      9 + sequence,
      groupData(
        leadChat,
        title: 'Mobile',
        agentIds: ['agent-lead'],
        leadId: 'agent-lead',
        lastMessageSequence: sequence,
      ),
    );
    swarm.routes['/api/super-tabs/$tab/parts'] = (_) {
      final load = firstLoad();
      (load['groups'] as List)[0] = lead();
      return load;
    };
    swarm.routes['/api/super-tabs/$tab/changes'] = (_) =>
        changes(cursor: 'c2', groups: [lead()]);
    final reader = SwarmReader(
      tabId: tab,
      accountId: me,
      request: swarm.request,
    );
    addTearDown(reader.dispose);
    return (swarm: swarm, reader: reader, move: (n) => sequence = n);
  }

  int proposalReads(FakeSwarm swarm) =>
      swarm.paths.where((p) => p == proposalsPath).length;

  group('proposals', () {
    test(
      'a read asks the project\'s proposals and holds them, oldest as sent',
      () async {
        final r = rig();
        r.swarm.routes[proposalsPath] = (_) => {
          'proposals': [proposalRow('m1'), proposalRow('m2', at: 5)],
        };
        await r.reader.refresh();
        var told = 0;
        r.reader.addListener(() => told++);

        await r.reader.readProposals(project);

        expect(r.reader.proposalsOf(project).map((p) => p.messageId), [
          'm1',
          'm2',
        ]);
        expect(r.reader.proposalsOf(project).first.title, 'Proposal m1');
        expect(r.reader.proposalsFailed(project), isFalse);
        expect(told, 1);
        expect(r.reader.proposalsOf('another'), isEmpty);
      },
    );

    test('nothing is asked again until the project chat has moved', () async {
      final r = rig();
      r.swarm.routes[proposalsPath] = (_) => {'proposals': <Object>[]};
      await r.reader.refresh();

      await r.reader.readProposals(project);
      await r.reader.readProposals(project);
      await r.reader.refresh();
      await r.reader.readProposals(project);

      expect(proposalReads(r.swarm), 1);
    });

    test('a move of the chat inside the minute is read once, when the minute is up', () {
      fakeAsync((async) {
        final r = rig();
        r.swarm.routes[proposalsPath] = (_) => {
          'proposals': [proposalRow('m1')],
        };
        r.reader.refresh();
        async.flushMicrotasks();
        r.reader.readProposals(project);
        async.flushMicrotasks();
        expect(proposalReads(r.swarm), 1);

        r.move(8);
        r.reader.refresh();
        async.flushMicrotasks();
        r.reader.readProposals(project);
        r.reader.readProposals(project);
        async.flushMicrotasks();
        expect(proposalReads(r.swarm), 1, reason: 'inside the minute');

        async.elapse(const Duration(seconds: 59));
        expect(proposalReads(r.swarm), 1);
        async.elapse(const Duration(seconds: 2));
        expect(proposalReads(r.swarm), 2, reason: 'one read for the moves');
      });
    });

    test('a failed read keeps what was shown, is flagged, and is read again when the chat moves', () {
      fakeAsync((async) {
        final r = rig();
        var fail = false;
        r.swarm.routes[proposalsPath] = (_) => fail
            ? throw SuperTabFailure('INTERNAL', 'Oops', statusCode: 500)
            : {
                'proposals': [proposalRow('m1')],
              };
        void read() {
          r.reader.refresh();
          async.flushMicrotasks();
          r.reader.readProposals(project);
          async.flushMicrotasks();
        }

        read();
        fail = true;
        async.elapse(const Duration(minutes: 2));
        r.move(8);
        read();

        expect(r.reader.proposalsOf(project).map((p) => p.messageId), ['m1']);
        expect(r.reader.proposalsFailed(project), isTrue);

        fail = false;
        async.elapse(const Duration(minutes: 2));
        r.move(9);
        read();
        expect(r.reader.proposalsFailed(project), isFalse);
      });
    });
  });

  group('closed work for Merged and Shipped', () {
    final since = DateTime.fromMillisecondsSinceEpoch(1000);

    Map<String, dynamic> closed(String id, int changedAt) => {
      'key': id,
      'version': changedAt,
      'changedAt': changedAt,
      'data': groupData(id, title: id, dormant: true),
    };

    test('pages are read until one ends before the window', () async {
      final r = rig();
      r.swarm.routes[dormant] = (_) => {
        'groups': [closed('a', 3000), closed('b', 2000)],
        'next': 'p2',
      };
      r.swarm.routes['$dormant&before=p2'] = (_) => {
        'groups': [closed('c', 1500), closed('d', 900)],
        'next': 'p3',
      };
      r.swarm.routes['$dormant&before=p3'] = (_) => {
        'groups': [closed('e', 100)],
        'next': null,
      };
      await r.reader.refresh();

      await r.reader.loadShipped(project, since);

      expect(r.swarm.paths.where((p) => p.startsWith(dormant)), [
        dormant,
        '$dormant&before=p2',
      ]);
      expect(r.reader.snapshot!.conversation('a'), isNotNull);
      expect(r.reader.snapshot!.conversation('d'), isNotNull);
      expect(r.reader.snapshot!.conversation('e'), isNull);
      expect(r.reader.shippedFailed(project), isFalse);
    });

    test(
      'a project with one page reads one, and a second call reads nothing',
      () async {
        final r = rig();
        r.swarm.routes[dormant] = (_) => {
          'groups': [closed('a', 3000)],
          'next': null,
        };
        await r.reader.refresh();

        await r.reader.loadShipped(project, since);
        await r.reader.loadShipped(project, since);

        expect(r.swarm.paths.where((p) => p.startsWith(dormant)), [dormant]);
      },
    );

    test('reading stops at 40 pages', () async {
      final r = rig();
      var page = 0;
      r.swarm.routes[dormant] = (_) => {
        'groups': [closed('g${page++}', 5000)],
        'next': 'p$page',
      };
      await r.reader.refresh();

      await r.reader.loadShipped(project, since);

      expect(r.swarm.paths.where((p) => p.startsWith(dormant)).length, 40);
    });

    test('a failed page is flagged, kept apart from the open work, and read again on the next call', () async {
      final r = rig();
      var fail = true;
      r.swarm.routes[dormant] = (_) => fail
          ? throw SuperTabFailure('INTERNAL', 'Oops', statusCode: 500)
          : {
              'groups': [closed('a', 3000)],
              'next': null,
            };
      await r.reader.refresh();

      await r.reader.loadShipped(project, since);
      expect(r.reader.shippedFailed(project), isTrue);
      expect(r.reader.snapshot!.conversation(leadChat), isNotNull);

      fail = false;
      await r.reader.loadShipped(project, since);
      expect(r.reader.shippedFailed(project), isFalse);
      expect(r.reader.snapshot!.conversation('a'), isNotNull);
    });
  });
}
