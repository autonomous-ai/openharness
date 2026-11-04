import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart' as grid;
import 'package:harness_mobile/shared/widgets/touch_target.dart';
import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/swarm_project_page.dart';
import 'package:harness_mobile/swarm/swarm_project_tabs.dart';
import 'package:harness_mobile/swarm/swarm_reader.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';
import 'package:harness_mobile/swarm/swarm_style.dart' show SwarmButton;
import 'package:harness_mobile/swarm/swarm_switch_pm.dart';
import 'package:harness_mobile/swarm/team_glance.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// Switch PM on the phone (Desktop's switch_pm.dart, spec
/// 2026-11-02-pm-switch-engine-account-design.md section 8): who is offered
/// it in the project's ⋮ › Project settings…, as Desktop's project menu has
/// it, and on the PM's limit note, what its dialog lists — the machines to
/// move it to, their accounts and the Swarm's models — when its machine
/// cannot switch it, what Switch sends, a refusal, and the PM reading
/// Switching… after.
void main() {
  // sha256('mac-1:claude:default') and sha256('mac-1:codex:default'), first
  // 16 hex: the ids the machine reports its default accounts by.
  final claudeDefault = swarmProfileId('mac-1', 'claude', 'default');
  final codexDefault = swarmProfileId('mac-1', 'codex', 'default');
  const changesPath = '/api/super-tabs/$tab/changes';
  const commandsPath = '/api/super-tabs/$tab/commands';
  const ken = 'person-ken';

  Map<String, dynamic> switching() => {
    'id': 'sw1',
    'engine': 'codex',
    'profileId': 'bbbbbbbbbbbbbbbb',
    'requestedBy': me,
    'at': '2026-11-03T08:00:00.000Z',
  };

  /// River, the project's PM, on mac-1, which [me] owns unless [over] says.
  Map<String, dynamic> pmData([Map<String, dynamic> over = const {}]) => {
    ...agent('agent-lead', name: 'Lead', displayName: 'River'),
    'machineOwnerId': me,
    ...over,
  };

  /// mac-1, read just now by a Harness that switches a PM, unless told
  /// otherwise.
  Map<String, dynamic> machineData({
    bool profiles = true,
    List<String> engines = const ['claude', 'codex'],
    DateTime? readAt,
    List<String> capabilities = const ['leadStart', 'leadSwitch'],
    String contributorId = me,
  }) => {
    'machineId': 'mac-1',
    'name': 'Team Mac.local',
    'contributorId': contributorId,
    'engines': engines,
    'observation': {
      'receivedAt': (readAt ?? DateTime.now()).millisecondsSinceEpoch,
      'capabilities': capabilities,
      if (profiles)
        'profiles': [
          {
            'engine': 'codex',
            'id': codexDefault,
            'label': 'Default',
            'leftPercent': 90,
            'resetsAt': null,
          },
          {
            'engine': 'claude',
            'id': claudeDefault,
            'label': 'Default',
            'leftPercent': 40,
            'resetsAt': null,
          },
          {
            'engine': 'claude',
            'id': 'aaaaaaaaaaaaaaaa',
            'label': 'Work',
            'leftPercent': 0,
            'resetsAt': '2099-01-02T15:00:00.000Z',
          },
          {
            'engine': 'codex',
            'id': 'bbbbbbbbbbbbbbbb',
            'label': 'Side',
            'leftPercent': 70,
            'resetsAt': null,
          },
        ],
    },
  };

  /// Another machine of the Swarm, read just now: Studio, the reader's own
  /// unless told, whose Harness starts and switches a PM, offering Codex in
  /// its default account unless it reports [profiles].
  Map<String, dynamic> studio({
    String id = 'mac-2',
    String name = 'Studio.local',
    String contributorId = me,
    DateTime? readAt,
    List<String> capabilities = const ['leadStart', 'leadSwitch'],
    List<Map<String, dynamic>>? profiles,
    Map<String, dynamic> over = const {},
  }) => {
    'machineId': id,
    'name': name,
    'contributorId': contributorId,
    'engines': ['codex'],
    'observation': {
      'receivedAt': (readAt ?? DateTime.now()).millisecondsSinceEpoch,
      'capabilities': capabilities,
      'profiles': ?profiles,
    },
    ...over,
  };

  /// A machine of the reader's last read five minutes ago.
  Map<String, dynamic> oldMac() => studio(
    id: 'mac-3',
    name: 'Old Mac',
    readAt: DateTime.now().subtract(const Duration(minutes: 5)),
  );

  /// The tab's routing-policy read, its catalog as backend catalog.ts has it.
  Map<String, dynamic> policy() => {
    'policy': <String, dynamic>{},
    'catalog': {
      'models': [
        for (final (engine, model, effort, offered) in const [
          ('claude', 'opus', 'high', true),
          ('claude', 'opus', 'xhigh', true),
          ('codex', 'default', 'default', true),
          ('codex', 'gpt-6.1-sol', 'high', true),
          ('codex', 'gpt-6-astra', 'xhigh', true),
          ('claude', 'sonnet', 'high', true),
          ('claude', 'haiku', 'auto', false),
        ])
          {
            'engine': engine,
            'model': model,
            'effort': effort,
            'strength': 3,
            'cost': 1,
            'offered': offered,
          },
      ],
    },
  };

  /// [hour]:[minute] of today, in local time.
  DateTime today(int hour, int minute) {
    final now = DateTime.now();
    return DateTime(now.year, now.month, now.day, hour, minute);
  }

  /// The PM's usage-limit note in its project chat (backend terminal.ts).
  Map<String, dynamic> limitNote({String agentId = 'agent-lead'}) => {
    'id': 'n1',
    'conversationId': leadChat,
    'sequence': 2,
    'text': 'River hit a usage limit.',
    'author': {'kind': 'agent', 'id': agentId, 'name': 'River'},
    'createdAt': DateTime.utc(2026, 11, 3, 8).toIso8601String(),
    'source': {
      'kind': 'terminal-alert',
      'alert': 'limit',
      'agentId': agentId,
      'lead': agentId == 'agent-lead' ? true : null,
      // Today, so the note names the time alone.
      'limitedUntil': today(18, 5).toIso8601String(),
    },
  };

  /// What the next command answers instead of the server.
  FutureOr<Object?> Function()? answer;

  setUp(() => answer = null);

  FakeSwarm backend({
    String role = 'owner',
    String projectOwner = me,
    Map<String, dynamic>? pm,
    Map<String, dynamic>? machine,
    List<Map<String, dynamic>> others = const [],
    FutureOr<Object?> Function()? policy,
    List<Map<String, dynamic>> messages = const [],
  }) {
    final fake = FakeSwarm();
    // Unrouted, the read fails: Default alone.
    if (policy != null) {
      fake.routes['/api/super-tabs/$tab/routing-policy'] = (_) => policy();
    }
    fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
      ],
      'next': null,
    };
    fake.routes['/api/super-tabs/$tab/parts'] = (_) => {
      ...firstLoad(
        head: headData(
          projects: [
            {
              'id': project,
              'name': 'Mobile',
              'ownerId': projectOwner,
              'leadConversationId': leadChat,
              'visibility': 'public',
              'members': <Object>[],
              'updateMinutes': 5,
            },
          ],
        ),
        agents: [pm ?? pmData()],
        machines: [machine ?? machineData(), ...others],
      ),
      'members': [part(me, 1, person(me, role: role))],
    };
    fake.routes[changesPath] = (_) => changes(cursor: 'c2');
    fake.routes['/api/super-tabs/$tab/decisions'] = (_) => {
      'decisions': <Object>[],
    };
    fake.routes['/api/super-tabs/$tab/mentions'] = (_) => {
      'mentions': <Object>[],
    };
    fake.routes['/api/super-tabs/$tab/conversations/$leadChat/messages'] =
        (_) => {
          'messages': messages.reversed.toList(),
          'threads': <Object>[],
          'next': null,
        };
    fake.routes[commandsPath] = (_) => answer?.call() ?? {'result': {}};
    return fake;
  }

  Future<SwarmHost> pump(
    WidgetTester tester,
    FakeSwarm fake, {
    Size size = const Size(390, 844),
  }) async {
    await tester.binding.setSurfaceSize(size);
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final account = ValueNotifier<String?>(me);
    final host = SwarmHost(
      accountId: () => account.value,
      account: account,
      request: fake.request,
      upload: refuseSwarmUpload,
      notices: SilentSystemNotices(),
      features: ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
        ..value = {PhoneExperiment.swarm},
    )..foreground = false;
    addTearDown(host.dispose);
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        builder: (context, child) => SwarmScope(notifier: host, child: child!),
        home: const SwarmProjectPage(
          swarmId: tab,
          projectId: project,
          tabs: SwarmProjectTab.homeC,
        ),
      ),
    );
    await tester.pumpAndSettle();
    return host;
  }

  /// The Swarm read again, its PM now [pm], [machines] as they are now,
  /// [gone] taken off it, and the reader [role].
  Future<void> readAgain(
    WidgetTester tester,
    FakeSwarm fake,
    SwarmHost host, {
    Map<String, dynamic>? pm,
    List<Map<String, dynamic>> machines = const [],
    List<String> gone = const [],
    String? role,
  }) async {
    fake.routes[changesPath] = (_) => {
      ...changes(cursor: 'c3', lastChangedAt: 200),
      'agents': [if (pm != null) part('agent-lead', 2, pm)],
      'machines': [
        for (final m in machines) part(m['machineId'] as String, 2, m),
        for (final id in gone)
          // After any part of it this read carries.
          {'key': id, 'version': 3, 'changedAt': 3, 'deleted': true},
      ],
      'members': [if (role != null) part(me, 2, person(me, role: role))],
    };
    await host.session!.inbox.reader(tab)!.refresh();
    await tester.pumpAndSettle();
  }

  Finder key(String value) => find.byKey(ValueKey(value));
  // Project settings…'s row (the limit note's has its own key).
  final menuItem = find.text('Switch PM…');
  final noteAction = key('swarm-limit-switch-pm');
  final dialog = find.byType(SwarmSwitchPmDialog);
  final confirm = key('swarm-switch-pm-confirm');

  Future<void> openMenu(WidgetTester tester) async {
    await tester.tap(key('swarm-project-menu'));
    await tester.pumpAndSettle();
  }

  Future<void> openSettings(WidgetTester tester) async {
    await openMenu(tester);
    await tester.tap(key('swarm-project-menu-settings'));
    await tester.pumpAndSettle();
    expect(find.text('Project settings'), findsOneWidget);
  }

  Future<void> openDialog(WidgetTester tester) async {
    await openSettings(tester);
    await tester.tap(menuItem);
    await tester.pumpAndSettle();
    expect(dialog, findsOneWidget);
  }

  bool confirmOn(WidgetTester tester) =>
      tester.widget<SwarmButton>(confirm).onPressed != null;

  List<Map<String, dynamic>> switches(FakeSwarm fake) => [
    for (final command in fake.commands)
      if (command['type'] == 'lead.switch') command,
  ];

  List<String> switchReceipts(FakeSwarm fake) => [
    for (final call in fake.calls)
      if (call.method == 'POST' &&
          call.path == commandsPath &&
          (call.body!['command'] as Map)['type'] == 'lead.switch')
        call.body!['operationId'] as String,
  ];

  group('Project settings…', () {
    testWidgets('offers Switch PM… to the project owner, after Project '
        'details; the ⋮ itself keeps its rows', (tester) async {
      await pump(tester, backend());
      await openMenu(tester);
      expect(key('swarm-project-menu-settings'), findsOneWidget);
      expect(menuItem, findsNothing, reason: 'not a row of the ⋮');
      await tester.tap(key('swarm-project-menu-settings'));
      await tester.pumpAndSettle();

      expect(menuItem, findsOneWidget);
      double y(Finder finder) => tester.getTopLeft(finder).dy;
      final details = find.text('Project details');
      expect(y(find.text('Rename project')), lessThan(y(details)));
      expect(y(details), lessThan(y(menuItem)));
    });

    testWidgets('offers it to the owner of the PM\'s machine who does not '
        'own the project', (tester) async {
      await pump(tester, backend(role: 'collaborator', projectOwner: ken));
      await openSettings(tester);
      expect(find.text('Rename project'), findsNothing);
      expect(menuItem, findsOneWidget);
    });

    testWidgets('not to a member who owns neither, a lent machine\'s '
        'borrower included', (tester) async {
      // The PM runs on mac-1, contributed by the reader but owned by Ken.
      await pump(
        tester,
        backend(
          role: 'collaborator',
          projectOwner: ken,
          pm: pmData({'machineOwnerId': ken}),
        ),
      );
      await openSettings(tester);
      expect(find.text('Project details'), findsOneWidget);
      expect(menuItem, findsNothing);
    });

    testWidgets('not to a viewer, even the project\'s owner', (tester) async {
      await pump(tester, backend(role: 'viewer'));
      await openSettings(tester);
      expect(find.text('Project details'), findsOneWidget);
      expect(menuItem, findsNothing);
    });

    testWidgets('not while the PM is switching', (tester) async {
      await pump(tester, backend(pm: pmData({'switchRequest': switching()})));
      await openSettings(tester);
      expect(find.text('Project details'), findsOneWidget);
      expect(menuItem, findsNothing);
    });

    testWidgets('not without a PM', (tester) async {
      final fake = backend();
      final load = fake.routes['/api/super-tabs/$tab/parts']!;
      fake.routes['/api/super-tabs/$tab/parts'] = (body) async {
        final read = await load(body) as Map<String, dynamic>;
        return {...read, 'agents': <Object>[]};
      };
      await pump(tester, fake);
      await openSettings(tester);
      expect(find.text('Project details'), findsOneWidget);
      expect(menuItem, findsNothing);
    });

    testWidgets('leaves the open sheet once a switch is asked for on another '
        'device', (tester) async {
      final fake = backend();
      final host = await pump(tester, fake);
      await openSettings(tester);
      expect(menuItem, findsOneWidget);
      await readAgain(
        tester,
        fake,
        host,
        pm: pmData({'switchRequest': switching()}),
      );
      expect(find.text('Project details'), findsOneWidget);
      expect(menuItem, findsNothing);
    });
  });

  group('the dialog', () {
    testWidgets('lists the PM machine\'s accounts by engine with what is '
        'left, the current one marked, 0% and current not pickable', (
      tester,
    ) async {
      await pump(tester, backend());
      await openDialog(tester);
      expect(find.text('Switch PM'), findsOneWidget);
      expect(find.text('Claude Code · Default'), findsOneWidget);
      expect(find.text('Current · 40% left'), findsOneWidget);
      expect(find.text('Claude Code · Work'), findsOneWidget);
      expect(find.textContaining('0% left · resets '), findsOneWidget);
      expect(find.text('Codex · Default'), findsOneWidget);
      expect(find.text('90% left'), findsOneWidget);
      expect(find.text('Codex · Side'), findsOneWidget);
      expect(find.text('70% left'), findsOneWidget);
      expect(
        find.text(
          'The new session starts fresh and reads a handoff note. Tasks and '
          'chat stay.',
        ),
        findsOneWidget,
      );
      // Claude's accounts first, then Codex's, each in the machine's order.
      double y(String text) => tester.getTopLeft(find.text(text)).dy;
      expect(y('Claude Code · Default'), lessThan(y('Claude Code · Work')));
      expect(y('Claude Code · Work'), lessThan(y('Codex · Default')));
      expect(y('Codex · Default'), lessThan(y('Codex · Side')));
      // The reader owns the machine: nothing is said of what is offered.
      expect(
        find.text('Only accounts its owner offered are listed.'),
        findsNothing,
      );

      expect(confirmOn(tester), isFalse);
      for (final id in [claudeDefault, 'aaaaaaaaaaaaaaaa']) {
        await tester.tap(key('swarm-switch-pm-claude-$id'));
        await tester.pumpAndSettle();
        expect(confirmOn(tester), isFalse, reason: id);
      }
      await tester.tap(key('swarm-switch-pm-codex-$codexDefault'));
      await tester.pumpAndSettle();
      expect(confirmOn(tester), isTrue);
    });

    testWidgets('Switch sends lead.switch with the engine and account, '
        'closes, and the PM reads Switching… once read again', (tester) async {
      final fake = backend();
      final host = await pump(tester, fake);
      await openDialog(tester);
      await tester.tap(find.text('Codex · Side'));
      await tester.pumpAndSettle();
      await tester.tap(confirm);
      await tester.pumpAndSettle();

      expect(switches(fake), [
        {
          'type': 'lead.switch',
          'projectId': project,
          'engine': 'codex',
          'profileId': 'bbbbbbbbbbbbbbbb',
        },
      ]);
      expect(dialog, findsNothing);
      final sent = fake.calls.indexWhere((c) => c.path == commandsPath);
      expect(
        fake.calls.skip(sent + 1).where((c) => c.path.startsWith(changesPath)),
        isNotEmpty,
        reason: 'the Swarm is read again',
      );

      await readAgain(
        tester,
        fake,
        host,
        pm: pmData({'switchRequest': switching()}),
      );
      final snapshot = host.session!.inbox.reader(tab)!.snapshot!;
      expect(
        swarmTeamGlance(snapshot, projectId: project).agents.single.label,
        'Switching…',
      );
      await openSettings(tester);
      expect(menuItem, findsNothing);
    });

    testWidgets('a refusal says why under the list and stays open; trying '
        'again is a new ask', (tester) async {
      final fake = backend();
      await pump(tester, fake);
      await openDialog(tester);
      await tester.tap(find.text('Codex · Side'));
      await tester.pumpAndSettle();
      answer = () => throw const SuperTabFailure(
        'MACHINE_OFFLINE',
        'Wait for a fresh reading from Team Mac.',
        statusCode: 409,
      );
      await tester.tap(confirm);
      await tester.pumpAndSettle();
      expect(dialog, findsOneWidget);
      expect(
        tester.widget<Text>(key('swarm-switch-pm-error')).data,
        'Wait for a fresh reading from Team Mac.',
      );
      expect(confirmOn(tester), isTrue);

      answer = null;
      await tester.tap(confirm);
      await tester.pumpAndSettle();
      expect(dialog, findsNothing);
      final receipts = switchReceipts(fake);
      expect(receipts, hasLength(2));
      expect(receipts.first, isNot(receipts.last));
    });

    testWidgets('an answer lost on the way says so; trying again is the same '
        'ask', (tester) async {
      final fake = backend();
      await pump(tester, fake);
      await openDialog(tester);
      await tester.tap(find.text('Codex · Side'));
      await tester.pumpAndSettle();
      answer = () => throw TimeoutException('no answer');
      await tester.tap(confirm);
      await tester.pumpAndSettle();
      expect(dialog, findsOneWidget);
      expect(
        find.text('Could not reach this Swarm. Try again.'),
        findsOneWidget,
      );

      answer = null;
      await tester.tap(confirm);
      await tester.pumpAndSettle();
      expect(dialog, findsNothing);
      final receipts = switchReceipts(fake);
      expect(receipts, hasLength(2));
      expect(receipts.first, receipts.last);
    });

    testWidgets('Switch waits on its answer: neither Cancel nor a second '
        'tap', (tester) async {
      final fake = backend();
      await pump(tester, fake);
      await openDialog(tester);
      await tester.tap(find.text('Codex · Side'));
      await tester.pumpAndSettle();
      final sent = Completer<Object?>();
      answer = () => sent.future;
      await tester.tap(confirm);
      await tester.pump();
      expect(find.text('Switching…'), findsOneWidget);
      expect(confirmOn(tester), isFalse);
      expect(
        tester.widget<SwarmButton>(key('swarm-switch-pm-cancel')).onPressed,
        isNull,
      );
      sent.complete({'result': {}});
      await tester.pumpAndSettle();
      expect(dialog, findsNothing);
      expect(switches(fake), hasLength(1));
    });

    testWidgets('Cancel sends nothing', (tester) async {
      final fake = backend();
      await pump(tester, fake);
      await openDialog(tester);
      await tester.tap(find.text('Codex · Side'));
      await tester.pumpAndSettle();
      await tester.tap(key('swarm-switch-pm-cancel'));
      await tester.pumpAndSettle();
      expect(dialog, findsNothing);
      expect(switches(fake), isEmpty);
    });

    testWidgets('says only offered accounts are listed on a machine the '
        'reader does not own', (tester) async {
      // Desktop reads it from the machine's contributor.
      await pump(
        tester,
        backend(
          pm: pmData({'machineOwnerId': ken}),
          machine: machineData(contributorId: ken),
        ),
      );
      await openDialog(tester);
      expect(
        find.text('Only accounts its owner offered are listed.'),
        findsOneWidget,
      );
    });

    testWidgets('a machine that reports no accounts offers each engine\'s '
        'default; picking one sends the default', (tester) async {
      final fake = backend(machine: machineData(profiles: false));
      await pump(tester, fake);
      await openDialog(tester);
      expect(find.text('Claude Code · Default'), findsOneWidget);
      expect(find.text('Current'), findsOneWidget);
      expect(find.text('Codex · Default'), findsOneWidget);
      await tester.tap(key('swarm-switch-pm-codex-default'));
      await tester.pumpAndSettle();
      await tester.tap(confirm);
      await tester.pumpAndSettle();
      expect(switches(fake).single['profileId'], 'default');
      expect(switches(fake).single['engine'], 'codex');
    });

    testWidgets('waits for a fresh reading from the PM\'s machine: Switch '
        'stays off until its machine reports again', (tester) async {
      final fake = backend(
        machine: machineData(
          readAt: DateTime.now().subtract(const Duration(minutes: 1)),
        ),
      );
      final host = await pump(tester, fake);
      await openDialog(tester);
      final note = key('swarm-switch-pm-no-choice');
      expect(
        tester.widget<Text>(note).data,
        'Wait for a fresh reading from the PM’s machine.',
      );
      // Its accounts can still be picked, as on Desktop; Switch waits.
      await tester.tap(find.text('Codex · Side'));
      await tester.pumpAndSettle();
      expect(confirmOn(tester), isFalse);

      await readAgain(tester, fake, host, machines: [machineData()]);
      expect(dialog, findsOneWidget);
      expect(note, findsNothing);
      expect(confirmOn(tester), isTrue);
      expect(switches(fake), isEmpty);
    });

    testWidgets('says to update Harness on a machine too old to switch it, '
        'by its name without .local', (tester) async {
      await pump(
        tester,
        backend(machine: machineData(capabilities: const ['leadStart'])),
      );
      await openDialog(tester);
      expect(
        tester.widget<Text>(key('swarm-switch-pm-no-choice')).data,
        'Update Harness on Team Mac to switch this Product Manager.',
      );
      await tester.tap(find.text('Codex · Side'));
      await tester.pumpAndSettle();
      expect(confirmOn(tester), isFalse);
    });

    testWidgets('says so when no account can be picked', (tester) async {
      // A machine that offers only the engine the PM runs, in its default
      // account.
      await pump(
        tester,
        backend(
          machine: machineData(profiles: false, engines: const ['claude']),
        ),
      );
      await openDialog(tester);
      expect(find.text('Claude Code · Default'), findsOneWidget);
      expect(find.text('Codex · Default'), findsNothing);
      // No other machine to move it to either.
      expect(
        tester.widget<Text>(key('swarm-switch-pm-no-choice')).data,
        'No other machine or account can run a Product Manager right now.',
      );
      expect(confirmOn(tester), isFalse);
    });

    testWidgets('with nothing left to pick here, another machine to move it '
        'to is a choice', (tester) async {
      await pump(
        tester,
        backend(
          machine: machineData(profiles: false, engines: const ['claude']),
          others: [studio()],
        ),
      );
      await openDialog(tester);
      expect(key('swarm-switch-pm-no-choice'), findsNothing);
    });

    testWidgets('with nothing left here nor on the machines it could move '
        'to, says no engine or account can run it', (tester) async {
      await pump(
        tester,
        backend(
          machine: machineData(profiles: false, engines: const ['claude']),
          others: [
            // Every account of it ran out.
            studio(
              profiles: [
                {
                  'engine': 'codex',
                  'id': 'cccccccccccccccc',
                  'label': 'Studio',
                  'leftPercent': 0,
                  'resetsAt': null,
                },
              ],
            ),
            oldMac(),
          ],
        ),
      );
      await openDialog(tester);
      expect(
        tester.widget<Text>(key('swarm-switch-pm-no-choice')).data,
        'No engine or account can run a Product Manager right now.',
      );
      expect(confirmOn(tester), isFalse);
    });

    testWidgets('says nothing of the kind while it can switch', (tester) async {
      await pump(tester, backend());
      await openDialog(tester);
      expect(key('swarm-switch-pm-no-choice'), findsNothing);
    });

    testWidgets('goes once a switch is asked for on another device', (
      tester,
    ) async {
      final fake = backend();
      final host = await pump(tester, fake);
      await openDialog(tester);
      await readAgain(
        tester,
        fake,
        host,
        pm: pmData({'switchRequest': switching()}),
      );
      expect(dialog, findsNothing);
      expect(switches(fake), isEmpty);
    });

    testWidgets('goes once the reader is only a viewer', (tester) async {
      final fake = backend();
      final host = await pump(tester, fake);
      await openDialog(tester);
      await readAgain(tester, fake, host, role: 'viewer');
      expect(dialog, findsNothing);
    });
  });

  /// The Machine or Model row's menu, open.
  Future<void> openPicker(WidgetTester tester, String row) async {
    await tester.tap(key('swarm-switch-pm-$row'));
    await tester.pumpAndSettle();
  }

  /// Picks [option] of the Machine or Model row.
  Future<void> choose(WidgetTester tester, String row, String option) async {
    await openPicker(tester, row);
    await tester.tap(key('swarm-switch-pm-$row-$option'));
    await tester.pumpAndSettle();
  }

  /// What the Machine or Model row shows chosen, its menu shut.
  String shown(WidgetTester tester, String row) {
    final texts = tester
        .widgetList<Text>(
          find.descendant(
            of: key('swarm-switch-pm-$row'),
            matching: find.byType(Text),
          ),
        )
        .map((t) => t.data)
        .toList();
    // Its label, then what is chosen.
    return texts[1]!;
  }

  bool optionOn(WidgetTester tester, String row, String option) =>
      tester
          .widget<MenuItemButton>(key('swarm-switch-pm-$row-$option'))
          .onPressed !=
      null;

  /// The words of a menu option: its name, and why it cannot be chosen.
  List<String?> optionWords(WidgetTester tester, String row, String option) =>
      tester
          .widgetList<Text>(
            find.descendant(
              of: key('swarm-switch-pm-$row-$option'),
              matching: find.byType(Text),
            ),
          )
          .map((t) => t.data)
          .toList();

  group('the Machine row', () {
    testWidgets('lists the Swarm\'s machines, the PM\'s own marked Current, '
        'never a Team account read on its Mac', (tester) async {
      await pump(
        tester,
        backend(
          others: [
            studio(),
            studio(
              id: 'mac-2-team',
              name: 'Studio (Team)',
              over: {'hostMachineId': 'mac-2'},
            ),
          ],
        ),
      );
      await openDialog(tester);
      expect(shown(tester, 'machine'), 'Team Mac · Current');
      await openPicker(tester, 'machine');
      expect(optionWords(tester, 'machine', 'mac-1'), ['Team Mac · Current']);
      expect(optionWords(tester, 'machine', 'mac-2'), ['Studio']);
      expect(optionOn(tester, 'machine', 'mac-2'), isTrue);
      expect(key('swarm-switch-pm-machine-mac-2-team'), findsNothing);
      double y(String id) =>
          tester.getTopLeft(key('swarm-switch-pm-machine-$id')).dy;
      expect(y('mac-1'), lessThan(y('mac-2')));
    });

    testWidgets('a machine that cannot take it is dimmed, saying why in '
        'Desktop\'s words', (tester) async {
      await pump(
        tester,
        backend(
          others: [
            oldMac(),
            studio(
              id: 'mac-4',
              name: 'Lab',
              capabilities: const ['leadSwitch'],
            ),
            studio(id: 'mac-5', name: 'Ken Mac', contributorId: ken),
            studio(
              id: 'mac-6',
              name: 'Ken Mini',
              contributorId: ken,
              over: {
                'teamWork': {
                  'allowed': false,
                  'reason': 'Ken Mini takes no other projects now.',
                },
              },
            ),
            studio(
              id: 'mac-7',
              name: 'Shared',
              contributorId: ken,
              over: {
                'teamWork': {'allowed': true},
              },
            ),
            studio(id: 'mac-8', name: 'Paused Mac', over: {'paused': true}),
            studio(
              id: 'mac-9',
              name: 'Leaving',
              over: {
                'removal': {'at': 1},
              },
            ),
          ],
        ),
      );
      await openDialog(tester);
      await openPicker(tester, 'machine');
      final why = {
        'mac-3': ['Old Mac', 'Old Mac is offline.'],
        'mac-4': [
          'Lab',
          'Update Harness on Lab to move a Product Manager there.',
        ],
        'mac-5': ['Ken Mac', 'This machine cannot take this project’s work.'],
        'mac-6': ['Ken Mini', 'Ken Mini takes no other projects now.'],
        'mac-8': ['Paused Mac', 'Paused Mac is unavailable in this Swarm.'],
        'mac-9': ['Leaving', 'Leaving is unavailable in this Swarm.'],
      };
      for (final MapEntry(key: id, value: words) in why.entries) {
        expect(optionWords(tester, 'machine', id), words, reason: id);
        expect(optionOn(tester, 'machine', id), isFalse, reason: id);
      }
      // Someone else's machine that takes this project's work.
      expect(optionWords(tester, 'machine', 'mac-7'), ['Shared']);
      expect(optionOn(tester, 'machine', 'mac-7'), isTrue);
    });

    testWidgets('the PM machine\'s owner who does not own the project sees '
        'the others dimmed: only the project\'s owner moves it', (
      tester,
    ) async {
      final fake = backend(
        role: 'collaborator',
        projectOwner: ken,
        others: [studio()],
      );
      await pump(tester, fake);
      await openDialog(tester);
      await openPicker(tester, 'machine');
      expect(optionWords(tester, 'machine', 'mac-2'), [
        'Studio',
        'Only the project’s owner moves its PM to another machine.',
      ]);
      expect(optionOn(tester, 'machine', 'mac-2'), isFalse);
      await tester.tap(key('swarm-switch-pm-machine-mac-1'));
      await tester.pumpAndSettle();

      // Where it runs, they still switch it.
      await tester.tap(find.text('Codex · Side'));
      await tester.pumpAndSettle();
      await tester.tap(confirm);
      await tester.pumpAndSettle();
      expect(switches(fake).single.containsKey('machineId'), isFalse);
    });

    testWidgets('another machine lists its own accounts and forgets the one '
        'picked; back on the PM\'s, Current is there again', (tester) async {
      await pump(
        tester,
        backend(
          others: [
            studio(
              profiles: [
                {
                  'engine': 'codex',
                  'id': 'cccccccccccccccc',
                  'label': 'Studio',
                  'leftPercent': 50,
                  'resetsAt': null,
                },
              ],
            ),
          ],
        ),
      );
      await openDialog(tester);
      await tester.tap(find.text('Codex · Side'));
      await tester.pumpAndSettle();
      expect(confirmOn(tester), isTrue);

      await choose(tester, 'machine', 'mac-2');
      expect(shown(tester, 'machine'), 'Studio');
      expect(find.text('Codex · Studio'), findsOneWidget);
      expect(find.text('50% left'), findsOneWidget);
      expect(find.text('Codex · Side'), findsNothing);
      expect(find.textContaining('Current'), findsNothing);
      expect(confirmOn(tester), isFalse, reason: 'nothing picked there');
      await tester.tap(find.text('Codex · Studio'));
      await tester.pumpAndSettle();
      expect(confirmOn(tester), isTrue);

      await choose(tester, 'machine', 'mac-1');
      expect(find.text('Current · 40% left'), findsOneWidget);
      expect(confirmOn(tester), isFalse);
    });

    testWidgets('a machine someone else brought lists only what its owner '
        'offered', (tester) async {
      await pump(
        tester,
        backend(
          others: [
            studio(
              contributorId: ken,
              over: {
                'teamWork': {'allowed': true},
              },
            ),
          ],
        ),
      );
      await openDialog(tester);
      const offered = 'Only accounts its owner offered are listed.';
      expect(find.text(offered), findsNothing);
      await choose(tester, 'machine', 'mac-2');
      expect(find.text(offered), findsOneWidget);
    });

    testWidgets('a machine with no account to offer says so', (tester) async {
      await pump(
        tester,
        backend(
          others: [
            studio(over: {'engines': <String>[]}),
          ],
        ),
      );
      await openDialog(tester);
      await choose(tester, 'machine', 'mac-2');
      expect(
        find.text('No engine or account is available on this machine.'),
        findsOneWidget,
      );
      expect(confirmOn(tester), isFalse);
    });

    testWidgets('the machine chosen pausing dims its accounts and holds '
        'Switch; leaving the Swarm, it goes back to the PM\'s', (tester) async {
      final fake = backend(others: [studio()]);
      final host = await pump(tester, fake);
      await openDialog(tester);
      await choose(tester, 'machine', 'mac-2');
      await tester.tap(find.text('Codex · Default'));
      await tester.pumpAndSettle();
      expect(confirmOn(tester), isTrue);

      await readAgain(
        tester,
        fake,
        host,
        machines: [
          studio(over: {'paused': true}),
        ],
      );
      expect(dialog, findsOneWidget);
      expect(shown(tester, 'machine'), 'Studio');
      expect(confirmOn(tester), isFalse);
      expect(
        tester.widget<InkWell>(key('swarm-switch-pm-codex-default')).onTap,
        isNull,
      );

      await readAgain(tester, fake, host, gone: ['mac-2']);
      expect(dialog, findsOneWidget);
      expect(shown(tester, 'machine'), 'Team Mac · Current');
      expect(find.text('Codex · Side'), findsOneWidget);
      expect(confirmOn(tester), isFalse);
      expect(switches(fake), isEmpty);
    });
  });

  group('the Model row', () {
    testWidgets('offers Default, then each catalog model of the PM\'s engine '
        'once, never one the catalog does not offer', (tester) async {
      await pump(tester, backend(policy: policy));
      await openDialog(tester);
      expect(shown(tester, 'model'), 'Default');
      await openPicker(tester, 'model');
      for (final option in ['default', 'opus', 'sonnet']) {
        expect(key('swarm-switch-pm-model-$option'), findsOneWidget);
      }
      expect(optionWords(tester, 'model', 'default'), ['Default']);
      expect(key('swarm-switch-pm-model-haiku'), findsNothing);
      expect(key('swarm-switch-pm-model-gpt-6.1-sol'), findsNothing);
      double y(String option) =>
          tester.getTopLeft(key('swarm-switch-pm-model-$option')).dy;
      expect(y('default'), lessThan(y('opus')));
      expect(y('opus'), lessThan(y('sonnet')));
    });

    testWidgets('an account of another engine lists that engine\'s models, '
        'Codex\'s own default not twice, and forgets the model picked', (
      tester,
    ) async {
      await pump(tester, backend(policy: policy));
      await openDialog(tester);
      await choose(tester, 'model', 'sonnet');
      expect(shown(tester, 'model'), 'sonnet');

      await tester.tap(find.text('Codex · Side'));
      await tester.pumpAndSettle();
      expect(shown(tester, 'model'), 'Default');
      await openPicker(tester, 'model');
      expect(key('swarm-switch-pm-model-gpt-6.1-sol'), findsOneWidget);
      expect(key('swarm-switch-pm-model-gpt-6-astra'), findsOneWidget);
      expect(key('swarm-switch-pm-model-sonnet'), findsNothing);
      expect(find.text('default'), findsNothing);
    });

    testWidgets('another machine forgets the model picked', (tester) async {
      await pump(tester, backend(policy: policy, others: [studio()]));
      await openDialog(tester);
      await tester.tap(find.text('Codex · Side'));
      await tester.pumpAndSettle();
      await choose(tester, 'model', 'gpt-6.1-sol');
      expect(shown(tester, 'model'), 'gpt-6.1-sol');
      await choose(tester, 'machine', 'mac-2');
      expect(shown(tester, 'model'), 'Default');
    });

    testWidgets('a catalog that cannot be read leaves Default alone', (
      tester,
    ) async {
      final fake = backend();
      await pump(tester, fake);
      await openDialog(tester);
      expect(
        fake.paths,
        contains('/api/super-tabs/$tab/routing-policy'),
        reason: 'asked, and refused',
      );
      await openPicker(tester, 'model');
      expect(
        find.descendant(
          of: find.byType(MenuItemButton),
          matching: find.byType(Text),
        ),
        findsOneWidget,
      );
      expect(key('swarm-switch-pm-model-default'), findsOneWidget);
    });
  });

  group('what Switch sends', () {
    testWidgets('another machine: its id, and its default account by the '
        'literal default', (tester) async {
      final fake = backend(others: [studio()]);
      await pump(tester, fake);
      await openDialog(tester);
      await choose(tester, 'machine', 'mac-2');
      await tester.tap(find.text('Codex · Default'));
      await tester.pumpAndSettle();
      await tester.tap(confirm);
      await tester.pumpAndSettle();
      expect(switches(fake), [
        {
          'type': 'lead.switch',
          'projectId': project,
          'engine': 'codex',
          'profileId': 'default',
          'machineId': 'mac-2',
        },
      ]);
      expect(dialog, findsNothing);
    });

    testWidgets('a model picked: its name, and no effort', (tester) async {
      final fake = backend(policy: policy);
      await pump(tester, fake);
      await openDialog(tester);
      await tester.tap(find.text('Codex · Side'));
      await tester.pumpAndSettle();
      await choose(tester, 'model', 'gpt-6.1-sol');
      await tester.tap(confirm);
      await tester.pumpAndSettle();
      expect(switches(fake), [
        {
          'type': 'lead.switch',
          'projectId': project,
          'engine': 'codex',
          'profileId': 'bbbbbbbbbbbbbbbb',
          'model': 'gpt-6.1-sol',
        },
      ]);
    });

    testWidgets('a move the server refuses says why and keeps what was '
        'picked', (tester) async {
      final fake = backend(others: [studio()]);
      await pump(tester, fake);
      await openDialog(tester);
      await choose(tester, 'machine', 'mac-2');
      await tester.tap(find.text('Codex · Default'));
      await tester.pumpAndSettle();
      answer = () => throw const SuperTabFailure(
        'HOST_OUTDATED',
        'Update Harness on Studio to move the Product Manager.',
        statusCode: 409,
      );
      await tester.tap(confirm);
      await tester.pumpAndSettle();
      expect(dialog, findsOneWidget);
      expect(
        tester.widget<Text>(key('swarm-switch-pm-error')).data,
        'Update Harness on Studio to move the Product Manager.',
      );
      expect(shown(tester, 'machine'), 'Studio');
      expect(confirmOn(tester), isTrue);
    });

    testWidgets('after an answer lost on the way, another pick is a new '
        'ask', (tester) async {
      final fake = backend(policy: policy);
      await pump(tester, fake);
      await openDialog(tester);
      await tester.tap(find.text('Codex · Side'));
      await tester.pumpAndSettle();
      answer = () => throw TimeoutException('no answer');
      await tester.tap(confirm);
      await tester.pumpAndSettle();
      expect(dialog, findsOneWidget);

      answer = null;
      await choose(tester, 'model', 'gpt-6-astra');
      await tester.tap(confirm);
      await tester.pumpAndSettle();
      expect(dialog, findsNothing);
      final receipts = switchReceipts(fake);
      expect(receipts, hasLength(2));
      expect(receipts.first, isNot(receipts.last));
      expect(switches(fake).last['model'], 'gpt-6-astra');
    });
  });

  group('on a 320-point phone', () {
    testWidgets('the dialog, Machine and Model included, fits with nothing '
        'cut, and the Machine menu stays on the screen', (tester) async {
      const size = Size(320, 568);
      await pump(
        tester,
        backend(
          policy: policy,
          role: 'owner',
          others: [
            studio(id: 'mac-5', name: 'Ken MacBook Pro', contributorId: ken),
            oldMac(),
          ],
        ),
        size: size,
      );
      await openDialog(tester);
      expect(tester.takeException(), isNull);
      final screen = Offset.zero & size;
      for (final row in [
        'swarm-switch-pm-machine',
        'swarm-switch-pm-model',
        'swarm-switch-pm-cancel',
        'swarm-switch-pm-confirm',
      ]) {
        final rect = tester.getRect(key(row));
        expect(screen.contains(rect.topLeft), isTrue, reason: row);
        expect(
          screen.contains(rect.bottomRight - const Offset(1, 1)),
          isTrue,
          reason: row,
        );
      }
      expect(
        tester.getSize(key('swarm-switch-pm-machine')).height,
        greaterThanOrEqualTo(minTouchTarget),
      );

      await openPicker(tester, 'machine');
      expect(tester.takeException(), isNull);
      for (final id in ['mac-1', 'mac-5', 'mac-3']) {
        final option = key('swarm-switch-pm-machine-$id');
        final rect = tester.getRect(option);
        expect(rect.left, greaterThanOrEqualTo(0), reason: id);
        expect(rect.right, lessThanOrEqualTo(size.width), reason: id);
        expect(rect.height, greaterThanOrEqualTo(minTouchTarget), reason: id);
        // Each word whole, the why wrapped inside the menu.
        for (final text
            in find
                .descendant(of: option, matching: find.byType(Text))
                .evaluate()) {
          final box = text.renderObject! as RenderBox;
          final at = box.localToGlobal(Offset.zero) & box.size;
          expect(at.right, lessThanOrEqualTo(rect.right), reason: id);
        }
      }
    });
  });

  group('the PM\'s limit note', () {
    testWidgets('offers Switch PM… while its machine still alerts about the '
        'limit, and opens the dialog', (tester) async {
      await pump(
        tester,
        backend(
          pm: pmData({
            'alerting': ['limit'],
          }),
          messages: [limitNote()],
        ),
      );
      expect(find.textContaining('River hit a usage limit.'), findsOneWidget);
      expect(find.textContaining('until 18:05'), findsOneWidget);
      expect(noteAction, findsOneWidget);
      await tester.tap(noteAction);
      await tester.pumpAndSettle();
      expect(dialog, findsOneWidget);
      expect(find.text('Codex · Side'), findsOneWidget);
    });

    testWidgets('leaves once the limit alert ends or a switch is under way', (
      tester,
    ) async {
      final fake = backend(
        pm: pmData({
          'alerting': ['limit'],
        }),
        messages: [limitNote()],
      );
      final host = await pump(tester, fake);
      expect(noteAction, findsOneWidget);

      await readAgain(
        tester,
        fake,
        host,
        pm: pmData({
          'alerting': ['limit'],
          'switchRequest': switching(),
        }),
      );
      expect(noteAction, findsNothing);
      expect(find.textContaining('River hit a usage limit.'), findsOneWidget);

      fake.routes[changesPath] = (_) => {
        ...changes(cursor: 'c4', lastChangedAt: 300),
        'agents': [part('agent-lead', 3, pmData())],
      };
      await host.session!.inbox.reader(tab)!.refresh();
      await tester.pumpAndSettle();
      expect(noteAction, findsNothing);
    });

    testWidgets('not once its machine no longer alerts', (tester) async {
      await pump(tester, backend(messages: [limitNote()]));
      expect(find.textContaining('until 18:05'), findsOneWidget);
      expect(noteAction, findsNothing);
    });

    testWidgets('not to a viewer', (tester) async {
      await pump(
        tester,
        backend(
          role: 'viewer',
          pm: pmData({
            'alerting': ['limit'],
          }),
          messages: [limitNote()],
        ),
      );
      expect(noteAction, findsNothing);
    });

    testWidgets('a worker\'s limit note never offers it', (tester) async {
      await pump(
        tester,
        backend(
          pm: pmData({
            'alerting': ['limit'],
          }),
          messages: [limitNote(agentId: 'agent-builder')],
        ),
      );
      expect(noteAction, findsNothing);
    });
  });

  group('the model', () {
    test('a profile id is Desktop\'s and the CLI\'s', () {
      // The vectors desktop/test/usage_account_key_test.dart and
      // super_tab_switch_pm_test.dart pin.
      expect(swarmProfileId('m', 'claude', 'default'), '71dc90339553114c');
      expect(swarmProfileId('m', 'codex', 'default'), '07f54db4cdffbb30');
      expect(
        swarmProfileId('m', 'codex', '/home/me/.codex-b'),
        '77103ab28be2ebd0',
      );
    });

    SuperTabSnapshot snapshot(
      Map<String, dynamic> pm, {
      List<Map<String, dynamic>> machines = const [],
      String projectOwner = me,
    }) => SuperTabSnapshot.fromJson({
      'id': tab,
      'name': 'Phone Swarm',
      'ownerId': me,
      'projects': [
        {
          'id': project,
          'name': 'Mobile',
          'ownerId': projectOwner,
          'leadConversationId': leadChat,
          'visibility': 'public',
          'members': <Object>[],
          'updateMinutes': 5,
        },
      ],
      'people': [person(me)],
      'invitations': <Object>[],
      'version': 1,
      'conversations': [
        groupData(leadChat, agentIds: ['agent-lead'], leadId: 'agent-lead'),
      ],
      'agents': [pm],
      'machines': machines,
    });

    List<String> current(SuperTabSnapshot s) => [
      for (final c in swarmSwitchPmChoices(s, project))
        if (c.current) '${c.profile.engine}-${c.profile.id}',
    ];

    test('the PM\'s own account is current; none, or the literal default, is '
        'its engine\'s default', () {
      expect(current(snapshot(pmData(), machines: [machineData()])), [
        'claude-$claudeDefault',
      ]);
      expect(
        current(
          snapshot(pmData({'profileId': 'default'}), machines: [machineData()]),
        ),
        ['claude-$claudeDefault'],
      );
      expect(
        current(
          snapshot(
            pmData({'profileId': 'aaaaaaaaaaaaaaaa'}),
            machines: [machineData()],
          ),
        ),
        ['claude-aaaaaaaaaaaaaaaa'],
      );
      expect(
        current(
          snapshot(
            {
              ...pmData({'profileId': 'bbbbbbbbbbbbbbbb'}),
              'configuration': {'engine': 'codex'},
            },
            machines: [machineData()],
          ),
        ),
        ['codex-bbbbbbbbbbbbbbbb'],
      );
    });

    test('the PM\'s machine refuses a switch without a reading of the last '
        '35 seconds, or without leadSwitch', () {
      final now = DateTime(2026, 11, 4, 12);
      SwarmReader reader(Map<String, dynamic>? machine) {
        final reader = SwarmReader(
          tabId: tab,
          accountId: me,
          request: FakeSwarm().request,
        )..snapshot = snapshot(pmData(), machines: [?machine]);
        addTearDown(reader.dispose);
        return reader;
      }

      String? refusal(Map<String, dynamic>? machine) =>
          swarmSwitchPmRefusal(reader(machine), project, now: now);

      const stale = 'Wait for a fresh reading from the PM’s machine.';
      expect(refusal(null), stale);
      expect(
        refusal(machineData(readAt: now.subtract(const Duration(seconds: 35)))),
        stale,
      );
      expect(
        refusal(machineData(readAt: now.subtract(const Duration(seconds: 34)))),
        isNull,
      );
      expect(
        refusal({
          ...machineData(readAt: now, capabilities: const []),
          'name': null,
        }),
        'Update Harness on the PM’s machine to switch this Product Manager.',
      );
      expect(
        refusal({
          ...machineData(readAt: now),
          'observation': {'receivedAt': now.millisecondsSinceEpoch},
        }),
        'Update Harness on Team Mac to switch this Product Manager.',
      );
      // Without a PM there is nothing to refuse.
      expect(
        swarmSwitchPmRefusal(
          reader(machineData(readAt: now))..snapshot = null,
          project,
          now: now,
        ),
        isNull,
      );
    });

    test('the catalog keeps each row with an engine and a model not marked '
        'unoffered; an answer without one has none', () {
      expect(swarmSwitchPmCatalog(policy()), [
        (engine: 'claude', model: 'opus'),
        (engine: 'claude', model: 'opus'),
        (engine: 'codex', model: 'default'),
        (engine: 'codex', model: 'gpt-6.1-sol'),
        (engine: 'codex', model: 'gpt-6-astra'),
        (engine: 'claude', model: 'sonnet'),
      ]);
      expect(
        swarmSwitchPmCatalog({
          'catalog': {
            'models': [
              {'engine': 'claude'},
              {'engine': 'claude', 'model': 7},
              'opus',
              {'engine': 'claude', 'model': 'opus'},
            ],
          },
        }),
        [(engine: 'claude', model: 'opus')],
      );
      expect(swarmSwitchPmCatalog({'policy': <String, dynamic>{}}), isEmpty);
      expect(swarmSwitchPmCatalog(null), isEmpty);
      expect(
        swarmSwitchPmCatalog({
          'catalog': {'models': 'opus'},
        }),
        isEmpty,
      );
    });

    test('the models of an engine, each once, in the catalog\'s order, its '
        'own default left to Default', () {
      final catalog = swarmSwitchPmCatalog(policy());
      expect(swarmSwitchPmModels(catalog, 'claude'), ['opus', 'sonnet']);
      expect(swarmSwitchPmModels(catalog, 'codex'), [
        'gpt-6.1-sol',
        'gpt-6-astra',
      ]);
      expect(swarmSwitchPmModels(catalog, 'gemini'), isEmpty);
      expect(swarmSwitchPmModels(const [], 'claude'), isEmpty);
    });

    test('lead.switch names the machine only for a move, and the model '
        'only for one picked', () {
      const picked = (engine: 'codex', id: 'bbbbbbbbbbbbbbbb');
      expect(
        swarmSwitchPmCommand(
          projectId: project,
          picked: picked,
          currentMachineId: 'mac-1',
          machineId: 'mac-1',
        ),
        {
          'type': 'lead.switch',
          'projectId': project,
          'engine': 'codex',
          'profileId': 'bbbbbbbbbbbbbbbb',
        },
      );
      expect(
        swarmSwitchPmCommand(
          projectId: project,
          picked: (engine: 'codex', id: 'default'),
          currentMachineId: 'mac-1',
          machineId: 'mac-2',
          model: 'gpt-6-astra',
        ),
        {
          'type': 'lead.switch',
          'projectId': project,
          'engine': 'codex',
          'profileId': 'default',
          'machineId': 'mac-2',
          'model': 'gpt-6-astra',
        },
      );
    });

    test('another machine is offline from 35 seconds without a reading; '
        'the PM\'s own is never refused here', () {
      final now = DateTime(2026, 11, 4, 12);
      final reader = SwarmReader(
        tabId: tab,
        accountId: me,
        request: FakeSwarm().request,
      );
      addTearDown(reader.dispose);
      // Each machine read as the Swarm has it, beside the PM's.
      String? refusal(Map<String, dynamic> pool) {
        reader.snapshot = snapshot(
          pmData(),
          machines: [machineData(), if (pool['machineId'] != 'mac-1') pool],
        );
        return swarmSwitchPmMachineRefusal(reader, project, pool, now: now);
      }

      expect(
        refusal(studio(readAt: now.subtract(const Duration(seconds: 34)))),
        isNull,
      );
      expect(
        refusal(studio(readAt: now.subtract(const Duration(seconds: 35)))),
        'Studio is offline.',
      );
      expect(
        refusal({...studio(readAt: now), 'name': null, 'observation': null}),
        'Mac is offline.',
      );
      expect(
        refusal(machineData(readAt: now.subtract(const Duration(minutes: 9)))),
        isNull,
      );
    });

    test('a PM whose machine is not in the Swarm is offered its own '
        'engine\'s default alone, which it runs in', () {
      final choices = swarmSwitchPmChoices(snapshot(pmData()), project);
      expect(choices, hasLength(1));
      expect(choices.single.profile.id, 'default');
      expect(choices.single.current, isTrue);
      expect(swarmSwitchPmPickable(choices.single), isFalse);
    });

    test(
      'only the project\'s owner and the PM machine\'s owner may switch',
      () {
        expect(swarmMaySwitchLead(snapshot(pmData()), project, me), isTrue);
        expect(
          swarmMaySwitchLead(
            snapshot(pmData(), projectOwner: ken),
            project,
            me,
          ),
          isTrue,
        );
        expect(
          swarmMaySwitchLead(
            snapshot(pmData({'machineOwnerId': ken}), projectOwner: ken),
            project,
            me,
          ),
          isFalse,
        );
        expect(swarmMaySwitchLead(snapshot(pmData()), project, null), isFalse);
        expect(swarmMaySwitchLead(snapshot(pmData()), 'nope', me), isFalse);
      },
    );

    test('a PM with a switch asked for reads Switching…', () {
      final glance = swarmTeamGlance(
        snapshot(
          pmData({
            'switchRequest': switching(),
            'limitedUntil': DateTime.now()
                .add(const Duration(hours: 1))
                .toUtc()
                .toIso8601String(),
          }),
        ),
        projectId: project,
      );
      expect(glance.agents.single.label, 'Switching…');
      expect(glance.agents.single.state, SwarmAgentState.working);
    });
  });
}
