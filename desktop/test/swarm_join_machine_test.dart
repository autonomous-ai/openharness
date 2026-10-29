import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/machine_resources.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/join_machine.dart';
import 'package:harness/super_tabs/join_machine_note.dart';
import 'package:harness/super_tabs/model.dart';

import 'support/super_tab_fixture.dart';

const _gib = 1024 * 1024 * 1024;

/// This computer's daemon, as the join step asks it: setup of the Swarm's
/// folder (`prepareContribution`), then a wake once the machine is added.
class _Daemon {
  final asked = <Map<String, dynamic>>[];
  final woken = <String>[];

  /// Answers to `prepareContribution`, in turn; the last one repeats.
  List<Object> prepared = [
    {
      'ok': true,
      'state': 'ready',
      'scope': 'swarm',
      'cwd': '/Users/mate/Harness/Swarm',
      'engines': ['claude', 'codex', 'opencode'],
      'maxAgents': 4,
      'maxAvailableAgents': 16,
    },
  ];
  MachineResources? resources = const MachineResources(
    memoryTotalBytes: 32.0 * _gib,
  );

  Future<Map<String, dynamic>> request(
    String machineId,
    Map<String, dynamic> payload,
  ) async {
    asked.add({'machineId': machineId, ...payload});
    final next = prepared.length > 1 ? prepared.removeAt(0) : prepared.first;
    if (next is Exception) throw next;
    return Map<String, dynamic>.of(next as Map<String, dynamic>);
  }

  SwarmJoinMachine adder() => SwarmJoinMachine(
    machineRequest: request,
    readResources: (_) async => resources,
    wake: (id) async => woken.add(id),
    pause: Duration.zero,
    deadline: const Duration(milliseconds: 200),
  );
}

