import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/appearance_prefs_store.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/theme/prompt_style.dart';
import 'package:harness/shared/theme/status_line_style.dart';
import 'package:harness/state/workspace_status.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/widgets/session_work_dialog.dart';

import 'session_git_context_test.dart';
import 'swarm_screen_test.dart' show mount, terminal;
import 'swarm_state_test.dart' show createApp;

void main() {
  for (final native in [false, true]) {
    testWidgets(
      'recent branch opens work history without touching its terminal (native=$native)',
      (tester) async {
        final old = appearancePrefsStore.value;
        appearancePrefsStore.value = old.copyWith(prompt: const PromptPrefs());
        addTearDown(() => appearancePrefsStore.value = old);
        final updates = <Map>[];
        const channel = MethodChannel('harness/swarm_tabs');
        tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          channel,
          (call) async {
            if (call.method == 'update') updates.add(call.arguments as Map);
            return null;
          },
        );
        addTearDown(
          () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
            channel,
            null,
          ),
        );
        final app = createApp();
        addTearDown(app.dispose);
        final git = gitFixture();
        final recent = git['current'] as Map;
        git['state'] = 'multiple';
        git['current'] = null;
        git['checkouts'] = [
          recent,
          {
            ...recent,
            'cwd': '/launch',
            'root': '/launch',
            'branch': 'original',
          },
        ];
        git['recentWork'] = {'project': recent, 'at': '2026-09-27T13:00:00Z'};
        app.stateOf('m')!
          ..agents = [workAgent(git: git)]
          ..nodeOnline = false;
        final input = <TerminalBinaryFrame>[];
        final pane = app.adoptSessionForTest(terminal('hn', input));
        final session = pane.session;
        await mount(tester, app, nativeTabs: native);
        expect(WorkspacePaneContext.focused(app)?.branch, 'hn/preview-fix +1');
        if (native) {
          final fields =
              ((updates.last['focusedContext'] as Map)['fields'] as List)
                  .cast<Map>();
          final payload = fields.singleWhere((p) => p['field'] == 'branch');
          await tester.binding.defaultBinaryMessenger.handlePlatformMessage(
            channel.name,
            const StandardMethodCodec().encodeMethodCall(
              MethodCall('focusedContext', payload),
            ),
            (_) {},
          );
        } else {
          await tester.tap(
            find.byKey(const ValueKey('workspace-context-branch')),
          );
        }
        await tester.pumpAndSettle();
        expect(find.byType(SessionWorkDialog), findsOneWidget);
        expect(
          find.byWidgetPredicate(
            (widget) =>
                widget is ColoredBox &&
                widget.color == grid.AppDesktop.darkVeil,
          ),
          findsOneWidget,
        );
        if (native) expect(updates.last['footerCovered'], isTrue);
        expect(find.textContaining('/silent-beacon'), findsNothing);
        expect(pane.session, same(session));
        expect(input, isEmpty);
        await tester.sendKeyEvent(LogicalKeyboardKey.escape);
        await tester.pumpAndSettle();
        expect(find.byType(SessionWorkDialog), findsNothing);
        expect(pane.session, same(session));
        expect(input, isEmpty);
        await tester.pumpWidget(const SizedBox());
      },
    );
  }

  test('ambiguous workspace text is never decorated as a real branch', () {
    final app = createApp();
    addTearDown(app.dispose);
    app.stateOf('m')!.agents = [workAgent(git: gitFixture(state: 'multiple'))];
    app.adoptSessionForTest(terminal('hn', []));
    final context = WorkspacePaneContext.focused(app)!;
    for (final style in StatusLineStyle.values) {
      final parts = context.format(PromptPrefs(statusStyle: style));
      expect(parts.text, contains('Branches'));
      expect(parts.segments.any((s) => s.branchSymbol), isFalse);
      expect(parts.text, isNot(contains('original')));
    }
  });
}
