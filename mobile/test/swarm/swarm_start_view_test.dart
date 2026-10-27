import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/phone/tty_controls.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';
import 'package:harness_mobile/swarm/swarm_start.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// The person's computers as a test scripts them.
class FakeComputers extends ChangeNotifier implements SwarmComputers {
  FakeComputers(this.computers);

  @override
  List<SwarmComputer>? computers;

  @override
  bool rechecking = false;

  int rechecks = 0, adds = 0;

  /// Holds a recheck until completed.
  Completer<void>? held;

  /// What a recheck finds.
  List<SwarmComputer>? found;

  void set(List<SwarmComputer>? next) {
    computers = next;
    notifyListeners();
  }

  @override
  Future<void> recheck() async {
    rechecks++;
    rechecking = true;
    notifyListeners();
    await held?.future;
    rechecking = false;
    if (found case final next?) computers = next;
    notifyListeners();
  }

  @override
  void add(BuildContext context) => adds++;
}

/// Swarm Home's body before there is a Swarm to show: one screen per start
/// state, each with one button, over a scripted backend.
void main() {
  const mac = (name: 'MacBook Pro', away: false);
  const macAway = (name: 'MacBook Pro', away: true);
  const miniAway = (name: 'Mac mini', away: true);

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

  /// Swarm Home as Home build A draws it: the start screen in place of its
  /// body while one applies, its own body otherwise.
  Future<({SwarmHost host, SwarmSession session})> pump(
    WidgetTester tester,
    FakeSwarm fake,
    SwarmComputers? computers, {
    bool read = true,
  }) async {
    final features = ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
      ..value = {PhoneExperiment.swarm};
    final account = ValueNotifier<String?>(me);
    final host = SwarmHost(
      accountId: () => account.value,
      account: account,
      request: fake.request,
      notices: SilentSystemNotices(),
      features: features,
      computers: computers,
    )..foreground = false;
    addTearDown(host.dispose);
    final session = host.session!;
    if (read) await session.inbox.refresh();
    await tester.pumpWidget(
      MaterialApp(
        builder: (context, child) => SwarmScope(notifier: host, child: child!),
        home: Scaffold(
          body: Builder(
            builder: (context) => ListenableBuilder(
              listenable: session.inbox,
              builder: (context, _) =>
                  swarmStartView(context, session) ??
                  const Center(child: Text('Your Swarms')),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    return (host: host, session: session);
  }

  Finder primary() => find.byType(TtyPrimaryButton);

  testWidgets('no computer online: the computers, Try again, and how to add '
      'one', (tester) async {
    final fake = backend();
    fake.routes['/api/super-tabs/list'] = (_) => throw const SuperTabFailure(
      'MACHINE_UNAVAILABLE',
      'Connect one of your computers to open Swarm.',
    );
    final computers = FakeComputers([macAway, miniAway]);
    await pump(tester, fake, computers);

    expect(find.text('No computer online'), findsOneWidget);
    expect(
      find.text(
        'Swarm reaches your team through your computers. Turn one on and '
        'open Harness.',
      ),
      findsOneWidget,
    );
    expect(find.text('MacBook Pro'), findsOneWidget);
    expect(find.text('Mac mini'), findsOneWidget);
    expect(find.text('Offline'), findsNWidgets(2));
    expect(primary(), findsOneWidget, reason: 'one button on the screen');
    expect(find.text('Try again'), findsOneWidget);

    await tester.tap(find.text('Add a computer'));
    expect(computers.adds, 1);
  });

  testWidgets('Try again looks for the computers, says so, then reads the '
      'Swarms again', (tester) async {
    final fake = backend(tabs: ['a']);
    var away = true;
    fake.routes['/api/super-tabs/list'] = (_) => away
        ? throw const SuperTabFailure(
            'MACHINE_UNAVAILABLE',
            'Connect one of your computers to open Swarm.',
          )
        : {
            'tabs': [
              {'id': 'a', 'name': 'Swarm a', 'ownerId': me},
            ],
            'next': null,
          };
    final computers = FakeComputers([macAway])
      ..held = Completer<void>()
      ..found = [mac];
    await pump(tester, fake, computers);

    await tester.tap(find.text('Try again'));
    await tester.pump();
    expect(computers.rechecks, 1);
    expect(find.text('Looking for your computers…'), findsOneWidget);
    await tester.tap(find.text('Looking for your computers…'));
    expect(computers.rechecks, 1, reason: 'one look at a time');

    away = false;
    computers.held!.complete();
    await tester.pumpAndSettle();

    expect(find.text('No computer online'), findsNothing);
    expect(find.text('Your Swarms'), findsOneWidget);
  });

  testWidgets('a Try again that finds nothing stays, ready to try again', (
    tester,
  ) async {
    final fake = backend();
    fake.routes['/api/super-tabs/list'] = (_) => throw const SuperTabFailure(
      'MACHINE_UNAVAILABLE',
      'Connect one of your computers to open Swarm.',
    );
    final computers = FakeComputers([macAway]);
    await pump(tester, fake, computers);

    await tester.tap(find.text('Try again'));
    await tester.pumpAndSettle();

    expect(find.text('No computer online'), findsOneWidget);
    expect(find.text('Try again'), findsOneWidget);
  });

  testWidgets('no computer at all: Connect a computer, which opens the steps '
      'to add one', (tester) async {
    final computers = FakeComputers(const []);
    await pump(tester, backend(), computers, read: false);

    expect(find.text('No computer yet'), findsOneWidget);
    expect(primary(), findsOneWidget);
    expect(find.text('Try again'), findsNothing);

    await tester.tap(find.text('Connect a computer'));
    expect(computers.adds, 1);
  });

  testWidgets('no Swarm yet: what a Swarm is, and Show me how', (tester) async {
    await pump(tester, backend(), FakeComputers([mac]));

    expect(find.text('No Swarm yet'), findsOneWidget);
    expect(
      find.text(
        'A Swarm is a team of agents that works on your projects. Start one '
        'on your computer and it shows up here.',
      ),
      findsOneWidget,
    );
    expect(find.text('Invites to your email show up here.'), findsOneWidget);
    expect(primary(), findsOneWidget);

    await tester.tap(find.text('Show me how'));
    await tester.pumpAndSettle();

    expect(find.text('Start a Swarm'), findsOneWidget);
    expect(find.text('Open Harness on your computer.'), findsOneWidget);
    expect(find.text('Press ⌘S.'), findsOneWidget);
    expect(find.text('Name it and add your first project.'), findsOneWidget);
    expect(find.text("It shows up here when it's ready."), findsOneWidget);

    await tester.tap(find.text('Got it'));
    await tester.pumpAndSettle();
    expect(find.text('Start a Swarm'), findsNothing);
    expect(find.text('No Swarm yet'), findsOneWidget);
  });

  testWidgets('invited: the Swarm by name alone, and Join', (tester) async {
    final fake = backend(invites: [invite('t-lab', 'Design Lab')]);
    final accepted = Completer<Object?>();
    var joined = false;
    fake.routes['/api/super-tabs/t-lab/commands'] = (_) async {
      await accepted.future;
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
    await pump(tester, fake, FakeComputers([mac]));

    expect(find.text("You're invited to"), findsOneWidget);
    expect(find.text('Design Lab'), findsOneWidget);
    expect(primary(), findsOneWidget);

    await tester.tap(find.text('Join Design Lab'));
    await tester.pump();
    expect(find.text('Joining…'), findsOneWidget);

    accepted.complete(null);
    await tester.pumpAndSettle();

    expect(fake.commands.single['type'], 'invite.accept');
    expect(find.text('Your Swarms'), findsOneWidget);
  });

  testWidgets('a long Swarm name wraps, and is never cut', (tester) async {
    const name = 'Platform reliability and developer experience';
    await pump(
      tester,
      backend(invites: [invite('t-long', name)]),
      FakeComputers([mac]),
    );

    expect(
      tester.getSize(find.text(name)).height,
      greaterThan(2 * 28),
      reason: 'more than one line of the title',
    );
  });

  testWidgets('a Join that fails says why, and can be tried again', (
    tester,
  ) async {
    final fake = backend(invites: [invite('t-lab', 'Design Lab')]);
    fake.routes['/api/super-tabs/t-lab/commands'] = (_) =>
        throw const SuperTabFailure(
          'INVITE_EXPIRED',
          'This invitation has expired.',
          statusCode: 410,
        );
    await pump(tester, fake, FakeComputers([mac]));

    await tester.tap(find.text('Join Design Lab'));
    await tester.pumpAndSettle();

    expect(find.text('This invitation has expired.'), findsOneWidget);
    expect(find.text('Join Design Lab'), findsOneWidget);
  });

  testWidgets('Not now leaves the invitation for this session: no Swarm yet', (
    tester,
  ) async {
    final fake = backend(invites: [invite('t-lab', 'Design Lab')]);
    final app = await pump(tester, fake, FakeComputers([mac]));

    await tester.tap(find.text('Not now'));
    await tester.pumpAndSettle();

    expect(find.text('No Swarm yet'), findsOneWidget);
    expect(fake.commands, isEmpty, reason: 'nothing declined on the server');

    await app.session.inbox.refresh();
    await tester.pumpAndSettle();
    expect(find.text('No Swarm yet'), findsOneWidget, reason: 'read again');
  });

  testWidgets('a computer coming back takes the start screen away', (
    tester,
  ) async {
    final fake = backend(tabs: ['a']);
    var away = true;
    fake.routes['/api/super-tabs/list'] = (_) => away
        ? throw const SuperTabFailure(
            'MACHINE_UNAVAILABLE',
            'Connect one of your computers to open Swarm.',
          )
        : {
            'tabs': [
              {'id': 'a', 'name': 'Swarm a', 'ownerId': me},
            ],
            'next': null,
          };
    final computers = FakeComputers([macAway]);
    final app = await pump(tester, fake, computers);
    expect(find.text('No computer online'), findsOneWidget);

    away = false;
    computers.set([mac]);
    await app.session.inbox.refresh();
    await tester.pumpAndSettle();

    expect(find.text('No computer online'), findsNothing);
    expect(find.text('Your Swarms'), findsOneWidget);
  });

  group('Swarm turned off', () {
    Future<ExperimentalFeaturesStore> open(WidgetTester tester) async {
      final features = ExperimentalFeaturesStore(
        storage: MemoryKeyValueStore(),
      );
      await tester.pumpWidget(
        MaterialApp(
          home: Builder(
            builder: (context) => TextButton(
              onPressed: () => Navigator.of(context).push(
                MaterialPageRoute<void>(
                  builder: (_) => SwarmIntroPage(features: features),
                ),
              ),
              child: const Text('Settings'),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Settings'));
      await tester.pumpAndSettle();
      return features;
    }

    testWidgets('what Swarm does in three lines, and one button', (
      tester,
    ) async {
      await open(tester);

      expect(find.text('Your team of agents, on your phone'), findsOneWidget);
      expect(find.text('See what needs you'), findsOneWidget);
      expect(find.text('Answer in one tap'), findsOneWidget);
      expect(find.text('Chat with your PM'), findsOneWidget);
      expect(primary(), findsOneWidget);
    });

    testWidgets('Turn on Swarm turns it on and goes back', (tester) async {
      final features = await open(tester);

      await tester.tap(find.text('Turn on Swarm'));
      await tester.pumpAndSettle();

      expect(features.isOn(PhoneExperiment.swarm), isTrue);
      expect(find.text('Your team of agents, on your phone'), findsNothing);
    });

    testWidgets('Not now goes back and leaves it off', (tester) async {
      final features = await open(tester);

      await tester.tap(find.text('Not now'));
      await tester.pumpAndSettle();

      expect(features.isOn(PhoneExperiment.swarm), isFalse);
      expect(find.text('Your team of agents, on your phone'), findsNothing);
    });
  });

  testWidgets('without the computers wired in, Home is as it was', (
    tester,
  ) async {
    await pump(tester, backend(), null);

    expect(find.text('Your Swarms'), findsOneWidget);
  });
}
