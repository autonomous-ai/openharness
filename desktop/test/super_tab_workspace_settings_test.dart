import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/widgets/app_menu.dart';
import 'package:harness/super_tabs/client.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/workspace_settings.dart';
import 'package:harness/super_tabs/workspaces.dart';

import 'swarm_state_test.dart' show MemoryStore;

/// One Workspace's routes, answering from its people and invitations as they
/// are at each read.
class _Backend {
  _Backend(this.role);
  String role;
  final requests = <(String, String, Map<String, dynamic>?)>[];
  final failures = <String, SuperTabFailure>{};
  String name = 'Autonomous';

  /// Holds the people read until it completes.
  Future<void>? hold;

  /// Holds an invitation's answer until it completes.
  Future<void>? holdInvite;
  final answers = <String, Map<String, dynamic>>{};
  List<Map<String, dynamic>> members = [
    {'userId': 'ken', 'email': 'ken@example.com', 'role': 'owner'},
    {'userId': 'diego', 'email': 'diego@example.com', 'role': 'admin'},
    {'userId': 'tony', 'email': 'tony@example.com', 'role': 'member'},
    {'userId': 'huy', 'email': 'huy@example.com', 'role': 'guest'},
  ];
  List<Map<String, dynamic>> invitations = [
    // 6 November 2026, local time.
    {
      'email': 'new@acme.com',
      'role': 'member',
      'expiresAt': DateTime(2026, 11, 6, 13).millisecondsSinceEpoch,
    },
  ];

  Map<String, dynamic> get workspace => {
    'id': 'w1',
    'name': name,
    'role': role,
    'revision': 1,
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
  };

  Future<Object?> call(
    String method,
    String path, {
    Map<String, dynamic>? body,
  }) async {
    requests.add((method, path, body));
    if (path.endsWith('/members') && hold != null) await hold;
    if (path.endsWith('/invitations') && holdInvite != null) await holdInvite;
    final failure = failures[path];
    if (failure != null) throw failure;
    if (answers[path] case final answer?) return answer;
    return switch (path) {
      '/api/super-tabs/workspaces' when method == 'GET' => {
        'workspaces': [workspace],
      },
      '/api/super-tabs/workspace-invitations' => {'invitations': []},
      '/api/super-tabs/workspaces/w1/members' => {
        'members': members,
        'invitations': invitations,
      },
      _ => <String, dynamic>{},
    };
  }

  List<List<Object?>> get posts => [
    for (final (method, path, body) in requests)
      if (method == 'POST') [path, body],
  ];
}

