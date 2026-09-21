import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'signout_recovery_test.dart' show signOutHost;
import 'support/real_fonts.dart';
import 'swarm_state_test.dart' show MemoryStore;
import 'workspace_account_lifecycle_test.dart'
    show WorkspaceAccountFixture, WorkspaceAccountLogin;

void main() {
  setUpAll(() async {
    await loadRealFonts();
    await (FontLoader(
      'MaterialIcons',
    )..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'))).load();
  });
  for (final brightness in Brightness.values) {
    for (final scale in [1.0, 1.8]) {
      testWidgets(
        'expired session explains the next step in $brightness at $scale',
        (tester) async {
          tester.view.physicalSize = const Size(880, 560);
          tester.view.devicePixelRatio = 1;
          addTearDown(tester.view.resetPhysicalSize);
          addTearDown(tester.view.resetDevicePixelRatio);
          final cli = WorkspaceAccountLogin();
          final app = WorkspaceAccountFixture(MemoryStore(), cli);
          var disposed = false;
          void disposeApp() {
            if (disposed) return;
            disposed = true;
            app.dispose();
          }

          addTearDown(disposeApp);
          await app.expire();
          final boundary = GlobalKey();
          await tester.pumpWidget(
            RepaintBoundary(
              key: boundary,
              child: signOutHost(app, brightness: brightness, scale: scale),
            ),
          );
          await tester.pump();
          expect(find.text('Sign in'), findsOneWidget);
          expect(find.text('Could not sign in'), findsNothing);
          expect(find.text('Try again'), findsNothing);
          final notice = find.textContaining('You were signed out');
          expect(notice, findsOneWidget);
          expect(tester.getRect(notice).bottom, lessThanOrEqualTo(544));
          expect(
            tester.getRect(find.text('Sign in')).top,
            greaterThanOrEqualTo(16),
          );
          final directory = Platform.environment['HARNESS_AUTH_CAPTURE_DIR'];
          if (directory != null) {
            await tester.runAsync(
              () => precacheImage(
                const AssetImage('assets/app_icon.png'),
                boundary.currentContext!,
              ),
            );
            await tester.pump(const Duration(milliseconds: 300));
            final render =
                boundary.currentContext!.findRenderObject()!
                    as RenderRepaintBoundary;
            await tester.runAsync(() async {
              final image = await render.toImage(pixelRatio: 1);
              final bytes = await image.toByteData(
                format: ui.ImageByteFormat.png,
              );
              await Directory(directory).create(recursive: true);
              await File('$directory/expired-${brightness.name}-$scale.png')
                  .writeAsBytes(bytes!.buffer.asUint8List());
              image.dispose();
            });
          }
          await tester.sendKeyEvent(LogicalKeyboardKey.enter);
          await tester.pumpAndSettle();
          expect(cli.logins, 1);
          expect(app.sessionExpired, isFalse);
          expect(tester.takeException(), isNull);
          await tester.pumpWidget(const SizedBox());
          disposeApp();
        },
      );
    }
  }
}
