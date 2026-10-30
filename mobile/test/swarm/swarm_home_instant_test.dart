import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/local_key_value_store.dart';
import 'package:harness_mobile/logging/app_log.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/parts.dart';
import 'package:harness_mobile/swarm/swarm_home_cache.dart';
import 'package:harness_mobile/swarm/swarm_page.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';
import 'package:harness_mobile/swarm/swarm_start.dart';
import 'package:harness_mobile/swarm/swarm_style.dart';
import 'package:harness_mobile/swarm/swarm_you_page.dart';
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
  /// [readMarks] keeps the phone's marks and Home's choices; by default on
  /// disk, as on the phone. [home] is the screen drawn, Home by default.
  Future<({SwarmHost host, FakeSwarm fake})> coldStart(
    WidgetTester tester, {
    bool keep = true,
    Widget home = const SwarmPage(),
    FakeComputers? computers,
    LocalKeyValueStore? readMarks,
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
      readMarks: readMarks,
    );
    addTearDown(host.dispose);

    await tester.pumpWidget(
      MaterialApp(
        builder: (context, child) => SwarmScope(notifier: host, child: child!),
        home: home,
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
      // Nothing is read, nor anything pumped after: no disk to wait on.
      final (:host, :fake) = await coldStart(
        tester,
        readMarks: MemoryKeyValueStore(),
      );

      expect(key('swarm-projects-loading-$tab'), findsNothing);
      expect(
        find.byKey(const ValueKey('swarm-project-$tab-$project')),
        findsOneWidget,
      );
      expect(find.text('#Mobile'), findsOneWidget);
      expect(
        find.descendant(
          of: key('swarm-project-$tab-$project'),
          matching: find.text('No agents running'),
        ),
        findsOneWidget,
        reason: 'its team, Nova waiting on the person',
      );
      expect(
        [for (final need in host.session!.inbox.needs) need.conversationId],
        ['g1'],
        reason: 'Nova waiting in Fix login, kept for Activity',
      );
      expect(host.session!.inbox.loaded, isFalse, reason: 'nothing read yet');
      expect(fake.paths, ['/api/super-tabs/list']);
    },
  );

  testWidgets(
    'a cold start names the Swarm kept in the title, and its switcher lists '
    'it, with none on their way',
    (tester) async {
      await coldStart(tester);
      expect(tester.widget<Text>(key('swarm-title')).data, 'Phone Swarm');

      await tester.tap(key('swarm-title-button'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 500));

      expect(key('swarm-switch-$tab'), findsOneWidget);
      expect(key('swarm-switch-join'), findsOneWidget);
      expect(find.byType(SwarmSkeletonRows), findsNothing);
    },
  );

  testWidgets('a cold start draws you first on You, in your picture', (
    tester,
  ) async {
    await coldStart(tester, home: const SwarmYouPage());
    for (var i = 0; i < 5; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    final you = key('swarm-you-me');
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

    /// Nothing on Home says what the computers are doing.
    void saysNothing() {
      for (final words in [
        'No computer online',
        'Your computers are offline.',
        'Connecting to your computers…',
        'Showing your last update.',
        'Turn one on and open Harness.',
        'Try again',
        'Looking…',
        'Connect one of your computers to open Swarm.',
      ]) {
        expect(find.text(words), findsNothing, reason: words);
      }
    }

    for (final (name, computer) in [
      ('every computer offline', macAway),
      ('a computer still connecting', mac),
    ]) {
      testWidgets('$name: the Home kept stays, with no card and no line', (
        tester,
      ) async {
        final (:host, fake: _) = await coldStart(
          tester,
          computers: FakeComputers([computer]),
          list: unavailable,
        );

        expect(host.session!.inbox.noComputer, isTrue);
        expect(key('swarm-project-$tab-$project'), findsOneWidget);
        saysNothing();
        stopReads(host);
      });
    }

    testWidgets('nothing kept and every computer offline: Home on its way, '
        'with no card, never a screen in its place', (tester) async {
      final (:host, fake: _) = await coldStart(
        tester,
        keep: false,
        computers: FakeComputers([macAway]),
        list: unavailable,
      );

      expect(key('swarm-projects-loading'), findsOneWidget);
      expect(find.byType(SwarmStartView), findsNothing);
      saysNothing();
      stopReads(host);
    });

    /// A pull on Home, up to the read it starts.
    Future<void> pull(WidgetTester tester) async {
      await tester.fling(
        key('swarm-project-$tab-$project'),
        const Offset(0, 400),
        1000,
      );
      for (var i = 0; i < 10; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }
    }

    testWidgets('a pull looks for the computers, then reads the Swarms', (
      tester,
    ) async {
      var away = true;
      final computers = FakeComputers([macAway])
        ..held = Completer<void>()
        ..found = [mac];
      final (:host, :fake) = await coldStart(
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
      final inbox = host.session!.inbox;
      // The quick reads stopped: only the pull's is counted.
      stopReads(host);
      int lists() =>
          fake.paths.where((p) => p == '/api/super-tabs/list').length;
      final before = lists();

      await pull(tester);
      expect(computers.rechecks, 1);
      expect(lists(), before, reason: 'not before the look ends');

      away = false;
      computers.held!.complete();
      for (var i = 0; i < 10; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }

      expect(lists(), before + 1);
      expect(inbox.noComputer, isFalse);
      expect(key('swarm-project-$tab-$project'), findsOneWidget);
    });

    testWidgets('a look that fails is logged, and the Swarms are read still', (
      tester,
    ) async {
      final log = _Log();
      final logged = appLog;
      appLog = log;
      addTearDown(() => appLog = logged);
      final computers = _BrokenComputers([macAway]);
      final (:host, :fake) = await coldStart(
        tester,
        computers: computers,
        list: unavailable,
      );
      int lists() =>
          fake.paths.where((p) => p == '/api/super-tabs/list').length;
      final before = lists();

      await pull(tester);

      expect(computers.rechecks, 1);
      expect(log.messages, contains('Computers not looked for'));
      expect(lists(), greaterThan(before));
      expect(tester.takeException(), isNull);
      expect(key('swarm-project-$tab-$project'), findsOneWidget);
      stopReads(host);
    });

    testWidgets('with the computers answering, a pull only reads the Swarms', (
      tester,
    ) async {
      final computers = FakeComputers([mac]);
      final (:host, :fake) = await coldStart(
        tester,
        computers: computers,
        list: (_) => {
          'tabs': [
            {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
          ],
          'next': null,
        },
      );
      for (var i = 0; i < 5; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }
      int lists() =>
          fake.paths.where((p) => p == '/api/super-tabs/list').length;
      final before = lists();

      await pull(tester);

      expect(computers.rechecks, 0);
      expect(lists(), greaterThan(before));
      stopReads(host);
    });
  });

  testWidgets(
    'the Home kept says nothing of being read again, before or after',
    (tester) async {
      final answer = Completer<Object?>();
      final (:host, fake: _) = await coldStart(
        tester,
        list: (_) => answer.future,
      );

      expect(key('swarm-project-$tab-$project'), findsOneWidget);
      expect(updating(), findsNothing, reason: 'the kept rows are enough');

      answer.complete({
        'tabs': [
          {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
        ],
        'next': null,
      });
      await tester.pump();
      await tester.pump();
      await tester.pump();

      expect(key('swarm-project-$tab-$project'), findsOneWidget);
      expect(updating(), findsNothing);
      stopReads(host);
    },
  );
  testWidgets("a project opened from the Home kept: its header's team line "
      'counts its humans and agents, before and after its Swarm is read '
      'again, with no Updating…', (tester) async {
    final (:host, :fake) = await coldStart(tester);
    final read = Completer<void>();
    fake.routes['/api/super-tabs/$tab/parts'] = (_) async {
      await read.future;
      return firstLoad();
    };
    await tester.tap(key('swarm-project-$tab-$project'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));

    final line = key('swarm-project-team-line');
    Finder inLine(Finder matching) =>
        find.descendant(of: line, matching: matching);
    // Kept: Nova waiting on the person in Fix login.
    expect(inLine(find.text('Updating…')), findsNothing);
    expect(inLine(find.textContaining('agent')), findsOneWidget);
    expect(
      inLine(find.textContaining('waiting')),
      findsNothing,
      reason: 'the line counts heads, not what they are doing',
    );

    read.complete();
    await tester.pump();
    await tester.pump();
    await tester.pump();

    // Read again: still only the count, whatever the team is doing.
    expect(inLine(find.text('Updating…')), findsNothing);
    expect(inLine(find.textContaining('human')), findsOneWidget);
    expect(inLine(find.textContaining('All idle')), findsNothing);
    stopReads(host);
  });

  testWidgets(
    'a first read of the Swarm that fails leaves the Home kept as it is, '
    'with no line, until a read gets through',
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

      expect(key('swarm-project-$tab-$project'), findsOneWidget);
      expect(updating(), findsNothing);

      fake.routes['/api/super-tabs/$tab/parts'] = (_) => firstLoad();
      await inbox.refresh();
      await tester.pump();
      await tester.pump();

      expect(key('swarm-project-$tab-$project'), findsOneWidget);
      expect(updating(), findsNothing);
      stopReads(host);
    },
  );
}

Finder key(String value) => find.byKey(ValueKey(value));

class _Log implements AppLog {
  final messages = <String>[];

  @override
  void record(
    AppLogLevel level,
    String category,
    String message, {
    Object? error,
    StackTrace? stackTrace,
  }) => messages.add(message);
}

/// Computers a look for them fails on.
class _BrokenComputers extends FakeComputers {
  _BrokenComputers(super.computers);

  @override
  Future<void> recheck() async {
    rechecks++;
    throw StateError('Nothing to look through');
  }
}

/// Harness behind: [host]'s polls, and its quick retries while no computer
/// answers, stop.
void stopReads(SwarmHost host) => host.foreground = false;

/// "Updating…" under Home's title, which is no longer drawn: the tab's, or
/// the top bar's when pushed.
Finder updating() => find.descendant(
  of: find.byWidgetPredicate(
    (widget) => widget is SwarmTabHeader || widget is SwarmTopBar,
  ),
  matching: find.text('Updating…'),
);
