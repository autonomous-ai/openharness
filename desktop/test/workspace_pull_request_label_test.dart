import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/theme/color_palette.dart';
import 'package:harness/shared/theme/pull_request_icon.dart';
import 'package:harness/shared/theme/status_line_style.dart';
import 'package:harness/terminal/terminal_theme.dart';
import 'package:harness/terminal/terminal_theme_store.dart';
import 'package:harness/widgets/workspace_pull_request_label.dart';

import 'support/real_fonts.dart';

void main() {
  setUpAll(loadRealFonts);

  test(
    'PR colors contrast on terminal themes; color off follows foreground',
    () {
      for (final theme in [darkTerminalTheme, tangoTerminalTheme]) {
        final colors = <Color>{};
        for (final state in ['Open', 'Merged', 'Closed', 'Draft']) {
          final color = pullRequestIconColor(state, theme);
          colors.add(color);
          final a = color.computeLuminance();
          final b = theme.background.computeLuminance();
          final ratio = a > b ? (a + .05) / (b + .05) : (b + .05) / (a + .05);
          expect(ratio, greaterThanOrEqualTo(3));
          expect(
            pullRequestIconColor(state, theme, color: false),
            theme.foreground,
          );
        }
        expect(colors.length, 4);
      }
      final originalPalette = grid.AppTheme.palette.value;
      addTearDown(() => grid.AppTheme.palette.value = originalPalette);
      for (final brightness in Brightness.values) {
        grid.AppTheme.palette.value = brightness == Brightness.light
            ? HarnessPalette.paper
            : HarnessPalette.graphite;
        final surface = grid.AppTheme.as(
          brightness,
          () => grid.AppPalette.cardBg,
        );
        for (final state in ['Open', 'Merged', 'Closed', 'Draft']) {
          final color = pullRequestIconColor(
            state,
            null,
            brightness: brightness,
          );
          expect(
            pullRequestIconColor(
              state,
              tangoTerminalTheme,
              brightness: brightness,
            ),
            color,
          );
          final a = color.computeLuminance();
          final b = surface.computeLuminance();
          final ratio = a > b ? (a + .05) / (b + .05) : (b + .05) / (a + .05);
          expect(ratio, greaterThanOrEqualTo(4.5));
        }
      }
    },
  );

  testWidgets(
    'compact PR keeps its size through state, hover, and monochrome',
    (tester) async {
      final original = terminalThemeStore.value;
      addTearDown(() => terminalThemeStore.value = original);
      final semantics = tester.ensureSemantics();

      try {
        Size? size;
        for (final state in ['Open', 'Merged', 'Closed', 'Draft']) {
          for (final emphasized in [false, true]) {
            for (final color in [true, false]) {
              await tester.pumpWidget(
                MaterialApp(
                  theme: grid.buildAppTheme(brightness: Brightness.dark),
                  home: Center(
                    child: WorkspacePullRequestLabel(
                      number: 436,
                      state: state,
                      color: color,
                      emphasized: emphasized,
                    ),
                  ),
                ),
              );
              await tester.pumpAndSettle();
              expect(find.text('#436'), findsOneWidget);
              expect(find.text(state), findsNothing);
              expect(
                find.bySemanticsLabel('Pull request #436: $state'),
                findsOneWidget,
              );
              final icon = tester.widget<SvgPicture>(find.byType(SvgPicture));
              expect(icon.bytesLoader, isA<SvgAssetLoader>());
              expect(
                (icon.bytesLoader as SvgAssetLoader).assetName,
                pullRequestIconAsset(state),
              );
              final next = tester.getSize(
                find.byType(WorkspacePullRequestLabel),
              );
              size ??= next;
              expect(next, size);
              expect(tester.takeException(), isNull);
            }
          }
        }
        for (final style in StatusLineStyle.values) {
          for (final width in [0.0, 8.0, 24.0, 40.0, 80.0, 120.0]) {
            await tester.pumpWidget(
              MaterialApp(
                theme: grid.buildAppTheme(brightness: Brightness.dark),
                home: Center(
                  child: SizedBox(
                    width: width,
                    child: WorkspacePullRequestLabel(
                      number: 123456,
                      state: 'Open',
                      style: style,
                    ),
                  ),
                ),
              ),
            );
            await tester.pumpAndSettle();
            expect(tester.takeException(), isNull);
          }
        }
      } finally {
        semantics.dispose();
      }
    },
  );
}
