// Task #3006 (Dee, 11-05): Appearance > Workspace in a new theme, for the
// pictures Dee okays before it merges. Writes nothing unless THEME_SHOTS
// names a folder.
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/core/local_key_value_store.dart';
import 'package:harness/shared/theme/appearance_prefs_store.dart';
import 'package:harness/shared/theme/color_palette.dart';
import 'package:harness/widgets/harness_customize_pane.dart';

import 'support/capture.dart';

final shots = Platform.environment['THEME_SHOTS'];

void main() {
  setUpAll(() => loadCaptureFonts(shots));

  testWidgets('Appearance > Workspace in Plum', (tester) async {
    if (shots == null) return;
    final store = AppearancePrefsStore(storage: _Memory());
    addTearDown(store.dispose);
    await store.setPalette(HarnessPalette.plum);
    final previous = (
      grid.AppTheme.palette.value,
      grid.AppTheme.brightness.value,
    );
    grid.AppTheme.palette.value = HarnessPalette.plum;
    grid.AppTheme.brightness.value = Brightness.light;
    addTearDown(() {
      grid.AppTheme.palette.value = previous.$1;
      grid.AppTheme.brightness.value = previous.$2;
    });
    tester.view.devicePixelRatio = 2;
    tester.view.physicalSize = const Size(880, 1500);
    addTearDown(tester.view.reset);
    final picture = GlobalKey();
    await tester.pumpWidget(
      MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: grid.buildAppTheme(brightness: Brightness.light),
        home: RepaintBoundary(
          key: picture,
          child: Scaffold(
            body: HarnessCustomizePane(onClose: () {}, store: store),
          ),
        ),
      ),
    );
    await tester.tap(find.byKey(const ValueKey('customize-appearance')));
    await tester.pumpAndSettle();
    await captureBoundary(
      tester,
      picture.currentContext!.findRenderObject()! as RenderRepaintBoundary,
      shots,
      'theme-appearance-workspace',
    );
  }, variant: TargetPlatformVariant.only(TargetPlatform.macOS));
}

class _Memory implements LocalKeyValueStore {
  final values = <String, String>{};
  @override
  Future<String?> read(String key) async => values[key];
  @override
  Future<void> delete(String key) async => values.remove(key);
  @override
  Future<void> write(String key, String value) async => values[key] = value;
}
