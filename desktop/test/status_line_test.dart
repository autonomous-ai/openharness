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
            expect(pr.text, 'PR #298 · $state');
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
        expect(designs, hasLength(5));
      }
      expect(StatusLineStyle.fromId('starship'), StatusLineStyle.standard);
      expect(fitStatusLineWidths([10, 80, 40], 90), [
        10,
        closeTo(40, .01),
        closeTo(40, .01),
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
                          body: Align(
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
