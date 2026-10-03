import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/phone/new_agent_draft.dart';
import 'package:harness_mobile/phone/new_agent_page.dart';
import 'package:harness_mobile/state/app_state.dart';

import 'edge_fixture.dart';

/// New — start an agent — laid out at every phone, scale and brightness, empty, full, typing and
/// failed. None may report an overflow.
void main() {
  setUpAll(loadRealFontsIfAsked);
  tearDown(() => newAgentDraft = null);

  /// A repository with a long branch, so the options have something to say.
  const gitAnswer = {
    'git_project_info': {
      'isGit': true,
      'branch': longBranch,
      'root': '/code/$longProject',
      'defaultRef': 'refs/heads/main',
      'branches': [
        {'ref': 'refs/heads/main', 'name': 'main'},
        {'ref': 'refs/heads/$longBranch', 'name': longBranch},
      ],
    },
  };

  Future<void> pumpNew(
    WidgetTester tester,
    AppNotifier app,
    double scale,
    Brightness brightness,
  ) async {
    await tester.pumpWidget(
      phoneApp(
        NewAgentPage(notifier: app, machineId: 'm', voice: edgeVoice().voice),
        textScale: scale,
        brightness: brightness,
      ),
    );
    await frames(tester);
  }

  testWidgets('a machine with nothing running and no project yet', (
    tester,
  ) async {
    await expectNoLayoutErrors(tester, (scale, brightness) async {
      final app = edgeApp(agents: []);
      addTearDown(app.dispose);
      await pumpNew(tester, app, scale, brightness);
      expect(find.text('Choose a project', findRichText: true), findsWidgets);
    });
  });

  testWidgets('long names everywhere, 200 agents, every option shown', (
    tester,
  ) async {
    await expectNoLayoutErrors(tester, (scale, brightness) async {
      final app = edgeApp(
        machineName: longMachine,
        conn: EdgeConn(gitAnswer),
        agents: [
          edgeAgent('a', name: longName, project: longProject),
          ...manyAgents(199),
        ],
      );
      addTearDown(app.dispose);
      await pumpNew(tester, app, scale, brightness);
      await tapInView(tester, find.text('options'));
      await frames(tester);
    });
  });

  testWidgets('typing a long task with the keyboard up', (tester) async {
    await expectNoLayoutErrors(tester, (scale, brightness) async {
      final app = edgeApp(
        machineName: longMachine,
        agents: [edgeAgent('a', project: longProject)],
      );
      addTearDown(app.dispose);
      await pumpNew(tester, app, scale, brightness);
      await tester.enterText(
        find.byType(TextField),
        List.filled(40, 'fix the login test $emojiName $rtlName').join(' '),
      );
      raiseKeyboard(tester);
      await frames(tester);
      lowerKeyboard(tester);
      await frames(tester);
    });
  });

  testWidgets(
    'on an SE at the largest text size, typing keeps Start on screen above the keys',
    (tester) async {
      setPhone(tester, smallPhone);
      final app = edgeApp(agents: [edgeAgent('a')]);
      addTearDown(app.dispose);
      await pumpNew(tester, app, 19 / 14, Brightness.dark);
      await tester.enterText(
        find.byType(TextField),
        List.filled(12, 'fix the login test and run the suite').join(' '),
      );
      raiseKeyboard(tester);
      await frames(tester);

      // Before: the dock overflowed by 10px here and Start fell under the keyboard.
      expect(tester.takeException(), isNull);
      final start = tester.getRect(find.text('Start'));
      expect(
        start.bottom,
        lessThanOrEqualTo(smallPhone.size.height - smallPhone.keyboard),
      );
      await tester.tap(find.text('Start'), warnIfMissed: true);
      lowerKeyboard(tester);
      await unmount(tester);
    },
  );

  testWidgets('a creation the machine refused', (tester) async {
    await expectNoLayoutErrors(tester, (scale, brightness) async {
      final app = edgeApp(
        conn: EdgeConn(const {
          'agent_create': {
            'error': {
              'code': 'INVALID_CWD',
              'message':
                  'The project folder is unavailable on this machine. Choose another '
                  'folder and try again, or check that the disk is mounted.',
            },
          },
        }),
        agents: [edgeAgent('a', project: longProject)],
      );
      addTearDown(app.dispose);
      await pumpNew(tester, app, scale, brightness);
      await tester.tap(find.text('Start'));
      await frames(tester);
    });
  });
}
