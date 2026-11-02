import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/swarm/swarm_inbox.dart';
import 'package:harness_mobile/swarm/swarm_page.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// A person already in a Swarm is told of a new invitation (Tony's mobile list,
/// task 24): the phone reads them in any Swarm state, slowly while it has a
/// Swarm to show.
void main() {
  const invitations = '/api/super-tabs/invitations';
  Map<String, Object?> invite(String id, String name) => {
    'tabId': 't-$id',
    'name': name,
    'inviteId': id,
    'role': 'collaborator',
  };

  FakeSwarm backend({List<String> tabs = const ['a']}) {
    final fake = FakeSwarm();
    fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        for (final id in tabs) {'id': id, 'name': id, 'ownerId': me},
      ],
      'next': null,
    };
    for (final id in tabs) {
      fake.routes['/api/super-tabs/$id/parts'] = (_) => firstLoad(tabId: id);
    }
    fake.routes[invitations] = (_) => [invite('i1', 'Design Team')];
    return fake;
  }

  int reads(FakeSwarm fake) => fake.paths.where((p) => p == invitations).length;

  late DateTime at;
  SwarmInbox inbox(FakeSwarm fake) {
    final i = SwarmInbox(accountId: me, request: fake.request, now: () => at);
    addTearDown(i.dispose);
    return i;
  }

  setUp(() => at = DateTime.utc(2026, 11, 3, 9));

  test('reads them with a Swarm to show', () async {
    final i = inbox(backend());
    await i.refresh();
    expect(i.invitations.single.name, 'Design Team');
  });

  test('with a Swarm, at most every 5 minutes', () async {
    final fake = backend();
    final i = inbox(fake);
    await i.refresh();
    await i.refresh();
    at = at.add(const Duration(minutes: 4, seconds: 59));
    await i.refresh();
    expect(reads(fake), 1);
    at = at.add(const Duration(seconds: 1));
    await i.refresh();
    expect(reads(fake), 2);
  });

  test('with no Swarm, every read of the list, as before', () async {
    final fake = backend(tabs: const []);
    final i = inbox(fake);
    await i.refresh();
    await i.refresh();
    expect(reads(fake), 2);
  });

  test('a pull reads them now', () async {
    final fake = backend();
    final i = inbox(fake);
    await i.refresh();
    await i.refreshAll();
    expect(reads(fake), 2);
  });

  test('a failed read with a Swarm keeps the list and says nothing', () async {
    final fake = backend();
    final i = inbox(fake);
    await i.refresh();
    fake.routes[invitations] = (_) => throw const SuperTabFailure(
      'MACHINE_UNAVAILABLE',
      'No computer.',
      statusCode: 503,
    );
    await i.refreshAll();
    expect(i.invitations.single.name, 'Design Team');
    expect(i.invitationsFailed, isFalse);
    expect(i.noComputer, isFalse);
    expect(i.error, isNull);
  });

  test('joining takes it off the list at once, and it stays off', () async {
    final fake = backend();
    fake.routes['/api/super-tabs/t-i1/commands'] = (_) => <String, Object?>{};
    final i = inbox(fake);
    await i.refresh();
    expect(await i.join(i.invitations.single), isTrue);
    expect(i.invitations, isEmpty);
    expect(reads(fake), 2, reason: 'joining reads them again');
  });

  test('Not now stays hidden after a pull', () async {
    final i = inbox(backend());
    await i.refresh();
    i.notNow(i.invitations.single);
    await i.refreshAll();
    expect(i.invitations, isEmpty);
  });

  group('Home', () {
    Future<SwarmHost> pump(WidgetTester tester, FakeSwarm fake) async {
      tester.view.physicalSize = const Size(1170, 2532);
      tester.view.devicePixelRatio = 3;
      addTearDown(tester.view.reset);
      final features = ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
        ..value = {PhoneExperiment.swarm};
      final account = ValueNotifier<String?>(me);
      final host = SwarmHost(
        accountId: () => account.value,
        account: account,
        request: fake.request,
        notices: SilentSystemNotices(),
        features: features,
        readMarks: MemoryKeyValueStore(),
      )..foreground = false;
      addTearDown(host.dispose);
      await tester.pumpWidget(
        MaterialApp(
          builder: (context, child) =>
              SwarmScope(notifier: host, child: child!),
          home: const SwarmPage(),
        ),
      );
      await tester.pumpAndSettle();
      return host;
    }

    Finder key(String k) => find.byKey(ValueKey(k));

    testWidgets('a person in a Swarm sees a new invitation, one line, and '
        'joins it', (tester) async {
      final fake = backend();
      fake.routes['/api/super-tabs/t-i1/commands'] = (_) {
        fake.routes['/api/super-tabs/list'] = (_) => {
          'tabs': [
            {'id': 'a', 'name': 'a', 'ownerId': me},
            {'id': 't-i1', 'name': 'Design Team', 'ownerId': 'ken'},
          ],
          'next': null,
        };
        fake.routes['/api/super-tabs/t-i1/parts'] = (_) =>
            firstLoad(tabId: 't-i1');
        fake.routes[invitations] = (_) => <Object>[];
        return <String, Object?>{};
      };
      await pump(tester, fake);
      expect(find.text('Invitations'), findsOneWidget);
      final row = key('swarm-invitation-i1');
      expect(
        find.descendant(of: row, matching: find.text('Design Team')),
        findsOneWidget,
      );
      expect(tester.getSize(row).height, lessThan(64), reason: 'one line');
      await tester.tap(key('swarm-invitation-join-i1'));
      await tester.pumpAndSettle();
      expect(fake.commands.last, {'type': 'invite.accept', 'inviteId': 'i1'});
      expect(find.text('Invitations'), findsNothing);
      expect(row, findsNothing);
    });

    testWidgets('Not now hides it, and the section with it', (tester) async {
      final host = await pump(tester, backend());
      await tester.tap(key('swarm-invitation-later-i1'));
      await tester.pumpAndSettle();
      expect(find.text('Invitations'), findsNothing);
      await host.session!.inbox.refreshAll();
      await tester.pumpAndSettle();
      expect(key('swarm-invitation-i1'), findsNothing);
    });

    testWidgets('a join refused says why, and the row stays', (tester) async {
      final fake = backend();
      fake.routes['/api/super-tabs/t-i1/commands'] = (_) =>
          throw const SuperTabFailure(
            'INVITE_EXPIRED',
            'This invitation has expired.',
            statusCode: 409,
          );
      await pump(tester, fake);
      await tester.tap(key('swarm-invitation-join-i1'));
      await tester.pumpAndSettle();
      expect(find.text('This invitation has expired.'), findsOneWidget);
      expect(key('swarm-invitation-i1'), findsOneWidget);
    });

    testWidgets('with none, no section', (tester) async {
      final fake = backend();
      fake.routes[invitations] = (_) => <Object>[];
      await pump(tester, fake);
      expect(find.text('Invitations'), findsNothing);
    });
  });
}
