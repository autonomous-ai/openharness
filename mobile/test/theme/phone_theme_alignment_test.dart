import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/phone/phone_sheet.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';

import 'sheet_shape.dart';

/// The phone takes Desktop's corners and roles, at the sizes the Phone section
/// of desktop/design/desktop-design-system.md gives them.
void main() {
  double radiusOf(ShapeBorder? shape) {
    final border = shape! as RoundedRectangleBorder;
    return (border.borderRadius as BorderRadius).topLeft.x;
  }

  for (final brightness in Brightness.values) {
    group('$brightness', () {
      final theme = buildAppTheme(brightness: brightness);

      test('action buttons are capsules', () {
        for (final style in [
          theme.filledButtonTheme.style,
          theme.outlinedButtonTheme.style,
          theme.textButtonTheme.style,
        ]) {
          expect(style!.shape!.resolve({}), isA<StadiumBorder>());
        }
      });

      test('fields round at 10', () {
        final border =
            theme.inputDecorationTheme.enabledBorder! as OutlineInputBorder;
        expect(border.borderRadius.topLeft.x, 10);
      });

      test('menus and popovers round at 16', () {
        expect(radiusOf(theme.popupMenuTheme.shape), 16);
        expect(radiusOf(theme.menuTheme.style!.shape!.resolve({})), 16);
      });

      test('dialogs round at 20', () {
        expect(radiusOf(theme.dialogTheme.shape), 20);
      });

      test('bottom sheets round their top corners at 12', () {
        expect(radiusOf(theme.bottomSheetTheme.shape), 12);
      });
    });
  }

  testWidgets('the shared phone sheet rounds its top corners at 12', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) => TextButton(
            onPressed: () => showPhoneSheet(context, title: 'Menu'),
            child: const Text('Open'),
          ),
        ),
      ),
    );
    await tester.tap(find.text('Open'));
    await tester.pumpAndSettle();
    expect(sheetTopRadius(tester), 12);
  });

  test('type roles take their phone sizes', () {
    expect(AppType.display().fontSize, 34);
    expect(AppType.title().fontSize, 22);
    expect(AppType.heading().fontSize, 17);
    expect(AppType.heading().fontWeight, FontWeight.w600);
    expect(AppType.body().fontSize, 17);
    expect(AppType.label().fontSize, 17);
    expect(AppType.caption().fontSize, 13);
    expect(AppType.mono().fontSize, 13);
    expect(AppType.monoLabel().fontSize, 12);
    expect(AppType.monoMeta().fontSize, 11);
  });

  test('a role keeps the caller\'s colour, weight and tabular figures', () {
    const ink = Color(0xFF123456);
    final style = AppType.label(
      color: ink,
      fontWeight: FontWeight.w700,
      fontFeatures: const [FontFeature.tabularFigures()],
    );
    expect(style.color, ink);
    expect(style.fontWeight, FontWeight.w700);
    expect(style.fontFeatures, const [FontFeature.tabularFigures()]);
  });
}