void main() {
  late ConversationServer server;
  late _Daemon daemon;

  /// The Swarm as [person] sees it right after joining with [role].
  ConversationServer joinedAs(String role, {String person = 'mate'}) {
    final s = ConversationServer();
    (s.state['people'] as List).add({
      'id': person,
      'email': '$person@example.com',
      'role': role,
    });
    return s;
  }

  List<Map<String, dynamic>> contributions() => [
    for (final post in server.posts)
      if ((post['command'] as Map)['type'] == 'machine.contribute')
        Map<String, dynamic>.from(post['command'] as Map),
  ];

  setUp(() {
    server = joinedAs('collaborator');
    daemon = _Daemon();
  });

  test('adds this computer with Add machine\'s defaults, only through a Team account for teammates', () async {
    final c = server.controller(account: 'mate');
    await c.refresh();
    final note = await daemon.adder().add(
      c,
      machineId: 'mate-mac',
      machineName: 'MacBook Air',
      current: () => true,
    );
    expect(note?.added, isTrue);
    expect(note?.tabId, 'tab');
    expect(note?.machineId, 'mate-mac');
    expect(contributions(), [
      {
        'type': 'machine.contribute',
        'machineId': 'mate-mac',
        'name': 'MacBook Air',
        'cwd': '/Users/mate/Harness/Swarm',
        'scope': 'swarm',
        // Only the engines a Swarm runs.
        'engines': ['claude', 'codex'],
        // Half its memory in agents, at most 16: 32 GiB suggests 8.
        'maxAgents': 8,
        'teamAccountOnly': true,
      },
    ]);
    expect(daemon.asked.single, {
      'machineId': 'mate-mac',
      'action': 'prepareContribution',
      'tabId': 'tab',
      'scope': 'swarm',
      'operationId': isA<String>(),
    });
    expect(daemon.woken, ['mate-mac']);
    c.dispose();
  });

  test('waits for the folder setup, then falls back to its offer when memory cannot be read', () async {
    daemon.resources = null;
    daemon.prepared = [
      {'ok': true, 'state': 'preparing'},
      {'ok': true, 'state': 'preparing'},
      {...daemon.prepared.single as Map<String, dynamic>, 'maxAgents': 6},
    ];
    final c = server.controller(account: 'mate');
    await c.refresh();
    final note = await daemon.adder().add(
      c,
      machineId: 'mate-mac',
      machineName: 'MacBook Air',
      current: () => true,
    );
    expect(note?.added, isTrue);
    expect(contributions().single['maxAgents'], 6);
    // One operation for the whole setup, so the daemon answers the same one.
    expect(daemon.asked.map((a) => a['operationId']).toSet(), hasLength(1));
    expect(daemon.asked, hasLength(3));
    c.dispose();
  });

  test('leaves a viewer, a machine already in the Swarm and a Swarm without Team accounts alone', () async {
    for (final setup in <void Function()>[
      () => server = joinedAs('viewer'),
      () => server.state['machines'] = [
        {
          'machineId': 'mate-mac',
          'name': 'MacBook Air',
          'contributorId': 'mate',
          'engines': ['codex'],
          'maxAgents': 2,
        },
      ],
      () => server.state['teamAccounts'] = false,
    ]) {
      server = joinedAs('collaborator');
      daemon = _Daemon();
      setup();
      final c = server.controller(account: 'mate');
      await c.refresh();
      final note = await daemon.adder().add(
        c,
        machineId: 'mate-mac',
        machineName: 'MacBook Air',
        current: () => true,
      );
      expect(note, isNull);
      expect(contributions(), isEmpty);
      expect(daemon.asked, isEmpty);
      c.dispose();
    }
  });

  test('says why it could not add it: no Claude Code or Codex, Harness too old, or refused', () async {
    Future<SwarmJoinedMachine?> attempt() async {
      final c = server.controller(account: 'mate');
      await c.refresh();
      try {
        return await daemon.adder().add(
          c,
          machineId: 'mate-mac',
          machineName: 'MacBook Air',
          current: () => true,
        );
      } finally {
        c.dispose();
      }
    }

    daemon.prepared = [
      {
        ...daemon.prepared.single as Map<String, dynamic>,
        'engines': ['opencode'],
      },
    ];
    expect(
      (await attempt())?.problem,
      'Install Claude Code or Codex on this computer, then add it from Machines.',
    );
    expect(contributions(), isEmpty);

    daemon = _Daemon()
      ..prepared = [
        {'ok': true, 'state': 'unknown'},
      ];
    expect(
      (await attempt())?.problem,
      'Update Harness on this computer, then add it from Machines.',
    );

    daemon = _Daemon();
    server.refuse = {
      'code': 'MACHINES_FULL',
      'message': 'A Super Tab can have up to 32 contributed machines.',
    };
    final refused = await attempt();
    expect(refused?.added, isFalse);
    expect(
      refused?.problem,
      'A Super Tab can have up to 32 contributed machines.',
    );
    expect(daemon.woken, isEmpty);
  });

  test('gives up within its deadline when setup never finishes or the daemon cannot be reached', () async {
    daemon.prepared = [
      {'ok': true, 'state': 'preparing'},
    ];
    final c = server.controller(account: 'mate');
    await c.refresh();
    final slow = await daemon.adder().add(
      c,
      machineId: 'mate-mac',
      machineName: 'MacBook Air',
      current: () => true,
    );
    expect(
      slow?.problem,
      'Setting up this computer took too long. Add it from Machines.',
    );
    daemon = _Daemon()..prepared = [Exception('socket closed')];
    final unreachable = await daemon.adder().add(
      c,
      machineId: 'mate-mac',
      machineName: 'MacBook Air',
      current: () => true,
    );
    expect(
      unreachable?.problem,
      'Could not reach Harness on this computer. Add it from Machines.',
    );
    expect(daemon.asked, hasLength(1));
    expect(contributions(), isEmpty);
    c.dispose();
  });

  test('stops, adding nothing and saying nothing, once the account changed or signed out', () async {
    var current = true;
    daemon.prepared = [
      {'ok': true, 'state': 'preparing'},
      daemon.prepared.single,
    ];
    final c = server.controller(account: 'mate');
    await c.refresh();
    final adder = SwarmJoinMachine(
      machineRequest: (id, payload) {
        current = false;
        return daemon.request(id, payload);
      },
      readResources: (_) async => daemon.resources,
      wake: (id) async => daemon.woken.add(id),
      pause: Duration.zero,
      deadline: const Duration(milliseconds: 200),
    );
    final note = await adder.add(
      c,
      machineId: 'mate-mac',
      machineName: 'MacBook Air',
      current: () => current,
    );
    expect(note, isNull);
    expect(contributions(), isEmpty);
    expect(daemon.asked, hasLength(1));
    c.dispose();
  });

  test(
    'a snapshot reads whether the Swarm uses Team accounts, absent meaning yes',
    () {
      SuperTabSnapshot read(Map<String, dynamic> extra) =>
          SuperTabSnapshot.fromJson({...server.state, ...extra});
      expect(read({}).teamAccounts, isTrue);
      expect(read({'teamAccounts': false}).teamAccounts, isFalse);
    },
  );

  // Review of #2188: an invitation accepted on this computer by someone who
  // joined by link on another one made no membership, and shares nothing.
  test('a join or accept adds this computer only when the server says it made the membership', () {
    // An invitation's accept answers as the backend's commands.ts does.
    expect(
      swarmNewMemberRole({
        'conversationId': 'lead',
        'alreadyMember': false,
        'role': 'collaborator',
      }),
      'collaborator',
    );
    expect(
      swarmNewMemberRole({
        'conversationId': 'lead',
        'alreadyMember': true,
        'role': 'collaborator',
      }),
      isNull,
    );
    // A link join, as store.ts answers it.
    expect(
      swarmNewMemberRole({
        'id': 'tab',
        'role': 'viewer',
        'alreadyMember': false,
      }),
      'viewer',
    );
    // An older server says neither: nothing is added.
    expect(swarmNewMemberRole({'conversationId': 'lead'}), isNull);
    expect(swarmNewMemberRole({'alreadyMember': false}), isNull);
  });

  group('the note after joining', noteTests);
}

