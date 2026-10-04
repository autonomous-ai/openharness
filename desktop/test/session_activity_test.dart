import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/session_activity.dart';
import 'package:harness/state/swarm_search.dart';
import 'package:harness/widgets/desktop_chrome.dart';
import 'package:harness/widgets/swarm_switcher.dart';
import 'package:harness/widgets/workspace_welcome.dart';

import 'session_search_rendering_test.dart' show TailConnection;
import 'swarm_state_test.dart' show createApp;

void main() {
  for (final picker in [false, true]) {
    testWidgets(
      '${picker ? 'Cmd-P' : 'Cmd-T'} updates working state in place during a long turn',
      (tester) async {
        final now = tester.binding.clock.now();
        var lastAt = now.subtract(const Duration(minutes: 12));
        bool? working = true;
        const open = true;
        var fail = false;
        var reads = 0;
        final hit = <String, dynamic>{
          'agentId': '',
          'sessionId': 'claude-session',
          'engine': 'claude',
          'field': 'name',
          'snippet': '',
          'lastAt': lastAt.millisecondsSinceEpoch,
          'external': {
            'title': 'Pane connection losses',
            'cwd': '/work/api',
            'origin': 'terminal',
            'open': true,
            'openIn': 'terminal',
          },
        };
        final connection = TailConnection(
          {
            '': [hit],
            'Pane': [hit],
          },
          tail: (_) {
            reads++;
            return fail
                ? {'error': 'OFFLINE'}
                : {
                    'lastAt': lastAt.millisecondsSinceEpoch,
                    'external': {'open': open, 'working': ?working},
                    'rows': <Object>[],
                    'total': 0,
                    'hasMore': false,
                  };
          },
        );
        final app = createApp(
          connected: true,
          connectionForTest: (_) => connection,
        );
        app.machineStates['m']!.agents = [
          Agent(
            id: 'other',
            name: 'Other work',
            engine: 'codex',
            terminalAvailable: true,
            lastOpenedAt: now,
            lastActivityAt: now.subtract(const Duration(minutes: 3)),
          ),
        ];
        addTearDown(app.dispose);
        final search = SwarmSearchController(
          app,
          const [],
          adding: true,
          activityFirst: true,
        );
        addTearDown(search.dispose);
        if (picker) search.setQuery('Pane');
        await tester.pumpWidget(
          MaterialApp(
            home: DesktopChrome(
              child: Scaffold(
                body: picker
                    ? SwarmSearchResults(
                        search: search,
                        onChoose: (_) {},
                        onRefocus: () {},
                        showPreview: false,
                        now: tester.binding.clock.now,
                      )
                    : WorkspaceWelcome(
                        app: app,
                        onCommand: (_) {},
                        onOpen: (_) {},
                        now: tester.binding.clock.now,
                        composerBuilder: (recents) =>
                            recents ?? const SizedBox(),
                      ),
              ),
            ),
          ),
        );
        await tester.pump(const Duration(milliseconds: 200));
        await tester.pumpAndSettle();
        final title = find.text('Pane connection losses');
        final position = tester.getTopLeft(title);
        expect(find.text('Working'), findsOneWidget);
        expect(find.text('12m'), findsNothing);
        final selected = search.selected?.id;

        // A quiet tool can work for minutes without writing another message.
        await tester.pump(const Duration(minutes: 2));
        await tester.pumpAndSettle();
        expect(find.text('Working'), findsOneWidget);
        expect(tester.getTopLeft(title), position);

        working = false;
        lastAt = tester.binding.clock.now();
        await tester.pump(const Duration(seconds: 5));
        await tester.pumpAndSettle();
        expect(find.text('Working'), findsNothing);
        expect(find.text('now'), findsOneWidget);
        expect(tester.getTopLeft(title), position);
        expect(search.selected?.id, selected);

        // Older daemons know the process is open, but cannot say it is working.
        working = null;
        await tester.pump(const Duration(seconds: 5));
        await tester.pumpAndSettle();
        expect(find.text('Open'), findsOneWidget);
        expect(find.text('Working'), findsNothing);
        fail = true;
        await tester.pump(const Duration(seconds: 5));
        await tester.pumpAndSettle();
        expect(find.text('Open'), findsNothing);
        expect(find.text('Working'), findsNothing);

        await tester.pumpWidget(const SizedBox());
        final finishedReads = reads;
        await tester.pump(const Duration(seconds: 30));
        expect(reads, finishedReads);
      },
    );
  }

  test('managed sessions read current activity independently of their ranking snapshot', () async {
    final app = createApp(connected: true);
    addTearDown(app.dispose);
    final machine = app.machineStates['m']!;
    final old = DateTime.utc(2026, 10, 4, 10);
    final latest = old.add(const Duration(minutes: 12));
    machine.agents = [Agent(id: 'a', name: 'Work', engine: 'codex', terminalAvailable: true, lastActivityAt: old)];
    final search = SwarmSearchController(
      app,
      const [],
      adding: true,
      activityFirst: true,
    );
    addTearDown(search.dispose);
    final row = search.rows.singleWhere((row) => row.agentId == 'a');
    expect(search.activityOf(row), old);
    final activity = SessionActivityController(app);
    addTearDown(activity.dispose);
    activity.watch([row]);
    machine.agents = [Agent(id: 'a', name: 'Work', engine: 'codex', terminalAvailable: true, lastActivityAt: latest)];
    machine.processingAgentIds.add('a');
    expect(activity.read(row), (at: latest, status: 'Working'));
    expect(search.activityOf(row), old);
    machine.processingAgentIds.clear();
    expect(activity.read(row), (at: latest, status: null));
  });
}
