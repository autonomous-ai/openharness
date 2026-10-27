import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/web/parts/deferred_part.dart';
import 'package:harness/web/parts/workspace_part.dart';
import 'package:harness/web/shell/web_workspace.dart';

import 'swarm_state_test.dart' show createApp;

void main() {
  testWidgets('the signed-in workspace waits for its part, then draws', (
    tester,
  ) async {
    final app = createApp(connected: true);
    addTearDown(app.dispose);
    tester.view.physicalSize = const Size(1280, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: DeferredWorkspace(app: app),
      ),
    );
    expect(find.text('Loading…'), findsOneWidget);
    expect(find.byType(WebWorkspace), findsNothing);

    // A native test has no part to fetch; loadLibrary answers on a timer.
    await tester.pump(const Duration(milliseconds: 1));

    expect(find.byType(WebWorkspace), findsOneWidget);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('the workspace starts downloading with the first frame, once', (
    tester,
  ) async {
    var asked = 0;
    final part = DeferredPart(() async => asked++);

    await tester.pumpWidget(
      WorkspacePrefetch(part: part, child: const SizedBox.shrink()),
    );
    expect(asked, 1);

    // The frame is rebuilt with the app; it asks once.
    await tester.pumpWidget(
      WorkspacePrefetch(part: part, child: const SizedBox()),
    );
    await tester.pump();
    expect(asked, 1);
  });

  testWidgets('a download that fails while nothing waits on it is no error', (
    tester,
  ) async {
    final part = DeferredPart(() => Future.error(Exception('offline')));

    await tester.pumpWidget(
      WorkspacePrefetch(part: part, child: const SizedBox.shrink()),
    );
    await tester.pump();

    expect(tester.takeException(), isNull);
    expect(part.loaded, isFalse);
  });
}