void noteTests() {
  late ConversationServer server;
  setUp(() => server = ConversationServer());

  Future<SuperTabController> mount(
    WidgetTester tester,
    SwarmJoinedMachine note,
  ) async {
    final c = server.controller();
    await c.refresh();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              onPressed: () => showJoinedMachineNote(
                context,
                (_) async => c,
                note,
                operatingSystem: 'macos',
              ),
              child: const Text('show'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('show'));
    await tester.pumpAndSettle();
    return c;
  }

  const added = SwarmJoinedMachine(
    tabId: 'tab',
    swarmName: 'Pilot',
    machineId: 'mate-mac',
    machineName: 'MacBook Air',
  );

  testWidgets('says this Mac was added, and Pause pauses it', (tester) async {
    final c = await mount(tester, added);
    expect(
      find.text(
        'This Mac was added to Pilot. Teammates\' agents run here only in '
        'Harness Team, never as you.',
      ),
      findsOneWidget,
    );
    await tester.tap(find.byKey(const Key('swarm-joined-machine-pause')));
    await tester.pumpAndSettle();
    expect(server.posts.map((p) => p['command']), [
      {'type': 'machine.pause', 'machineId': 'mate-mac', 'paused': true},
    ]);
    expect(find.byKey(const Key('swarm-joined-machine-note')), findsNothing);
    c.dispose();
  });

  testWidgets('Remove removes it; a refusal says why', (tester) async {
    server.refuse = {
      'code': 'FORBIDDEN',
      'message': 'Only its owner can remove it.',
    };
    final c = await mount(tester, added);
    await tester.tap(find.byKey(const Key('swarm-joined-machine-remove')));
    await tester.pumpAndSettle();
    expect(server.posts.map((p) => p['command']), [
      {'type': 'machine.remove', 'machineId': 'mate-mac'},
    ]);
    expect(find.text('Only its owner can remove it.'), findsOneWidget);
    c.dispose();
  });

  testWidgets('a computer that was not added says why, with nothing to undo', (
    tester,
  ) async {
    final c = await mount(
      tester,
      const SwarmJoinedMachine(
        tabId: 'tab',
        swarmName: 'Pilot',
        machineId: 'mate-mac',
        machineName: 'MacBook Air',
        problem: 'Install Claude Code or Codex on this computer, then add it from Machines.',
      ),
    );
    expect(
      find.text(
        'This Mac was not added to Pilot. Install Claude Code or Codex on this '
        'computer, then add it from Machines.',
      ),
      findsOneWidget,
    );
    expect(find.byKey(const Key('swarm-joined-machine-pause')), findsNothing);
    expect(find.byKey(const Key('swarm-joined-machine-remove')), findsNothing);
    c.dispose();
  });
}
