import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/app_shell.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/widgets/bootstrapping_screen.dart';

import 'boot_flow_widget_test.dart' show makeNotifier;

// Task #3563: the first frame draws only the window's own colour. The app
// state, its bootstrap and the screen over it are built on the next frame, so
// the first frame does not wait for what is not on screen yet.
void main() {
  Future<({AppNotifier app, bool Function() created})> mount(
    WidgetTester tester,
    AppStatus status, {
    bool defer = true,
  }) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(1280, 800);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final app = makeNotifier(status);
    addTearDown(app.dispose);
    var created = false;
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          appStateProvider.overrideWith((ref) {
            created = true;
            return app;
          }),
        ],
        child: HarnessApp(
          deferFirstScreen: defer,
          authenticatedScreen: (_) =>
              const Scaffold(body: Center(child: Text('Workspace'))),
        ),
      ),
    );
    return (app: app, created: () => created);
  }

  testWidgets('the first frame builds no app state and no screen', (
    tester,
  ) async {
    final mounted = await mount(tester, AppStatus.bootstrapping);
    expect(mounted.created(), isFalse);
    expect(find.byType(RootShell), findsNothing);
    expect(find.byType(BootstrappingScreen), findsNothing);
    expect(find.byKey(const Key('first-frame-placeholder')), findsOneWidget);
  });

  testWidgets('the next frame builds the app state and the boot screen', (
    tester,
  ) async {
    final mounted = await mount(tester, AppStatus.bootstrapping);
    await tester.pump();
    expect(mounted.created(), isTrue);
    expect(find.byType(RootShell), findsOneWidget);
    expect(find.byType(BootstrappingScreen), findsOneWidget);
    expect(find.byKey(const Key('first-frame-placeholder')), findsNothing);
  });

  testWidgets('what was deferred still appears once loaded', (tester) async {
    await mount(tester, AppStatus.authenticated);
    expect(find.text('Workspace'), findsNothing);
    await tester.pump();
    expect(find.text('Workspace'), findsOneWidget);
    // And it stays: later frames never bring the placeholder back.
    await tester.pump(const Duration(seconds: 1));
    expect(find.text('Workspace'), findsOneWidget);
    expect(find.byKey(const Key('first-frame-placeholder')), findsNothing);
  });

  testWidgets('without deferral the first frame holds the whole screen', (
    tester,
  ) async {
    final mounted = await mount(tester, AppStatus.authenticated, defer: false);
    expect(mounted.created(), isTrue);
    expect(find.text('Workspace'), findsOneWidget);
    expect(find.byKey(const Key('first-frame-placeholder')), findsNothing);
  });
}
