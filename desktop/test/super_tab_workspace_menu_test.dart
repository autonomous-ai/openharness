import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/client.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/workspace_menu.dart';
import 'package:harness/super_tabs/workspaces.dart';

import 'swarm_state_test.dart' show MemoryStore;

/// The backend's Workspace routes, answering from [workspaces] and
/// [invitations] as they are at each read.
class _Backend {
  final requests = <(String, String, Map<String, dynamic>?)>[];
  List<Map<String, dynamic>> workspaces = [];
  List<Map<String, dynamic>> invitations = [];
  final failures = <String, SuperTabFailure>{};

  Future<Object?> call(
    String method,
    String path, {
    Map<String, dynamic>? body,
  }) async {
    requests.add((method, path, body));
    final failure = failures[path];
    if (failure != null) throw failure;
    return switch (path) {
      '/api/super-tabs/workspaces' when method == 'GET' => {
        'workspaces': workspaces,
      },
      '/api/super-tabs/workspace-invitations' => {'invitations': invitations},
      _ => <String, dynamic>{},
    };
  }

  List<String> get posts => [
    for (final (method, path, _) in requests)
      if (method == 'POST') path,
  ];
}

Map<String, dynamic> _swarm(
  String id,
  String name, {
  bool member = true,
  bool open = false,
}) => {
  'id': id,
  'name': name,
  'workspaceVisibility': open ? 'workspace' : 'invite-only',
  'member': member,
};

Map<String, dynamic> _workspace(
  String id,
  String name,
  String role,
  List<Map<String, dynamic>> swarms,
) => {'id': id, 'name': name, 'role': role, 'revision': 1, 'swarms': swarms};

/// Ken's Workspaces: Autonomous, which he owns, and a customer's, where he is
/// a guest.
_Backend _ken() => _Backend()
  ..workspaces = [
    _workspace('w1', 'Autonomous', 'owner', [
      _swarm('s1', 'openharness'),
      _swarm('s2', 'lamp-os', member: false, open: true),
      _swarm('s3', 'firmware', member: false),
    ]),
    _workspace('w2', 'Customer X', 'guest', [_swarm('s4', 'support')]),
  ];

class _Calls {
  final opened = <(String, String)>[];
  final settings = <String>[];
  final newSwarm = <String>[];
  int newWorkspace = 0;
}

