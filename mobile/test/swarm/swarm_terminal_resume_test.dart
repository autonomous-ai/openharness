import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/phone/phone_shell_scope.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart' as grid;
import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_project_details.dart';
import 'package:harness_mobile/swarm/swarm_project_page.dart';
import 'package:harness_mobile/swarm/swarm_project_tabs.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';
import 'package:harness_mobile/swarm/swarm_terminal_row.dart';

import '../voice_fakes.dart';
import 'swarm_computers_fake.dart';
import 'swarm_fixture.dart';

/// Resume a stopped agent from Swarm (task 36): the desktop's Resume on a
/// Swarm agent's stopped pane, from the Open terminal rows of the Buddy chat's
/// ⋮, the project's ⋮ and the project's details. Stopped work the person's
/// own machine can bring back says "Stopped" and is not dimmed; the tap asks
/// first, names the machine, resumes it, then opens its terminal. Anything
/// else stopped stays dimmed, and nothing resumes on a machine this phone
/// does not open.
void main() {
  const buddyChat = 'buddy-me';
  const changesPath = '/api/super-tabs/$tab/changes';
  const wren = ('mac-1', 'harness-agent-wren');
  const river = ('mac-1', 'harness-agent-lead');

  void commonRoutes(FakeSwarm fake) {
    fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
      ],
      'next': null,
    };
    fake.routes[changesPath] = (_) => changes(cursor: 'c2');
    fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
      'decisions': <Object>[],
    };
    fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
      'mentions': <Object>[],
    };
    for (final chat in [buddyChat, leadChat]) {
      fake.routes['/api/super-tabs/$tab/conversations/$chat/messages'] = (_) =>
          {'messages': <Object>[], 'next': null};
    }
  }

  /// One Swarm where the person has their Buddy chat in Mobile, with Wren,
  /// their own Buddy on mac-1, unless [buddy] says otherwise.
  FakeSwarm buddyBackend({String role = 'owner', Map<String, dynamic>? buddy}) {
    final fake = FakeSwarm();
    commonRoutes(fake);
    final wrenData = buddy ?? buddyData('agent-wren', displayName: 'Wren');
    fake.routes['/api/super-tabs/$tab/parts'] = (_) => {
      ...firstLoad(
        groups: [
          buddyChatData(buddyChat, agentIds: [wrenData['id'] as String]),
        ],
        agents: [
          agent('agent-lead', name: 'Lead', displayName: 'River'),
          wrenData,
        ],
      ),
      'members': [part(me, 1, person(me, role: role))],
    };
    return fake;
  }

  /// Mobile's project chat, whose PM is River on mac-1 unless [pm] says
  /// otherwise.
  FakeSwarm projectBackend({Map<String, dynamic>? pm}) {
    final fake = FakeSwarm();
    commonRoutes(fake);
    fake.routes['/api/super-tabs/$tab/parts'] = (_) => firstLoad(
      agents: [pm ?? agent('agent-lead', name: 'Lead', displayName: 'River')],
    );
    return fake;
  }

  /// The phone's machines as the shell sees them: [opens] those it can open
  /// now; [stoppedOn] each session its machines list as stopped (true: a
  /// resume can bring it back); every terminal it was asked to open lands in
  /// [opened], every resume asked for in [resumed]. A resume answers
  /// [resumeError] (null: back, and no longer stopped), or waits for [held].
  late Set<String> opens;
  late Map<(String, String), bool> stoppedOn;
  late List<(String, String)> opened;
  late List<(String, String)> resumed;
  late FakeComputers computers;
  String? resumeError;
  Completer<String?>? held;
  late bool canResume;

  setUp(() {
    opens = {'mac-1'};
    stoppedOn = {};
    opened = [];
    resumed = [];
    resumeError = null;
    held = null;
    canResume = true;
    computers = FakeComputers(const [])
      ..own = const [(id: 'mac-1', name: 'Tonys-MacBook-Pro', away: false)];
  });

  Future<String?> resume(String machineId, String agentId) async {
    resumed.add((machineId, agentId));
    final error = await (held?.future ?? Future.value(resumeError));
    if (error == null) stoppedOn.remove((machineId, agentId));
    return error;
  }

  Future<SwarmHost> pump(
    WidgetTester tester,
    FakeSwarm fake,
    Widget home, {
    ValueNotifier<String?>? account,
  }) async {
    account ??= ValueNotifier<String?>(me);
    final host = SwarmHost(
      accountId: () => account!.value,
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
          agentStopped: (machine, agent) => stoppedOn[(machine, agent)],
          onResumeAgent: canResume ? resume : null,
          child: SwarmScope(notifier: host, child: child!),
        ),
        home: home,
      ),
    );
    await tester.pumpAndSettle();
    return host;
  }

  Future<SwarmHost> pumpBuddy(WidgetTester tester, FakeSwarm fake) => pump(
    tester,
    fake,
    const SwarmConversationPage(swarmId: tab, conversationId: buddyChat),
  );

  Future<SwarmHost> pumpProject(
    WidgetTester tester,
    FakeSwarm fake, {
    ValueNotifier<String?>? account,
  }) => pump(
    tester,
    fake,
    const SwarmProjectPage(
      swarmId: tab,
      projectId: project,
      tabs: SwarmProjectTab.homeC,
    ),
    account: account,
  );

  Finder key(String value) => find.byKey(ValueKey(value));
  final question = key('swarm-resume-title');

  /// The word at the end of the Open terminal row, or null with none.
  String? word() {
    for (final w in const ['Stopped', 'Offline', 'Not linked']) {
      if (find.text(w).evaluate().isNotEmpty) return w;
    }
    return null;
  }

  /// Opens the Buddy chat's ⋮ and taps Open terminal.
  Future<void> tapBuddyRow(WidgetTester tester) async {
    await tester.tap(key('swarm-buddy-menu'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Open terminal'));
    await tester.pumpAndSettle();
  }

  /// Opens the project's ⋮ and taps Open terminal.
  Future<void> tapProjectRow(WidgetTester tester) async {
    await tester.tap(key('swarm-project-menu'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Open terminal'), warnIfMissed: false);
    await tester.pumpAndSettle();
  }

  Future<void> confirm(WidgetTester tester) async {
    await tester.tap(key('swarm-resume-confirm'));
    await tester.pumpAndSettle();
  }

  group('Buddy chat ⋮', () {
    testWidgets('stopped work its machine can bring back: Stopped, not '
        'dimmed; the tap asks first and names the machine', (tester) async {
      stoppedOn[wren] = true;
      await pumpBuddy(tester, buddyBackend());
      await tester.tap(key('swarm-buddy-menu'));
      await tester.pumpAndSettle();
      expect(word(), 'Stopped');

      await tester.tap(find.text('Open terminal'));
      await tester.pumpAndSettle();
      expect(find.text('Rename Buddy'), findsNothing, reason: 'sheet closed');
      expect(find.text('Resume Wren?'), findsOneWidget);
      expect(
        find.text('This agent is stopped on Tonys-MacBook-Pro.'),
        findsOneWidget,
      );
      expect(resumed, isEmpty, reason: 'nothing resumes before the answer');
      expect(opened, isEmpty);
    });

    testWidgets('Cancel resumes nothing and opens nothing', (tester) async {
      stoppedOn[wren] = true;
      await pumpBuddy(tester, buddyBackend());
      await tapBuddyRow(tester);

      await tester.tap(key('swarm-resume-cancel'));
      await tester.pumpAndSettle();
      expect(question, findsNothing);
      expect(resumed, isEmpty);
      expect(opened, isEmpty);
    });

    testWidgets('Resume brings it back, then opens its terminal', (
      tester,
    ) async {
      stoppedOn[wren] = true;
      await pumpBuddy(tester, buddyBackend());
      await tapBuddyRow(tester);
      await confirm(tester);

      expect(resumed, [wren]);
      expect(question, findsNothing);
      expect(opened, [wren]);
    });

    testWidgets('while it resumes: Resuming…, and neither Cancel, the veil '
        'nor back closes the question', (tester) async {
      stoppedOn[wren] = true;
      held = Completer<String?>();
      await pumpBuddy(tester, buddyBackend());
      await tapBuddyRow(tester);
      await tester.tap(key('swarm-resume-confirm'));
      await tester.pump();

      expect(find.text('Resuming…'), findsOneWidget);
      await tester.tap(key('swarm-resume-cancel'), warnIfMissed: false);
      await tester.pump();
      await tester.tapAt(const Offset(4, 4));
      await tester.pump();
      await tester.binding.handlePopRoute();
      await tester.pump();
      expect(question, findsOneWidget);
      expect(opened, isEmpty);

      held!.complete(null);
      await tester.pumpAndSettle();
      expect(question, findsNothing);
      expect(resumed, [wren], reason: 'asked once');
      expect(opened, [wren]);
    });

    testWidgets('a resume the machine refuses says why, opens nothing, and '
        'Resume tries again', (tester) async {
      stoppedOn[wren] = true;
      resumeError =
          'This harness has no supported saved conversation to resume.';
      await pumpBuddy(tester, buddyBackend());
      await tapBuddyRow(tester);
      await confirm(tester);

      expect(question, findsOneWidget);
      expect(
        find.text(
          'This harness has no supported saved conversation to resume.',
        ),
        findsOneWidget,
      );
      expect(opened, isEmpty);

      resumeError = null;
      await confirm(tester);
      expect(resumed, [wren, wren]);
      expect(question, findsNothing);
      expect(opened, [wren]);
    });

    testWidgets('stopped work its machine cannot bring back: Stopped, dimmed, '
        'and the tap asks nothing', (tester) async {
      stoppedOn[wren] = false;
      await pumpBuddy(tester, buddyBackend());
      await tapBuddyRow(tester);

      expect(word(), 'Stopped');
      expect(find.text('Rename Buddy'), findsOneWidget, reason: 'sheet stays');
      expect(question, findsNothing);
      expect(resumed, isEmpty);
      expect(opened, isEmpty);
    });

    testWidgets('the Swarm reads a stopped session as down: still Stopped, '
        'and resumable, not Offline', (tester) async {
      stoppedOn[wren] = true;
      await pumpBuddy(
        tester,
        buddyBackend(
          buddy: {
            ...buddyData('agent-wren', displayName: 'Wren'),
            'downSince': '2026-11-01T07:00:00Z',
          },
        ),
      );
      await tester.tap(key('swarm-buddy-menu'));
      await tester.pumpAndSettle();
      expect(word(), 'Stopped');
      await tester.tap(find.text('Open terminal'));
      await tester.pumpAndSettle();
      await confirm(tester);
      expect(opened, [wren]);
    });

    testWidgets('no resume where the shell offers none: Stopped, dimmed', (
      tester,
    ) async {
      stoppedOn[wren] = true;
      canResume = false;
      await pumpBuddy(tester, buddyBackend());
      await tapBuddyRow(tester);
      expect(word(), 'Stopped');
      expect(question, findsNothing);
      expect(opened, isEmpty);
    });

    testWidgets('its machine offline: Offline, never a resume', (tester) async {
      stoppedOn[wren] = true;
      opens = {};
      computers.own = const [
        (id: 'mac-1', name: 'Tonys-MacBook-Pro', away: true),
      ];
      await pumpBuddy(tester, buddyBackend());
      await tapBuddyRow(tester);
      expect(word(), 'Offline');
      expect(question, findsNothing);
      expect(resumed, isEmpty);
    });

    testWidgets('resumed elsewhere between the sheet and the tap: opens it, '
        'and asks nothing', (tester) async {
      stoppedOn[wren] = true;
      await pumpBuddy(tester, buddyBackend());
      await tester.tap(key('swarm-buddy-menu'));
      await tester.pumpAndSettle();
      expect(word(), 'Stopped');

      stoppedOn.clear();
      await tester.tap(find.text('Open terminal'));
      await tester.pumpAndSettle();
      expect(question, findsNothing);
      expect(resumed, isEmpty);
      expect(opened, [wren]);
    });

    testWidgets('stopped between the sheet and the tap: asks first', (
      tester,
    ) async {
      await pumpBuddy(tester, buddyBackend());
      await tester.tap(key('swarm-buddy-menu'));
      await tester.pumpAndSettle();
      expect(word(), isNull);

      stoppedOn[wren] = true;
      await tester.tap(find.text('Open terminal'));
      await tester.pumpAndSettle();
      expect(find.text('Resume Wren?'), findsOneWidget);
      expect(opened, isEmpty);
    });

    testWidgets('access lost with the question open closes it, resuming and '
        'opening nothing', (tester) async {
      stoppedOn[wren] = true;
      final host = await pumpBuddy(tester, buddyBackend());
      await tapBuddyRow(tester);
      expect(question, findsOneWidget);

      host.session!.inbox.reader(tab)!.revoke();
      await tester.pumpAndSettle();
      expect(question, findsNothing);
      expect(resumed, isEmpty);
      expect(opened, isEmpty);
    });

    testWidgets('access lost while it resumes: the question goes, and the '
        'terminal is not opened', (tester) async {
      stoppedOn[wren] = true;
      held = Completer<String?>();
      final host = await pumpBuddy(tester, buddyBackend());
      await tapBuddyRow(tester);
      await tester.tap(key('swarm-resume-confirm'));
      await tester.pump();

      host.session!.inbox.reader(tab)!.revoke();
      await tester.pumpAndSettle();
      expect(question, findsNothing);

      held!.complete(null);
      await tester.pumpAndSettle();
      expect(resumed, [wren]);
      expect(opened, isEmpty);
    });

    testWidgets('the Buddy removed elsewhere with the question open closes '
        'it, and never resumes its session', (tester) async {
      stoppedOn[wren] = true;
      final fake = buddyBackend();
      final host = await pumpBuddy(tester, fake);
      await tapBuddyRow(tester);
      expect(question, findsOneWidget);

      fake.routes[changesPath] = (_) => {
        ...changes(cursor: 'c3', lastChangedAt: 200),
        'agents': [
          part('agent-wren', 2, {
            ...buddyData('agent-wren', displayName: 'Wren'),
            'workDecision': 'stop',
          }),
        ],
      };
      await host.session!.inbox.reader(tab)!.refresh();
      await tester.pumpAndSettle();
      expect(question, findsNothing);
      expect(resumed, isEmpty);
      expect(opened, isEmpty);
    });

    testWidgets('a viewer has no Open terminal, so no resume', (tester) async {
      stoppedOn[wren] = true;
      await pumpBuddy(tester, buddyBackend(role: 'viewer'));
      expect(find.text('Open terminal'), findsNothing);
      expect(resumed, isEmpty);
    });
  });

  group("project's ⋮", () {
    testWidgets("the PM's stopped work: asks, resumes it, opens its terminal", (
      tester,
    ) async {
      stoppedOn[river] = true;
      await pumpProject(tester, projectBackend());
      await tester.tap(key('swarm-project-menu'));
      await tester.pumpAndSettle();
      final row = key('swarm-project-menu-terminal');
      expect(
        find.descendant(of: row, matching: find.text('Stopped')),
        findsOneWidget,
      );
      expect(tester.widget<MenuItemButton>(row).onPressed, isNotNull);

      await tester.tap(find.text('Open terminal'));
      await tester.pumpAndSettle();
      expect(find.text('Resume River?'), findsOneWidget);
      expect(
        find.text('This agent is stopped on Tonys-MacBook-Pro.'),
        findsOneWidget,
      );
      await confirm(tester);
      expect(resumed, [river]);
      expect(opened, [river]);
    });

    testWidgets("a teammate's machine is never resumed from here: Not linked, "
        'whatever it lists', (tester) async {
      // Ken's computer: not among the person's own, and the phone does not
      // open it.
      const ken = ('mac-ken', 'harness-agent-lead');
      stoppedOn[ken] = true;
      await pumpProject(
        tester,
        projectBackend(
          pm: {
            ...agent(
              'agent-lead',
              name: 'Lead',
              displayName: 'River',
              machineId: 'mac-ken',
            ),
            'machineOwnerId': 'person-ken',
          },
        ),
      );
      await tapProjectRow(tester);
      expect(word(), 'Not linked');
      expect(question, findsNothing);
      expect(resumed, isEmpty);
      expect(opened, isEmpty);
    });

    testWidgets('a PM the Swarm stopped is not resumed: Stopped, dimmed', (
      tester,
    ) async {
      stoppedOn[river] = true;
      await pumpProject(
        tester,
        projectBackend(
          pm: {
            ...agent('agent-lead', name: 'Lead', displayName: 'River'),
            'workDecision': 'stop',
          },
        ),
      );
      await tester.tap(key('swarm-project-menu'));
      await tester.pumpAndSettle();
      final row = key('swarm-project-menu-terminal');
      expect(tester.widget<MenuItemButton>(row).onPressed, isNull);
      expect(word(), 'Stopped');
      expect(resumed, isEmpty);
    });

    testWidgets('the PM stopped by the Swarm with the question open closes '
        'it, and never resumes its session', (tester) async {
      stoppedOn[river] = true;
      final fake = projectBackend();
      final host = await pumpProject(tester, fake);
      await tapProjectRow(tester);
      expect(question, findsOneWidget);

      fake.routes[changesPath] = (_) => {
        ...changes(cursor: 'c3', lastChangedAt: 200),
        'agents': [
          part('agent-lead', 2, {
            ...agent('agent-lead', name: 'Lead', displayName: 'River'),
            'workDecision': 'stop',
          }),
        ],
      };
      await host.session!.inbox.reader(tab)!.refresh();
      await tester.pumpAndSettle();
      expect(question, findsNothing);
      expect(resumed, isEmpty);
      expect(opened, isEmpty);
    });

    testWidgets('signing out with the question open closes it', (tester) async {
      stoppedOn[river] = true;
      final account = ValueNotifier<String?>(me);
      await pumpProject(tester, projectBackend(), account: account);
      await tapProjectRow(tester);
      expect(question, findsOneWidget);

      account.value = null;
      await tester.pumpAndSettle();
      expect(question, findsNothing);
      expect(resumed, isEmpty);
      expect(opened, isEmpty);
    });

    testWidgets("the PM replaced while the question is open closes it, and "
        'never resumes the one it replaced', (tester) async {
      stoppedOn[river] = true;
      final fake = projectBackend();
      final host = await pumpProject(tester, fake);
      await tapProjectRow(tester);
      expect(question, findsOneWidget);

      fake.routes[changesPath] = (_) => {
        ...changes(
          cursor: 'c3',
          lastChangedAt: 200,
          groups: [
            part(
              leadChat,
              5,
              groupData(
                leadChat,
                title: 'Mobile',
                agentIds: ['agent-nova'],
                leadId: 'agent-nova',
              ),
            ),
          ],
        ),
        'agents': [
          part('agent-nova', 2, agent('agent-nova', displayName: 'Nova')),
        ],
      };
      await host.session!.inbox.reader(tab)!.refresh();
      await tester.pumpAndSettle();
      expect(question, findsNothing);
      expect(resumed, isEmpty);
      expect(opened, isEmpty);
    });
  });

  // The project's details (a tap on its #name), whose Open terminal is the
  // menu's row: the same resume, asked once the details are gone.
  group('project details', () {
    Finder terminal() => key('swarm-project-details-terminal');
    bool detailsOpen() =>
        find.byType(SwarmProjectDetailsSheet).evaluate().isNotEmpty;

    Future<void> openDetails(WidgetTester tester) async {
      await tester.tap(key('swarm-title-button'));
      await tester.pumpAndSettle();
    }

    testWidgets("the PM's stopped work: heard Stopped, not greyed; the tap "
        'closes the details, asks, resumes it, then opens it', (tester) async {
      final semantics = tester.ensureSemantics();
      stoppedOn[river] = true;
      await pumpProject(tester, projectBackend());
      await openDetails(tester);
      expect(
        tester.getSemantics(terminal()),
        isSemantics(
          label: 'Open terminal, Stopped',
          isButton: true,
          hasEnabledState: true,
          isEnabled: true,
        ),
      );

      await tester.tap(terminal());
      await tester.pumpAndSettle();
      expect(detailsOpen(), isFalse);
      expect(find.text('Resume River?'), findsOneWidget);
      expect(
        find.text('This agent is stopped on Tonys-MacBook-Pro.'),
        findsOneWidget,
      );
      expect(resumed, isEmpty);

      await confirm(tester);
      expect(resumed, [river]);
      expect(question, findsNothing);
      expect(opened, [river]);
      semantics.dispose();
    });

    testWidgets('Cancel resumes nothing and opens nothing', (tester) async {
      stoppedOn[river] = true;
      await pumpProject(tester, projectBackend());
      await openDetails(tester);
      await tester.tap(terminal());
      await tester.pumpAndSettle();

      await tester.tap(key('swarm-resume-cancel'));
      await tester.pumpAndSettle();
      expect(question, findsNothing);
      expect(resumed, isEmpty);
      expect(opened, isEmpty);
    });

    testWidgets('stopped work its machine cannot bring back: greyed, and the '
        'tap asks nothing', (tester) async {
      stoppedOn[river] = false;
      await pumpProject(tester, projectBackend());
      await openDetails(tester);

      await tester.tap(terminal());
      await tester.pumpAndSettle();
      expect(detailsOpen(), isTrue);
      expect(question, findsNothing);
      expect(resumed, isEmpty);
      expect(opened, isEmpty);
    });
  });

  group('the row rule', () {
    final wrenAgent = SuperTabAgent.fromJson(buddyData('agent-wren'));
    bool? stopped(String m, String a) => stoppedOn[(m, a)];

    test('a session its machine lists as stopped reads Stopped, resumable '
        'or not, where the machine opens', () {
      for (final value in [true, false]) {
        stoppedOn = {wren: value};
        expect(
          swarmTerminalBlock(
            wrenAgent,
            canOpen: {'mac-1'}.contains,
            own: const [],
            stopped: stopped,
          ),
          'Stopped',
        );
        expect(
          swarmTerminalResumes(
            wrenAgent,
            canOpen: {'mac-1'}.contains,
            stopped: stopped,
          ),
          value,
        );
      }
    });

    test('a running session, or none listed, keeps the old words', () {
      stoppedOn = {};
      expect(
        swarmTerminalBlock(
          wrenAgent,
          canOpen: {'mac-1'}.contains,
          own: const [],
          stopped: stopped,
        ),
        isNull,
      );
      expect(
        swarmTerminalResumes(
          wrenAgent,
          canOpen: {'mac-1'}.contains,
          stopped: stopped,
        ),
        isFalse,
      );
    });

    test('a machine the phone does not open is never resumed', () {
      stoppedOn = {wren: true};
      expect(
        swarmTerminalBlock(
          wrenAgent,
          canOpen: (_) => false,
          own: const [],
          stopped: stopped,
        ),
        'Not linked',
      );
      expect(
        swarmTerminalResumes(wrenAgent, canOpen: null, stopped: stopped),
        isFalse,
      );
    });

    test('an agent the Swarm stopped, or none, is never resumed', () {
      stoppedOn = {wren: true};
      final stoppedBySwarm = SuperTabAgent.fromJson({
        ...buddyData('agent-wren'),
        'workDecision': 'stop',
      });
      for (final a in [stoppedBySwarm, null]) {
        expect(
          swarmTerminalResumes(
            a,
            canOpen: {'mac-1'}.contains,
            stopped: stopped,
          ),
          isFalse,
        );
      }
    });
  });
}
