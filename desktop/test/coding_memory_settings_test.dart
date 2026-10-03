import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/companions/coding_memory_connection.dart';
import 'package:harness/companions/coding_memory_settings.dart';
import 'package:harness/settings/experimental_features.dart';
import 'package:harness/settings/sections/experimental_section.dart';
import 'package:harness/shared/theme/app_theme.dart';
import 'package:harness/shared/theme/color_palette.dart';

import 'experimental_features_test.dart' show AccountSettings;
import 'support/real_fonts.dart';

class SettingsConnection extends CodingMemoryConnection {
  @override
  bool valid = true;
  @override
  int epoch = 1;
  bool enabled = false;
  int revision = 0;
  String? failure;
  Completer<void>? hold;
  final calls = <Map<String, dynamic>>[];
  @override
  Future<Map<String, dynamic>> request(Map<String, dynamic> payload) async {
    calls.add(payload);
    await hold?.future;
    if (failure != null) throw CodingMemoryFailure(failure!);
    if (payload['action'] == 'configure_experiment') {
      expect(payload['expected'], revision);
      enabled = payload['enabled'] as bool;
      revision++;
    }
    return {'ok': true, 'enabled': enabled, 'revision': revision};
  }

  @override
  void invalidate() {
    valid = false;
    epoch++;
    notifyListeners();
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(loadRealFonts);
  late SettingsConnection connection;
  late CodingMemorySettings settings;
  setUp(() {
    connection = SettingsConnection();
    settings = CodingMemorySettings(() => connection);
  });
  tearDown(() => settings.dispose());

  test(
    'reads without writing, waits for acknowledgement, and can turn memory off',
    () async {
      await settings.refresh();
      expect(settings.loaded, isTrue);
      expect(settings.enabled, isFalse);
      expect(connection.calls, [
        {'action': 'experiment'},
      ]);
      connection.hold = Completer();
      final saving = settings.setEnabled(true);
      expect(settings.saving, isTrue);
      expect(settings.enabled, isFalse);
      connection.hold!.complete();
      await saving;
      expect(settings.enabled, isTrue);
      expect(settings.saving, isFalse);
      await settings.setEnabled(false);
      expect(settings.enabled, isFalse);
      expect(connection.revision, 2);
    },
  );

  test(
    'clears the previous account and rejects a late setting reply',
    () async {
      await settings.refresh();
      connection.hold = Completer();
      final saving = settings.setEnabled(true);
      connection.invalidate();
      connection.hold!.complete();
      await saving;
      expect(settings.loaded, isFalse);
      expect(settings.enabled, isFalse);
      expect(settings.error, contains('account'));
    },
  );

  test(
    'does not repeat an uncertain write and refreshes the actual saved value',
    () async {
      await settings.refresh();
      connection.failure = 'TIMEOUT';
      await settings.setEnabled(true);
      expect(settings.loaded, isFalse);
      expect(settings.enabled, isFalse);
      await settings.setEnabled(true);
      expect(connection.calls.length, 2);
      connection.failure = null;
      connection.enabled = true;
      connection.revision = 1;
      await settings.refresh();
      expect(settings.enabled, isTrue);
    },
  );

  test(
    'explains the companion prerequisite without enabling anything',
    () async {
      connection.failure = 'DAEMONS_OFF';
      await settings.refresh();
      expect(settings.loaded, isFalse);
      expect(settings.error, contains('Focus-bar creature'));
      expect(connection.calls, [
        {'action': 'experiment'},
      ]);
    },
  );

  for (final brightness in [Brightness.light, Brightness.dark]) {
    for (final scale in [1.0, 2.0]) {
      testWidgets(
        'coding memory stays manageable with companions off, ${brightness.name} ${scale}x',
        (tester) async {
          tester.view.physicalSize = Size(scale == 1 ? 780 : 420, 1100);
          tester.view.devicePixelRatio = 1;
          addTearDown(tester.view.reset);
          final oldPalette = AppTheme.palette.value;
          final oldBrightness = AppTheme.brightness.value;
          AppTheme.palette.value = brightness == Brightness.dark
              ? HarnessPalette.graphite
              : HarnessPalette.paper;
          AppTheme.brightness.value = brightness;
          addTearDown(() {
            AppTheme.palette.value = oldPalette;
            AppTheme.brightness.value = oldBrightness;
          });
          final account = AccountSettings('synthetic-owner');
          final experiments = ExperimentalFeaturesStore(
            pollInterval: Duration.zero,
          )..bind(account.accountId, transport: account);
          addTearDown(experiments.dispose);
          connection.enabled = true;
          connection.revision = 1;
          final boundary = GlobalKey();
          await tester.pumpWidget(
            RepaintBoundary(
              key: boundary,
              child: MaterialApp(
                debugShowCheckedModeBanner: false,
                theme: buildAppTheme(brightness: brightness),
                builder: (context, child) => MediaQuery(
                  data: MediaQuery.of(context)
                      .copyWith(textScaler: TextScaler.linear(scale)),
                  child: child!,
                ),
                home: Scaffold(
                  body: ExperimentalSection(
                    store: experiments,
                    openCodingMemory: () => connection,
                  ),
                ),
              ),
            ),
          );
          await tester.pumpAndSettle();
          final toggle = find.byKey(const Key('experimental-coding-memory'));
          await tester.ensureVisible(toggle);
          await tester.pumpAndSettle();
          expect(tester.widget<Switch>(toggle).value, isTrue);
          expect(tester.widget<Switch>(toggle).onChanged, isNotNull);
          expect(
            find.text(
              'Learning and recall are paused while Focus-bar creature is off.',
            ),
            findsOneWidget,
          );
          expect(account.writes, isEmpty);
          final output =
              Platform.environment['HARNESS_MEMORY_SETTINGS_CAPTURE_DIR'];
          if (output != null) {
            await tester.runAsync(() async {
              final image =
                  await (boundary.currentContext!.findRenderObject()
                          as RenderRepaintBoundary)
                      .toImage(pixelRatio: 1);
              final bytes = await image.toByteData(
                format: ui.ImageByteFormat.png,
              );
              await Directory(output).create(recursive: true);
              await File('$output/setting-${brightness.name}-${scale}x.png')
                  .writeAsBytes(bytes!.buffer.asUint8List());
              image.dispose();
            });
          }
          connection.hold = Completer();
          await tester.tap(toggle);
          await tester.pump();
          expect(tester.widget<Switch>(toggle).value, isTrue);
          expect(tester.widget<Switch>(toggle).onChanged, isNull);
          connection.hold!.complete();
          await tester.pumpAndSettle();
          expect(tester.widget<Switch>(toggle).value, isFalse);
          expect(
            connection.calls.where(
              (call) => call['action'] == 'configure_experiment',
            ),
            [
              {
                'action': 'configure_experiment',
                'enabled': false,
                'expected': 1,
              },
            ],
          );
          expect(account.writes, isEmpty);
          expect(tester.takeException(), isNull);
          await tester.pumpWidget(const SizedBox());
        },
      );
    }
  }
}
