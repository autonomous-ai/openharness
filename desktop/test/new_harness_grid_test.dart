import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shortcuts/app_keymap.dart';
import 'package:harness/shortcuts/keymap_host.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/widgets/new_harness_form.dart';
import 'package:harness/ws/ws_conn.dart';

import 'keymap_host_test.dart' show MemoryKeymap, key;
import 'support/launch_menu.dart' show focusLaunchRow;
import 'support/mixed_agents.dart';
import 'swarm_state_test.dart' show createApp;

/// Records what the form asks the daemon for, so a test can tell whether a
/// key STARTED an agent rather than inferring it from the screen.
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

  final requests = <String>[];

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    requests.add(type);
    if (type == 'engines_probe') return {'engines': []};
    if (type == 'dsh_list') return {'dsh': []};
    if (type == 'git_project_info') {
      return {
        'isGit': true,
        'branch': 'main',
        'branches': [
          {'ref': 'refs/heads/main', 'name': 'main'},
        ],
      };
    }
    return {};
  }
}

void main() {
  Future<(NewHarnessController, _Daemon)> mount(
    WidgetTester tester, {
    String focus = 'agent',
  }) async {
    final daemon = _Daemon();
    final app = createApp(connectionForTest: (_) => daemon);
    seedMixedAgents(app);
    final box = NewHarnessController(
      app,
      machineId: 'm',
      folder: '/work/harness-app-landing-page',
    );
    addTearDown(app.dispose);
    addTearDown(box.dispose);
    final keymap = MemoryKeymap();
    await tester.pumpWidget(
      MaterialApp(
        theme: ThemeData.dark(),
        home: KeymapProvider(
          keymap: keymap,
          child: KeymapHost(
            keymap: keymap,
            enabled: () => true,
            actions: const {},
            child: Scaffold(
              body: Center(
                child: SizedBox(
                  width: 820,
                  height: 450,
                  child: NewHarnessForm(
                    controller: box,
                    onClose: () {},
                    onCreated: () {},
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await focusLaunchRow(tester, focus);
    return (box, daemon);
  }

  group('⇧⏎ starts from any field', () {
    testWidgets('from a value row, without walking to the button', (
      tester,
    ) async {
      final (_, daemon) = await mount(tester);
      await key(tester, LogicalKeyboardKey.enter);
      expect(
        daemon.requests,
        isNot(contains('agent_create')),
        reason: 'Plain Return on a value row must still never start.',
      );
      await key(tester, LogicalKeyboardKey.enter, shift: true);
      expect(daemon.requests, contains('agent_create'));
    });

    testWidgets('taking the value highlighted in a live list first', (
      tester,
    ) async {
      final (box, daemon) = await mount(tester);
      await key(tester, LogicalKeyboardKey.arrowRight);
      await key(tester, LogicalKeyboardKey.arrowDown);
      final wanted = box.selected!.id;
      expect(wanted, isNot(box.engine));
      await key(tester, LogicalKeyboardKey.enter, shift: true);
      expect(
        box.engine,
        wanted,
        reason: 'The highlight is what the person was looking at.',
      );
      expect(daemon.requests, contains('agent_create'));
    });

    testWidgets('the button prints the key that reaches it', (tester) async {
      await mount(tester);
      expect(find.text('[ New Harness ]'), findsOneWidget);
      expect(find.textContaining('⇧'), findsWidgets);
    });
  });

  group('one grid', () {
    double heightOf(WidgetTester tester, String field) =>
        tester.getSize(find.byKey(ValueKey('new-harness-field-$field'))).height;

    testWidgets('every field is exactly one row', (tester) async {
      await mount(tester);
      final row = heightOf(tester, 'agent');
      for (final field in ['harness', 'model', 'machine', 'project']) {
        expect(heightOf(tester, field), row, reason: '$field drifted');
      }
    });

    testWidgets('a wrapped notice is a whole number of rows', (tester) async {
      final (box, _) = await mount(tester, focus: 'model');
      final row = heightOf(tester, 'agent');
      final notice = box.modelNotice;
      expect(notice, isNotNull);
      final height = tester.getSize(find.text(notice!)).height;
      expect(height / row, closeTo((height / row).roundToDouble(), .01));
      expect(height, greaterThan(row), reason: 'The fixture wraps it.');
    });

    testWidgets('the right pane has one text column', (tester) async {
      final (box, _) = await mount(tester, focus: 'model');
      double left(Finder finder) => tester.getTopLeft(finder).dx;
      final column = left(find.byKey(const ValueKey('new-harness-query')));
      expect(left(find.text(box.modelNotice!)), closeTo(column, .5));
      expect(left(find.text('Subscription')), closeTo(column, .5));
      expect(left(find.text('Refresh models')), closeTo(column, .5));
    });

    testWidgets('every value on the left starts on one column', (tester) async {
      final (box, _) = await mount(tester);
      // The same words can be a choice on the right; look inside each field.
      double left(String field, String text) => tester
          .getTopLeft(
            find.descendant(
              of: find.byKey(ValueKey('new-harness-field-$field')),
              matching: find.text(text),
            ),
          )
          .dx;
      final column = left('agent', box.agentLabel);
      expect(left('machine', box.machineLabel), closeTo(column, .5));
      expect(left('project', box.projectLabel), closeTo(column, .5));
    });

    testWidgets('a blank row sets Advanced apart from the core fields', (
      tester,
    ) async {
      await mount(tester);
      // Branch is the last core field now, under Project.
      final project = tester.getRect(
        find.byKey(const ValueKey('new-harness-field-branch')),
      );
      final advanced = tester.getRect(
        find.byKey(const ValueKey('new-harness-field-advanced')),
      );
      expect(advanced.top - project.bottom, closeTo(project.height, .5));
    });
  });

  group('small reads', () {
    testWidgets('the hint sits against the caret, with no space between', (
      tester,
    ) async {
      final (box, _) = await mount(tester);
      await key(tester, LogicalKeyboardKey.arrowRight);
      final hint = tester
          .widget<TextField>(find.byKey(const ValueKey('new-harness-query')))
          .decoration!
          .hintText!;
      expect(hint, isNot(startsWith(' ')));
      expect(hint, 'Search ${box.field.name}');
    });

    testWidgets('the key hint spaces its keys: ⇧ ⏎, not ⇧⏎', (tester) async {
      await mount(tester);
      final hint = find.textContaining('⇧');
      expect(tester.widget<Text>(hint).data, startsWith('⇧ '));
    });

    testWidgets('this computer leads the machine list', (tester) async {
      final (box, _) = await mount(tester, focus: 'machine');
      // Make the machine that lists LAST the local one, so this passes only
      // if the list really moves it to the top.
      final last = box.options.lastWhere((row) => !row.synthetic);
      expect(last.id, isNot(box.options.first.id));
      box.app.stateOf(last.id)!.localOnly = true;
      box.focusField(NewHarnessField.agent);
      box.focusField(NewHarnessField.machine);
      await tester.pumpAndSettle();
      expect(box.options.firstWhere((row) => !row.synthetic).id, last.id);
    });

    testWidgets('usable machines come before unusable ones', (tester) async {
      final (box, _) = await mount(tester, focus: 'machine');
      final rows = box.options.where((row) => !row.synthetic).toList();
      final firstUnusable = rows.indexWhere((row) => !row.enabled);
      expect(firstUnusable, isNonNegative, reason: 'fixture has one');
      expect(
        rows.skip(firstUnusable).every((row) => !row.enabled),
        isTrue,
        reason: 'No usable machine may follow an unusable one.',
      );
    });

    testWidgets('Terminal needs no gloss', (tester) async {
      await mount(tester);
      expect(find.text('A shell, no agent'), findsNothing);
    });
  });
}
