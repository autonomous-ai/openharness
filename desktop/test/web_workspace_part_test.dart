import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/web/parts/deferred_part.dart';
import 'package:harness/web/parts/terminal_fonts.dart';
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

  test('the workspace part waits for the terminal font as well', () async {
    final library = Completer<void>();
    final fonts = Completer<void>();
    var done = false;
    unawaited(
      downloadWorkspace(
        library: () => library.future,
        fonts: () => fonts.future,
      ).then((_) => done = true),
    );

    library.complete();
    await pumpEventQueue();
    expect(done, isFalse);

    fonts.complete();
    await pumpEventQueue();
    expect(done, isTrue);
  });

  test('a terminal font that fails does not keep the workspace away', () async {
    await downloadWorkspace(
      library: () async {},
      fonts: () => Future.error(Exception('offline')),
    );
  });

  test('fonts that never arrive hold the workspace only so long', () async {
    final stalled = Completer<void>();
    var done = false;
    unawaited(
      downloadWorkspace(
        library: () async {},
        fonts: () => stalled.future,
        fontsGrace: const Duration(milliseconds: 50),
      ).then((_) => done = true),
    );

    await pumpEventQueue();
    expect(done, isFalse);

    await Future<void>.delayed(const Duration(milliseconds: 100));
    expect(done, isTrue);
  });

  test('a workspace library that fails fails the part', () async {
    await expectLater(
      downloadWorkspace(
        library: () => Future.error(Exception('offline')),
        fonts: () async {},
      ),
      throwsException,
    );
  });

  test('the icon face does not hold the text face', () async {
    final text = Completer<void>();
    final icons = Completer<void>();
    var done = false;
    unawaited(
      loadTextFaceFirst(
        text: text.future,
        icons: icons.future,
      ).then((_) => done = true),
    );

    await pumpEventQueue();
    expect(done, isFalse);

    text.complete();
    await pumpEventQueue();
    expect(done, isTrue);

    icons.complete();
    await pumpEventQueue();
  });

  test('an icon face that fails still lets the text face finish', () async {
    await loadTextFaceFirst(
      text: Future<void>.value(),
      icons: Future<void>.error(Exception('offline')),
    );
    await pumpEventQueue();
  });

  test('the terminal font files are in the bundle the browser reads', () async {
    TestWidgetsFlutterBinding.ensureInitialized();
    expect(terminalFontAssets, hasLength(2));
    for (final asset in [...terminalFontAssets, terminalIconFontAsset]) {
      final bytes = await rootBundle.load(asset);
      // A TrueType file opens with its version, 0x00010000.
      expect(bytes.getUint32(0), 0x00010000, reason: asset);
    }
  });
}
