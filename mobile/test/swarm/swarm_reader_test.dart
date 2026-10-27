import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/swarm_reader.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';

import 'swarm_fixture.dart';

/// One Swarm as the phone keeps it current: a first load, then only what
/// changed since (docs/design/2026-10-26-swarm-state-parts.md, section 4).
void main() {
  SwarmReader reader(FakeSwarm swarm) =>
      SwarmReader(tabId: tab, accountId: me, request: swarm.request);

  test('the first read is a first load, and draws the Swarm', () async {
    final swarm = FakeSwarm();
    swarm.routes['/api/super-tabs/$tab/parts'] = (_) =>
        firstLoad(groups: [groupData('g1', title: 'Fix login', number: 7)]);
    final r = reader(swarm);
    addTearDown(r.dispose);

    await r.refresh();

    expect(r.snapshot!.name, 'Phone Swarm');
    expect(r.snapshot!.projects.single.name, 'Mobile');
    expect(r.snapshot!.conversation('g1')!.label, '#7 Fix login');
    expect(r.error, isNull);
  });

  test('later reads ask only what changed since the cursor', () async {
    final swarm = FakeSwarm();
    swarm.routes['/api/super-tabs/$tab/parts'] = (_) => firstLoad(cursor: 'c1');
    swarm.routes['/api/super-tabs/$tab/changes'] = (_) => changes(
      cursor: 'c2',
      groups: [part('g2', 9, groupData('g2', title: 'New work'))],
      lastChangedAt: 200,
    );
    final r = reader(swarm);
    addTearDown(r.dispose);

    await r.refresh();
    await r.refresh();

    expect(swarm.paths, [
      '/api/super-tabs/$tab/parts',
      '/api/super-tabs/$tab/changes?cursor=c1',
    ]);
    expect(r.snapshot!.conversation('g2')!.title, 'New work');
    expect(r.lastChangedAt, 200);

    await r.refresh();
    expect(swarm.paths.last, '/api/super-tabs/$tab/changes?cursor=c2');
  });

  test('a reload answer starts again from a first load', () async {
    var loads = 0;
    final swarm = FakeSwarm();
    swarm.routes['/api/super-tabs/$tab/parts'] = (_) {
      loads++;
      return firstLoad(head: headData(name: loads == 1 ? 'Before' : 'After'));
    };
    swarm.routes['/api/super-tabs/$tab/changes'] = (_) => {'reload': true};
    final r = reader(swarm);
    addTearDown(r.dispose);

    await r.refresh();
    await r.refresh();

    expect(loads, 2);
    expect(r.snapshot!.name, 'After');
  });

  test('a change read refused for access tries a first load', () async {
    var forbidden = false;
    final swarm = FakeSwarm();
    swarm.routes['/api/super-tabs/$tab/parts'] = (_) => forbidden
        ? throw const SuperTabFailure(
            'FORBIDDEN',
            'Not yours.',
            statusCode: 403,
          )
        : firstLoad();
    swarm.routes['/api/super-tabs/$tab/changes'] = (_) =>
        throw const SuperTabFailure('FORBIDDEN', 'Not yours.', statusCode: 403);
    final r = reader(swarm);
    addTearDown(r.dispose);
    await r.refresh();

    forbidden = true;
    await r.refresh();

    expect(swarm.paths.last, '/api/super-tabs/$tab/parts');
    expect(r.accessRevoked, isTrue, reason: 'the first load was refused too');
    expect(
      r.snapshot,
      isNull,
      reason: 'nothing of a Swarm it left stays shown',
    );
  });

  test('a failed read keeps what was shown and says so', () async {
    var down = false;
    final swarm = FakeSwarm();
    swarm.routes['/api/super-tabs/$tab/parts'] = (_) => firstLoad();
    swarm.routes['/api/super-tabs/$tab/changes'] = (_) => down
        ? throw const SuperTabFailure(
            'MACHINE_UNAVAILABLE',
            'Connect one of your computers to open Swarm.',
          )
        : changes(cursor: 'c2');
    final r = reader(swarm);
    addTearDown(r.dispose);
    await r.refresh();

    down = true;
    await r.refresh();

    expect(r.snapshot!.name, 'Phone Swarm');
    expect(r.error, 'Connect one of your computers to open Swarm.');
    expect(r.accessRevoked, isFalse);

    down = false;
    await r.refresh();
    expect(r.error, isNull);
  });

  test(
    'a backend this build cannot read asks for an update and stops',
    () async {
      final swarm = FakeSwarm();
      swarm.routes['/api/super-tabs/$tab/parts'] = (_) =>
          throw const SuperTabFailure(
            'UPDATE_REQUIRED',
            'Update Harness.',
            statusCode: 426,
          );
      final r = reader(swarm);
      addTearDown(r.dispose);

      await r.refresh();
      await r.refresh();

      expect(r.updateRequired, isTrue);
      expect(swarm.calls, hasLength(1), reason: 'no read can succeed now');
    },
  );

  test('another Swarm in the answer is never shown as this one', () async {
    final swarm = FakeSwarm();
    swarm.routes['/api/super-tabs/$tab/parts'] = (_) => {
      ...firstLoad(),
      'head': part('head', 1, {...headData(), 'id': 'tab-other'}),
    };
    final r = reader(swarm);
    addTearDown(r.dispose);

    await r.refresh();

    expect(r.snapshot, isNull);
    expect(r.error, isNotNull);
  });

  test('a read that changes nothing redraws nothing', () async {
    final swarm = FakeSwarm();
    swarm.routes['/api/super-tabs/$tab/parts'] = (_) => firstLoad();
    swarm.routes['/api/super-tabs/$tab/changes'] = (_) => changes(cursor: 'c2');
    final r = reader(swarm);
    addTearDown(r.dispose);
    await r.refresh();
    var redraws = 0;
    r.addListener(() => redraws++);

    await r.refresh();

    expect(redraws, 0);
  });

  test('a closed conversation is read by id when it is opened', () async {
    final swarm = FakeSwarm();
    swarm.routes['/api/super-tabs/$tab/parts'] = (_) => firstLoad();
    swarm.routes['/api/super-tabs/$tab/groups/g-old'] = (_) => {
      'group': part(
        'g-old',
        5,
        groupData('g-old', title: 'Shipped', dormant: true),
      ),
    };
    final r = reader(swarm);
    addTearDown(r.dispose);
    await r.refresh();

    expect(await r.loadConversation('g-old'), isTrue);
    expect(r.snapshot!.conversation('g-old')!.closed, isTrue);
    expect(await r.loadConversation('g-missing'), isFalse);
  });

  test('while shown it reads every poll; hidden, it reads nothing', () {
    fakeAsync((async) {
      final swarm = FakeSwarm();
      swarm.routes['/api/super-tabs/$tab/parts'] = (_) => firstLoad();
      swarm.routes['/api/super-tabs/$tab/changes'] = (_) =>
          changes(cursor: 'c2');
      final r = SwarmReader(
        tabId: tab,
        accountId: me,
        request: swarm.request,
        pollInterval: const Duration(seconds: 5),
      );

      r.shown = true;
      async.flushMicrotasks();
      expect(swarm.calls, hasLength(1), reason: 'shown reads at once');

      async.elapse(const Duration(seconds: 11));
      expect(swarm.calls, hasLength(3));

      r.shown = false;
      async.elapse(const Duration(minutes: 1));
      expect(swarm.calls, hasLength(3));

      r.shown = true;
      async.flushMicrotasks();
      expect(swarm.calls, hasLength(4), reason: 'shown again reads at once');
      r.dispose();
    });
  });
}
