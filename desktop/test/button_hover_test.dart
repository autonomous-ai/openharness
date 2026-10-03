// Every button in this app must answer the pointer.
//
// `splashFactory: NoSplash` turns Material's ripple off app-wide, which is
// right — a ripple is an Android idiom. But the ripple was also the only thing
// the theme left drawing a hover response: M3 derives its overlay from
// `foregroundColor`, and a `styleFrom` that passes none resolves to **null**.
// Text buttons across the app lit up on press and did nothing at all under the
// pointer, which on a desktop app makes a control read as a label.
//
// Two rules, both measured here:
//   1. the theme declares a hover overlay for each button kind;
//   2. a `styleFrom` at a call site restates it, because `styleFrom` REPLACES
//      the theme's style rather than merging with it.

import 'dart:math' as math;
import 'dart:ui' show PointerDeviceKind;

import 'package:harness/shared/theme/app_icons.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:harness/shared/theme/app_theme.dart';
import 'package:harness/shared/theme/color_palette.dart';
import 'package:harness/shared/widgets/app_icon_button.dart';

import 'support/real_fonts.dart';

const _hovered = {WidgetState.hovered};

Color _over(Color base, Color layer) {
  final a = layer.a;
  return Color.from(
    alpha: 1,
    red: layer.r * a + base.r * (1 - a),
    green: layer.g * a + base.g * (1 - a),
    blue: layer.b * a + base.b * (1 - a),
  );
}

