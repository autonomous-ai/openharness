import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/phone/phone_status.dart';
import 'package:harness_mobile/phone/status_pill.dart';
import 'package:harness_mobile/phone/terminal_header.dart';
import 'package:harness_mobile/phone/terminal_place_line.dart';

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
              machineName: 'MacBookPro2021.local',
            ),
          ),
        ),
      );

  testWidgets(
    'one line: the name, then the machine, and the state on the mark',
    (tester) async {
      await pumpHeader(tester, {
        'name': 'api',
        'project': {
          'name': 'autonomous-harness',
          'cwd': '/srv/autonomous-harness',
          'branch': 'feat/mobile-ios-android',
        },
      });

      expect(find.text('api'), findsOneWidget);
      expect(find.text('MacBookPro2021.local'), findsOneWidget);
      // The folder and branch are in the ⋮ sheet: the header floats over the
      // terminal, and every line it takes is a line of output.
      expect(find.text('autonomous-harness'), findsNothing);
      expect(find.text('feat/mobile-ios-android'), findsNothing);
      // No word for the state — the dot says it, and its tooltip.
      expect(find.text('Live'), findsNothing);
      expect(find.byType(StatusDot), findsOneWidget);
      expect(find.byTooltip('Live'), findsOneWidget);
    },
  );

  testWidgets('the name is the session\'s title when it has one', (
    tester,
  ) async {
    await pumpHeader(tester, {
      'name': 'harness-3',
      'title': 'Worktree and branches organization',
      'project': {
        'name': 'autonomous-harness',
        'cwd': '/srv/worktrees/worktree-35ab',
        'root': '/srv/worktrees/worktree-35ab',
        'branch': 'harness/3',
        'branchPending': true,
      },
    });

    expect(find.text('Worktree and branches organization'), findsOneWidget);
  });

  group('the second line shares out only what overruns it', () {
    // Machine, folder, branch — the order they are drawn in, and the order each gives way in.
    const givesWay = [1, 2, 0];

    test('everything whole where it fits', () {
      expect(
        placeWidths(wanted: [100, 90, 80], givesWay: givesWay, free: 300),
        [100, 90, 80],
      );
    });

    test('the branch gives way first, then the machine; the folder last', () {
      expect(
        placeWidths(wanted: [100, 90, 80], givesWay: givesWay, free: 250),
        [100, 90, 60],
      );
      expect(
        placeWidths(wanted: [100, 90, 80], givesWay: givesWay, free: 200),
        [56, 90, kPlaceFloor],
      );
    });

    test('below the floors only once every name is down to its own', () {
      // Then in the same order: the branch first again.
      expect(
        placeWidths(wanted: [100, 90, 80], givesWay: givesWay, free: 150),
        [kPlaceFloor, kPlaceFloor, 42],
      );
    });
  });
}
