import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/phone/phone_status.dart';
import 'package:harness_mobile/phone/status_pill.dart';
import 'package:harness_mobile/phone/terminal_header.dart';

/// The terminal's top bar: *agent* over *folder ⑂ branch*, with the
/// connection state as a dot on the engine mark.
void main() {
  group('the sheet names the folder with its parent, the rest folded', () {
    for (final (cwd, label) in [
      (
        '/Users/dudu/Bitcoin_builder/Grid/autonomous-harness/mobile',
        '~/…/autonomous-harness/mobile',
      ),
      ('/home/tony/work/harness', '~/work/harness'),
      ('/Users/dudu/notes', '~/notes'),
      ('/Users/dudu', '~'),
      ('/root/a/b/c', '~/…/b/c'),
      ('/srv/app', '/srv/app'),
      ('/opt/tools/grid', '/…/tools/grid'),
      (r'C:\Users\tony\code\harness', 'C:/…/code/harness'),
      ('/', '/'),
    ]) {
      test('$cwd → $label', () => expect(projectPathTrail(cwd), label));
    }
  });

  Future<void> pumpHeader(WidgetTester tester, Map<String, dynamic> wire) =>
      tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: TerminalHeader(
              agent: Agent.fromJson({'id': 'a', 'engine': 'claude', ...wire}),
              status: (label: 'Live', tone: PhoneTone.good),
            ),
          ),
        ),
      );

  testWidgets('two lines, and the state on the mark', (tester) async {
    await pumpHeader(tester, {
      'name': 'api',
      'project': {
        'name': 'autonomous-harness',
        'cwd': '/Users/dudu/Bitcoin_builder/Grid/autonomous-harness',
        'branch': 'feat/mobile-ios-android',
      },
    });

    expect(find.text('api'), findsOneWidget);
    expect(find.text('autonomous-harness'), findsOneWidget);
    expect(find.text('feat/mobile-ios-android'), findsOneWidget);
    // No word for the state — the dot says it, and its tooltip.
    expect(find.text('Live'), findsNothing);
    expect(find.byType(StatusDot), findsOneWidget);
    expect(find.byTooltip('Live'), findsOneWidget);
  });

  testWidgets('reads as the desktop\'s pane header does', (tester) async {
    await pumpHeader(tester, {
      'name': 'harness-3',
      'title': 'Worktree and branches organization',
      'project': {
        'name': 'autonomous-harness',
        'cwd': '/Users/dudu/.harness/worktrees/worktree-35ab',
        'root': '/Users/dudu/.harness/worktrees/worktree-35ab',
        'branch': 'harness/3',
        'branchPending': true,
      },
    });

    // The session's title over the CLI's made-up name, the repository over the worktree's
    // folder, and no branch while Harness's placeholder waits for the session's name.
    expect(find.text('Worktree and branches organization'), findsOneWidget);
    expect(find.text('autonomous-harness'), findsOneWidget);
    expect(find.text('worktree-35ab'), findsNothing);
    expect(find.text('harness/3'), findsNothing);
  });
}
