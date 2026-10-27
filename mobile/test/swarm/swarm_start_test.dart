import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/swarm_inbox.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_start.dart';

import 'swarm_fixture.dart';

/// What Swarm shows before there is a Swarm to show, from what the phone
/// already knows: its computers, and what the Swarm list said.
void main() {
  const mac = (name: 'MacBook Pro', away: false);
  const macAway = (name: 'MacBook Pro', away: true);

  /// The account's Swarm list answers [tabs]; its invitations, [invites].
  FakeSwarm backend({
    List<String> tabs = const [],
    List<Map<String, dynamic>> invites = const [],
  }) {
    final fake = FakeSwarm();
    fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        for (final id in tabs) {'id': id, 'name': 'Swarm $id', 'ownerId': me},
      ],
      'next': null,
    };
    for (final id in tabs) {
      fake.routes['/api/super-tabs/$id/parts'] = (_) => firstLoad(tabId: id);
    }
    fake.routes['/api/super-tabs/invitations'] = (_) => invites;
    return fake;
  }

  Map<String, dynamic> invite(String tabId, String name) => {
    'tabId': tabId,
    'name': name,
    'inviteId': 'invite-$tabId',
    'role': 'collaborator',
    'expiresAt': 1893456000000,
  };

  SwarmInbox inbox(FakeSwarm fake) {
    final inbox = SwarmInbox(accountId: me, request: fake.request);
    addTearDown(inbox.dispose);
    return inbox;
  }

  test('an account with no computer at all is asked to connect one', () async {
    final i = inbox(backend());

    expect(swarmStart(i, const []), SwarmStart.noComputer);
  });

  test('a computer list not answered yet says nothing', () async {
    final i = inbox(backend());

    expect(swarmStart(i, null), isNull);
  });

  test(
    'every computer away, before any Swarm was read: no computer online',
    () {
      final i = inbox(backend());

      expect(swarmStart(i, const [macAway]), SwarmStart.offline);
    },
  );

  test(
    'a list that failed for want of a computer: no computer online',
    () async {
      final fake = FakeSwarm();
      fake.routes['/api/super-tabs/list'] = (_) => throw const SuperTabFailure(
        'MACHINE_UNAVAILABLE',
        'Connect one of your computers to open Swarm.',
      );
      final i = inbox(fake);

      await i.refresh();

      expect(swarmStart(i, const [mac]), SwarmStart.offline);
    },
  );

  test('a list that failed otherwise is not "no computer"', () async {
    final fake = FakeSwarm();
    fake.routes['/api/super-tabs/list'] = (_) => throw const SuperTabFailure(
      'SWARM_MIGRATING',
      'This Swarm is being moved. Try again in a moment.',
      statusCode: 503,
    );
    final i = inbox(fake);

    await i.refresh();

    expect(swarmStart(i, const [mac]), isNull);
  });

  test('read once, a computer going away mid-session keeps what was shown, '
      'and says no start screen', () async {
    final i = inbox(backend(tabs: ['a']));
    await i.refresh();

    expect(swarmStart(i, const [macAway]), isNull);
  });

  test('read, with no Swarm and no invitation: no Swarm yet', () async {
    final i = inbox(backend());

    await i.refresh();

    expect(swarmStart(i, const [mac]), SwarmStart.none);
  });

  test('read, with no Swarm but an invitation: invited, to it', () async {
    final i = inbox(backend(invites: [invite('t-lab', 'Design Lab')]));

    await i.refresh();

    expect(swarmStart(i, const [mac]), SwarmStart.invited);
    expect(i.invitations.single.name, 'Design Lab');
  });

  test(
    'a Swarm to show: no start screen, and invitations are not read',
    () async {
      final fake = backend(
        tabs: ['a'],
        invites: [invite('t-lab', 'Design Lab')],
      );
      final i = inbox(fake);

      await i.refresh();

      expect(swarmStart(i, const [mac]), isNull);
      expect(fake.paths, isNot(contains('/api/super-tabs/invitations')));
    },
  );

  test('a server without invitations: no Swarm yet', () async {
    final fake = backend();
    fake.routes.remove('/api/super-tabs/invitations');
    final i = inbox(fake);

    await i.refresh();

    expect(swarmStart(i, const [mac]), SwarmStart.none);
    expect(i.error, isNull);
  });

  test('Join accepts the invitation once, under one receipt, then the Swarm '
      'is read', () async {
    var joined = false;
    final fake = backend(invites: [invite('t-lab', 'Design Lab')]);
    fake.routes['/api/super-tabs/t-lab/commands'] = (_) {
      joined = true;
      return {'result': <String, dynamic>{}};
    };
    fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        if (joined)
          {'id': 't-lab', 'name': 'Design Lab', 'ownerId': 'person-o'},
      ],
      'next': null,
    };
    fake.routes['/api/super-tabs/t-lab/parts'] = (_) =>
        firstLoad(tabId: 't-lab');
    final i = inbox(fake);
    await i.refresh();

    expect(await i.join(i.invitations.single), isTrue);

    expect(fake.commands.single, {
      'type': 'invite.accept',
      'inviteId': 'invite-t-lab',
    });
    expect([for (final s in i.swarms) s.name], ['Design Lab']);
    expect(swarmStart(i, const [mac]), isNull);
  });

  test('a Join whose answer is lost is sent again under the same receipt, '
      'and says why it failed meanwhile', () async {
    final fake = backend(invites: [invite('t-lab', 'Design Lab')]);
    var lost = true;
    fake.routes['/api/super-tabs/t-lab/commands'] = (_) => lost
        ? throw Exception('socket closed')
        : {'result': <String, dynamic>{}};
    final i = inbox(fake);
    await i.refresh();
    final invitation = i.invitations.single;

    expect(await i.join(invitation), isFalse);
    expect(i.joinError, 'Could not join. Try again.');

    lost = false;
    expect(await i.join(invitation), isTrue);
    final receipts = {
      for (final call in fake.calls)
        if (call.method == 'POST') call.body!['operationId'],
    };
    expect(receipts, hasLength(1));
    expect(i.joinError, isNull);
  });
}
