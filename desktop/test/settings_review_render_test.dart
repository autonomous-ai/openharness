// Optional pictures: HARNESS_SETTINGS_CAPTURE_DIR=/private/tmp/settings-review
// flutter test --no-pub test/settings_review_render_test.dart
// Uses the real screen with synthetic account data. It never starts a CLI,
// loads user usage logs, edits preferences, or invokes a settings action.
import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/settings/settings_nav.dart';
import 'package:harness/settings/settings_screen.dart';
import 'package:harness/settings/settings_section.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/update/desktop_updater.dart';
import 'package:harness/update/manual_update_check.dart';
import 'package:harness/widgets/shortcuts_sheet.dart';
import 'package:harness/widgets/update_notice.dart';

import 'support/real_fonts.dart';

void main() {
  setUpAll(() async {
    // Real Apple faces include the modifier glyphs. The metric-compatible
    // Arial used by the shared layout helper does not contain Command/Shift.
    if (Platform.isMacOS) {
      for (final (family, path) in [
        ('.AppleSystemUIFont', '/System/Library/Fonts/SFNS.ttf'),
        ('SF Pro Text', '/System/Library/Fonts/SFNS.ttf'),
        ('Roboto', '/System/Library/Fonts/SFNS.ttf'),
        ('.AppleSystemUIFontMonospaced', '/System/Library/Fonts/SFNSMono.ttf'),
        ('Menlo', '/System/Library/Fonts/SFNSMono.ttf'),
        ('Helvetica Neue', '/System/Library/Fonts/Apple Symbols.ttf'),
      ]) {
        final bytes = ByteData.sublistView(await File(path).readAsBytes());
        await (FontLoader(family)..addFont(Future.value(bytes))).load();
      }
    } else {
      await loadRealFonts();
    }
    for (final (family, path) in [
      ('MaterialIcons', 'fonts/MaterialIcons-Regular.otf'),
      (
        'packages/lucide_icons_flutter/Lucide',
        'packages/lucide_icons_flutter/assets/lucide.ttf',
      ),
      (
        'packages/lucide_icons_flutter/Lucide300',
        'packages/lucide_icons_flutter/assets/build_font/LucideVariable-w300.ttf',
      ),
    ]) {
      await (FontLoader(family)..addFont(rootBundle.load(path))).load();
    }
    PackageInfo.setMockInitialValues(
      appName: 'Harness',
      packageName: 'ai.autonomous.harness',
      version: '1.0.0',
      buildNumber: '1',
      buildSignature: '',
    );
  });

  for (final brightness in Brightness.values) {
    for (final scale in [1.0, 1.8]) {
      for (final section in settingsGroupsFor(
        debugSurface: false,
      ).expand((group) => group.sections)) {
        testWidgets(
          '${section.name} at minimum window, ${brightness.name}, $scale text',
          (tester) async {
            tester.view.devicePixelRatio = 1;
            tester.view.physicalSize = const Size(880, 560);
            addTearDown(tester.view.reset);
            final oldBrightness = grid.AppTheme.brightness.value;
            grid.AppTheme.brightness.value = brightness;
            addTearDown(() => grid.AppTheme.brightness.value = oldBrightness);
            final shadows = debugDisableShadows;
            debugDisableShadows = false;
            addTearDown(() => debugDisableShadows = shadows);
            final app =
                AppNotifier(
                    config: AppConfig.dev,
                    authSession: AuthSession(),
                    configStore: null,
                  )
                  ..currentUser = const CurrentUserProfile(
                    name: 'Morgan Rivera',
                    email: 'morgan@example.test',
                  );
            final boundary = GlobalKey();
            Future<void> capture(String name) async {
              final output =
                  Platform.environment['HARNESS_SETTINGS_CAPTURE_DIR'];
              if (output == null) return;
              final render =
                  boundary.currentContext!.findRenderObject()!
                      as RenderRepaintBoundary;
              await tester.runAsync(() async {
                final image = await render.toImage(pixelRatio: 1);
                final bytes = await image.toByteData(
                  format: ui.ImageByteFormat.png,
                );
                await Directory(output).create(recursive: true);
                await File('$output/$name.png')
                    .writeAsBytes(bytes!.buffer.asUint8List());
                image.dispose();
              });
            }

            addTearDown(() async {
              await tester.pumpWidget(const SizedBox());
              app.dispose();
            });
            await tester.pumpWidget(
              RepaintBoundary(
                key: boundary,
                child: MaterialApp(
                  debugShowCheckedModeBanner: false,
                  theme: grid.buildAppTheme(brightness: brightness),
                  builder: (context, child) => MediaQuery(
                    data: MediaQuery.of(context)
                        .copyWith(textScaler: TextScaler.linear(scale)),
                    child: grid.BrightnessScope(child: child!),
                  ),
                  home: SettingsScreen(notifier: app),
                ),
              ),
            );
            await tester.pumpAndSettle();
            final search = find.byKey(const Key('settings-search-field'));
            expect(
              tester.widget<TextField>(search).focusNode!.hasFocus,
              isTrue,
            );
            await tester.enterText(search, section.label);
            await tester.sendKeyEvent(LogicalKeyboardKey.enter);
            await tester.pumpAndSettle();
            expect(
              tester.widget<SettingsNav>(find.byType(SettingsNav)).section,
              section,
            );
            if (section == SettingsSection.about) {
              await tester.runAsync(() async {
                await precacheImage(
                  const AssetImage('assets/app_icon.png'),
                  boundary.currentContext!,
                );
              });
              await tester.pumpAndSettle();
            }
            final name = '${section.name}-${brightness.name}-$scale';
            await capture(name);
            debugDisableShadows = shadows;
            if (section == SettingsSection.usage) {
              final label = tester.renderObject<RenderParagraph>(
                find.text('Last 30 days'),
              );
              expect(
                label.getMaxIntrinsicWidth(double.infinity),
                lessThanOrEqualTo(label.size.width + 0.1),
                reason: 'The current Usage range must be readable at a glance.',
              );
              await tester.ensureVisible(find.text('Last 30 days'));
              await tester.pumpAndSettle();
              debugDisableShadows = false;
              await capture('$name-range');
              debugDisableShadows = shadows;
            }
            if (section == SettingsSection.about) {
              await tester.ensureVisible(
                find.byKey(const Key('settings-flash-firmware-button')),
              );
              await tester.pumpAndSettle();
              debugDisableShadows = false;
              await capture('$name-actions');
              debugDisableShadows = shadows;
              const available = DesktopUpdateCheck.available(
                UpdateInfo(
                  version: '1.0.4',
                  url: 'https://updates.example.test/Harness.zip',
                  sha256: 'unused',
                  size: 48000000,
                ),
              );
              for (final result in const [
                ManualUpdateCheck(check: DesktopUpdateCheck.upToDate()),
                ManualUpdateCheck(check: DesktopUpdateCheck.failed()),
                ManualUpdateCheck(check: DesktopUpdateCheck.disabled()),
                ManualUpdateCheck(check: available),
                ManualUpdateCheck(check: available, isSkipped: true),
              ]) {
                unawaited(
                  showUpdateCheckDialog(
                    tester.element(find.byType(SettingsScreen)),
                    app,
                    result,
                  ),
                );
                await tester.pumpAndSettle();
                debugDisableShadows = false;
                await capture(
                  '$name-update-${result.status.name}'
                  '${result.isSkipped ? '-skipped' : ''}',
                );
                debugDisableShadows = shadows;
                expect(
                  tester.takeException(),
                  isNull,
                  reason: result.status.name,
                );
                await tester.sendKeyEvent(LogicalKeyboardKey.escape);
                await tester.pumpAndSettle();
                expect(find.byType(Dialog), findsNothing);
              }
            }
            if (section == SettingsSection.shortcuts) {
              final label = tester.renderObject<RenderParagraph>(
                find.text('Workspace'),
              );
              expect(
                label.getMaxIntrinsicWidth(double.infinity),
                lessThanOrEqualTo(label.size.width + 0.1),
                reason:
                    'The shortcut context must be readable without opening it.',
              );
              unawaited(
                showShortcutsSheet(tester.element(find.byType(SettingsScreen))),
              );
              await tester.pumpAndSettle();
              debugDisableShadows = false;
              await capture('$name-sheet');
              debugDisableShadows = shadows;
              await tester.sendKeyEvent(LogicalKeyboardKey.escape);
              await tester.pumpAndSettle();
              expect(find.byType(Dialog), findsNothing);
            }
            expect(tester.takeException(), isNull);
          },
          variant: TargetPlatformVariant.only(TargetPlatform.macOS),
        );
      }
    }
  }
}
