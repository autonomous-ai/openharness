import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/swarm.dart';
import 'package:harness/state/terminal_pane.dart';
import 'package:harness/super_tabs/personal_projects.dart';
import 'package:harness/super_tabs/project_sidebar.dart';
import 'package:harness/super_tabs/swarm_switcher.dart';

import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;

/// The project list's draw time on a big desk of the person's (ENGINEERING
/// §4, review of #3073): [_repos] repos with [_panesPerRepo] panes each across
/// two Macs, every pane open, so the list shows the same rows before and
/// after and the hidden check does its whole walk. Runs only with
/// PERSONAL_SIDEBAR_BENCH set; prints the median and p95 of [_draws] draws.
const _repos = 60, _panesPerRepo = 4, _draws = 400;
final _bench = Platform.environment['PERSONAL_SIDEBAR_BENCH'] != null;

void main() {
  testWidgets('the project list draws as fast with hiding as without', (
    tester,
  ) async {
    if (!_bench) return;
    await tester.binding.setSurfaceSize(const Size(1280, 4000));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final f = SuperTabLaunchFixture();
    final laptop = Machine(
      machineId: 'laptop',
      authMode: MachineAuthMode.remote,
      name: 'Mac laptop',
    );
    f.app.machines = [...f.app.machines, laptop];
    f.app.machineStates['laptop'] = MachineState(laptop)
      ..nodeOnline = true
      ..agentLoadStatus = AgentLoadStatus.loaded;
    var paneId = 20000;
    for (final machine in ['m', 'laptop']) {
      f.app.machineStates[machine]!.agents = [
        for (var r = 0; r < _repos; r++)
          for (var i = 0; i < _panesPerRepo ~/ 2; i++)
            Agent(
              id: '$machine-$r-$i',
              name: 'Agent $r $i',
              engine: 'codex',
              terminalAvailable: true,
              project: AgentProject(
                name: 'repo$r',
                cwd: '/w/repo$r',
                root: '/w/repo$r',
                remote: 'https://github.com/acme/repo$r',
              ),
            ),
      ];
    }
    for (var r = 0; r < _repos; r++) {
      f.app.swarms.add(
        Swarm(id: 'tab$r', name: 'tab$r')
          ..panes.addAll([
            for (final machine in ['m', 'laptop'])
              for (var i = 0; i < _panesPerRepo ~/ 2; i++)
                TerminalPane(
                  id: paneId++,
                  machineId: machine,
                  agentId: '$machine-$r-$i',
                ),
          ]),
      );
    }
    for (final state in f.app.machineStates.values) {
      state.localOnly = true;
    }
    f.connection.server.state
      ..['name'] = 'Personal'
      ..['ownerId'] = 'owner'
      ..['people'] = [
        {'id': 'owner', 'email': 'owner@example.com', 'role': 'owner'},
      ];
    late final List<int> times;
    await tester.runAsync(() async {
      await f.app.superTabs.storage.write('super_tab.personal.owner', tabId);
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Personal');
      PersonalSwarm.of(f.app).id;
      for (var i = 0; i < 20; i++) {
        await Future<void>.microtask(() {});
      }
    });
    final c = (await tester.runAsync(() async {
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      await PersonalProjects.of(f.app).sync(c);
      await c.refresh();
      return c;
    }))!;
    final redraw = ValueNotifier(0);
    addTearDown(redraw.dispose);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ListenableBuilder(
            listenable: redraw,
            builder: (_, _) => SizedBox(
              width: 260,
              child: ProjectSidebar(
                controller: c,
                app: f.app,
                onSelect: (_) {},
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pump();
    final rows = find.byWidgetPredicate(
      (w) =>
          w.key is ValueKey<String> &&
          (w.key! as ValueKey<String>).value.startsWith('super-project-'),
    );
    final listed = rows.evaluate().length;
    times = [];
    final watch = Stopwatch();
    for (var i = 0; i < _draws; i++) {
      redraw.value++;
      watch
        ..reset()
        ..start();
      await tester.pump();
      watch.stop();
      times.add(watch.elapsedMicroseconds);
    }
    times.sort();
    final median = times[times.length ~/ 2];
    // What hiding adds to each draw, timed apart from the draw so a loaded
    // machine moves both alike: the per-row walk the first version did (each
    // project asks for its panes) against the one pass the list makes now.
    final projects = PersonalProjects.of(f.app);
    final leads = [
      for (final project in c.snapshot!.projects) project.leadConversationId,
    ];
    int perRow() {
      var hidden = 0;
      for (final lead in leads) {
        if (projects.panesFor(c, lead).isEmpty) hidden++;
      }
      return hidden;
    }

    final rowTimes = <int>[], passTimes = <int>[];
    for (var i = 0; i < _draws; i++) {
      watch
        ..reset()
        ..start();
      perRow();
      watch.stop();
      rowTimes.add(watch.elapsedMicroseconds);
      watch
        ..reset()
        ..start();
      projects.hiddenIn(c);
      watch.stop();
      passTimes.add(watch.elapsedMicroseconds);
    }
    rowTimes.sort();
    passTimes.sort();
    // ignore: avoid_print
    print(
      'PERSONAL_SIDEBAR_BENCH hidden_check per_row_median_us='
      '${rowTimes[rowTimes.length ~/ 2]} one_pass_median_us='
      '${passTimes[passTimes.length ~/ 2]}',
    );
    final p95 = times[(times.length * 95) ~/ 100];
    // ignore: avoid_print
    print(
      'PERSONAL_SIDEBAR_BENCH projects=${c.snapshot!.projects.length} '
      'listed=$listed panes=${_repos * _panesPerRepo} draws=$_draws '
      'median_us=$median p95_us=$p95',
    );
    await tester.pumpWidget(const SizedBox());
    await tester.runAsync(c.flush);
    f.app.superTabs.dispose();
    await tester.pump();
  });
}
