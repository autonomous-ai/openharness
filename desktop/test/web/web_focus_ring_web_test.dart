@TestOn('browser')
library;

// The browser build's frame draws the keyboard focus ring (P8).
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/web/parts/workspace_part.dart';
import 'package:harness/web/web_entry.dart';

void main() {
  testWidgets('Tab in the web app draws the ring; a click puts it away', (
    tester,
  ) async {
    final app = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
    );
    addTearDown(app.dispose);
    // Under the app's ProviderScope, as `startHarness` runs it.
    await tester.pumpWidget(
      ProviderScope(
        overrides: [appStateProvider.overrideWithValue(app)],
        child: appFrame(
          MaterialApp(
            theme: grid.buildAppTheme(brightness: Brightness.dark),
            home: Scaffold(
              body: Column(
                children: [
                  FilledButton(
                    autofocus: true,
                    onPressed: () {},
                    child: const Text('First'),
                  ),
                  OutlinedButton(onPressed: () {}, child: const Text('Second')),
                ],
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pump();
    final ring = find.byKey(const Key('web-focus-ring'));
    expect(ring, findsNothing);
    await tester.sendKeyEvent(LogicalKeyboardKey.tab);
    await tester.pump();
    await tester.pump();
    expect(ring, findsOneWidget);
    await tester.tapAt(const Offset(5, 500));
    await tester.pump();
    expect(ring, findsNothing);
    // The frame's first frame started the workspace's download; a test build
    // has no part to fetch, so it lands on the next timer.
    await tester.pump(const Duration(milliseconds: 1));
    expect(workspacePart.loaded, isTrue);
  });
}