Future<(SwarmWorkspaces, _Calls)> _show(
  WidgetTester tester,
  _Backend backend, {
  String tabId = 's1',
  Brightness brightness = Brightness.dark,
}) async {
  final client = SuperTabClient(transport: backend.call, storage: MemoryStore())
    ..bind('ken');
  final state = SwarmWorkspaces(client);
  addTearDown(state.dispose);
  final calls = _Calls();
  await tester.binding.setSurfaceSize(const Size(900, 700));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: brightness),
      home: Scaffold(
        body: Align(
          alignment: Alignment.topLeft,
          child: SizedBox(
            width: 280,
            child: SwarmWorkspaceMenu(
              workspaces: state,
              tabId: tabId,
              onOpenSwarm: (id, name) => calls.opened.add((id, name)),
              onSettings: (w) => calls.settings.add(w.id),
              onNewSwarm: (w) => calls.newSwarm.add(w.id),
              onNewWorkspace: () => calls.newWorkspace++,
              operationId: () => 'op',
            ),
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return (state, calls);
}

/// The menu scrolls past its maximum height, as every menu does.
Future<void> _tap(WidgetTester tester, Finder finder) async {
  await tester.ensureVisible(finder);
  await tester.pumpAndSettle();
  await tester.tap(finder);
  await tester.pumpAndSettle();
}

Future<void> _open(WidgetTester tester) async {
  await tester.tap(find.byKey(const ValueKey('super-workspace-menu')));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('the row names the Workspace of the Swarm on screen', (
    tester,
  ) async {
    await _show(tester, _ken(), tabId: 's4');
    expect(
      find.descendant(
        of: find.byKey(const ValueKey('super-workspace-menu')),
        matching: find.text('Customer X'),
      ),
      findsOneWidget,
    );
  });

  testWidgets('a member of one Workspace sees no row, as before Workspaces', (
    tester,
  ) async {
    final backend = _Backend()
      ..workspaces = [
        _workspace('w1', 'Autonomous', 'member', [_swarm('s1', 'openharness')]),
      ];
    await _show(tester, backend);
    expect(find.byKey(const ValueKey('super-workspace-menu')), findsNothing);
    expect(find.text('Autonomous'), findsNothing);
  });

  testWidgets('an owner of one Workspace sees the row', (tester) async {
    final backend = _Backend()
      ..workspaces = [
        _workspace('w1', 'Autonomous', 'owner', [_swarm('s1', 'openharness')]),
      ];
    await _show(tester, backend);
    expect(find.byKey(const ValueKey('super-workspace-menu')), findsOneWidget);
  });

  testWidgets('the menu lists each Workspace with its role and Swarms', (
    tester,
  ) async {
    await _show(tester, _ken());
    await _open(tester);
    for (final text in [
      'Customer X',
      'Owner',
      'Guest',
      'openharness',
      'lamp-os',
      'firmware',
      'support',
      'Join',
      'Not a member',
    ]) {
      expect(find.text(text), findsWidgets, reason: text);
    }
  });

  testWidgets('picking a Swarm the person is in opens its tab', (tester) async {
    final (_, calls) = await _show(tester, _ken());
    await _open(tester);
    await _tap(tester, find.text('support'));
    expect(calls.opened, [('s4', 'support')]);
  });

  testWidgets('picking another Workspace opens its first Swarm', (
    tester,
  ) async {
    final (_, calls) = await _show(tester, _ken());
    await _open(tester);
    await _tap(tester, find.byKey(const ValueKey('super-workspace-w2')));
    expect(calls.opened, [('s4', 'support')]);
  });

  testWidgets('Join adds the person at once, then opens the Swarm', (
    tester,
  ) async {
    final backend = _ken();
    final (_, calls) = await _show(tester, backend);
    await _open(tester);
    await _tap(tester, find.text('lamp-os'));
    expect(backend.posts, ['/api/super-tabs/s2/workspace-join']);
    expect(backend.requests.where((r) => r.$1 == 'POST').single.$3, {
      'operationId': 'op',
    });
    expect(calls.opened, [('s2', 'lamp-os')]);
  });

  testWidgets('a refused Join says why and opens nothing', (tester) async {
    final backend = _ken()
      ..failures['/api/super-tabs/s2/workspace-join'] = const SuperTabFailure(
        'FORBIDDEN',
        'This Swarm is not open to its Workspace.',
        statusCode: 403,
      );
    final (_, calls) = await _show(tester, backend);
    await _open(tester);
    await _tap(tester, find.text('lamp-os'));
    expect(
      find.text('This Swarm is not open to its Workspace.'),
      findsOneWidget,
    );
    expect(calls.opened, isEmpty);
  });

  testWidgets('a Swarm the person is not in cannot be opened', (tester) async {
    final backend = _ken();
    final (_, calls) = await _show(tester, backend);
    await _open(tester);
    await _tap(tester, find.text('firmware'));
    await tester.pumpAndSettle();
    expect(calls.opened, isEmpty);
    expect(backend.posts, isEmpty);
  });

  testWidgets('owners and admins get Workspace settings for the current one', (
    tester,
  ) async {
    final (_, calls) = await _show(tester, _ken());
    await _open(tester);
    await _tap(tester, find.text('Workspace settings…'));
    expect(calls.settings, ['w1']);
  });

  testWidgets('a guest gets no Workspace settings and no New Swarm there', (
    tester,
  ) async {
    await _show(tester, _ken(), tabId: 's4');
    await _open(tester);
    expect(find.text('Workspace settings…'), findsNothing);
    expect(find.textContaining('New Swarm'), findsNothing);
    expect(find.text('New Workspace…'), findsOneWidget);
  });

  testWidgets('New Swarm goes into the current Workspace', (tester) async {
    final (_, calls) = await _show(tester, _ken());
    await _open(tester);
    await _tap(tester, find.text('New Swarm in Autonomous'));
    expect(calls.newSwarm, ['w1']);
  });

  testWidgets('New Workspace asks the host to create one', (tester) async {
    final (_, calls) = await _show(tester, _ken());
    await _open(tester);
    await _tap(tester, find.text('New Workspace…'));
    expect(calls.newWorkspace, 1);
  });

  testWidgets('a waiting invitation is accepted from the menu', (tester) async {
    final backend = _ken()
      ..invitations = [
        {
          'workspaceId': 'w3',
          'name': 'Acme',
          'role': 'member',
          'expiresAt': 1794000000000,
        },
      ];
    final (state, _) = await _show(tester, backend);
    await _open(tester);
    expect(find.text('Invited: Acme as Member'), findsOneWidget);
    backend
      ..invitations = []
      ..workspaces = [
        ...backend.workspaces,
        _workspace('w3', 'Acme', 'member', []),
      ];
    await _tap(tester, find.text('Accept'));
    expect(backend.posts, ['/api/super-tabs/workspaces/w3/accept']);
    expect(
      [for (final w in state.workspaces!) w.name],
      ['Autonomous', 'Customer X', 'Acme'],
    );
  });

  testWidgets('a Workspace with no Swarms says so', (tester) async {
    final backend = _ken()
      ..workspaces = [
        ..._ken().workspaces,
        _workspace('w3', 'Acme', 'owner', []),
      ];
    await _show(tester, backend);
    await _open(tester);
    expect(find.text('No Swarms yet'), findsOneWidget);
  });

  testWidgets('opening the menu reads the list again', (tester) async {
    final backend = _ken();
    await _show(tester, backend);
    backend.workspaces = [
      ...backend.workspaces,
      _workspace('w3', 'Acme', 'member', []),
    ];
    await _open(tester);
    expect(find.text('Acme'), findsOneWidget);
  });
}
