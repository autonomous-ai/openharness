// Optional PNGs: HARNESS_CONNECTION_CAPTURE_DIR=/private/tmp/connection-review
// flutter test test/connection_review_render_test.dart
import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/auth/cli_link.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/widgets/add_phone_dialog.dart';
import 'package:harness/widgets/link_machine_dialog.dart';
import 'package:harness/widgets/link_machine_screen.dart';

import 'box_render_preview_test.dart' show loadPreviewFonts;
import 'support/password_cli.dart';

class _ReviewCli extends PasswordCli {
  String connectError = "Incorrect password. Try again.";
  @override
  Future<CliLinkConnectResult> connect(
    String machineId,
    String password, {
    void Function(String stage)? onProgress,
    String? displayName,
  }) async => CliLinkConnectResult(error: connectError);
}

void main() {
  setUpAll(loadPreviewFonts);
  for (final brightness in Brightness.values) {
    for (final (size, scale) in [
      (const Size(720, 560), 1.0),
      (const Size(720, 560), 2.0),
      (const Size(480, 360), 1.6),
    ]) {
      testWidgets('connection forms ${brightness.name}, $size, $scale text', (
        tester,
      ) async {
        tester.view.devicePixelRatio = 1;
        tester.view.physicalSize = size;
        addTearDown(tester.view.reset);
        final oldBrightness = grid.AppTheme.brightness.value;
        grid.AppTheme.brightness.value = brightness;
        addTearDown(() => grid.AppTheme.brightness.value = oldBrightness);
        final oldShadows = debugDisableShadows;
        debugDisableShadows = false;
        addTearDown(() => debugDisableShadows = oldShadows);
        final cli = _ReviewCli();
        final multilineError = List.generate(
          12,
          (index) =>
              'Connection diagnostic $index: could not complete the request.',
        ).join('\n');
        if (size.width == 480) cli.connectError = multilineError;
        final app =
            AppNotifier(
                config: AppConfig.dev,
                authSession: AuthSession(),
                configStore: null,
                cliLink: cli,
              )
              ..status = AppStatus.authenticated
              ..signedIn = true
              ..currentUser = const CurrentUserProfile(
                email: 'review@example.test',
              );
        addTearDown(app.dispose);
        const local = Machine(
          machineId: 'local',
          name: 'This Mac',
          authMode: MachineAuthMode.remote,
        );
        const remote = Machine(
          machineId: 'remote',
          name: 'Design Studio',
          authMode: MachineAuthMode.remote,
        );
        app.machines = [local, remote];
        app.machineStates['local'] = MachineState(local)..localOnly = true;
        app.machineStates['remote'] = MachineState(remote)..needsLink = true;
        final boundary = GlobalKey();
        late BuildContext opener;
        await tester.pumpWidget(
          RepaintBoundary(
            key: boundary,
            child: MaterialApp(
              debugShowCheckedModeBanner: false,
              theme: grid.buildAppTheme(brightness: brightness),
              builder: (context, child) => MediaQuery(
                data: MediaQuery.of(context).copyWith(
                  textScaler: TextScaler.linear(scale),
                  disableAnimations: true,
                ),
                child: child!,
              ),
              home: Scaffold(
                body: Builder(
                  builder: (context) {
                    opener = context;
                    return const SizedBox.expand();
                  },
                ),
              ),
            ),
          ),
        );

        Future<void> capture(String name) async {
          expect(tester.takeException(), isNull);
          final directory =
              Platform.environment['HARNESS_CONNECTION_CAPTURE_DIR'];
          if (directory == null) return;
          await tester.runAsync(() async {
            final render =
                boundary.currentContext!.findRenderObject()!
                    as RenderRepaintBoundary;
            final picture = await render.toImage();
            try {
              final bytes = await picture.toByteData(
                format: ui.ImageByteFormat.png,
              );
              await Directory(directory).create(recursive: true);
              await File('$directory/$name-${brightness.name}-$scale.png')
                  .writeAsBytes(bytes!.buffer.asUint8List());
            } finally {
              picture.dispose();
            }
          });
        }

        if (size.width > 480) {
          unawaited(
            showAddPhoneDialog(
              opener,
              app,
              pair: (_, cancel) async {
                await cancel.whenCancel;
                return const PhonePairAnswer.failed('CANCELLED');
              },
              signInCode: () async =>
                  (code: 'synthetic-code', ttl: const Duration(seconds: 90)),
              onManageDevices: () {},
            ),
          );
          await tester.pumpAndSettle();
          expect(find.text('Done').hitTestable(), findsOneWidget);
          expect(find.byType(PhonePairQr).hitTestable(), findsOneWidget);
          await capture('add-phone');
          // The way to the account's devices stays reachable at every size.
          final manage = find.byKey(const ValueKey('add-phone-manage-devices'));
          await tester.ensureVisible(manage);
          expect(manage.hitTestable(), findsOneWidget);
          await tester.tap(find.text('Done'));
          await tester.pumpAndSettle();
        }

        unawaited(showLinkMachineDialog(opener, app));
        await tester.pumpAndSettle();
        expect(find.text('Close').hitTestable(), findsOneWidget);
        await capture('set-password');
        await tester.enterText(
          find.byKey(const Key('remote-password-field')),
          'fixture',
        );
        await tester.enterText(
          find.byKey(const Key('remote-password-confirm-field')),
          'different',
        );
        await tester.ensureVisible(
          find.byKey(const Key('remote-password-set-button')),
        );
        await tester.tap(find.byKey(const Key('remote-password-set-button')));
        await tester.pumpAndSettle();
        expect(cli.passwords, isEmpty);
        expect(
          find.text('Passwords do not match').hitTestable(),
          findsOneWidget,
        );
        await capture('set-password-error');
        if (size.width == 480) {
          cli.setResult = RemotePasswordSetResult(error: multilineError);
          await tester.enterText(
            find.byKey(const Key('remote-password-confirm-field')),
            'fixture',
          );
          await tester.tap(find.byKey(const Key('remote-password-set-button')));
          await tester.pumpAndSettle();
          expect(find.text('Close').hitTestable(), findsOneWidget);
          expect(
            find.byKey(const Key('remote-password-set-button')).hitTestable(),
            findsOneWidget,
          );
          expect(find.text(multilineError), findsOneWidget);
          await capture('set-password-long-error');
        }

        await tester.tap(find.text('Close'));
        await tester.pumpAndSettle();

        unawaited(showLinkMachineScreenDialog(opener, app, 'remote'));
        await tester.pumpAndSettle();
        expect(find.text('Close').hitTestable(), findsOneWidget);
        expect(find.text('Link machine').hitTestable(), findsOneWidget);
        await capture('link-machine');
        await tester.enterText(
          find.byKey(const Key('remote-password-connect-field')),
          'fixture',
        );
        await tester.tap(find.text('Link machine'));
        await tester.pumpAndSettle();
        expect(find.text(cli.connectError).hitTestable(), findsOneWidget);
        await capture('link-machine-error');
        await tester.tap(find.text('Close'));
        await tester.pumpAndSettle();
        await tester.pumpWidget(const SizedBox());
        debugDisableShadows = oldShadows;
      });
    }
  }
}
