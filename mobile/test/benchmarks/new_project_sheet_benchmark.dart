// Run explicitly: flutter test test/benchmarks/new_project_sheet_benchmark.dart --reporter expanded
// Headless CPU measurements of New project's rebuilds, not display latency.
//
// Task #3373 (Guide's review of #3204): the sheet now reads New repository's
// outcome on each rebuild, and its Repository list derives the Swarm's GitHub
// owners. This rebuilds the sheet's form and its Repository list over a Swarm
// of [sizes] projects, each with its own repository, and prints the median and
// p95 of a rebuild in microseconds (60 is the most this fixture loads). It uses
// only what main has too, so the same
// file measures both.
import 'dart:async';

import 'package:flutter/cupertino.dart' show CupertinoPageRoute;
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/swarm/swarm_new_project_sheet.dart';
import 'package:harness_mobile/swarm/swarm_page.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart';
import '../swarm/swarm_fixture.dart';
import '../swarm/swarm_new_project_fixture.dart';

const sizes = [20, 40, 60];
const rebuilds = 200;

/// Three seconds of frames: a long Home list may never settle.
Future<void> settle(WidgetTester tester) async {
  for (var i = 0; i < 30; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
}

void main() {
  for (final size in sizes) {
    for (final page in ['form', 'repository list']) {
      testWidgets('New project $page rebuild, $size projects', (tester) async {
        tester.view.physicalSize = const Size(1170, 2532);
        tester.view.devicePixelRatio = 3;
        addTearDown(tester.view.reset);
        final swarm = NewProjectSwarm(
          projects: [
            for (var i = 0; i < size; i++)
              swarmProject(
                i == 0 ? project : 'bench-$i',
                'Project $i',
                repo: 'https://github.com/org-${i % 7}/repo-$i',
              ),
          ],
        );
        final features = ExperimentalFeaturesStore(
          storage: MemoryKeyValueStore(),
        )..value = {PhoneExperiment.swarm};
        final host = SwarmHost(
          accountId: () => me,
          account: ValueNotifier<String?>(me),
          request: newProjectBackend([swarm]).request,
          notices: SilentSystemNotices(),
          features: features,
          readMarks: MemoryKeyValueStore(),
        )..foreground = false;
        addTearDown(host.dispose);
        await tester.pumpWidget(
          MaterialApp(
            builder: (context, child) =>
                SwarmScope(notifier: host, child: child!),
            onGenerateRoute: (_) => CupertinoPageRoute<void>(
              builder: (_) => SwarmPage(now: () => newProjectNow),
            ),
          ),
        );
        await settle(tester);
        // A large Swarm's read takes a few more frames.
        for (var i = 0; i < 300; i++) {
          if (host.session?.inbox.reader(tab)?.snapshot != null) break;
          await tester.pump(const Duration(milliseconds: 100));
        }
        // Opened as Home's switcher opens it; with many projects that list
        // builds lazily, so it is opened directly.
        unawaited(
          showSwarmNewProjectSheet(
            tester.element(find.byType(SwarmPage)),
            session: host.session!,
            swarmIds: const [tab],
            now: () => newProjectNow,
          ),
        );
        await settle(tester);
        if (page == 'repository list') {
          await tester.tap(
            find.byKey(const ValueKey('swarm-new-project-repository')),
          );
          await settle(tester);
        }
        final sheet = tester.state(find.byType(SwarmNewProjectSheet));
        final times = <int>[];
        for (var i = 0; i < rebuilds; i++) {
          // ignore: invalid_use_of_protected_member
          sheet.setState(() {});
          final watch = Stopwatch()..start();
          await tester.pump();
          times.add(watch.elapsedMicroseconds);
        }
        times.sort();
        // ignore: avoid_print
        print(
          'new-project $page size=$size '
          'median=${times[times.length ~/ 2]}us '
          'p95=${times[(times.length * 0.95).floor()]}us',
        );
        await tester.pumpWidget(const SizedBox());
      });
    }
  }
}
