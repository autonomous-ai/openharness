import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/agent_output_stats.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/phone/agent_index.dart';
import 'package:harness_mobile/phone/compact_age.dart';
import 'package:harness_mobile/phone/sheet_agent_lines.dart';
import 'package:harness_mobile/state/app_state.dart';

/// An agent's row in the sheet reads as the desktop's Harness Monitor reads it.
void main() {
  final now = DateTime.utc(2026, 9, 23, 12);

  AgentEntry entryOf(Agent agent) => AgentEntry(
    machine: MachineState(
      const Machine(
        machineId: 'm',
        authMode: MachineAuthMode.remote,
        name: 'MacBookPro2021.local',
      ),
    )..nodeOnline = true,
    agent: agent,
  );

  Map<String, dynamic> wire({Object? tokenUsage, Object? outputStats}) => {
    'id': 'a',
    'name': 'api',
    'engine': 'claude',
    'tokenUsage': ?tokenUsage,
    'outputStats': ?outputStats,
  };

  group('what the machine measured', () {
    test('is read as the desktop reads it', () {
      final agent = Agent.fromJson(
        wire(
          tokenUsage: {
            'totalTokens': 4500000,
            'updatedAt': '2026-09-23T11:00:00Z',
          },
          outputStats: {
            'linesAdded': 120,
            'linesRemoved': 48,
            'pullRequestsCreated': 2,
          },
        ),
      );
      expect(agent.tokensUsed, 4500000);
      expect(agent.tokensUpdatedAt, DateTime.utc(2026, 9, 23, 11));
      expect(agent.outputStats?.linesAdded, 120);
      expect(agent.outputStats?.pullRequestsCreated, 2);
      expect(agent.hasMonitorStats, isTrue);
    });

    test('drops what no count could be, and half an edit pair', () {
      final agent = Agent.fromJson(
        wire(
          tokenUsage: {'totalTokens': -1},
          outputStats: {'linesAdded': 3},
        ),
      );
      expect(agent.tokensUsed, isNull);
      expect(agent.outputStats, isNull);
      expect(agent.hasMonitorStats, isFalse);
    });
  });

  test('counts and ages are the desktop\'s strings', () {
    expect(formatCount(980), '980');
    expect(formatCount(12300), '12.3k');
    expect(formatCount(4500000), '4.5M');
    expect(harnessActivityAge(now.subtract(const Duration(minutes: 49)), now), '49m');
    expect(harnessActivityAge(now.subtract(const Duration(hours: 21)), now), '21h');
    expect(harnessActivityAge(now.subtract(const Duration(days: 9)), now), '9d');
    expect(harnessActivityAge(null, now), '—');
  });

  testWidgets('a row says its age, its trouble, its place and its output', (
    tester,
  ) async {
    final entry = entryOf(
      Agent(
        id: 'a',
        name: 'Respond to greeting',
        engine: 'claude',
        updatedAt: now.subtract(const Duration(minutes: 50)),
        launchState: 'failed',
        project: const AgentProject(
          name: 'autonomous-harness',
          cwd: '/work/autonomous-harness',
          branch: 'main',
        ),
        tokensUsed: 4500000,
        outputStats: const AgentOutputStats(
          linesAdded: 120,
          linesRemoved: 48,
          pullRequestsCreated: 1,
        ),
      ),
    );
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Column(
            children: [
              SheetAgentTitle(
                entry: entry,
                name: const Text('Respond to greeting'),
                now: now,
              ),
              SheetAgentMeta(entry: entry),
            ],
          ),
        ),
      ),
    );

    expect(find.text('· 50m'), findsOneWidget);
    expect(find.text('Start failed'), findsOneWidget);
    expect(find.text('MacBookPro2021.local'), findsOneWidget);
    expect(find.text('autonomous-harness'), findsOneWidget);
    expect(find.text('main'), findsOneWidget);
    expect(
      find.textContaining('4.5M tokens', findRichText: true),
      findsOneWidget,
    );
    expect(find.textContaining('+120 −48', findRichText: true), findsOneWidget);
    expect(find.textContaining('1 PR', findRichText: true), findsOneWidget);
  });
}
