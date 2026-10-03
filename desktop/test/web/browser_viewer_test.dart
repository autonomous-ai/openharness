@TestOn('browser')
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/app_shell.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/screens/login_screen.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/viewer/interactive_viewer.dart';
import 'package:harness/viewer/viewer_page.dart';
import 'package:web/web.dart' as web;

import '../swarm_state_test.dart' show MemoryStore;

// A small opaque JPEG, generated for this transport test; no external assets or real viewers.
const picture =
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAYACADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDyOiiitCQooooAKKKKACiiigD/2Q==';

class _App extends AppNotifier {
  _App()
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(storage: MemoryStore()),
        configStore: null,
        workspaceEnabled: () => false,
      );
  final requests = <Map<String, dynamic>>[];
  bool fail = false;
  @override
  Future<Map<String, dynamic>> viewerSurface(
    String machineId,
    String agentId,
    Map<String, dynamic> payload,
  ) async {
    requests.add({'machine': machineId, 'agent': agentId, ...payload});
    if (payload['op'] == 'close') return {'closed': true};
    if (fail) {
      return {'error': 'VIEWER_UNAVAILABLE', 'detail': 'Fixture disconnected'};
    }
    return {
      'data': picture,
      'mime': 'image/jpeg',
      'width': payload['width'],
      'height': payload['height'],
    };
  }
}

void main() {
  testWidgets('a damaged viewer link remains an error page after sign-in', (
    tester,
  ) async {
    final previous = web.window.location.href;
    web.window.history.replaceState(
      null,
      '',
      '/?viewer=1&machine=%FF&agent=model',
    );
    addTearDown(() => web.window.history.replaceState(null, '', previous));
    final app = _App()..status = AppStatus.authenticated;
    await tester.pumpWidget(
      ProviderScope(
        overrides: [appStateProvider.overrideWithValue(app)],
        child: HarnessApp(
          authenticatedScreen: (_) => const Text('Workspace must stay closed'),
        ),
      ),
    );
    await tester.pump();
    expect(
      find.text('This viewer link is incomplete. Run hn view again.'),
      findsOneWidget,
    );
    expect(find.text('Workspace must stay closed'), findsNothing);
    expect(find.byType(ViewerPage), findsNothing);
    expect(app.requests, isEmpty);
    expect(app.allPanes, isEmpty);
    await tester.pumpWidget(const SizedBox.shrink());
    app.dispose();
    expect(tester.takeException(), isNull);
  });
  testWidgets(
    'hn browser link gates sign-in, drives only its viewer and closes only its surface',
    (tester) async {
      final previous = web.window.location.href;
      web.window.history.replaceState(
        null,
        '',
        '/?viewer=1&machine=render&agent=chair',
      );
      addTearDown(() => web.window.history.replaceState(null, '', previous));
      final app = _App()..status = AppStatus.unauthenticated;
      const machine = Machine(
        machineId: 'render',
        name: 'Render server',
        authMode: MachineAuthMode.remote,
      );
      app.machines = [machine];
      app.machineStates['render'] = MachineState(machine)
        ..nodeOnline = true
        ..connectionStatus = ConnectionStatus.connected
        ..agentLoadStatus = AgentLoadStatus.loaded
        ..agents = [
          const Agent(
            id: 'chair',
            name: 'Chair',
            viewerName: '3D Viewer',
            viewerUrl: 'http://127.0.0.1:19679/',
          ),
        ];
      await tester.pumpWidget(
        ProviderScope(
          overrides: [appStateProvider.overrideWithValue(app)],
          child: HarnessApp(
            authenticatedScreen: (_) =>
                const Text('Workspace must stay closed'),
          ),
        ),
      );
      await tester.pump();
      expect(find.byType(LoginScreen), findsOneWidget);
      expect(find.byType(ViewerPage), findsNothing);
      expect(app.requests, isEmpty);
      app.status = AppStatus.authenticated;
      app.notifyListeners();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));
      expect(find.byType(ViewerPage), findsOneWidget);
      expect(find.text('Workspace must stay closed'), findsNothing);
      expect(app.requests, isNotEmpty);
      expect(
        app.requests.every(
          (r) => r['machine'] == 'render' && r['agent'] == 'chair',
        ),
        isTrue,
      );
      final surface = tester.widget<RemoteViewerSurface>(
        find.byType(RemoteViewerSurface),
      );
      expect(surface.session.image, isNotNull);
      await tester.pump(const Duration(milliseconds: 400));
      await tester.pump();
      final image = find.descendant(
        of: find.byType(RemoteViewerSurface),
        matching: find.byType(Image),
      );
      expect(
        tester.getSize(image),
        tester.getSize(find.byType(RemoteViewerSurface)),
      );
      expect(tester.getSize(image).width, greaterThan(100));
      await tester.tap(find.byType(RemoteViewerSurface));
      await tester.pump(const Duration(milliseconds: 50));
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowLeft);
      await tester.pump(const Duration(milliseconds: 50));
      expect(
        app.requests
            .expand((r) => (r['events'] as List?) ?? [])
            .any((e) => e['event'] == 'mousePressed'),
        isTrue,
      );
      expect(
        app.requests
            .expand((r) => (r['events'] as List?) ?? [])
            .any((e) => e['type'] == 'key' && e['key'] == 'ArrowLeft'),
        isTrue,
      );
      app.fail = true;
      await tester.pump(const Duration(milliseconds: 500));
      await tester.pump();
      expect(find.text('Fixture disconnected'), findsOneWidget);
      app.fail = false;
      await tester.tap(find.textContaining('Retry'));
      await tester.pump(const Duration(milliseconds: 50));
      expect(app.requests.any((r) => r['reload'] == true), isTrue);
      expect(app.allPanes, isEmpty);
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();
      expect(app.requests.last['op'], 'close');
      expect(app.machineStates['render']!.agents.single.id, 'chair');
      app.dispose();
      expect(tester.takeException(), isNull);
    },
  );
}
