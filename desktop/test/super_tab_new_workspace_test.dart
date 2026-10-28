import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/client.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/workspace_settings.dart';
import 'package:harness/super_tabs/workspaces.dart';

import 'swarm_state_test.dart' show MemoryStore;

class _Backend {
  final posts = <Map<String, dynamic>>[];
  final workspaces = <Map<String, dynamic>>[
    {
      'id': 'w1',
      'name': 'Autonomous',
      'role': 'owner',
      'revision': 1,
      'swarms': [],
    },
  ];
  SuperTabFailure? refuse;

  Future<Object?> call(
    String method,
    String path, {
    Map<String, dynamic>? body,
  }) async {
    if (path == '/api/super-tabs/workspaces' && method == 'POST') {
      posts.add(body!);
      if (refuse case final failure?) throw failure;
      workspaces.add({
        'id': 'w2',
        'name': body['name'],
        'role': 'owner',
        'revision': 1,
        'swarms': [],
      });
      return {'id': 'w2'};
    }
    if (path == '/api/super-tabs/workspaces') {
      return {'workspaces': workspaces};
    }
    return {'invitations': []};
  }
}

Future<(SwarmWorkspaces, List<String>)> _show(
  WidgetTester tester,
  _Backend backend,
) async {
  final client = SuperTabClient(transport: backend.call, storage: MemoryStore())
    ..bind('ken');
  final state = SwarmWorkspaces(client);
  addTearDown(state.dispose);
  await state.refresh();
  final newSwarms = <String>[];
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: Brightness.dark),
      home: Scaffold(
        body: SwarmNewWorkspaceDialog(
          workspaces: state,
          operationId: () => 'op-${backend.posts.length}',
          onNewSwarm: (w) => newSwarms.add(w.id),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return (state, newSwarms);
}

Finder get _create => find.widgetWithText(FilledButton, 'Create');

void main() {
  testWidgets('Create waits for a name', (tester) async {
    await _show(tester, _Backend());
    expect(tester.widget<FilledButton>(_create).onPressed, isNull);
    await tester.enterText(find.byType(TextField), '   ');
    await tester.pump();
    expect(tester.widget<FilledButton>(_create).onPressed, isNull);
  });

  testWidgets('creates the Workspace, then offers its first Swarm', (
    tester,
  ) async {
    final backend = _Backend();
    final (state, newSwarms) = await _show(tester, backend);
    await tester.enterText(find.byType(TextField), ' Acme ');
    await tester.pump();
    await tester.tap(_create);
    await tester.pumpAndSettle();
    expect(backend.posts, [
      {'operationId': 'op-0', 'name': 'Acme'},
    ]);
    expect([for (final w in state.workspaces!) w.name], ['Autonomous', 'Acme']);
    expect(find.text('Acme is ready. It has no Swarms yet.'), findsOneWidget);
    await tester.tap(find.text('New Swarm in Acme'));
    await tester.pumpAndSettle();
    expect(newSwarms, ['w2']);
    expect(state.takeNewSwarmWorkspace(), 'w2');
  });

  testWidgets('a refusal says why, and Retry repeats the same request', (
    tester,
  ) async {
    final backend = _Backend()
      ..refuse = const SuperTabFailure(
        'TEAM_SESSION_LIMITED',
        'Sign in as yourself to create a Workspace.',
        statusCode: 403,
      );
    await _show(tester, backend);
    await tester.enterText(find.byType(TextField), 'Acme');
    await tester.pump();
    await tester.tap(_create);
    await tester.pumpAndSettle();
    expect(
      find.text('Sign in as yourself to create a Workspace.'),
      findsOneWidget,
    );
    backend.refuse = null;
    await tester.tap(_create);
    await tester.pumpAndSettle();
    expect([for (final p in backend.posts) p['operationId']], ['op-0', 'op-0']);
  });
}
