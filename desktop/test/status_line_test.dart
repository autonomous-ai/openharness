import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/theme/status_line_style.dart';
import 'package:harness/terminal/terminal_text.dart';
import 'package:harness/terminal/terminal_theme.dart';
import 'package:harness/terminal/terminal_theme_store.dart';
import 'package:harness/widgets/status_line.dart';

import 'support/real_fonts.dart';

void main() {
  setUpAll(loadRealFonts);
  test(
    'themes have distinct resolved colors and segments, including PR states',
    () {
      for (final theme in [darkTerminalTheme, tangoTerminalTheme]) {
        final designs = <String>{};
        for (final style in StatusLineStyle.values) {
          final parts = statusLineParts(
            provider: 'OpenAI',
            machine: 'M2',
            project: 'app',
            branch: 'main',
            style: style,
          );
          final paint = statusLinePaintSegments(parts, theme);
          if (style == StatusLineStyle.standard) {
            expect(
              paint.map((part) => part.foreground),
              everyElement(theme.foreground),
            );
          }
          designs.add(paint.map((p) => p.toJson()).toString());
          expect(paint.any((p) => p.background != null), style.segmented);
          expect(
            statusLinePaintSegments(
              parts,
              theme,
              color: false,
            ).map((p) => p.foreground),
            everyElement(theme.foreground),
          );
          for (final state in ['Draft', 'Open', 'Merged', 'Closed']) {
            final pr = pullRequestStatusLineParts(
              number: 298,
              state: state,
              style: style,
            );
            expect(pr.text, '#298 $state');
            if (style == StatusLineStyle.standard) {
              expect(
                statusLinePaintSegments(
                  pr,
                  theme,
                ).map((part) => part.foreground),
                everyElement(theme.foreground),
              );
            }
            expect(
              statusLinePaintSegments(
                pr,
                theme,
              ).any((p) => p.background != null),
              style.segmented,
            );
          }
          expect(
            statusLineParts(
              provider: '',
              machine: '',
              project: '',
              style: style,
            ).text,
            isEmpty,
          );
        }
        expect(designs, hasLength(StatusLineStyle.values.length));
      }
      expect(StatusLineStyle.fromId('unknown'), StatusLineStyle.standard);
      expect(fitStatusLineWidths([10, 80, 40], 90), [
        10,
        closeTo(40, .01),
        closeTo(40, .01),
      ]);
    },
  );

  test(
    'branch symbols follow real branches without changing searchable text',
    () {
      for (final style in StatusLineStyle.values) {
        for (var mask = 0; mask < 8; mask++) {
          final branch = mask & 4 == 0 ? null : 'feature/日本語';
          final parts = statusLineParts(
            provider: '',
            machine: mask & 1 == 0 ? '' : 'M2',
            project: mask & 2 == 0 ? '' : 'app',
            branch: branch,
            style: style,
          );
          final icons = parts.segments.where((part) => part.branchSymbol);
          expect(icons.length, branch != null && style.branchSymbol ? 1 : 0);
          if (icons.isNotEmpty) {
            expect(icons.single.text, branch);
            expect(icons.single.field, StatusLineField.branch);
          }
          expect(
            parts.text.runes.any((rune) => rune >= 0xe000 && rune <= 0xf8ff),
            isFalse,
          );
          for (final color in [true, false]) {
            final whole = statusLinePaintSegments(
              parts,
              darkTerminalTheme,
              color: color,
            );
            final split = [
              for (final component in parts.components)
                ...statusLinePaintSegments(
                  component.parts,
                  darkTerminalTheme,
                  color: color,
                  segmentOffset: component.offset,
                ),
            ];
            expect(split.map((p) => p.toJson()), whole.map((p) => p.toJson()));
          }
        }
      }
    },
  );

  test(
    'named palettes keep their identity and readable context and PR text',
    () {
      for (final style in [
        StatusLineStyle.pastelPowerline,
        StatusLineStyle.catppuccinPowerline,
        StatusLineStyle.tokyoNight,
        StatusLineStyle.gruvboxRainbow,
      ]) {
        final context = statusLineParts(
          provider: '',
          machine: 'M2',
          project: 'app',
          branch: 'main',
          style: style,
        );
        for (final parts in [
          context,
          for (final state in ['Open', 'Merged', 'Closed', 'Draft'])
            pullRequestStatusLineParts(number: 298, state: state, style: style),
        ]) {
          final paint = statusLinePaintSegments(parts, darkTerminalTheme);
          expect(
            paint.map((p) => p.toJson()),
            statusLinePaintSegments(
              parts,
              tangoTerminalTheme,
            ).map((p) => p.toJson()),
          );
          for (final segment in paint) {
            final a = segment.foreground.computeLuminance();
            final b = segment.background!.computeLuminance();
            final contrast = a > b
                ? (a + .05) / (b + .05)
                : (b + .05) / (a + .05);
            expect(
              contrast,
              greaterThanOrEqualTo(4.5),
              reason: '${style.name}: ${segment.text}',
            );
          }
          expect(
            statusLinePaintSegments(
              parts,
              tangoTerminalTheme,
              color: false,
            ).map((s) => s.foreground),
            everyElement(tangoTerminalTheme.foreground),
          );
        }
      }
      final catppuccin = statusLinePaintSegments(
        statusLineParts(
          provider: '',
          machine: 'M2',
          project: 'app',
          branch: 'main',
          style: StatusLineStyle.catppuccinPowerline,
        ),
        darkTerminalTheme,
      );
      expect(catppuccin.map((s) => s.background), const [
        Color(0xfff38ba8),
        Color(0xfffab387),
        Color(0xfff9e2af),
      ]);
    },
  );

  testWidgets(
    'every theme and PR fit one terminal row at narrow widths and large text',
    (tester) async {
      final previousTheme = terminalThemeStore.value;
      addTearDown(() => terminalThemeStore.value = previousTheme);
      tester.view.physicalSize = const Size(1000, 750);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      final boundary = GlobalKey();
      for (final choice in TerminalThemeChoice.values) {
        terminalThemeStore.value = choice;
        for (final scale in [1.0, 1.8]) {
          for (final width in [160.0, 840.0]) {
            await tester.pumpWidget(
              MaterialApp(
                debugShowCheckedModeBanner: false,
                theme: grid.buildAppTheme(brightness: Brightness.dark),
                home: MediaQuery(
                  data: MediaQueryData(textScaler: TextScaler.linear(scale)),
                  child: TerminalFontScope(
                    child: Builder(
                      builder: (context) {
                        final cell = terminalCellSizeOf(context);
                        return Scaffold(
                          backgroundColor: terminalThemeFor(
                            grid.AppTheme.palette.value,
                            choice,
                          ).background,
                          body: SingleChildScrollView(
                            child: Align(
                              alignment: Alignment.topLeft,
                              child: RepaintBoundary(
                                key: boundary,
                                child: SizedBox(
                                  width: width,
                                  child: Column(
                                    mainAxisSize: MainAxisSize.min,
                                    crossAxisAlignment:
                                        CrossAxisAlignment.stretch,
                                    children: [
                                      for (final style
                                          in StatusLineStyle.values) ...[
                                        Text(
                                          style.label,
                                          style: terminalContentStyle(
                                            color: Colors.grey,
                                          ),
                                        ),
                                        SizedBox(
                                          height: cell.height,
                                          child: StatusLine(
                                            key: ValueKey(
                                              'context-${style.name}',
                                            ),
                                            textAlign: TextAlign.left,
                                            parts: statusLineParts(
                                              provider: 'OpenAI',
                                              machine: 'M2',
                                              project: 'openharness',
                                              branch: 'feature/日本語',
                                              style: style,
                                            ),
                                          ),
                                        ),
                                        SizedBox(
                                          height: cell.height,
                                          child: StatusLine(
                                            textAlign: TextAlign.left,
                                            parts: pullRequestStatusLineParts(
                                              number: 298,
                                              state: 'Merged',
                                              style: style,
                                            ),
                                          ),
                                        ),
                                        SizedBox(height: cell.height),
                                      ],
                                    ],
                                  ),
                                ),
                              ),
                            ),
                          ),
                        );
                      },
                    ),
                  ),
                ),
              ),
            );
            await tester.pump();
            expect(tester.takeException(), isNull);
            for (final style in StatusLineStyle.values) {
              expect(
                tester
                    .getSize(find.byKey(ValueKey('context-${style.name}')))
                    .width,
                width,
              );
            }
            final directory =
                Platform.environment['HARNESS_STATUS_CAPTURE_DIR'];
            if (directory != null && scale == 1 && width == 840) {
              await tester.runAsync(() async {
                final render =
                    boundary.currentContext!.findRenderObject()!
                        as RenderRepaintBoundary;
                final image = await render.toImage();
                final bytes = await image.toByteData(
                  format: ui.ImageByteFormat.png,
                );
                await Directory(directory).create(recursive: true);
                await File('$directory/${choice.name}.png')
                    .writeAsBytes(bytes!.buffer.asUint8List());
                image.dispose();
              });
            }
          }
        }
      }
      await tester.pumpWidget(const SizedBox());
    },
  );
}
