// A Finder tile on a computer. The grid imports the Finder through a switch
// that hands a browser a part it downloads later (web/parts/); a computer
// must keep drawing the Finder itself, in the first frame.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/finder/widgets/finder_pane_panel.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/terminal_pane.dart';
import 'package:harness/web/parts/deferred_part.dart';
import 'package:harness/widgets/pane_grid.dart';

void main() {
  testWidgets(
    'a computer draws a Finder tile at once, with nothing to download',
    (tester) async {
      final notifier = AppNotifier(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      );
      notifier.panes.add(
        TerminalPane(
          id: 1,
          machineId: 'm',
          kind: PaneKind.finder,
          finderRoot: '/work/repo',
        ),
      );
      await tester.binding.setSurfaceSize(const Size(1200, 800));
      addTearDown(() => tester.binding.setSurfaceSize(null));

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(body: PaneGrid(notifier: notifier)),
        ),
      );

      expect(
        tester.widget<FinderPanePanel>(find.byType(FinderPanePanel)).root,
        '/work/repo',
      );
      expect(find.byType(DeferredPartView), findsNothing);
      expect(find.text('Loading…'), findsNothing);
    },
  );
}
