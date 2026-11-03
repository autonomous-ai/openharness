import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/phone/phone_shell_scope.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart' as grid;
import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';
import 'package:harness_mobile/swarm/swarm_terminal_row.dart';

import '../voice_fakes.dart';
import 'swarm_computers_fake.dart';
import 'swarm_fixture.dart';

/// Open terminal in your Buddy chat's ⋮ (Tony, 11-01): first in the sheet,
/// opening the Buddy's terminal on this phone by Team's rule (its machine
/// linked here and not reported offline), otherwise dimmed with why:
/// Stopped, Offline or Not linked. Never in anyone else's Buddy chat nor for
/// a viewer, and the sheet goes with access or the Buddy.
void main() {
  const chat = 'buddy-me';
  const changesPath = '/api/super-tabs/$tab/changes';

  /// One Swarm where the person has their Buddy chat in Mobile, owned by
  /// [owner], with [buddies] in the Swarm's agents (Wren, the person's own on
  /// mac-1, unless told otherwise).
  FakeSwarm backend({
    String owner = me,
    String role = 'owner',
    List<Map<String, dynamic>>? buddies,
  }) {
    final fake = FakeSwarm();
    fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
      ],
      'next': null,
    };
    final agents =
        buddies ?? [buddyData('agent-wren', owner: owner, displayName: 'Wren')];
    fake.routes['/api/super-tabs/$tab/parts'] = (_) => {
      ...firstLoad(
        groups: [
          buddyChatData(
            chat,
            owner: owner,
            agentIds: [for (final a in agents) a['id'] as String],
          ),
        ],
        agents: [
          agent('agent-lead', name: 'Lead', displayName: 'River'),
          ...agents,
        ],
      ),
      'members': [
        part(me, 1, person(me, role: role)),
        part('person-dee', 1, person('person-dee', role: 'member')),
      ],
    };
    fake.routes[changesPath] = (_) => changes(cursor: 'c2');
    fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
      'decisions': <Object>[],
    };
    fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
      'mentions': <Object>[],
    };
    fake.routes['/api/super-tabs/$tab/conversations/$chat/messages'] = (_) => {
      'messages': <Object>[],
      'next': null,
    };
    return fake;
  }

  /// The phone's machines as the shell sees them: [opens] those it can open
  /// now; every terminal it was asked to open lands in [opened].
  late Set<String> opens;
  late List<(String, String)> opened;
  late FakeComputers computers;

  setUp(() {
    opens = {'mac-1'};
    opened = [];
    computers = FakeComputers(const [])
      ..own = const [(id: 'mac-1', name: 'Tonys-MacBook-Pro', away: false)];
  });

  Future<SwarmHost> pump(WidgetTester tester, FakeSwarm fake) async {
    final account = ValueNotifier<String?>(me);
    final host = SwarmHost(
      accountId: () => account.value,
      account: account,
      request: fake.request,
      upload: refuseSwarmUpload,
      notices: SilentSystemNotices(),
      computers: computers,
      features: ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
        ..value = {PhoneExperiment.swarm},
    )..foreground = false;
    addTearDown(host.dispose);
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        builder: (context, child) => PhoneShellScope(
          onMachineLinked: (_) {},
          onOpenAgent: (machine, agent) => opened.add((machine, agent)),
          canOpenMachine: opens.contains,
          child: SwarmScope(notifier: host, child: child!),
        ),
        home: const SwarmConversationPage(swarmId: tab, conversationId: chat),
      ),
    );
    await tester.pumpAndSettle();
    return host;
  }

  Finder key(String value) => find.byKey(ValueKey(value));

  Future<void> openMenu(WidgetTester tester) async {
    await tester.tap(key('swarm-buddy-menu'));
    await tester.pumpAndSettle();
  }

  /// The word at the end of the Open terminal row, or null with none.
  String? word(WidgetTester tester) {
    for (final w in const ['Stopped', 'Offline', 'Not linked']) {
      if (find.text(w).evaluate().isNotEmpty) return w;
    }
    return null;
  }

  /// Taps Open terminal, then: whether the sheet stayed open.
  Future<bool> tapRow(WidgetTester tester) async {
    await tester.tap(find.text('Open terminal'));
    await tester.pumpAndSettle();
    return find.text('Rename Buddy').evaluate().isNotEmpty;
  }

  void refreshWith(
    FakeSwarm fake,
    SwarmHost host, {
    List<Map<String, dynamic>> agents = const [],
    List<Map<String, dynamic>> members = const [],
  }) {
    fake.routes[changesPath] = (_) => {
      ...changes(cursor: 'c3', lastChangedAt: 200),
      'agents': agents,
      'members': members,
    };
    unawaited(host.session!.inbox.reader(tab)!.refresh());
  }

  Map<String, dynamic> gone(String id) => {
    'key': id,
    'version': 9,
    'changedAt': 200,
    'deleted': true,
  };

  group('each state', () {
    testWidgets('running on a machine this phone opens: first in the sheet, '
        "and opens that Buddy's terminal", (tester) async {
      await pump(tester, backend());
      await openMenu(tester);

      final terminal = tester.getTopLeft(find.text('Open terminal')).dy;
      expect(
        terminal,
        lessThan(tester.getTopLeft(find.text('Rename Buddy')).dy),
        reason: 'above Rename Buddy',
      );
      expect(word(tester), isNull);

      expect(await tapRow(tester), isFalse, reason: 'the sheet closes');
      expect(opened, [('mac-1', 'harness-agent-wren')]);
    });

    testWidgets('no Buddy running: dimmed, Stopped, and a tap does nothing', (
      tester,
    ) async {
      await pump(tester, backend(buddies: const []));
      await openMenu(tester);
      expect(word(tester), 'Stopped');
      expect(await tapRow(tester), isTrue, reason: 'the sheet stays');
      expect(opened, isEmpty);
    });

    testWidgets('a Buddy being stopped: Stopped', (tester) async {
      await pump(
        tester,
        backend(
          buddies: [
            {...buddyData('agent-wren'), 'workDecision': 'stop'},
          ],
        ),
      );
      await openMenu(tester);
      expect(word(tester), 'Stopped');
      expect(await tapRow(tester), isTrue);
      expect(opened, isEmpty);
    });

    testWidgets('its machine linked here but reported offline: Offline', (
      tester,
    ) async {
      opens = {};
      await pump(tester, backend());
      await openMenu(tester);
      expect(word(tester), 'Offline');
      expect(await tapRow(tester), isTrue);
      expect(opened, isEmpty);
    });

    testWidgets('the Swarm says the Buddy is down: Offline, even where the '
        'phone could open the machine', (tester) async {
      await pump(
        tester,
        backend(
          buddies: [
            {...buddyData('agent-wren'), 'downSince': '2026-11-01T07:00:00Z'},
          ],
        ),
      );
      await openMenu(tester);
      expect(word(tester), 'Offline');
      expect(await tapRow(tester), isTrue);
      expect(opened, isEmpty);
    });

    testWidgets('its machine not linked to this phone: Not linked', (
      tester,
    ) async {
      opens = {};
      computers.own = const [];
      await pump(tester, backend());
      await openMenu(tester);
      expect(word(tester), 'Not linked');
      expect(await tapRow(tester), isTrue);
      expect(opened, isEmpty);
    });

    testWidgets('a Team-account machine the phone cannot open: Not linked', (
      tester,
    ) async {
      // A Harness Team account's machine is never among the person's own.
      opens = {};
      computers.own = const [(id: 'mac-2', name: 'Studio', away: false)];
      await pump(tester, backend());
      await openMenu(tester);
      expect(word(tester), 'Not linked');
      expect(opened, isEmpty);
    });

    test('outside the shell nothing opens: Not linked', () {
      expect(
        swarmTerminalBlock(
          SuperTabAgent.fromJson(buddyData('agent-wren')),
          canOpen: null,
          own: const [],
        ),
        'Not linked',
      );
    });
  });

  group('privacy', () {
    testWidgets("someone else's Buddy chat has no ⋮, so no Open terminal", (
      tester,
    ) async {
      await pump(tester, backend(owner: 'person-dee'));
      expect(key('swarm-buddy-menu'), findsNothing);
      expect(find.text('Open terminal'), findsNothing);
    });

    testWidgets('a viewer has no Open terminal', (tester) async {
      await pump(tester, backend(role: 'viewer'));
      expect(key('swarm-buddy-menu'), findsNothing);
      expect(find.text('Open terminal'), findsNothing);
    });

    testWidgets("another person's Buddy in the same chat's project is never "
        'opened from mine', (tester) async {
      await pump(
        tester,
        backend(
          buddies: [
            buddyData('agent-dee', owner: 'person-dee', displayName: 'Juno'),
          ],
        ),
      );
      await openMenu(tester);
      expect(word(tester), 'Stopped');
      expect(await tapRow(tester), isTrue);
      expect(opened, isEmpty);
    });

    testWidgets("my Buddy of another project is not this chat's", (
      tester,
    ) async {
      await pump(
        tester,
        backend(
          buddies: [
            {...buddyData('agent-wren'), 'projectId': 'project-other'},
          ],
        ),
      );
      await openMenu(tester);
      expect(word(tester), 'Stopped');
      expect(await tapRow(tester), isTrue);
      expect(opened, isEmpty);
    });
  });

  group('lifecycle', () {
    testWidgets('access lost with the sheet open closes it', (tester) async {
      final host = await pump(tester, backend());
      await openMenu(tester);
      expect(find.text('Open terminal'), findsOneWidget);

      host.session!.inbox.reader(tab)!.revoke();
      await tester.pumpAndSettle();
      expect(find.text('Open terminal'), findsNothing);
      expect(opened, isEmpty);
    });

    testWidgets('the Buddy removed with the sheet open closes it', (
      tester,
    ) async {
      final fake = backend();
      final host = await pump(tester, fake);
      await openMenu(tester);
      expect(word(tester), isNull);

      refreshWith(fake, host, agents: [gone('agent-wren')]);
      await tester.pumpAndSettle();
      expect(find.text('Open terminal'), findsNothing);
      expect(find.text('Rename Buddy'), findsNothing);
      expect(opened, isEmpty);
    });

    testWidgets('the Buddy stopped elsewhere with the sheet open closes it', (
      tester,
    ) async {
      final fake = backend();
      final host = await pump(tester, fake);
      await openMenu(tester);

      refreshWith(
        fake,
        host,
        agents: [
          part('agent-wren', 9, {
            ...buddyData('agent-wren'),
            'workDecision': 'stop',
          }),
        ],
      );
      await tester.pumpAndSettle();
      expect(find.text('Open terminal'), findsNothing);
    });

    testWidgets('losing write access with the sheet open closes it', (
      tester,
    ) async {
      final fake = backend();
      final host = await pump(tester, fake);
      await openMenu(tester);

      refreshWith(
        fake,
        host,
        members: [part(me, 2, person(me, role: 'viewer'))],
      );
      await tester.pumpAndSettle();
      expect(find.text('Open terminal'), findsNothing);
    });

    testWidgets('a machine the phone lost between the sheet and the tap is '
        'not opened', (tester) async {
      await pump(tester, backend());
      await openMenu(tester);
      expect(word(tester), isNull);

      // The shell's own word changes without telling the sheet.
      opens.clear();
      expect(await tapRow(tester), isFalse);
      expect(opened, isEmpty);
    });

    testWidgets("a Buddy started while the sheet is open: the row follows, "
        'and opens the new one', (tester) async {
      final fake = backend(buddies: const []);
      final host = await pump(tester, fake);
      await openMenu(tester);
      expect(word(tester), 'Stopped');

      refreshWith(
        fake,
        host,
        agents: [part('agent-wren', 2, buddyData('agent-wren'))],
      );
      await tester.pumpAndSettle();
      expect(word(tester), isNull);
      expect(await tapRow(tester), isFalse);
      expect(opened, [('mac-1', 'harness-agent-wren')]);
    });

    testWidgets("the phone's computers answering late, with the sheet open, "
        'enables the row', (tester) async {
      // A first read of the machines that had not answered: nothing linked.
      opens = {};
      computers.own = const [];
      await pump(tester, backend());
      await openMenu(tester);
      expect(word(tester), 'Not linked');

      opens.add('mac-1');
      computers
        ..own = const [(id: 'mac-1', name: 'Tonys-MacBook-Pro', away: false)]
        ..notifyListeners();
      await tester.pumpAndSettle();
      expect(word(tester), isNull);
      expect(await tapRow(tester), isFalse);
      expect(opened, [('mac-1', 'harness-agent-wren')]);
    });

    testWidgets('the machine going offline with the sheet open dims the row', (
      tester,
    ) async {
      await pump(tester, backend());
      await openMenu(tester);
      expect(word(tester), isNull);

      opens.clear();
      computers
        ..own = const [(id: 'mac-1', name: 'Tonys-MacBook-Pro', away: true)]
        ..notifyListeners();
      await tester.pumpAndSettle();
      expect(word(tester), 'Offline');
      expect(await tapRow(tester), isTrue);
      expect(opened, isEmpty);
    });
  });
}
