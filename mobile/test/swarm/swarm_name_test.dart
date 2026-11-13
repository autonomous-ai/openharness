import 'package:flutter/cupertino.dart' show CupertinoPageRoute;
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/swarm_home_view.dart';
import 'package:harness_mobile/swarm/swarm_inbox.dart';
import 'package:harness_mobile/swarm/swarm_name.dart';
import 'package:harness_mobile/swarm/swarm_page.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// Another person's Personal Swarm, named after them on the phone as on
/// Desktop (#4135, anh Dee, 2026-11-12): a guest sees Dee's as "Dee's Swarm",
/// so "Personal" is only ever the reader's own. Which Swarm is a Personal one
/// the server says (backend #4179: the list's `personalSwarm`, the read's
/// `personal`).
void main() {
  const dee = 'person-dee';
  const deeSwarm = 'swarm-dee';
  const mine = 'swarm-mine';

  /// Dee, who set no name when [named] is false: then their username.
  Map<String, dynamic> deePerson({bool named = true}) => {
    ...person(dee),
    'username': 'dee',
    if (named) 'name': 'Dee',
  };

  /// The reader's Phone Swarm (a team Swarm, theirs), Dee's Personal Swarm
  /// they were invited to, and their own Personal Swarm. [listMarks] false
  /// is a list from before #4179; [headMarks] true marks each Personal one
  /// in its read too. [deeReads] false: Dee's Swarm cannot be read yet.
  /// [deeInTeam]: Dee is in the Phone Swarm too.
  FakeSwarm backend({
    bool listMarks = true,
    bool headMarks = false,
    bool deeReads = true,
    bool deeNamed = true,
    bool deeInTeam = false,
    String role = 'collaborator',
  }) {
    final fake = FakeSwarm();
    fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
        {
          'id': deeSwarm,
          'name': 'Personal',
          'ownerId': dee,
          if (listMarks) 'personalSwarm': true,
        },
        {
          'id': mine,
          'name': 'Personal',
          'ownerId': me,
          if (listMarks) ...{'personal': true, 'personalSwarm': true},
        },
      ],
      'next': null,
    };
    Map<String, dynamic> load(
      String id,
      String name,
      String owner,
      List<Map<String, dynamic>> people, {
      bool personal = false,
    }) => {
      ...firstLoad(
        tabId: id,
        head: {
          ...headData(id: id, name: name, ownerId: owner),
          if (personal && headMarks) 'personal': true,
        },
      ),
      'members': [for (final p in people) part(p['id'] as String, 1, p)],
    };
    fake.routes['/api/super-tabs/$tab/parts'] = (_) => load(
      tab,
      'Phone Swarm',
      me,
      [person(me), if (deeInTeam) deePerson(named: deeNamed)],
    );
    fake.routes['/api/super-tabs/$deeSwarm/parts'] = (_) => deeReads
        ? load(deeSwarm, 'Personal', dee, [
            deePerson(named: deeNamed),
            person(me, role: role),
          ], personal: true)
        : throw const SuperTabFailure('UNAVAILABLE', 'Busy.', statusCode: 503);
    fake.routes['/api/super-tabs/$mine/parts'] = (_) =>
        load(mine, 'Personal', me, [person(me)], personal: true);
    for (final id in [tab, deeSwarm, mine]) {
      fake.routes['/api/super-tabs/$id/changes'] = (_) => changes(cursor: 'c2');
      fake.routes['/api/super-tabs/$id/decisions?state=open'] = (_) => {
        'decisions': <Object>[],
      };
      fake.routes['/api/super-tabs/$id/mentions?state=waiting'] = (_) => {
        'mentions': <Object>[],
      };
    }
    return fake;
  }

  group('swarmShownName', () {
    Future<SwarmInbox> read(FakeSwarm fake) async {
      final inbox = SwarmInbox(accountId: me, request: fake.request);
      addTearDown(inbox.dispose);
      await inbox.refresh();
      return inbox;
    }

    String shown(SwarmInbox inbox, String id) => swarmShownName(
      inbox,
      id,
      inbox.swarms.singleWhere((s) => s.id == id).name,
    );

    test("another person's Personal Swarm is theirs; the reader's own is "
        'Personal; a team Swarm keeps its name', () async {
      final inbox = await read(backend());
      expect(shown(inbox, deeSwarm), "Dee's Swarm");
      expect(shown(inbox, mine), 'Personal');
      expect(shown(inbox, tab), 'Phone Swarm');
      // Shown only: the Swarm is still named Personal.
      expect(
        inbox.swarms.singleWhere((s) => s.id == deeSwarm).name,
        'Personal',
      );
    });

    test('an owner with no name set is named by their username', () async {
      final inbox = await read(backend(deeNamed: false));
      expect(shown(inbox, deeSwarm), "dee's Swarm");
    });

    test('a Swarm the server does not mark keeps its name, even one called '
        'Personal (an older backend)', () async {
      final inbox = await read(backend(listMarks: false));
      expect(shown(inbox, deeSwarm), 'Personal');
      expect(shown(inbox, mine), 'Personal');
    });

    test("the read's mark is enough without the list's", () async {
      final inbox = await read(backend(listMarks: false, headMarks: true));
      expect(shown(inbox, deeSwarm), "Dee's Swarm");
      expect(shown(inbox, mine), 'Personal');
    });

    test('its owner not read yet: plain Swarm, never Personal', () async {
      final inbox = await read(backend(deeReads: false));
      expect(inbox.reader(deeSwarm)?.snapshot, isNull);
      expect(shown(inbox, deeSwarm), 'Swarm');
    });

    test(
      'its owner read in another of the reader\'s Swarms names it',
      () async {
        final inbox = await read(backend(deeReads: false, deeInTeam: true));
        expect(shown(inbox, deeSwarm), "Dee's Swarm");
      },
    );

    test('Home kept for a cold start keeps the mark', () async {
      final inbox = await read(backend(listMarks: false, headMarks: true));
      final kept = swarmHomeSwarm(inbox.reader(deeSwarm)!.snapshot!, const {});
      expect(kept.state['personal'], isTrue);
      expect(SuperTabSnapshot.fromJson(kept.state).personal, isTrue);
      final team = swarmHomeSwarm(inbox.reader(tab)!.snapshot!, const {});
      expect(team.state.containsKey('personal'), isFalse);
    });
  });

  group('on the phone', () {
    late FakeSwarm fake;

    Future<void> pump(
      WidgetTester tester, {
      String role = 'collaborator',
    }) async {
      fake = backend(role: role);
      tester.view.physicalSize = const Size(1170, 2532);
      tester.view.devicePixelRatio = 3;
      addTearDown(tester.view.reset);
      final account = ValueNotifier<String?>(me);
      final host = SwarmHost(
        accountId: () => account.value,
        account: account,
        request: fake.request,
        notices: SilentSystemNotices(),
        features: ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
          ..value = {PhoneExperiment.swarm},
        readMarks: MemoryKeyValueStore(),
      )..foreground = false;
      addTearDown(host.dispose);
      await tester.pumpWidget(
        MaterialApp(
          builder: (context, child) =>
              SwarmScope(notifier: host, child: child!),
          onGenerateRoute: (_) =>
              CupertinoPageRoute<void>(builder: (_) => const SwarmPage()),
        ),
      );
      await tester.pumpAndSettle();
    }

    Finder key(String value) => find.byKey(ValueKey(value));
    Finder inside(String of, String text) =>
        find.descendant(of: key(of), matching: find.text(text));

    Future<void> switcher(WidgetTester tester) async {
      await tester.tap(key('swarm-title-button'));
      await tester.pumpAndSettle();
    }

    testWidgets("Home heads Dee's Personal Swarm as Dee's, the reader's own "
        'as Personal', (tester) async {
      await pump(tester);
      expect(inside('swarm-heading-$deeSwarm', "Dee's Swarm"), findsOneWidget);
      expect(inside('swarm-heading-$mine', 'Personal'), findsOneWidget);
      expect(inside('swarm-heading-$tab', 'Phone Swarm'), findsOneWidget);
    });

    testWidgets("the switcher lists it as Dee's, and Home's title says so "
        'once it is the one shown', (tester) async {
      await pump(tester);
      await switcher(tester);
      expect(inside('swarm-switch-$deeSwarm', "Dee's Swarm"), findsOneWidget);
      expect(inside('swarm-switch-$mine', 'Personal'), findsOneWidget);

      await tester.tap(key('swarm-switch-$deeSwarm'));
      await tester.pumpAndSettle();
      expect(inside('swarm-title-button', "Dee's Swarm"), findsOneWidget);
    });

    testWidgets("its menu is titled Dee's, and Rename Swarm edits its own "
        'name, as Desktop does', (tester) async {
      await pump(tester);
      await switcher(tester);
      await tester.longPress(key('swarm-switch-$deeSwarm'));
      await tester.pumpAndSettle();
      expect(find.text("Dee's Swarm"), findsWidgets);
      await tester.tap(find.text('Rename Swarm'));
      await tester.pumpAndSettle();
      expect(
        tester.widget<TextField>(key('swarm-rename-name')).controller!.text,
        'Personal',
      );
    });
  });
}