Future<SwarmWorkspaces> _show(
  WidgetTester tester,
  _Backend backend, {
  Size size = const Size(900, 1100),
}) async {
  final client = SuperTabClient(transport: backend.call, storage: MemoryStore())
    ..bind(backend.role == 'owner' ? 'ken' : 'diego');
  final state = SwarmWorkspaces(client);
  addTearDown(state.dispose);
  await state.refresh();
  await tester.binding.setSurfaceSize(size);
  addTearDown(() => tester.binding.setSurfaceSize(null));
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: Brightness.dark),
      home: Scaffold(
        body: SwarmWorkspaceSettingsDialog(
          workspaces: state,
          workspaceId: 'w1',
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return state;
}

Finder _row(String email) => find.byKey(ValueKey('workspace-person-$email'));
Finder _inRow(String email, Finder finder) =>
    find.descendant(of: _row(email), matching: finder);

Future<void> _tap(WidgetTester tester, Finder finder) async {
  await tester.ensureVisible(finder);
  await tester.pumpAndSettle();
  await tester.tap(finder);
  await tester.pumpAndSettle();
}

Finder _option(String label) =>
    find.descendant(of: find.byType(AppMenuItem), matching: find.text(label));

Future<void> _choose(WidgetTester tester, Finder field, String option) async {
  await _tap(tester, field);
  await _tap(
    tester,
    find.descendant(of: find.byType(AppMenuItem), matching: find.text(option)),
  );
}

void main() {
  testWidgets('lists the people, their roles and the open invitations', (
    tester,
  ) async {
    await _show(tester, _Backend('owner'));
    for (final email in [
      'ken@example.com',
      'diego@example.com',
      'tony@example.com',
      'huy@example.com',
    ]) {
      expect(_row(email), findsOneWidget, reason: email);
    }
    expect(_inRow('ken@example.com', find.text('Owner')), findsOneWidget);
    expect(find.text('new@acme.com'), findsOneWidget);
    expect(find.text('Member · until 6 Nov'), findsOneWidget);
  });

  testWidgets('the owner may give any role but Owner, to everyone else', (
    tester,
  ) async {
    await _show(tester, _Backend('owner'));
    expect(
      _inRow('ken@example.com', find.byKey(const ValueKey('workspace-role'))),
      findsNothing,
    );
    await _tap(
      tester,
      _inRow('diego@example.com', find.byKey(const ValueKey('workspace-role'))),
    );
    expect(_option('Admin'), findsOneWidget);
    expect(_option('Member'), findsOneWidget);
    expect(_option('Guest'), findsOneWidget);
    expect(_option('Owner'), findsNothing);
  });

  testWidgets('an admin manages members and guests, not admins or the owner', (
    tester,
  ) async {
    await _show(tester, _Backend('admin'));
    expect(
      _inRow('diego@example.com', find.byKey(const ValueKey('workspace-role'))),
      findsNothing,
    );
    expect(_inRow('diego@example.com', find.text('Admin')), findsOneWidget);
    expect(
      _inRow('ken@example.com', find.byKey(const ValueKey('workspace-role'))),
      findsNothing,
    );
    await _tap(
      tester,
      _inRow('tony@example.com', find.byKey(const ValueKey('workspace-role'))),
    );
    expect(_option('Admin'), findsNothing);
    expect(_option('Member'), findsOneWidget);
    expect(_option('Guest'), findsOneWidget);
  });

  testWidgets('only the owner renames the Workspace', (tester) async {
    await _show(tester, _Backend('admin'));
    expect(find.byKey(const ValueKey('workspace-name')), findsNothing);
    expect(find.text('Autonomous'), findsOneWidget);
  });

  testWidgets('renaming sends the new name and shows it', (tester) async {
    final backend = _Backend('owner');
    final state = await _show(tester, backend);
    await tester.enterText(
      find.byKey(const ValueKey('workspace-name')),
      'Autonomous AI',
    );
    backend.name = 'Autonomous AI';
    await _tap(tester, find.text('Rename'));
    expect(backend.posts, [
      [
        '/api/super-tabs/workspaces/w1',
        {'name': 'Autonomous AI'},
      ],
    ]);
    expect(state.workspaces!.single.name, 'Autonomous AI');
  });

  testWidgets('inviting sends the email and role and lists the invitation', (
    tester,
  ) async {
    final backend = _Backend('owner');
    await _show(tester, backend);
    await tester.enterText(
      find.byKey(const ValueKey('workspace-invite-email')),
      'sam@acme.com',
    );
    await _choose(
      tester,
      find.byKey(const ValueKey('workspace-invite-role')),
      'Guest',
    );
    backend.invitations = [
      ...backend.invitations,
      {
        'email': 'sam@acme.com',
        'role': 'guest',
        'expiresAt': DateTime(2026, 11, 11).millisecondsSinceEpoch,
      },
    ];
    await _tap(tester, find.byKey(const ValueKey('workspace-invite-send')));
    expect(backend.posts, [
      [
        '/api/super-tabs/workspaces/w1/invitations',
        {'email': 'sam@acme.com', 'role': 'guest'},
      ],
    ]);
    expect(find.text('sam@acme.com'), findsOneWidget);
    expect(find.text('Guest · until 11 Nov'), findsOneWidget);
  });

  testWidgets('an admin invites as Member or Guest only', (tester) async {
    await _show(tester, _Backend('admin'));
    await _tap(tester, find.byKey(const ValueKey('workspace-invite-role')));
    expect(
      find.descendant(
        of: find.byType(AppMenuItem),
        matching: find.text('Admin'),
      ),
      findsNothing,
    );
  });

  testWidgets('a refused invitation says why', (tester) async {
    final backend = _Backend('owner')
      ..failures['/api/super-tabs/workspaces/w1/invitations'] =
          const SuperTabFailure(
            'WORKSPACE_ROLE_REQUIRED',
            'Your role in this Workspace cannot invite as admin.',
            statusCode: 403,
          );
    await _show(tester, backend);
    await tester.enterText(
      find.byKey(const ValueKey('workspace-invite-email')),
      'sam@acme.com',
    );
    await _tap(tester, find.byKey(const ValueKey('workspace-invite-send')));
    expect(
      find.text('Your role in this Workspace cannot invite as admin.'),
      findsOneWidget,
    );
  });

  testWidgets('changing a role sends it', (tester) async {
    final backend = _Backend('owner');
    await _show(tester, backend);
    backend.members[2] = {...backend.members[2], 'role': 'admin'};
    await _choose(
      tester,
      _inRow('tony@example.com', find.byKey(const ValueKey('workspace-role'))),
      'Admin',
    );
    expect(backend.posts, [
      [
        '/api/super-tabs/workspaces/w1/members/tony',
        {'role': 'admin'},
      ],
    ]);
  });

  testWidgets('removing asks first, then shows Swarms still being left', (
    tester,
  ) async {
    final backend = _Backend('owner')
      ..answers['/api/super-tabs/workspaces/w1/members/huy/remove'] = {
        'userId': 'huy',
        'pending': 1,
      };
    await _show(tester, backend);
    await _tap(
      tester,
      _inRow(
        'huy@example.com',
        find.byKey(const ValueKey('workspace-person-menu')),
      ),
    );
    await _tap(tester, find.text('Remove'));
    expect(find.text('Remove huy@example.com?'), findsOneWidget);
    expect(backend.posts, isEmpty);
    backend.members = backend.members.sublist(0, 3);
    await _tap(tester, find.widgetWithText(FilledButton, 'Remove'));
    expect(backend.posts, [
      ['/api/super-tabs/workspaces/w1/members/huy/remove', <String, dynamic>{}],
    ]);
    expect(_row('huy@example.com'), findsNothing);
    expect(find.text('Removing huy@example.com from 1 Swarm…'), findsOneWidget);
  });

  testWidgets('Cancel removes nobody', (tester) async {
    final backend = _Backend('owner');
    await _show(tester, backend);
    await _tap(
      tester,
      _inRow(
        'huy@example.com',
        find.byKey(const ValueKey('workspace-person-menu')),
      ),
    );
    await _tap(tester, find.text('Remove'));
    await _tap(tester, find.text('Cancel'));
    expect(backend.posts, isEmpty);
  });

  testWidgets('the owner makes an admin the owner, after asking', (
    tester,
  ) async {
    final backend = _Backend('owner');
    await _show(tester, backend);
    await _tap(
      tester,
      _inRow(
        'diego@example.com',
        find.byKey(const ValueKey('workspace-person-menu')),
      ),
    );
    await _tap(tester, find.text('Make owner'));
    expect(find.text('Make diego@example.com the owner?'), findsOneWidget);
    await _tap(tester, find.widgetWithText(FilledButton, 'Make owner'));
    expect(backend.posts, [
      [
        '/api/super-tabs/workspaces/w1/transfer',
        {'userId': 'diego'},
      ],
    ]);
  });

  testWidgets('Make owner is offered on an admin\'s row only', (tester) async {
    await _show(tester, _Backend('owner'));
    await _tap(
      tester,
      _inRow(
        'tony@example.com',
        find.byKey(const ValueKey('workspace-person-menu')),
      ),
    );
    expect(find.text('Make owner'), findsNothing);
    expect(find.text('Remove'), findsOneWidget);
  });

  testWidgets('an admin cannot make anyone the owner', (tester) async {
    await _show(tester, _Backend('admin'));
    await _tap(
      tester,
      _inRow(
        'tony@example.com',
        find.byKey(const ValueKey('workspace-person-menu')),
      ),
    );
    expect(find.text('Make owner'), findsNothing);
    expect(find.text('Remove'), findsOneWidget);
  });

  testWidgets('each Swarm can be opened to the Workspace or closed again', (
    tester,
  ) async {
    final backend = _Backend('owner');
    await _show(tester, backend);
    await _choose(
      tester,
      find.byKey(const ValueKey('workspace-swarm-s1')),
      'Open to Workspace',
    );
    await _choose(
      tester,
      find.byKey(const ValueKey('workspace-swarm-s2')),
      'Invite only',
    );
    expect(backend.posts, [
      [
        '/api/super-tabs/s1/workspace-visibility',
        {'visibility': 'workspace'},
      ],
      [
        '/api/super-tabs/s2/workspace-visibility',
        {'visibility': 'invite-only'},
      ],
    ]);
  });

  testWidgets('fits a phone-width browser window', (tester) async {
    await _show(tester, _Backend('owner'), size: const Size(360, 900));
    expect(tester.takeException(), isNull);
    expect(find.byKey(const ValueKey('workspace-invite-send')), findsOneWidget);
  });

  group('a role lost while settings are open', () {
    testWidgets('an admin made a member no longer sees invitations', (
      tester,
    ) async {
      final backend = _Backend('admin');
      final state = await _show(tester, backend);
      expect(find.text('new@acme.com'), findsOneWidget);
      backend.role = 'member';
      // As the backend: a member's people list carries no invitations.
      final invitations = backend.invitations;
      backend.invitations = [];
      await state.refresh();
      await tester.pumpAndSettle();
      expect(find.text('new@acme.com'), findsNothing);
      expect(
        find.byKey(const ValueKey('workspace-invite-email')),
        findsNothing,
      );
      expect(find.byKey(const ValueKey('workspace-role')), findsNothing);
      backend.invitations = invitations;
    });

    testWidgets('shown nothing cached before the people are read again', (
      tester,
    ) async {
      final backend = _Backend('admin');
      final state = await _show(tester, backend);
      backend.role = 'member';
      final read = Completer<void>();
      backend.hold = read.future;
      await state.refresh();
      await tester.pump();
      expect(find.text('new@acme.com'), findsNothing);
      read.complete();
      await tester.pumpAndSettle();
    });

    testWidgets('a guest no longer sees the people', (tester) async {
      final backend = _Backend('admin');
      final state = await _show(tester, backend);
      backend.role = 'guest';
      backend.failures['/api/super-tabs/workspaces/w1/members'] =
          const SuperTabFailure(
            'WORKSPACE_ROLE_REQUIRED',
            'Your role in this Workspace cannot see its people.',
            statusCode: 403,
          );
      await state.refresh();
      await tester.pumpAndSettle();
      expect(_row('tony@example.com'), findsNothing);
      expect(find.text('new@acme.com'), findsNothing);
    });
  });

  testWidgets('an invitation answered after settings closed changes nothing '
      'and throws nothing', (tester) async {
    final backend = _Backend('owner');
    final answer = Completer<void>();
    backend.holdInvite = answer.future;
    await _show(tester, backend);
    await tester.enterText(
      find.byKey(const ValueKey('workspace-invite-email')),
      'sam@acme.com',
    );
    await _tap(tester, find.byKey(const ValueKey('workspace-invite-send')));
    await tester.pumpWidget(const SizedBox());
    answer.complete();
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
  });
}
