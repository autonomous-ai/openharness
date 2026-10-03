import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/harness_activity.dart';
import 'package:harness/terminal/terminal_theme_store.dart';
import 'package:harness/widgets/desktop_workspace_tab.dart';
import 'package:harness/widgets/harness_activity_mark.dart';

import 'harness_activity_test.dart' show activityQuestion;
import 'swarm_state_test.dart' show createApp;
import 'swarm_screen_test.dart' show mount, terminal;
import 'support/real_fonts.dart';

Future<void> captureWorkspace(WidgetTester tester, String path) =>
    tester.runAsync(() async {
      final view = tester.binding.renderViews.first;
      final image = await (view.debugLayer! as OffsetLayer).toImage(
        Offset.zero & view.size,
        pixelRatio: 2,
      );
      final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
      await File(path).writeAsBytes(bytes!.buffer.asUint8List());
      image.dispose();
    });

void main() {
  final capture = Platform.environment['HARNESS_ACTIVITY_CAPTURE_DIR'];
  setUpAll(() async {
    if (capture != null && Platform.isMacOS) {
      for (final (family, path) in [
        ('SF Mono', '/System/Library/Fonts/SFNSMono.ttf'),
        ('.AppleSystemUIFontMonospaced', '/System/Library/Fonts/SFNSMono.ttf'),
        ('Menlo', '/System/Library/Fonts/Menlo.ttc'),
        ('Apple Symbols', '/System/Library/Fonts/Apple Symbols.ttf'),
        ('.AppleSystemUIFont', '/System/Library/Fonts/SFNS.ttf'),
        ('Roboto', '/System/Library/Fonts/Supplemental/Arial.ttf'),
      ]) {
        final bytes = ByteData.sublistView(await File(path).readAsBytes());
        await (FontLoader(family)..addFont(Future.value(bytes))).load();
      }
    } else {
      await loadRealFonts();
    }
    if (capture != null) {
      await (FontLoader('packages/lucide_icons_flutter/Lucide400')..addFont(
            rootBundle.load(
              'packages/lucide_icons_flutter/assets/build_font/LucideVariable-w400.ttf',
            ),
          ))
          .load();
    }
  });

  for (final native in [false, true]) {
    testWidgets(
      'pane and tab states agree and native receives changes, not animation frames (native=$native)',
      (tester) async {
        final updates = <Map>[];
        const channel = MethodChannel('harness/swarm_tabs');
        tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          channel,
          (call) async {
            if (call.method == 'update') updates.add(call.arguments as Map);
            return true;
          },
        );
        addTearDown(
          () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
            channel,
            null,
          ),
        );
        final app = createApp(connected: true);
        final machine = app.stateOf('m')!;
        app.renameSwarm(app.activeSwarmId, 'desktop');
        final first = app.activeSwarm;
        app.adoptSessionForTest(
          terminal('a0', [])..agentName = 'Review pull requests',
        );
        app.adoptSessionForTest(
          terminal('a1', [])..agentName = 'Fix reconnect',
        );
        app.newSwarm(name: 'daemons');
        final second = app.activeSwarm;
        app.adoptSessionForTest(terminal('a2', [])..agentName = 'Daemon tests');
        app.selectSwarm(first.id);
        machine.processingAgentIds.addAll(['a0', 'a1', 'a2']);
        machine.blockedAgents['a0'] = activityQuestion('a0');
        await mount(tester, app, nativeTabs: native);
        await tester.pump(const Duration(milliseconds: 100));

        HarnessActivity? flutterState(String tab) => tester
            .widget<ActivityMark>(find.byKey(ValueKey('tab-activity:$tab')))
            .activity;
        Map nativeActivity(String tab) =>
            ((updates.last['tabs'] as List).cast<Map>().singleWhere(
                  (row) => row['id'] == tab,
                )['activity']
                as Map);
        if (native) {
          expect(nativeActivity(first.id)['mark'], '?');
          expect(nativeActivity(second.id)['working'], isTrue);
          final count = updates.length;
          await tester.pump(const Duration(milliseconds: 500));
          expect(updates.length, count, reason: 'native animates locally');
          expect(updates.last['reduceMotion'], isFalse);
          tester.platformDispatcher.accessibilityFeaturesTestValue =
              FakeAccessibilityFeatures(disableAnimations: true);
          await tester.pump();
          expect(updates.last['reduceMotion'], isTrue);
          tester.platformDispatcher.clearAccessibilityFeaturesTestValue();
          await tester.pump();
        } else {
          expect(flutterState(first.id), HarnessActivity.needsInput);
          expect(flutterState(second.id), HarnessActivity.working);
          expect(
            tester
                .getRect(find.byKey(ValueKey('tab-activity:${first.id}')))
                .left,
            greaterThan(tester.getRect(find.text('desktop')).right),
          );
          // Two visible panes and the second tab: the hidden daemon pane is
          // retained but contributes no extra animation or terminal rebuilds.
          expect(find.byType(HarnessActivityMark), findsNWidgets(2));
        }

        if (capture != null) {
          await tester.runAsync(() async {
            final dir = Directory(capture);
            await dir.create(recursive: true);
            if (native) {
              await File('$capture/native-activity.json')
                  .writeAsString(jsonEncode(updates.last));
            }
          });
          if (!native) {
            await captureWorkspace(tester, '$capture/workspace-activity.png');
            terminalThemeStore.value = TerminalThemeChoice.tango;
            await tester.pump();
            await captureWorkspace(
              tester,
              '$capture/workspace-activity-tango.png',
            );
            terminalThemeStore.value = TerminalThemeChoice.matchApp;
            await tester.pump();
          }
        }

        machine.blockedAgents.clear();
        await app.handleEventForTest('m', {
          'type': 'turn_ended',
          'agentId': 'a0',
          'error': 'Test failure',
        });
        await tester.pump(const Duration(milliseconds: 100));
        if (native) {
          expect(nativeActivity(first.id)['mark'], '✗');
        } else {
          expect(flutterState(first.id), HarnessActivity.failed);
        }
        await app.handleEventForTest('m', {
          'type': 'turn_ended',
          'agentId': 'a2',
        });
        await app.handleEventForTest('m', {
          'type': 'turn_summary',
          'agentId': 'a2',
          'payload': {
            'notification': {'id': 'result-a2', 'kind': 'done'},
          },
        });
        await tester.pump(const Duration(milliseconds: 100));
        if (native) {
          expect(nativeActivity(second.id)['mark'], '✓');
        } else {
          expect(flutterState(second.id), HarnessActivity.done);
        }
        app.markAgentSeen('m', 'a2');
        await tester.pump();
        if (native) {
          expect(nativeActivity(second.id)['mark'], isEmpty);
        } else {
          expect(
            find.byKey(ValueKey('tab-activity:${second.id}')),
            findsNothing,
          );
          expect(
            tester
                .widget<DesktopWorkspaceTab>(
                  find.byWidgetPredicate(
                    (widget) =>
                        widget is DesktopWorkspaceTab && widget.id == second.id,
                  ),
                )
                .activityLabel,
            HarnessActivity.idle.label,
          );
        }
        // Narrow windows keep the symbol, shorten the name, and retain controls.
        tester.view.physicalSize = const Size(640, 600);
        await tester.pump(const Duration(milliseconds: 150));
        expect(tester.takeException(), isNull);
        if (capture != null && !native) {
          await captureWorkspace(
            tester,
            '$capture/workspace-activity-narrow.png',
          );
        }
        await tester.pumpWidget(const SizedBox());
        app.dispose();
        grid.AppTheme.brightness.value = Brightness.dark;
      },
    );
  }
}
