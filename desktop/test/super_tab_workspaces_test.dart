import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/client.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/workspaces.dart';

import 'swarm_state_test.dart' show MemoryStore;

/// The backend's Workspace routes (backend/src/routes/superTabs.ts), answering
/// what [answers] holds for a path and recording every request.
class _Backend {
  final requests =
      <({String method, String path, Map<String, dynamic>? body})>[];
  final answers = <String, Object?>{};
  final failures = <String, SuperTabFailure>{};

  Future<Object?> call(
    String method,
    String path, {
    Map<String, dynamic>? body,
  }) async {
    requests.add((method: method, path: path, body: body));
    final failure = failures[path];
    if (failure != null) throw failure;
    return answers[path] ?? <String, dynamic>{};
  }
}

SwarmWorkspacesApi _api(_Backend backend) => SwarmWorkspacesApi(
  SuperTabClient(transport: backend.call, storage: MemoryStore())..bind('ken'),
);

Map<String, dynamic> _workspace(
  String id,
  String role, {
  List<String> swarms = const [],
}) => {
  'id': id,
  'name': 'Workspace $id',
  'role': role,
  'revision': 1,
  'swarms': [
    for (final s in swarms)
      {
        'id': s,
        'name': 'Swarm $s',
        'workspaceVisibility': 'invite-only',
        'member': true,
      },
  ],
};

void _lists(
  _Backend backend,
  List<Map<String, dynamic>> workspaces, {
  List<Map<String, dynamic>> invitations = const [],
}) {
  backend.answers['/api/super-tabs/workspaces'] = {'workspaces': workspaces};
  backend.answers['/api/super-tabs/workspace-invitations'] = {
    'invitations': invitations,
  };
}

int _reads(_Backend backend) => backend.requests
    .where((r) => r.method == 'GET' && r.path == '/api/super-tabs/workspaces')
    .length;

