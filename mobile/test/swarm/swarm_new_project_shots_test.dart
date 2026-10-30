import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/cupertino.dart' show CupertinoPageRoute;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/color_palette.dart';
import 'package:harness_mobile/swarm/swarm_page.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';
import 'swarm_new_project_fixture.dart';

/// Review screenshots of + New project: Home's row, the sheet filled in, PM
/// runs on, the brief written with the keyboard up, a long error (with the
/// keyboard up too), a Product Manager that did not start, and no machine able to run
/// one. On a 390-point and a 320-point phone in both phone themes, from
/// made-up data only, to the folder `SWARM_NEW_PROJECT_SHOTS` names. The
/// keyboard is a drawn box of an iPhone keyboard's height, labelled so.
final shots = Platform.environment['SWARM_NEW_PROJECT_SHOTS'];
void main() {
  setUpAll(() async {
    if (shots == null || !Platform.isMacOS) return;
    final sf = ByteData.sublistView(
      await File('/System/Library/Fonts/SFNS.ttf').readAsBytes(),
    );
    for (final family in ['.AppleSystemUIFont', 'Roboto']) {
      await (FontLoader(family)..addFont(Future.value(sf))).load();
    }
    final mono = ByteData.sublistView(
      await File('/System/Library/Fonts/SFNSMono.ttf').readAsBytes(),
    );
    for (final family in ['.AppleSystemUIFontMonospaced', 'monospace']) {
      await (FontLoader(family)..addFont(Future.value(mono))).load();
    }
    final manifest =
        jsonDecode(await rootBundle.loadString('FontManifest.json')) as List;
    for (final entry in manifest.cast<Map<String, dynamic>>()) {
      final loader = FontLoader(entry['family'] as String);
      for (final font in (entry['fonts'] as List).cast<Map>()) {
        loader.addFont(rootBundle.load(font['asset'] as String));
      }
      await loader.load();
    }
  });

  testWidgets('+ New project on a 390 and a 320 point phone, in both phone '
      'themes', (tester) async {
    for (final (width, height, top, bottom, keys) in [
      (390.0, 844.0, 47.0, 34.0, 336.0),
      (320.0, 568.0, 20.0, 0.0, 260.0),
    ]) {
      // The phone's screen, as the sheet measures its height by it.
      await tester.binding.setSurfaceSize(Size(width, height));
      tester.view.physicalSize = Size(width * 3, height * 3);
      tester.view.devicePixelRatio = 3;
      // An iPhone's status bar and home indicator.
      tester.view.padding = FakeViewPadding(top: top * 3, bottom: bottom * 3);
      for (final palette in [HarnessPalette.graphite, HarnessPalette.paper]) {
        final brightness = palette.brightness;
        AppTheme.palette.value = palette;
        AppTheme.brightness.value = brightness;
        final swarm = NewProjectSwarm(
          machines: [
            leadPool('mac-studio', name: 'Studio.local', slots: 3),
            leadPool(
              'mac-air',
              name: 'Air.local',
              slots: 1,
              deviceType: 'MacBook Air',
            ),
            leadPool(
              'mac-ken',
              name: 'Ken’s Mac mini',
              contributor: 'person-ken',
              lead: {
                'claude': {'machineId': 'team-ken'},
                'codex': {'machineId': 'team-ken'},
              },
            ),
          ],
        );
        final features = ExperimentalFeaturesStore(
          storage: MemoryKeyValueStore(),
        )..value = {PhoneExperiment.swarm};
        final account = ValueNotifier<String?>(me);
        final host = SwarmHost(
          accountId: () => me,
          account: account,
          request: newProjectBackend([swarm]).request,
          notices: SilentSystemNotices(),
          features: features,
          readMarks: MemoryKeyValueStore(),
        )..foreground = false;
        final boundary = GlobalKey();
        final keyboard = ValueNotifier<double>(0);
        await tester.pumpWidget(
          RepaintBoundary(
            key: boundary,
            child: Directionality(
              textDirection: TextDirection.ltr,
              child: Stack(
                children: [
                  MaterialApp(
                    debugShowCheckedModeBanner: false,
                    theme: buildAppTheme(brightness: brightness),
                    builder: (_, child) =>
                        SwarmScope(notifier: host, child: child!),
                    onGenerateRoute: (_) => CupertinoPageRoute<void>(
                      builder: (_) => SwarmPage(now: () => newProjectNow),
                    ),
                  ),
                  // Where the keyboard is, while it is up.
                  ValueListenableBuilder(
                    valueListenable: keyboard,
                    builder: (_, height, _) => height == 0
                        ? const SizedBox.shrink()
                        : Positioned(
                            left: 0,
                            right: 0,
                            bottom: 0,
                            height: height,
                            child: ColoredBox(
                              color: brightness == Brightness.dark
                                  ? const Color(0xFF2C2C2E)
                                  : const Color(0xFFD1D3D9),
                              child: Center(
                                child: Text(
                                  'Keyboard',
                                  style: TextStyle(
                                    fontFamily: '.AppleSystemUIFont',
                                    fontSize: 17,
                                    color: brightness == Brightness.dark
                                        ? const Color(0xFF8E8E93)
                                        : const Color(0xFF6E6E73),
                                  ),
                                ),
                              ),
                            ),
                          ),
                  ),
                ],
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        Future<void> capture(String name) => tester.runAsync(() async {
          final image =
              await (boundary.currentContext!.findRenderObject()!
                      as RenderRepaintBoundary)
                  .toImage(pixelRatio: 3);
          final png = await image.toByteData(format: ui.ImageByteFormat.png);
          await File(
            '$shots/new-project-${width.toInt()}-$name-${brightness.name}.png',
          ).writeAsBytes(png!.buffer.asUint8List());
          image.dispose();
        });
        Finder key(String value) => find.byKey(ValueKey(value));
        Future<void> tap(String k) async {
          await tester.ensureVisible(key(k));
          await tester.pumpAndSettle();
          await tester.tap(key(k));
          await tester.pumpAndSettle();
        }

        // Home: + New project, the last of Projects.
        await tester.ensureVisible(key('swarm-new-project'));
        await tester.pumpAndSettle();
        await capture('home');

        // The sheet, its brief written and its machine picked.
        await tap('swarm-new-project');
        await tester.enterText(
          key('swarm-new-project-brief'),
          'Let people start a project from the phone, with its Product '
          'Manager on a Swarm machine.',
        );
        FocusManager.instance.primaryFocus?.unfocus();
        await tester.pumpAndSettle();
        await tap('swarm-new-project-machine');
        await capture('machines');
        await tap('swarm-new-project-pick-machine-mac-studio');
        await capture('sheet');

        // The keyboard up while the brief is written: it and Create stay in
        // sight.
        Future<void> raiseKeyboard() async {
          await tester.showKeyboard(key('swarm-new-project-brief'));
          tester.view.viewInsets = FakeViewPadding(bottom: keys * 3);
          // Under the keyboard there is no home indicator to keep clear of.
          tester.view.padding = FakeViewPadding(top: top * 3);
          keyboard.value = keys;
          await tester.pumpAndSettle();
        }

        Future<void> lowerKeyboard() async {
          FocusManager.instance.primaryFocus?.unfocus();
          tester.view.resetViewInsets();
          tester.view.padding = FakeViewPadding(
            top: top * 3,
            bottom: bottom * 3,
          );
          keyboard.value = 0;
          await tester.pumpAndSettle();
        }

        await raiseKeyboard();
        await capture('keyboard');
        await lowerKeyboard();

        // A create refused with a long reason, then the brief written again.
        swarm.answer = (command) => command['type'] == 'project.create'
            ? throw const SuperTabFailure(
                'PROJECT_LIMIT',
                'This Swarm has as many projects as its plan holds. Archive '
                    'one you no longer need, or ask its owner to raise the '
                    'limit, then try again.',
                statusCode: 409,
              )
            : null;
        await tap('swarm-new-project-create');
        await capture('error');
        await raiseKeyboard();
        await capture('keyboard-error');
        await lowerKeyboard();

        // Its Product Manager refused: the project stays, and says why.
        swarm.answer = (command) => command['type'] == 'lead.start'
            ? throw const SuperTabFailure(
                'ENGINE_UNAVAILABLE',
                'Claude Code isn’t signed in on Studio.',
                statusCode: 409,
              )
            : null;
        await tap('swarm-new-project-create');
        await capture('failed');
        await tap('swarm-new-project-close');

        // No machine can run it: each says why.
        swarm.machines = [
          leadPool(
            'mac-studio',
            name: 'Studio.local',
            ago: const Duration(minutes: 3),
          ),
          leadPool(
            'mac-air',
            name: 'Air.local',
            capable: false,
            deviceType: 'MacBook Air',
          ),
          leadPool(
            'mac-ken',
            name: 'Ken’s Mac mini',
            contributor: 'person-ken',
            lead: {
              'claude': {'refused': 'Claude Code isn’t signed in there.'},
              'codex': {'refused': 'Codex isn’t signed in there.'},
            },
          ),
        ];
        await host.session!.inbox.reader(tab)!.refresh();
        await tester.pumpAndSettle();
        await tap('swarm-new-project');
        await tap('swarm-new-project-machine');
        await capture('none');

        await tester.pumpWidget(const SizedBox());
        await tester.pump(const Duration(seconds: 30));
        host.dispose();
        account.dispose();
        keyboard.dispose();
      }
    }
    await tester.binding.setSurfaceSize(null);
    tester.view.reset();
    AppTheme.palette.value = HarnessPalette.graphite;
    AppTheme.brightness.value = Brightness.dark;
  }, skip: shots == null);
}
