import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/parts.dart';
import 'package:harness_mobile/swarm/swarm_home_cache.dart';
import 'package:harness_mobile/swarm/swarm_page.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';
import 'package:harness_mobile/swarm/swarm_style.dart';
import 'package:harness_mobile/swarm/waiting_work.dart';

import '../voice_fakes.dart';
import 'swarm_computers_fake.dart';
import 'swarm_fixture.dart';

/// A cold start draws the last Home at once, before any computer answers
/// (owner, 2026-10-27: 4 to 5 seconds of "Reading your Swarms…" on the
/// iPhone 14), then reads.
void main() {
  /// The Home kept: project Mobile, its Product Manager River, Nova waiting
  /// on the person in Fix login.
  SwarmHomeEntry kept() {
    final state = SuperTabParts.firstLoad({
      ...firstLoad(
        groups: [
          {
            ...groupData(
              'g1',
              title: 'Fix login',
              number: 4,
              agentIds: ['agent-builder'],
              status: 'needs_human',
            ),
            'partnerId': me,
          },
        ],
      ),
      'members': [
        part(me, 1, {
          ...person(me),
          'avatar': {'kind': 'preset', 'key': 'fox'},
        }),
      ],
    }).state;
    return (
      id: tab,
      name: 'Phone Swarm',
      view: swarmHomeSwarm(
        SuperTabSnapshot.fromJson(state),
        swarmPartners(state),
      ),
    );
  }

  /// A cold start over the Home kept (none when [keep] is false), with the
  /// account's [computers]. Unless [list] answers it, no computer answers:
  /// the list never comes back. Pumped until the kept view is read off disk.
  Future<({SwarmHost host, FakeSwarm fake})> coldStart(
    WidgetTester tester, {
    bool keep = true,
    FakeComputers? computers,
    FutureOr<Object?> Function(Map<String, dynamic>? body)? list,
  }) async {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    final cache = memoryHomeCache();
    if (keep) await tester.runAsync(() => cache.write(me, [kept()]));
    final fake = FakeSwarm();
    fake.routes['/api/super-tabs/list'] =
        list ?? (_) => Completer<Object?>().future;
    fake.routes['/api/super-tabs/$tab/parts'] = (_) => firstLoad();
    final account = ValueNotifier<String?>(me);
    final host = SwarmHost(
      accountId: () => account.value,
      account: account,
      request: fake.request,
      notices: SilentSystemNotices(),
      features: ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
        ..value = {PhoneExperiment.swarm},
      computers: computers,
      homeCache: cache,
    );
    addTearDown(host.dispose);

    await tester.pumpWidget(
      MaterialApp(
        builder: (context, child) => SwarmScope(notifier: host, child: child!),
        home: const SwarmPage(),
      ),
    );
    // The kept view is read off disk: real time, then a frame, until it is.
    for (
      var i = 0;
      i < 100 && keep && host.session!.inbox.swarms.isEmpty;
      i++
    ) {
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 10)),
      );
      await tester.pump();
    }

    await tester.pump();
    return (host: host, fake: fake);
  }

  testWidgets(
    'a cold start draws the Home kept before the first read answers',
    (tester) async {
      final (:host, :fake) = await coldStart(tester);

      expect(key('swarm-projects-loading-$tab'), findsNothing);
      expect(
        find.byKey(const ValueKey('swarm-project-$tab-$project')),
        findsOneWidget,
      );
      expect(find.text('Mobile'), findsWidgets);
      expect(
        find.byKey(const ValueKey('swarm-home-buddy-$tab-$project')),
        findsOneWidget,
        reason: 'its Buddies',
      );
      expect(find.textContaining('Fix login'), findsOneWidget);
      expect(host.session!.inbox.loaded, isFalse, reason: 'nothing read yet');
      expect(fake.paths, ['/api/super-tabs/list']);
    },
  );

  testWidgets(
    'a cold start lists the projects kept in the drawer, with none on their '
    'way',
    (tester) async {
      await coldStart(tester);

      await tester.tap(key('swarm-menu'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 500));

      expect(key('swarm-drawer-project-$tab-$project'), findsOneWidget);
      expect(key('swarm-drawer-loading'), findsNothing);
    },
  );

  testWidgets('a cold start draws you first in the menu, in your picture', (
    tester,
  ) async {
    await coldStart(tester);
    await tester.tap(key('swarm-menu'));
    for (var i = 0; i < 5; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    final you = key('swarm-drawer-you-$tab');
    expect(find.descendant(of: you, matching: find.text('🦊')), findsOneWidget);
    // The kept view holds no email: no name to give, so You.
    expect(
      find.descendant(of: you, matching: find.text('You')),
      findsOneWidget,
    );
  });

  group('no computer answering', () {
    const mac = (name: 'MacBook Pro', away: false);
    const macAway = (name: 'MacBook Pro', away: true);

    Object? unavailable(Map<String, dynamic>? _) => throw const SuperTabFailure(
      'MACHINE_UNAVAILABLE',
      'Connect one of your computers to open Swarm.',
    );

    testWidgets(
      'every computer offline: the Home kept stays, with a line that says '
      'so, never a screen in its place',
      (tester) async {
        final (:host, fake: _) = await coldStart(
          tester,
          computers: FakeComputers([macAway]),
          list: unavailable,
        );

        expect(find.text('No computer online'), findsNothing);
        expect(
          find.byKey(const ValueKey('swarm-project-$tab-$project')),
          findsOneWidget,
        );
        final notice = key('swarm-connection');
        expect(
          find.descendant(
            of: notice,
            matching: find.text('Your computers are offline.'),
          ),
          findsOneWidget,
        );
        expect(
          find.descendant(
            of: notice,
            matching: find.text('Showing your last update.'),
          ),
          findsOneWidget,
        );
        expect(
          find.descendant(of: notice, matching: find.text('Try again')),
          findsOneWidget,
        );
        expect(
          find.text('Connect one of your computers to open Swarm.'),
          findsNothing,
          reason: 'the notice says it, not a red line besides',
        );
        stopReads(host);
      },
    );

    testWidgets(
      'a computer still connecting: the Home kept stays, and the line says '
      'it is connecting',
      (tester) async {
        final (:host, fake: _) = await coldStart(
          tester,
          computers: FakeComputers([mac]),
          list: unavailable,
        );

        expect(find.text('No computer online'), findsNothing);
        expect(
          find.byKey(const ValueKey('swarm-project-$tab-$project')),
          findsOneWidget,
        );
        expect(
          find.descendant(
            of: key('swarm-connection'),
            matching: find.text('Connecting to your computers…'),
          ),
          findsOneWidget,
        );
        stopReads(host);
      },
    );

    testWidgets(
      'nothing kept and every computer offline: Home on its way, with the '
      'line, never a screen in its place',
      (tester) async {
        final (:host, fake: _) = await coldStart(
          tester,
          keep: false,
          computers: FakeComputers([macAway]),
          list: unavailable,
        );

        expect(find.text('No computer online'), findsNothing);
        expect(key('swarm-projects-loading'), findsOneWidget);
        expect(
          find.descendant(
            of: key('swarm-connection'),
            matching: find.text('Your computers are offline.'),
          ),
          findsOneWidget,
        );
        expect(
          find.descendant(
            of: key('swarm-connection'),
            matching: find.text('Turn one on and open Harness.'),
          ),
          findsOneWidget,
        );
        stopReads(host);
      },
    );

    testWidgets(
      'Try again looks for the computers, says so, then reads the Swarms; '
      'once they answer the line goes',
      (tester) async {
        var away = true;
        final computers = FakeComputers([macAway])
          ..held = Completer<void>()
          ..found = [mac];
        final (:host, fake: _) = await coldStart(
          tester,
          computers: computers,
          list: (_) => away
              ? unavailable(null)
              : {
                  'tabs': [
                    {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
                  ],
                  'next': null,
                },
        );

        await tester.tap(
          find.descendant(
            of: key('swarm-connection'),
            matching: find.text('Try again'),
          ),
        );
        await tester.pump();
        expect(computers.rechecks, 1);
        expect(find.text('Looking…'), findsOneWidget);

        away = false;
        computers.held!.complete();
        await tester.pump();
        await tester.pump();
        await tester.pump();

        expect(key('swarm-connection'), findsNothing);
        expect(
          find.byKey(const ValueKey('swarm-project-$tab-$project')),
          findsOneWidget,
        );
        stopReads(host);
      },
    );

    testWidgets('a Try again that finds nothing keeps the line, ready to try '
        'again', (tester) async {
      final computers = FakeComputers([macAway]);
      final (:host, fake: _) = await coldStart(
        tester,
        computers: computers,
        list: unavailable,
      );

      await tester.tap(
        find.descendant(
          of: key('swarm-connection'),
          matching: find.text('Try again'),
        ),
      );
      await tester.pump();
      await tester.pump();

      expect(computers.rechecks, 1);
      expect(
        find.descendant(
          of: key('swarm-connection'),
          matching: find.text('Try again'),
        ),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('swarm-project-$tab-$project')),
        findsOneWidget,
      );
      stopReads(host);
    });
  });

  testWidgets(
    'the Home kept says it is updating until its Swarm is read again',
    (tester) async {
      final answer = Completer<Object?>();
      final (:host, fake: _) = await coldStart(
        tester,
        list: (_) => answer.future,
      );

      expect(updating(), findsOneWidget, reason: 'under the title, quiet');
      expect(key('swarm-connection'), findsNothing);

      answer.complete({
        'tabs': [
          {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
        ],
        'next': null,
      });
      await tester.pump();
      await tester.pump();
      await tester.pump();

      expect(updating(), findsNothing);
      stopReads(host);
    },
  );
  testWidgets(
    'the Home kept hides its team counts until its Swarm is read again: '
    'counts kept are not now',
    (tester) async {
      final answer = Completer<Object?>();
      final (:host, fake: _) = await coldStart(
        tester,
        list: (_) => answer.future,
      );
      final row = key('swarm-project-$tab-$project');
      Finder inRow(String text) =>
          find.descendant(of: row, matching: find.text(text));

      // Kept: Nova waiting on the person in Fix login.
      expect(inRow('Updating…'), findsOneWidget);
      expect(
        find.descendant(of: row, matching: find.textContaining('waiting')),
        findsNothing,
      );

      answer.complete({
        'tabs': [
          {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
        ],
        'next': null,
      });
      await tester.pump();
      await tester.pump();
      await tester.pump();

      // Read again: nobody holds work.
      expect(inRow('All idle'), findsOneWidget);
      expect(inRow('Updating…'), findsNothing);
      stopReads(host);
    },
  );

  testWidgets("a project opened from the Home kept: its menu's status reads "
      'Updating… until its Swarm is read again', (tester) async {
    final (:host, :fake) = await coldStart(tester);
    final read = Completer<void>();
    fake.routes['/api/super-tabs/$tab/parts'] = (_) async {
      await read.future;
      return firstLoad();
    };
    await tester.tap(key('swarm-project-$tab-$project'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));
    await tester.tap(key('swarm-project-menu'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));

    final line = key('swarm-project-menu-status');
    Finder inLine(Finder matching) =>
        find.descendant(of: line, matching: matching);
    // Kept: Nova waiting on the person in Fix login.
    expect(inLine(find.text('Updating…')), findsOneWidget);
    expect(
      inLine(find.textContaining('waiting')),
      findsNothing,
      reason: 'neither the team nor what waits on the person is now',
    );

    read.complete();
    await tester.pump();
    await tester.pump();
    await tester.pump();

    // Read again: nobody holds work.
    expect(inLine(find.text('Updating…')), findsNothing);
    expect(inLine(find.text('All idle')), findsOneWidget);
    stopReads(host);
  });

  testWidgets('the drawer hides the team counts kept too', (tester) async {
    await coldStart(tester);

    await tester.tap(key('swarm-menu'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));

    final row = key('swarm-drawer-project-$tab-$project');
    expect(
      find.descendant(of: row, matching: find.text('Updating…')),
      findsOneWidget,
    );
    expect(
      find.descendant(of: row, matching: find.textContaining('waiting')),
      findsNothing,
    );
  });

  testWidgets(
    'a first read of the Swarm that fails keeps the counts kept hidden, on '
    'Home and in the drawer, until a read gets through',
    (tester) async {
      final answer = Completer<Object?>();
      final (:host, :fake) = await coldStart(
        tester,
        list: (_) => answer.future,
      );
      fake.routes['/api/super-tabs/$tab/parts'] = (_) =>
          throw const SuperTabFailure('TIMEOUT', 'The Swarm did not answer.');
      answer.complete({
        'tabs': [
          {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
        ],
        'next': null,
      });
      await tester.pump();
      await tester.pump();
      await tester.pump();
      final inbox = host.session!.inbox;
      expect(inbox.loaded, isTrue);
      expect(inbox.reader(tab)!.error, isNotNull, reason: 'the read failed');

      final home = key('swarm-project-$tab-$project');
      final drawer = key('swarm-drawer-project-$tab-$project');
      void hidden() {
        for (final row in [home, drawer]) {
          expect(
            find.descendant(of: row, matching: find.text('Updating…')),
            findsOneWidget,
          );
          expect(
            find.descendant(of: row, matching: find.textContaining('waiting')),
            findsNothing,
          );
        }
        expect(updating(), findsOneWidget);
      }

      await tester.tap(key('swarm-menu'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 500));
      hidden();

      fake.routes['/api/super-tabs/$tab/parts'] = (_) => firstLoad();
      await inbox.refresh();
      await tester.pump();
      await tester.pump();

      for (final row in [home, drawer]) {
        expect(
          find.descendant(of: row, matching: find.text('All idle')),
          findsOneWidget,
        );
      }
      expect(updating(), findsNothing);
      stopReads(host);
    },
  );
}

Finder key(String value) => find.byKey(ValueKey(value));

/// Harness behind: [host]'s polls, and its quick retries while no computer
/// answers, stop.
void stopReads(SwarmHost host) => host.foreground = false;

/// Home's quiet "Updating…" under its title.
Finder updating() => find.descendant(
  of: find.byType(SwarmTopBar),
  matching: find.text('Updating…'),
);