void main() {
  test(
    'lists the person\'s Workspaces with the Swarms the server shows them',
    () async {
      final backend = _Backend()
        ..answers['/api/super-tabs/workspaces'] = {
          'workspaces': [
            {
              'id': 'w1',
              'name': 'Autonomous',
              'role': 'owner',
              'revision': 3,
              'swarms': [
                {
                  'id': 's1',
                  'name': 'openharness',
                  'workspaceVisibility': 'invite-only',
                  'member': true,
                },
                {
                  'id': 's2',
                  'name': 'lamp-os',
                  'workspaceVisibility': 'workspace',
                  'member': false,
                },
              ],
            },
            {
              'id': 'w2',
              'name': 'Customer X',
              'role': 'guest',
              'revision': 1,
              'swarms': [],
            },
          ],
        };
      final workspaces = await _api(backend).list();
      expect(workspaces, isNotNull);
      expect(
        [for (final w in workspaces!) (w.id, w.name, w.role, w.revision)],
        [
          ('w1', 'Autonomous', SwarmWorkspaceRole.owner, 3),
          ('w2', 'Customer X', SwarmWorkspaceRole.guest, 1),
        ],
      );
      expect(
        [
          for (final s in workspaces.first.swarms)
            (s.id, s.name, s.openToWorkspace, s.member),
        ],
        [('s1', 'openharness', false, true), ('s2', 'lamp-os', true, false)],
      );
      expect(workspaces.last.swarms, isEmpty);
    },
  );

  test(
    'an older backend without Workspaces lists none, not a failure',
    () async {
      final backend = _Backend()
        ..failures['/api/super-tabs/workspaces'] = const SuperTabFailure(
          'NOT_FOUND',
          'Not found',
          statusCode: 404,
        );
      expect(await _api(backend).list(), isNull);
    },
  );

  test('another failure is reported with the server\'s sentence', () async {
    final backend = _Backend()
      ..failures['/api/super-tabs/workspaces'] = const SuperTabFailure(
        'WORKSPACE_ACCESS_REVOKED',
        'You were removed.',
        statusCode: 403,
      );
    await expectLater(
      _api(backend).list(),
      throwsA(
        isA<SuperTabFailure>().having(
          (f) => f.message,
          'message',
          'You were removed.',
        ),
      ),
    );
  });

  test('reads a Workspace\'s people and its open invitations', () async {
    final backend = _Backend()
      ..answers['/api/super-tabs/workspaces/w1/members'] = {
        'members': [
          {'userId': 'ken', 'email': 'ken@example.com', 'role': 'owner'},
          {'userId': 'diego', 'email': 'diego@example.com', 'role': 'admin'},
        ],
        'invitations': [
          {
            'email': 'new@acme.com',
            'role': 'member',
            'expiresAt': 1794000000000,
          },
        ],
      };
    final people = await _api(backend).members('w1');
    expect(
      [for (final m in people.members) (m.userId, m.email, m.role)],
      [
        ('ken', 'ken@example.com', SwarmWorkspaceRole.owner),
        ('diego', 'diego@example.com', SwarmWorkspaceRole.admin),
      ],
    );
    expect(
      [for (final i in people.invitations) (i.email, i.role, i.expiresAt)],
      [
        (
          'new@acme.com',
          SwarmWorkspaceRole.member,
          DateTime.fromMillisecondsSinceEpoch(1794000000000),
        ),
      ],
    );
  });

  test('reads the invitations waiting for the person', () async {
    final backend = _Backend()
      ..answers['/api/super-tabs/workspace-invitations'] = {
        'invitations': [
          {
            'workspaceId': 'w3',
            'name': 'Acme',
            'role': 'member',
            'expiresAt': 1794000000000,
          },
        ],
      };
    final waiting = await _api(backend).invitationsForMe();
    expect(
      [for (final i in waiting) (i.workspaceId, i.name, i.role)],
      [('w3', 'Acme', SwarmWorkspaceRole.member)],
    );
  });

  test('each Workspace action reaches its route with its body', () async {
    final backend = _Backend();
    final api = _api(backend);
    await api.create(operationId: 'op1', name: 'Acme');
    await api.rename('w1', 'Autonomous AI');
    await api.invite(
      'w1',
      email: 'new@acme.com',
      role: SwarmWorkspaceRole.member,
    );
    await api.accept('w3');
    await api.setRole('w1', 'tony', SwarmWorkspaceRole.admin);
    await api.remove('w1', 'huy');
    await api.transfer('w1', 'diego');
    await api.setSwarmOpenToWorkspace('s1', open: true);
    await api.setSwarmOpenToWorkspace('s2', open: false);
    await api.join('s2', operationId: 'op2');
    expect(
      [
        for (final r in backend.requests) [r.method, r.path, r.body],
      ],
      [
        [
          'POST',
          '/api/super-tabs/workspaces',
          {'operationId': 'op1', 'name': 'Acme'},
        ],
        [
          'POST',
          '/api/super-tabs/workspaces/w1',
          {'name': 'Autonomous AI'},
        ],
        [
          'POST',
          '/api/super-tabs/workspaces/w1/invitations',
          {'email': 'new@acme.com', 'role': 'member'},
        ],
        ['POST', '/api/super-tabs/workspaces/w3/accept', <String, dynamic>{}],
        [
          'POST',
          '/api/super-tabs/workspaces/w1/members/tony',
          {'role': 'admin'},
        ],
        [
          'POST',
          '/api/super-tabs/workspaces/w1/members/huy/remove',
          <String, dynamic>{},
        ],
        [
          'POST',
          '/api/super-tabs/workspaces/w1/transfer',
          {'userId': 'diego'},
        ],
        [
          'POST',
          '/api/super-tabs/s1/workspace-visibility',
          {'visibility': 'workspace'},
        ],
        [
          'POST',
          '/api/super-tabs/s2/workspace-visibility',
          {'visibility': 'invite-only'},
        ],
        [
          'POST',
          '/api/super-tabs/s2/workspace-join',
          {'operationId': 'op2'},
        ],
      ],
    );
  });

  test('ids in a route are escaped', () async {
    final backend = _Backend();
    await _api(backend).remove('w/1', 'a b');
    expect(
      backend.requests.single.path,
      '/api/super-tabs/workspaces/w%2F1/members/a%20b/remove',
    );
  });

  test('a removal still running is reported as pending', () async {
    final backend = _Backend()
      ..answers['/api/super-tabs/workspaces/w1/members/huy/remove'] = {
        'userId': 'huy',
        'pending': 1,
      };
    expect(await _api(backend).remove('w1', 'huy'), 1);
  });

  group(
    'what a role may do, as the backend allows it (superTabs/workspaces.ts)',
    () {
      test('roles each role may give', () {
        expect(SwarmWorkspaceRole.owner.gives, [
          SwarmWorkspaceRole.admin,
          SwarmWorkspaceRole.member,
          SwarmWorkspaceRole.guest,
        ]);
        expect(SwarmWorkspaceRole.admin.gives, [
          SwarmWorkspaceRole.member,
          SwarmWorkspaceRole.guest,
        ]);
        expect(SwarmWorkspaceRole.member.gives, isEmpty);
        expect(SwarmWorkspaceRole.guest.gives, isEmpty);
      });

      test('who manages whom', () {
        expect(
          SwarmWorkspaceRole.owner.manages(SwarmWorkspaceRole.admin),
          isTrue,
        );
        expect(
          SwarmWorkspaceRole.owner.manages(SwarmWorkspaceRole.owner),
          isFalse,
        );
        expect(
          SwarmWorkspaceRole.admin.manages(SwarmWorkspaceRole.member),
          isTrue,
        );
        expect(
          SwarmWorkspaceRole.admin.manages(SwarmWorkspaceRole.admin),
          isFalse,
        );
        expect(
          SwarmWorkspaceRole.member.manages(SwarmWorkspaceRole.guest),
          isFalse,
        );
      });

      test('settings, renaming and transferring', () {
        expect(
          [for (final r in SwarmWorkspaceRole.values) r.managesPeople],
          [true, true, false, false],
        );
        expect(
          [for (final r in SwarmWorkspaceRole.values) r.renames],
          [true, false, false, false],
        );
        expect(
          [for (final r in SwarmWorkspaceRole.values) r.createsSwarms],
          [true, true, true, false],
        );
        expect(
          [for (final r in SwarmWorkspaceRole.values) r.seesPeople],
          [true, true, true, false],
        );
      });

      test(
        'an unknown role from a newer backend reads as guest, the least',
        () {
          expect(SwarmWorkspaceRole.parse('auditor'), SwarmWorkspaceRole.guest);
        },
      );
    },
  );

  group('the person\'s Workspaces, as the menu shows them', () {
    late _Backend backend;
    late SuperTabClient client;
    late SwarmWorkspaces state;
    setUp(() {
      backend = _Backend();
      client = SuperTabClient(transport: backend.call, storage: MemoryStore())
        ..bind('ken');
      state = SwarmWorkspaces(client);
    });
    tearDown(() => state.dispose());

    test(
      'an owner with one Workspace sees the menu, to manage its people',
      () async {
        _lists(backend, [
          _workspace('w1', 'owner', swarms: ['s1']),
        ]);
        await state.refresh();
        expect(state.showsMenu, isTrue);
      },
    );

    test('an admin with one Workspace sees it too', () async {
      _lists(backend, [_workspace('w1', 'admin')]);
      await state.refresh();
      expect(state.showsMenu, isTrue);
    });

    test(
      'a member or guest with one Workspace sees the sidebar as today',
      () async {
        _lists(backend, [
          _workspace('w1', 'member', swarms: ['s1']),
        ]);
        await state.refresh();
        expect(state.showsMenu, isFalse);
        _lists(backend, [
          _workspace('w1', 'guest', swarms: ['s1']),
        ]);
        await state.refresh();
        expect(state.showsMenu, isFalse);
      },
    );

    test(
      'a guest with an invitation waiting sees the menu, to accept it',
      () async {
        _lists(
          backend,
          [_workspace('w1', 'guest')],
          invitations: [
            {
              'workspaceId': 'w3',
              'name': 'Acme',
              'role': 'member',
              'expiresAt': 1794000000000,
            },
          ],
        );
        await state.refresh();
        expect(state.showsMenu, isTrue);
        expect([for (final i in state.invitations) i.name], ['Acme']);
      },
    );

    test('a guest in two Workspaces sees the menu, to switch', () async {
      _lists(backend, [_workspace('w1', 'guest'), _workspace('w2', 'guest')]);
      await state.refresh();
      expect(state.showsMenu, isTrue);
    });

    test('an older backend without Workspaces shows no menu', () async {
      backend.failures['/api/super-tabs/workspaces'] = const SuperTabFailure(
        'NOT_FOUND',
        'Not found',
        statusCode: 404,
      );
      backend.failures['/api/super-tabs/workspace-invitations'] =
          const SuperTabFailure('NOT_FOUND', 'Not found', statusCode: 404);
      await state.refresh();
      expect(state.workspaces, isNull);
      expect(state.showsMenu, isFalse);
      expect(state.error, isNull);
    });

    test(
      'the current Workspace is the one holding the Swarm on screen',
      () async {
        _lists(backend, [
          _workspace('w1', 'guest', swarms: ['s1']),
          _workspace('w2', 'owner', swarms: ['s2']),
        ]);
        await state.refresh();
        expect(state.current('s1')?.id, 'w1');
        expect(state.current('s2')?.id, 'w2');
        // A Swarm no Workspace lists: the first one the person manages.
        expect(state.current('elsewhere')?.id, 'w2');
      },
    );

    test('a failed read keeps the last list and says why', () async {
      _lists(backend, [_workspace('w1', 'owner')]);
      await state.refresh();
      backend.failures['/api/super-tabs/workspaces'] = const SuperTabFailure(
        'OFFLINE',
        'Harness is offline.',
      );
      await state.refresh();
      expect([for (final w in state.workspaces!) w.id], ['w1']);
      expect(state.error, 'Harness is offline.');
      backend.failures.clear();
      await state.refresh();
      expect(state.error, isNull);
    });

    test(
      'an answer that is not a Workspaces list is reported, not thrown',
      () async {
        backend.answers['/api/super-tabs/workspaces'] = 'Swarm';
        await state.refresh();
        expect(state.workspaces, isNull);
        expect(state.showsMenu, isFalse);
        expect(state.error, 'Workspaces could not be read.');
      },
    );

    test('reads asked together share one request', () async {
      _lists(backend, [_workspace('w1', 'owner')]);
      await Future.wait<void>([state.refresh(), state.refresh()]);
      expect(_reads(backend), 1);
    });

    test('nothing of an account that left is shown to the next one', () async {
      _lists(backend, [
        _workspace('w1', 'owner', swarms: ['s1']),
      ]);
      await state.refresh();
      client.bind('diego');
      expect(state.workspaces, isNull);
      expect(state.showsMenu, isFalse);
      expect(state.current('s1'), isNull);
    });

    test('a new Swarm goes to the Workspace chosen for it, once', () async {
      _lists(backend, [
        _workspace('w1', 'guest', swarms: ['s1']),
        _workspace('w2', 'owner', swarms: ['s2']),
        _workspace('w3', 'member'),
      ]);
      await state.refresh();
      state.shownTabId = 's2';
      state.chooseForNewSwarm('w3');
      expect(state.takeNewSwarmWorkspace(), 'w3');
      expect(state.takeNewSwarmWorkspace(), 'w2');
    });

    test('otherwise to the Workspace on screen, if the person may create '
        'Swarms there', () async {
      _lists(backend, [
        _workspace('w1', 'guest', swarms: ['s1']),
        _workspace('w2', 'owner', swarms: ['s2']),
        _workspace('w3', 'member', swarms: ['s3']),
      ]);
      await state.refresh();
      state.shownTabId = 's3';
      expect(state.takeNewSwarmWorkspace(), 'w3');
      // A guest creates no Swarm: the first Workspace that lets them.
      state.shownTabId = 's1';
      expect(state.takeNewSwarmWorkspace(), 'w2');
      expect([for (final w in state.swarmHomes) w.id], ['w2', 'w3']);
    });

    test('no Workspace is named for a new Swarm by an older backend', () async {
      backend.failures['/api/super-tabs/workspaces'] = const SuperTabFailure(
        'NOT_FOUND',
        'Not found',
        statusCode: 404,
      );
      await state.refresh();
      state.chooseForNewSwarm('w1');
      expect(state.takeNewSwarmWorkspace(), isNull);
    });

    test('a read that answers after the account changed is dropped', () async {
      _lists(backend, [_workspace('w1', 'owner')]);
      final read = state.refresh();
      client.bind('diego');
      await read;
      expect(state.workspaces, isNull);
    });
  });
}
