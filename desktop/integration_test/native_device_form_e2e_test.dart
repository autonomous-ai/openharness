import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:harness/core/test_run.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/new_harness.dart';
import 'package:harness/state/swarm_catalog.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/ws/ws_conn.dart';

import '../test/swarm_state_test.dart' show createApp;
import '../test/swarm_screen_test.dart' show terminal;

class _Daemon extends WsConn {
  _Daemon()
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );
  final creates = <Map<String, dynamic>>[];
  final requests = <String>[];
  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    requests.add(type);
    if (type == 'engines_probe') {
      return {
        'engines': [
          {'engine': 'codex', 'installed': true},
          {'engine': 'claude', 'installed': true},
        ],
      };
    }
    if (type == 'dsh_list') return {'dsh': []};
    if (type == 'git_project_info') return {'isGit': false};
    if (type == 'agent_create') {
      creates.add(Map.of(payload));
      return {
        'creationId': payload['creationId'],
        'state': 'created',
        'agent': {
          'id': 'made',
          'name': 'New work from the device',
          'engine': payload['engine'],
          'terminal': {'available': true},
        },
      };
    }
    return {};
  }
}

/// Production form and actual workspace navigation, with an in-memory daemon.
/// No native keys, external processes, persistent settings or live agent input.
void main() {
  if (!kUnderTest) throw StateError('Device fixture requires FLUTTER_TEST=1');
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'device chooses a project and starts exactly one harness through Cmd-N',
    (t) async {
      final daemon = _Daemon(),
          app = createApp(connected: true, connectionForTest: (_) => daemon);
      app.machineStates['m']!.localOnly = true;
      app.gitProjectReaderForTest = (_, _) async => {'isGit': false};
      await app.projectHistory.select('m', '/work/project');
      final input = <TerminalBinaryFrame>[];
      app.adoptSessionForTest(terminal('a0', input));
      final oldBox = newHarnessOpensInBox;
      newHarnessOpensInBox = true;
      final boundary = GlobalKey();
      final directory = Directory('/private/tmp/habitat15-native')
        ..createSync(recursive: true);
      var state = <String, dynamic>{};
      var serial = 0;
      Future<Map<String, dynamic>> send(
        String op, {
        int delta = 0,
        int? revision,
        String? queryId,
        String? text,
      }) async {
        Map<String, dynamic>? result;
        final pending = app
            .formFromDevice('m', {
              'op': op,
              'formId': 'native-form',
              'requestId': 'native-${++serial}',
              'expiresAt': DateTime.now().millisecondsSinceEpoch + 2000,
              'revision': revision ?? state['revision'] ?? 0,
              'delta': delta,
              'queryId': ?queryId,
              'text': ?text,
            })
            .then((value) => result = value);
        for (var i = 0; i < 20 && result == null; i++) {
          await t.pump(const Duration(milliseconds: 20));
        }
        await pending;
        state = result!;
        await t.pump(const Duration(milliseconds: 100));
        return state;
      }

      Future<void> capture(String name) async {
        final render =
            boundary.currentContext!.findRenderObject()!
                as RenderRepaintBoundary;
        final image = await render.toImage(pixelRatio: 1);
        final png = await image.toByteData(format: ui.ImageByteFormat.png);
        await File('${directory.path}/$name.png')
            .writeAsBytes(png!.buffer.asUint8List());
        image.dispose();
      }

      try {
        await t.pumpWidget(
          RepaintBoundary(
            key: boundary,
            child: MaterialApp(
              debugShowCheckedModeBanner: false,
              theme: grid.buildAppTheme(brightness: Brightness.dark),
              home: SwarmScreen(
                notifier: app,
                nativeTabs: false,
                projectStore: SwarmProjectStore(),
              ),
            ),
          ),
        );
        await t.pump(const Duration(milliseconds: 200));
        expect((await send('open'))['active'], isTrue);
        await send('state');
        await capture('form');
        for (var i = 0; i < 8 && state['label'] != 'Project'; i++) {
          await send('move', delta: 1);
        }
        expect(state['label'], 'Project');
        await send('activate');
        await send('state');
        expect(state['title'], 'Project');
        await capture('projects');
        final stale = state['revision'] as int;
        await send('move', delta: 1);
        expect((await send('activate', revision: stale))['ok'], isFalse);
        expect(daemon.creates, isEmpty);
        await send('query.begin', queryId: 'spoken-project');
        expect(state['queryId'], 'spoken-project');
        await send('query', queryId: 'spoken-project', text: 'Project.');
        expect(state['ok'], isTrue);
        expect(state['query'], 'Project');
        expect(daemon.creates, isEmpty);
        await capture('spoken-project');
        await send('activate'); // choosing still does not start the harness
        expect(daemon.creates, isEmpty);
        for (var i = 0; i < 8 && state['label'] != 'New Harness'; i++) {
          await send('move', delta: 1);
        }
        expect(state['label'], 'New Harness');
        final launchRevision = state['revision'] as int;
        await send('activate');
        await send(
          'activate',
          revision: launchRevision,
        ); // a duplicate cannot create again
        await send('state');
        expect(
          daemon.creates,
          hasLength(1),
          reason: jsonEncode({'state': state, 'requests': daemon.requests}),
        );
        expect(app.focusedPane?.agentId, 'made');
        expect(state['active'], isFalse);
        expect(input, isEmpty);
        await capture('created');
        await File('${directory.path}/result.json').writeAsString(
          jsonEncode({
            'fixture':
                'synthetic daemon, native macOS workspace and production Cmd-N',
            'voice_query_only_filters': true,
            'create_requests': daemon.creates.length,
            'terminal_input_frames': input.length,
            'stale_choice_refused': true,
            'duplicate_launch_refused': true,
            'focused_agent': app.focusedPane?.agentId,
            'passed': true,
          }),
        );
      } finally {
        await t.pumpWidget(const SizedBox());
        app.dispose();
        newHarnessOpensInBox = oldBox;
      }
    },
  );
}
