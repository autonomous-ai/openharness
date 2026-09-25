import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/auth/cli_login.dart';
import 'package:harness/core/config.dart';
import 'package:harness/screens/login_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/terminal/terminal_session.dart';

import 'support/real_fonts.dart';
import 'swarm_state_test.dart' show MemoryStore;

class SignOutFixture extends CliLogin {
  final attempts = <Completer<void>>[];
  var logins = 0;
  @override
  Future<void> logout() {
    final result = Completer<void>();
    attempts.add(result);
    return result.future;
  }

  @override
  Future<void> login({required void Function(String) onAuthorizeUrl}) async {
    logins++;
    throw StateError('Fixture login stopped before any external work.');
  }
}

Widget signOutHost(
  AppNotifier app, {
  Brightness brightness = Brightness.dark,
  double scale = 1,
}) {
  grid.AppTheme.brightness.value = brightness;
  return MaterialApp(
    debugShowCheckedModeBanner: false,
    theme: grid.buildAppTheme(brightness: brightness),
    builder: (context, child) => MediaQuery(
      data: MediaQuery.of(
        context,
      ).copyWith(disableAnimations: true, textScaler: TextScaler.linear(scale)),
      child: child!,
    ),
    home: grid.BrightnessScope(
      child: ListenableBuilder(
        listenable: app,
        builder: (_, _) => LoginScreen(notifier: app),
      ),
    ),
  );
}

AppNotifier signOutApp(SignOutFixture cli, {bool local = false}) => AppNotifier(
  config: AppConfig.dev,
  configStore: null,
  authSession: AuthSession(storage: MemoryStore()),
  cliLogin: cli,
  localManualFixture: local
      ? const LocalManualFixture(
          apiBaseUrl: 'http://127.0.0.1:1',
          apiKey: 'fixture',
          machineId: 'fixture',
          machineName: 'Fixture',
        )
      : null,
)..status = AppStatus.authenticated;

void main() {
  setUpAll(() async {
    await loadRealFonts();
    await (FontLoader(
      'MaterialIcons',
    )..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'))).load();
  });
  test(
    'sign-out waits for credentials, coalesces clicks, and gates sign-in',
    () async {
      final cli = SignOutFixture();
      final app = signOutApp(cli);
      addTearDown(app.dispose);
      var done = false;
      final first = app.logout().then((_) => done = true);
      final second = app.logout();
      await Future<void>.delayed(Duration.zero);
      expect(cli.attempts, hasLength(1));
      expect(done, isFalse);
      await app.login();
      expect(cli.logins, 0);
      cli.attempts.single.complete();
      await first;
      await second;
      expect(app.status, AppStatus.unauthenticated);
      await app.login();
      expect(cli.logins, 1);
    },
  );

  test(
    'disconnecting a development fixture never signs out the real CLI',
    () async {
      final cli = SignOutFixture();
      final app = signOutApp(cli, local: true);
      addTearDown(app.dispose);
      await app.logout();
      expect(cli.attempts, isEmpty);
      expect(app.status, AppStatus.unauthenticated);
    },
  );

  test('one failed terminal close cannot interrupt sign-out', () async {
    final cli = SignOutFixture();
    final app = signOutApp(cli);
    addTearDown(app.dispose);
    final closed = <String>[];
    for (final id in ['broken', 'healthy']) {
      app.adoptSessionForTest(
        TerminalSession(
          machineId: 'fixture',
          agentId: id,
          agentName: id,
          engineId: 'codex',
          send: (type, _) async {
            if (type == 'terminal_close') {
              closed.add(id);
              if (id == 'broken') throw StateError('disconnected fixture');
            }
            return true;
          },
          sendBinary: (_) async => true,
        )..streamId = id,
      );
    }
    final pending = app.logout();
    cli.attempts.single.complete();
    await pending;
    expect(closed, ['broken', 'healthy']);
    expect(app.allPanes, isEmpty);
    expect(app.signingOut, isFalse);
    expect(app.signOutError, isNull);
  });

  for (final brightness in Brightness.values) {
    for (final scale in [1.0, 1.8]) {
      testWidgets(
        'sign-out failure recovers using only the keyboard in $brightness at $scale',
        (tester) async {
          tester.view.physicalSize = const Size(880, 560);
          tester.view.devicePixelRatio = 1;
          addTearDown(tester.view.resetPhysicalSize);
          addTearDown(tester.view.resetDevicePixelRatio);
          final cli = SignOutFixture();
          final app = signOutApp(cli);
          addTearDown(app.dispose);
          final boundary = GlobalKey();
          Future<void> capture(String stage) async {
            final directory = Platform.environment['HARNESS_AUTH_CAPTURE_DIR'];
            if (directory == null) return;
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
              await File('$directory/$stage-${brightness.name}-$scale.png')
                  .writeAsBytes(bytes!.buffer.asUint8List());
              image.dispose();
            });
          }

          final pending = app.logout();
          await tester.pumpWidget(
            RepaintBoundary(
              key: boundary,
              child: signOutHost(app, brightness: brightness, scale: scale),
            ),
          );
          await tester.pump();
          expect(find.text('Signing out…'), findsOneWidget);
          expect(find.text('Sign in'), findsNothing);
          expect(find.text('Cancel'), findsNothing);
          await capture('pending');
          await tester.sendKeyEvent(LogicalKeyboardKey.enter);
          expect(cli.logins, 0);
          cli.attempts.single.completeError(
            StateError('fixture-private-details'),
          );
          await tester.pump();
          await pending;
          await tester.pump();
          expect(find.text('Retry sign out'), findsOneWidget);
          expect(find.textContaining('could not be cleared'), findsOneWidget);
          for (final content in [
            find.text('Retry sign out'),
            find.textContaining('could not be cleared'),
          ]) {
            expect(tester.getRect(content).bottom, lessThanOrEqualTo(544));
            expect(tester.getRect(content).top, greaterThanOrEqualTo(16));
          }
          expect(find.textContaining('fixture-private-details'), findsNothing);
          await capture('failed');
          await app.login();
          expect(cli.logins, 0);
          await tester.sendKeyEvent(LogicalKeyboardKey.enter);
          await tester.pump();
          expect(cli.attempts, hasLength(2));
          expect(find.text('Signing out…'), findsOneWidget);
          cli.attempts.last.complete();
          await tester.pump();
          await tester.pump();
          expect(find.text('Sign in'), findsOneWidget);
          await capture('ready');
          await tester.sendKeyEvent(LogicalKeyboardKey.enter);
          await tester.pump();
          expect(cli.logins, 1);
          expect(tester.takeException(), isNull);
          await tester.pumpWidget(const SizedBox());
        },
      );
    }
  }
}
