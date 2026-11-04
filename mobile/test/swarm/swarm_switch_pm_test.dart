import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart' as grid;
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
/// it, and on the PM's limit note, what its dialog lists, when its machine
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
  }) => {
    'machineId': 'mac-1',
    'name': 'Team Mac.local',
    'contributorId': me,
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
    List<Map<String, dynamic>> messages = const [],
  }) {
    final fake = FakeSwarm();
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
        machines: [machine ?? machineData()],
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

  Future<SwarmHost> pump(WidgetTester tester, FakeSwarm fake) async {
    await tester.binding.setSurfaceSize(const Size(390, 844));
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

  /// The Swarm read again, its PM now [pm], its machine [machine] and the
  /// reader [role].
  Future<void> readAgain(
    WidgetTester tester,
    FakeSwarm fake,
    SwarmHost host, {
    Map<String, dynamic>? pm,
    Map<String, dynamic>? machine,
    String? role,
  }) async {
    fake.routes[changesPath] = (_) => {
      ...changes(cursor: 'c3', lastChangedAt: 200),
      'agents': [if (pm != null) part('agent-lead', 2, pm)],
      'machines': [if (machine != null) part('mac-1', 2, machine)],
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
      await pump(tester, backend(pm: pmData({'machineOwnerId': ken})));
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

      await readAgain(tester, fake, host, machine: machineData());
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
      expect(
        tester.widget<Text>(key('swarm-switch-pm-no-choice')).data,
        'No engine or account can run a Product Manager right now.',
      );
      expect(confirmOn(tester), isFalse);
    });

    testWidgets('says nothing of the kind while it can switch', (
      tester,
    ) async {
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
        refusal(
          machineData(readAt: now.subtract(const Duration(seconds: 35))),
        ),
        stale,
      );
      expect(
        refusal(
          machineData(readAt: now.subtract(const Duration(seconds: 34))),
        ),
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
