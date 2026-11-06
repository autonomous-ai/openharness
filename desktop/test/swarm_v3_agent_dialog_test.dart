import 'dart:async';
import 'dart:io';

import 'support/capture.dart';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/join/agent_dialog.dart';
import 'package:harness/widgets/desktop_chrome.dart';

Future<void> mount(
  WidgetTester tester, {
  bool bringing = false,
  Brightness brightness = Brightness.light,
  List<String> engines = const ['claude', 'codex'],
  required SwarmAgentCreate create,
  bool Function()? current,
}) async {
  grid.AppTheme.brightness.value = brightness;
  addTearDown(() => grid.AppTheme.brightness.value = Brightness.light);
  await tester.pumpWidget(
    MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: grid.buildAppTheme(brightness: brightness),
      home: Builder(
        builder: (context) => Scaffold(
          body: TextButton(
            onPressed: () => showDialog<Map<String, dynamic>>(
              context: context,
              builder: (_) => SwarmAgentDialog(
                bringing: bringing,
                engines: engines,
                create: create,
                isCurrent: current ?? () => true,
              ),
            ),
            child: const Text('Open'),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('Open'));
  await tester.pumpAndSettle();
}

void main() {
  final shots = Platform.environment['HARNESS_V3_JOIN_SHOTS'];
  setUpAll(() => loadCaptureFonts(shots));
  for (final brightness in Brightness.values) {
    testWidgets('new agent forms fit in ${brightness.name}', (tester) async {
      await tester.binding.setSurfaceSize(const Size(1000, 760));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await mount(
        tester,
        brightness: brightness,
        create: (_, _, _, _) async => {'startId': 'one'},
      );
      final segments = tester.widget<SegmentedButton<String>>(find.byType(SegmentedButton<String>));
      expect(segments.style?.foregroundColor?.resolve({WidgetState.selected}), DesktopChrome.onSelection);
      expect(tester.takeException(), isNull);
      await captureWindow(tester, shots, 'new-regular-${brightness.name}');
      await tester.tap(find.text('PM'));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const Key('swarm-agent-project')),
        'My project',
      );
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      await captureWindow(tester, shots, 'new-pm-${brightness.name}');
    });
  }

  testWidgets('bringing an agent picks its engine and makes it the Buddy', (
    tester,
  ) async {
    final submitted = <(String, String, String?)>[];
    await mount(
      tester,
      bringing: true,
      create: (engine, kind, project, operation) async {
        submitted.add((engine, kind, project));
        return {'agentId': 'buddy'};
      },
    );
    expect(find.text('Bring your agent'), findsOneWidget);
    expect(find.textContaining('Team account'), findsNothing);
    expect(find.textContaining('Add machine'), findsNothing);
    expect(find.text('Regular'), findsNothing);
    await tester.tap(find.byKey(const Key('swarm-agent-engine')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Codex').last);
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('swarm-agent-submit')));
    await tester.pumpAndSettle();
    expect(submitted, [('codex', 'buddy', null)]);
    expect(find.text('Bring your agent'), findsNothing);
  });

  testWidgets('Regular has no project; PM requires a trimmed project name', (
    tester,
  ) async {
    final submitted = <(String, String, String?)>[];
    Future<Map<String, dynamic>> create(
      String e,
      String k,
      String? p,
      String op,
    ) async {
      submitted.add((e, k, p));
      return {'agentId': k};
    }

    await mount(tester, create: create);
    expect(find.byKey(const Key('swarm-agent-project')), findsNothing);
    await tester.tap(find.byKey(const Key('swarm-agent-submit')));
    await tester.pumpAndSettle();
    expect(submitted.single, ('claude', 'regular', null));
    await mount(tester, create: create);
    await tester.tap(find.text('PM'));
    await tester.pumpAndSettle();
    expect(
      tester
          .widget<FilledButton>(find.byKey(const Key('swarm-agent-submit')))
          .onPressed,
      isNull,
    );
    await tester.enterText(
      find.byKey(const Key('swarm-agent-project')),
      '  Compiler  ',
    );
    await tester.pump();
    await tester.tap(find.byKey(const Key('swarm-agent-submit')));
    await tester.pumpAndSettle();
    expect(submitted.last, ('claude', 'pm', 'Compiler'));
  });

  testWidgets(
    'lost response retries one operation and never shows raw failures',
    (tester) async {
      final operations = <String>[];
      await mount(
        tester,
        create: (e, k, p, op) async {
          operations.add(op);
          if (operations.length == 1) throw StateError('private-token-value');
          return {'agentId': 'one'};
        },
      );
      await tester.tap(find.byKey(const Key('swarm-agent-submit')));
      await tester.pumpAndSettle();
      expect(find.textContaining('private-token-value'), findsNothing);
      expect(find.text('Retry'), findsOneWidget);
      await tester.tap(find.text('Retry'));
      await tester.pumpAndSettle();
      expect(operations, hasLength(2));
      expect(operations.toSet(), hasLength(1));
    },
  );

  testWidgets('no local engine cannot launch and explains how to recover', (
    tester,
  ) async {
    await mount(
      tester,
      engines: [],
      create: (e, k, p, op) async => throw StateError('must not launch'),
    );
    expect(find.textContaining('Install'), findsOneWidget);
    expect(
      tester
          .widget<FilledButton>(find.byKey(const Key('swarm-agent-submit')))
          .onPressed,
      isNull,
    );
  });

  testWidgets(
    'pending submission is single and account changes invalidate it',
    (tester) async {
      final answer = Completer<Map<String, dynamic>>();
      var calls = 0, current = true;
      await mount(
        tester,
        current: () => current,
        create: (e, k, p, op) {
          calls++;
          return answer.future;
        },
      );
      await tester.tap(find.byKey(const Key('swarm-agent-submit')));
      await tester.pump();
      await tester.tap(find.byKey(const Key('swarm-agent-submit')));
      expect(calls, 1);
      current = false;
      answer.complete({'agentId': 'old-account'});
      await tester.pumpAndSettle();
      expect(find.text('New agent'), findsOneWidget);
      expect(find.textContaining('account changed'), findsOneWidget);
    },
  );
}
