import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/settings/sections/experimental_section.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/teams/swarm_settings_controller.dart';

import 'support/real_fonts.dart';
import 'support/experimental_settings.dart';
import 'swarm_state_test.dart' show MemoryStore;

void main() {
  setUpAll(loadRealFonts);
  test('opening settings is read-only and the explicit saved choice survives reopening', () async {
    var enabled = false, revision = 0;
    final calls = <Map<String, dynamic>>[];
    SwarmSettingsController open() => SwarmSettingsController(
      request: (p) async {
        calls.add(p);
        if (p['action'] == 'channel_configure') {
          enabled = p['enabled'] as bool;
          revision++;
        }
        return {'enabled': enabled, 'revision': revision};
      },
    );
    final first = open();
    expect(first.enabled, isFalse);
    await first.refresh();
    expect(calls, [
      {'action': 'channel_settings'},
    ]);
    await first.setEnabled(true);
    expect(first.enabled, isTrue);
    first.dispose();
    final reopened = open();
    await reopened.refresh();
    expect(reopened.enabled, isTrue);
    await reopened.setEnabled(false);
    reopened.dispose();
    final last = open();
    await last.refresh();
    expect(last.enabled, isFalse);
    last.dispose();
  });

  test('late reads cannot reverse a saved choice and a failed save does not pretend success', () async {
    final lateRead = Completer<Map<String, dynamic>>();
    var reads = 0, failWrite = false;
    final controller = SwarmSettingsController(
      request: (p) async {
        if (p['action'] == 'channel_settings') {
          if (++reads > 1) return lateRead.future;
          return {'enabled': false, 'revision': 0};
        }
        if (failWrite) throw StateError('unavailable');
        return {'enabled': p['enabled'], 'revision': 1};
      },
    );
    await controller.refresh();
    final reading = controller.refresh();
    await controller.setEnabled(true);
    lateRead.complete({'enabled': false, 'revision': 0});
    await reading;
    expect(controller.enabled, isTrue);
    failWrite = true;
    await controller.setEnabled(false);
    expect(controller.enabled, isTrue);
    expect(controller.error, contains('Refresh'));
    expect(controller.saving, isFalse);
    controller.dispose();
  });

  test(
    'unreadable settings never opt in and disposal ignores an in-flight write',
    () async {
      final writing = Completer<Map<String, dynamic>>();
      var failed = true;
      final controller = SwarmSettingsController(
        request: (p) async {
          if (failed) throw StateError('unsupported');
          if (p['action'] == 'channel_configure') return writing.future;
          return {'enabled': false, 'revision': 0};
        },
      );
      await controller.refresh();
      expect(controller.enabled, isFalse);
      expect(controller.loaded, isFalse);
      failed = false;
      await controller.refresh();
      final saving = controller.setEnabled(true);
      controller.dispose();
      writing.complete({'enabled': true, 'revision': 1});
      await saving;
      expect(controller.enabled, isFalse);
    },
  );

  for (final width in [390.0, 1100.0]) {
    testWidgets(
      'Experimental switch defaults off and changes only on a user action at $width',
      (tester) async {
        tester.view.devicePixelRatio = 1;
        tester.view.physicalSize = Size(width, 820);
        addTearDown(tester.view.reset);
        final calls = <Map<String, dynamic>>[];
        final controller = SwarmSettingsController(
          request: (p) async {
            calls.add(p);
            return {
              'enabled': p['enabled'] == true,
              'revision': p['action'] == 'channel_configure' ? 1 : 0,
            };
          },
        );
        final capture = GlobalKey();
        final preferences = MemoryExperimentalFeaturesStore(
          storage: MemoryStore(),
        );
        addTearDown(preferences.dispose);
        await preferences.refresh();
        await tester.pumpWidget(
          MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: grid.buildAppTheme(brightness: Brightness.dark),
            home: Scaffold(
              body: RepaintBoundary(
                key: capture,
                child: ExperimentalSection(
                  store: preferences,
                  controller: controller,
                ),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        final toggle = find.byKey(
          const Key('experimental-swarm-collaboration'),
        );
        await tester.ensureVisible(toggle);
        await tester.pumpAndSettle();
        expect(tester.widget<Switch>(toggle).value, isFalse);
        expect(calls, [
          {'action': 'channel_settings'},
        ]);
        expect(find.textContaining('automatically consult'), findsOneWidget);
        expect(tester.takeException(), isNull);
        final output = Platform.environment['CHANNEL_RENDER_DIR'];
        if (output != null) {
          await tester.runAsync(() async {
            final boundary =
                capture.currentContext!.findRenderObject()!
                    as RenderRepaintBoundary;
            final image = await boundary.toImage();
            final bytes = await image.toByteData(
              format: ui.ImageByteFormat.png,
            );
            await Directory(output).create(recursive: true);
            await File('$output/experimental-swarm-${width.toInt()}.png')
                .writeAsBytes(bytes!.buffer.asUint8List());
            image.dispose();
          });
        }
        await tester.tap(toggle);
        await tester.pumpAndSettle();
        expect(calls.last, {'action': 'channel_configure', 'enabled': true});
        expect(tester.widget<Switch>(toggle).value, isTrue);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        controller.dispose();
      },
    );
  }
}