double _luminance(Color c) {
  double channel(double v) =>
      v <= 0.03928 ? v / 12.92 : math.pow((v + 0.055) / 1.055, 2.4).toDouble();
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

double _contrast(Color a, Color b) {
  final l1 = _luminance(a), l2 = _luminance(b);
  final hi = l1 > l2 ? l1 : l2;
  final lo = l1 > l2 ? l2 : l1;
  return (hi + 0.05) / (lo + 0.05);
}

void main() {
  setUpAll(loadRealFonts);

  for (final brightness in [Brightness.dark, Brightness.light]) {
    group('on ${brightness.name}', () {
      late ThemeData theme;

      setUp(() {
        AppTheme.brightness.value = brightness;
        theme = buildAppTheme(brightness: brightness);
      });

      tearDown(() => AppTheme.brightness.value = Brightness.light);

      testWidgets('capsules keep space around enlarged system text', (
        tester,
      ) async {
        for (final scale in [1.0, 1.7, 2.0]) {
          await tester.pumpWidget(
            MaterialApp(
              theme: theme,
              builder: (context, child) => MediaQuery(
                data: MediaQuery.of(context)
                    .copyWith(textScaler: TextScaler.linear(scale)),
                child: child!,
              ),
              home: Scaffold(
                body: Center(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    spacing: 16,
                    children: [
                      TextButton(
                        key: const Key('text-button'),
                        onPressed: () {},
                        child: const Text('Close', key: Key('text-label')),
                      ),
                      OutlinedButton(
                        key: const Key('outlined-button'),
                        onPressed: () {},
                        child: const Text(
                          'Troubleshooting details',
                          key: Key('outlined-label'),
                        ),
                      ),
                      FilledButton(
                        key: const Key('filled-button'),
                        onPressed: () {},
                        child: const Text(
                          'Link machine',
                          key: Key('filled-label'),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          );
          for (final kind in ['text', 'outlined', 'filled']) {
            final button = tester.getRect(find.byKey(Key('$kind-button')));
            final label = tester.getRect(find.byKey(Key('$kind-label')));
            expect(
              label.top - button.top,
              greaterThanOrEqualTo(6),
              reason: '$kind at $scale needs space above its label',
            );
            expect(
              button.bottom - label.bottom,
              greaterThanOrEqualTo(6),
              reason: '$kind at $scale needs space below its label',
            );
            if (scale == 1) {
              expect(button.height, 32);
            } else {
              expect(button.height, greaterThan(32));
            }
          }
          expect(tester.takeException(), isNull);
        }
      });

      test('every button kind declares a hover overlay', () {
        final kinds = {
          'text': theme.textButtonTheme.style,
          'outlined': theme.outlinedButtonTheme.style,
          'filled': theme.filledButtonTheme.style,
          'icon': theme.iconButtonTheme.style,
        };
        kinds.forEach((name, style) {
          final overlay = style?.overlayColor?.resolve(_hovered);
          expect(
            overlay,
            isNotNull,
            reason: '$name buttons would have no hover state at all',
          );
          expect(
            overlay!.a,
            greaterThan(0),
            reason: '$name buttons resolve to a fully transparent hover',
          );
        });
      });

      test('icon focus is visible and disabled icons stay quiet', () {
        final overlay = theme.iconButtonTheme.style!.overlayColor!;
        expect(overlay.resolve({WidgetState.focused})!.a, greaterThan(0));
        expect(
          overlay.resolve({WidgetState.disabled, WidgetState.hovered})!.a,
          0,
        );
      });

      test('error text stays readable on ordinary desktop surfaces', () {
        final originalPalette = AppTheme.palette.value;
        addTearDown(() => AppTheme.palette.value = originalPalette);
        for (final palette in HarnessPalette.values) {
          AppTheme.palette.value = palette;
          final error = buildAppTheme(brightness: brightness).colorScheme.error;
          for (final surface in {
            'page': AppPalette.windowBg,
            'card': AppPalette.cardBg,
            'content card': AppCard.base,
            'menu': AppMenu.fill,
            'field': AppDesktop.field,
          }.entries) {
            expect(
              _contrast(error, surface.value),
              greaterThanOrEqualTo(4.5),
              reason: '${palette.name} ${surface.key} must carry error text',
            );
          }
        }
      });

      test('Increase Contrast strengthens neutral controls and focus', () {
        final accessible = buildAppTheme(
          brightness: brightness,
          highContrast: true,
        );
        final surface = accessible.colorScheme.surface;
        for (final control in [
          accessible.textButtonTheme.style!,
          accessible.outlinedButtonTheme.style!,
        ]) {
          final rest = control.side!.resolve({})!;
          final focused = control.side!.resolve({WidgetState.focused})!;
          expect(rest.width, focused.width);
          expect(
            _contrast(_over(surface, rest.color), surface),
            greaterThanOrEqualTo(3),
          );
          expect(
            _contrast(_over(surface, focused.color), surface),
            greaterThanOrEqualTo(3),
          );
          expect(
            control.side!.resolve({WidgetState.disabled})!.color.a,
            lessThan(rest.color.a),
          );
        }
      });

      // An overlay that exists but cannot be seen is the same bug wearing a
      // value. These are measured on the surfaces buttons actually sit on.
      test('the hover wash is visible on the surfaces buttons sit on', () {
        final page = brightness == Brightness.dark
            ? const Color(0xFF191919)
            : const Color(0xFFFAFAF9);
        final grounds = {
          'page': page,
          'card': _over(page, AppPalette.cardBg),
          'accent wash': _over(page, AppSurface.accentWash),
        };
        grounds.forEach((name, ground) {
          expect(
            _contrast(ground, _over(ground, AppSurface.hoverFill)),
            greaterThan(1.03),
            reason: 'hover is invisible on $name',
          );
        });
      });
    });
  }

  testWidgets('compact icons respond to hover and keyboard activation', (
    tester,
  ) async {
    var presses = 0;
    await tester.pumpWidget(
      MaterialApp(
        theme: buildAppTheme(brightness: Brightness.dark),
        home: Scaffold(
          body: Center(
            child: AppIconButton(
              icon: AppIcons.plus,
              onPressed: () => presses++,
            ),
          ),
        ),
      ),
    );
    final button = find.byType(AppIconButton);
    final material = find.descendant(
      of: button,
      matching: find.byType(Material),
    );
    BorderSide rim() =>
        (tester.widget<Material>(material).shape! as OutlinedBorder).side;
    Color? ink() => IconTheme.of(tester.element(find.byType(Icon))).color;
    final restingInk = ink();
    final bounds = tester.getRect(button);
    expect(bounds.size, const Size(32, 32));
    expect(rim().color.a, 0);
    final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
    await mouse.addPointer(location: Offset.zero);
    await mouse.moveTo(tester.getCenter(button));
    await tester.pumpAndSettle();
    expect(ink(), isNot(restingInk));
    expect(rim().color.a, 0, reason: 'hover is distinct from keyboard focus');
    await mouse.moveTo(Offset.zero);
    await tester.pumpAndSettle();
    expect(ink(), restingInk);
    await tester.sendKeyEvent(LogicalKeyboardKey.tab);
    await tester.pumpAndSettle();
    expect(rim().color.a, greaterThan(0));
    expect(
      tester.getRect(button),
      bounds,
      reason: 'focus must not move controls',
    );
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.sendKeyEvent(LogicalKeyboardKey.space);
    expect(presses, 2);
    await mouse.removePointer();
  });
}
