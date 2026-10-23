import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/finder/finder_roots.dart';
import 'package:harness/state/pane_arrangement.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/workspace.dart';

import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;
import 'support/super_tab_devices_fixture.dart';

const _viewerUrl = 'http://127.0.0.1:19679/project-preview';
const _finderRoot = '/work/project/assets';

Future<(SuperTabLaunchFixture, SuperTabController)> _mount(
  WidgetTester tester, {
  bool web = false,
  bool finder = false,
  int agents = 1,
}) async {
  await tester.binding.setSurfaceSize(const Size(1440, 900));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  final f = superTabDevicesFixture();
  f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Company');
  final state = f.connection.server.state;
  state['agents'] = [
    for (var i = 0; i < agents; i++)
      {
        'id': 'agent-$i',
        'name': 'Engineer $i',
        'machineId': 'm',
        'harnessId': 'native-$i',
        'contributorId': 'owner',
        'configuration': {'engine': 'codex'},
      },
  ];
  (state['conversations'] as List)[0]['agentIds'] = [
    for (var i = 0; i < agents; i++) 'agent-$i',
  ];
  f.app.machineStates['m']!.agents = [
    for (var i = 0; i < agents; i++)
      Agent.fromJson({
        'id': 'native-$i',
        'name': 'Engineer $i',
        'engine': 'codex',
        // Navigation must preserve a viewer without restarting its agent.
        'status': 'stopped',
        'sessionId': 'saved-$i',
        'terminal': {'available': false},
        if (web && i == 0) ...{
          'dsh': 'autonomous/web-viewer',
          'viewerUrl': _viewerUrl,
        },
      }),
  ];
  if (finder) f.app.finderRoots.set('m', 'native-0', _finderRoot);
  final c = await f.app.superTabs.open(tabId);
  await c.refresh();
  c.selectGroupTerminals('lead');
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: ListenableBuilder(
          listenable: f.app,
          builder: (_, _) => SuperTabWorkspace(
            app: f.app,
            onAddAgent: (_) {},
            // These are navigation/lifetime checks: avoid creating a platform
            // webview or terminal renderer, while exercising real pane state.
            canvas: const SizedBox.expand(),
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return (f, c);
}

Future<void> _dispose(
  WidgetTester tester,
  SuperTabLaunchFixture f,
  SuperTabController c,
) async {
  await tester.pumpWidget(const SizedBox());
  await c.flush();
  f.app.superTabs.dispose();
  await tester.pump();
}

void main() {
  for (final kind in ['web', 'Finder']) {
    testWidgets('$kind viewer survives repeated Devices round trips', (
      tester,
    ) async {
      final finder = kind == 'Finder';
      final (f, c) = await _mount(tester, web: !finder, finder: finder);
      final tab = f.app.activeSwarm;
      final tabs = f.app.swarms.map((tab) => tab.id).toList();
      void expectPreview() {
        expect(tab.panes, hasLength(2));
        final preview = tab.panes.singleWhere((pane) => pane.isViewer);
        final terminal = tab.panes.singleWhere((pane) => !pane.isViewer);
        expect(preview.viewsAgent('m', 'native-0'), isTrue);
        expect(terminal.agentId, 'native-0');
        if (finder) {
          expect(preview.isFinder, isTrue);
          expect(preview.finderRoot, _finderRoot);
          expect(f.app.finderRoots.rootOf('m', 'native-0'), _finderRoot);
        } else {
          expect(preview.isWeb, isTrue);
          expect(preview.url, _viewerUrl);
        }
      }

      expectPreview();
      for (var visit = 0; visit < 2; visit++) {
        await tester.tap(find.byKey(const ValueKey('super-your-devices')));
        await tester.pumpAndSettle();
        expect(c.devicesSelected, isTrue);
        expect(f.app.activeSwarm, same(tab));
        expect(tab.panes, hasLength(2));
        expect(tab.panes.where((pane) => pane.isDevices), hasLength(1));
        expect(tab.panes.where((pane) => pane.isWeb || pane.isFinder), isEmpty);
        if (finder) {
          // Closing a Finder itself forgets this. Visiting Devices must not.
          expect(f.app.finderRoots.rootOf('m', 'native-0'), _finderRoot);
          final persisted = FinderRoots(() => f.store);
          await persisted.load();
          expect(persisted.rootOf('m', 'native-0'), _finderRoot);
        }
        await tester.tap(find.byKey(const ValueKey('super-group-lead')));
        await tester.pumpAndSettle();
        expect(c.devicesSelected, isFalse);
        expectPreview();
        expect(f.app.swarms.map((tab) => tab.id), tabs);
      }
      expect(
        f.connection.calls.where(
          (call) => call.$1 == 'agent_create' || call.$1 == 'agent_resume',
        ),
        isEmpty,
      );
      expect(tester.takeException(), isNull);
      await _dispose(tester, f, c);
    });
  }

  testWidgets(
    'Devices keeps a user-adjusted split after visiting a two-agent workgroup',
    (tester) async {
      final (f, c) = await _mount(tester, agents: 2);
      final tab = f.app.activeSwarm;
      expect(tab.panes.map((pane) => pane.agentId), ['native-0', 'native-1']);
      c.selectDevices();
      await tester.pumpAndSettle();
      final resized = PaneArrangement(const [
        Rect.fromLTRB(0, 0, .58, 1),
        Rect.fromLTRB(.58, 0, 1, 1),
      ]);
      tab.arrangedKey = '2:manual';
      expect(f.app.resizePanes(tab.id, '2:manual', resized), isTrue);
      expect(tab.paneSizes['2:manual']!.tiles.first.right, .58);
      c.select('lead');
      await tester.pumpAndSettle();
      expect(tab.panes.map((pane) => pane.agentId), ['native-0', 'native-1']);
      c.selectDevices();
      await tester.pumpAndSettle();
      expect(tab.panes.where((pane) => pane.isDevices), hasLength(1));
      expect(tab.paneSizes['2:manual']!.tiles.first.right, .58);
      await _dispose(tester, f, c);
    },
  );
}
