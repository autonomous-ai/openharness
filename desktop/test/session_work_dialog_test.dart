import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/theme/color_palette.dart';
import 'package:harness/shared/theme/pull_request_icon.dart';
import 'package:harness/terminal/terminal_text.dart';
import 'package:harness/terminal/terminal_theme_store.dart';
import 'package:harness/widgets/desktop_chrome.dart';
import 'package:harness/widgets/session_work_dialog.dart';
import 'package:xterm/xterm.dart' show TerminalStyle;

import 'session_git_context_test.dart';
import 'support/real_fonts.dart';

Future<void> captureDialog(
  WidgetTester tester,
  GlobalKey boundary,
  String name,
) async {
  final output = Platform.environment['HARNESS_GIT_CONTEXT_CAPTURE_DIR'];
  if (output == null) return;
  final oldShadows = debugDisableShadows;
  void repaint(RenderObject object) {
    object.markNeedsPaint();
    object.visitChildren(repaint);
  }

  final render =
      boundary.currentContext!.findRenderObject()! as RenderRepaintBoundary;
  try {
    debugDisableShadows = false;
    repaint(render);
    await tester.pumpAndSettle();
    await tester.runAsync(() async {
      final picture = await render.toImage(pixelRatio: 2);
      final bytes = await picture.toByteData(format: ui.ImageByteFormat.png);
      await Directory(output).create(recursive: true);
      await File('$output/$name.png').writeAsBytes(bytes!.buffer.asUint8List());
      picture.dispose();
    });
  } finally {
    debugDisableShadows = oldShadows;
    repaint(render);
    await tester.pump();
  }
}

void main() {
  final capture = Platform.environment['HARNESS_GIT_CONTEXT_CAPTURE_DIR'];
  setUpAll(() async {
    // Captures use the actual macOS system face. Portable regression runs
    // retain the shared metric-compatible test fonts.
    if (capture != null && Platform.isMacOS) {
      for (final (family, path) in [
        ('.AppleSystemUIFont', '/System/Library/Fonts/SFNS.ttf'),
        ('.AppleSystemUIFontMonospaced', '/System/Library/Fonts/SFNSMono.ttf'),
        ('Roboto', '/System/Library/Fonts/Supplemental/Arial.ttf'),
      ]) {
        final bytes = ByteData.sublistView(await File(path).readAsBytes());
        await (FontLoader(family)..addFont(Future.value(bytes))).load();
      }
    } else {
      await loadRealFonts();
    }
  });
  testWidgets(
    'PRs appear once and branches are a separate keyboard-accessible view',
    (tester) async {
      final opened = <Uri>[];
      final git = gitFixture();
      git['activityUncertain'] = true;
      git['checkouts'] = [git['current']];
      git['recentWork'] = {
        'project': git['current'],
        'at': '2026-09-27T13:00:00Z',
      };
      git['history']['pullRequests'][0]['result'].addAll({
        'headBranch': 'hn/preview-fix',
        'baseBranch': 'main',
        'headRepository': 'acme/app',
        'title': 'Keep complete session previews',
        'updatedAt': '2026-09-27T13:00:00Z',
      });
      git['history']['branches'].add({
        'cwd': '/removed-temporary-checkout',
        'remote': 'github.com/acme/app',
        'branch': 'hn/nfc',
        'at': '2026-09-26T13:00:00Z',
      });
      git['history']['pullRequests'].add({
        'url': 'https://github.com/acme/app/pull/119',
        'cwd': '/removed-temporary-checkout',
        'at': '2026-09-26T13:00:00Z',
        'checkedAt': '2026-09-27T13:01:00Z',
        'result': {
          'status': 'found',
          'url': 'https://github.com/acme/app/pull/119',
          'number': 119,
          'state': 'Merged',
          'headBranch': 'hn/nfc',
          'baseBranch': 'main',
          'headRepository': 'acme/app',
          'title': 'Keep NFC conversations in order',
          'mergedAt': '2026-09-26T13:00:00Z',
        },
      });
      final boundary = GlobalKey();
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(1000, 720);
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        RepaintBoundary(
          key: boundary,
          child: MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: grid.buildAppTheme(brightness: Brightness.dark),
            home: Scaffold(
              body: SessionWorkDialog(
                agent: workAgent(git: git),
                read: (_) async => {
                  'gitContext': git,
                  'history': git['history'],
                },
                open: (uri) async {
                  opened.add(uri);
                  return true;
                },
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.textContaining('/silent-beacon'), findsNothing);
      expect(find.textContaining('/ship-hn'), findsNothing);
      expect(find.text('hn/preview-fix'), findsNothing);
      expect(find.text('Recent work'), findsNothing);
      expect(find.text('hn'), findsOneWidget);
      expect(find.text('acme/app'), findsOneWidget);
      expect(find.text('Pull requests (2)'), findsOneWidget);
      expect(find.text('Branches (2)'), findsOneWidget);
      expect(find.textContaining('#12 ·'), findsOneWidget);
      expect(find.text('Keep complete session previews'), findsOneWidget);
      expect(find.textContaining('#119 ·'), findsOneWidget);
      expect(find.text('2026-09-26'), findsOneWidget);
      expect(find.textContaining('completed'), findsNothing);
      expect(find.textContaining('Checked 2026'), findsNothing);
      expect(
        tester
            .getSize(find.byKey(const ValueKey('work-dialog-surface')))
            .height,
        lessThan(360),
      );
      expect(find.text('Work location unknown'), findsNothing);
      expect(find.byType(DesktopDialogSurface), findsOneWidget);
      expect(
        tester
            .widget<Text>(find.text('Keep complete session previews'))
            .style!
            .fontFamily,
        grid.AppType.sansFamily,
      );
      expect(
        tester
            .widgetList<SvgPicture>(find.byType(SvgPicture))
            .map((icon) => (icon.bytesLoader as SvgAssetLoader).assetName),
        [pullRequestIconAsset('Open'), pullRequestIconAsset('Merged')],
      );
      for (final state in ['Open', 'Merged']) {
        expect(
          tester.widget<Text>(find.text(state)).style!.color,
          DesktopChrome.foreground,
        );
      }

      await captureDialog(tester, boundary, 'pull-requests');
      await tester.tap(
        find.byKey(
          const ValueKey('work-pr-https://github.com/acme/app/pull/12'),
        ),
      );
      await tester.pumpAndSettle();
      expect(opened, [Uri.parse('https://github.com/acme/app/pull/12')]);
      await tester.tap(find.byKey(const ValueKey('git-branches-tab')));
      await tester.pumpAndSettle();
      expect(find.text('hn/nfc'), findsOneWidget);
      expect(find.text('hn/preview-fix'), findsOneWidget);
      expect(find.text('Checked out'), findsOneWidget);
      expect(find.text('Keep NFC conversations in order'), findsNothing);
      expect(tester.takeException(), isNull);
      await captureDialog(tester, boundary, 'branches');
      tester
          .widget<TextButton>(
            find.descendant(
              of: find.byKey(const ValueKey('git-branches-tab')),
              matching: find.byType(TextButton),
            ),
          )
          .focusNode!
          .requestFocus();
      await tester.pumpAndSettle();
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowLeft);
      await tester.pumpAndSettle();
      expect(find.text('Keep NFC conversations in order'), findsOneWidget);
      expect(find.text('Checked out'), findsNothing);
    },
  );

  testWidgets(
    'merged PRs remain visible in GitHub date order and loading more preserves history',
    (tester) async {
      final git = gitFixture();
      final saved = Map<String, Object>.from(
        git['history']['pullRequests'][0] as Map,
      );
      git['history']['pullRequests'] = [
        for (final (number, title, date) in [
          (12, 'Earlier change', '2026-09-20'),
          (13, 'Latest change', '2026-09-22'),
          (14, 'Another change', '2026-09-21'),
        ])
          {
            ...saved,
            'url': 'https://github.com/acme/app/pull/$number',
            'result': {
              ...(saved['result'] as Map),
              'url': 'https://github.com/acme/app/pull/$number',
              'state': 'Merged',
              'number': number,
              'title': title,
              'headBranch': 'hn/preview-fix',
              'baseBranch': 'main',
              'mergedAt': '${date}T13:00:00Z',
            },
          },
      ];
      final calls = <int>[];
      final boundary = GlobalKey();
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(1000, 720);
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        RepaintBoundary(
          key: boundary,
          child: MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: grid.buildAppTheme(brightness: Brightness.dark),
            home: Scaffold(
              body: SessionWorkDialog(
                agent: workAgent(git: git),
                read: (offset) async {
                  calls.add(offset);
                  return {
                    'gitContext': git,
                    'history': git['history'],
                    'nextOffset': offset == 0 ? 4 : null,
                  };
                },
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(
        tester.getTopLeft(find.text('Latest change')).dy,
        lessThan(tester.getTopLeft(find.text('Another change')).dy),
      );
      expect(
        tester.getTopLeft(find.text('Another change')).dy,
        lessThan(tester.getTopLeft(find.text('Earlier change')).dy),
      );
      expect(find.text('Merged'), findsNWidgets(3));
      expect(find.textContaining('completed'), findsNothing);
      await captureDialog(tester, boundary, 'merged-pull-requests');
      await tester.tap(find.widgetWithText(TextButton, 'Load more'));
      await tester.pumpAndSettle();
      expect(calls, [0, 4]);
      expect(find.text('Merged'), findsNWidgets(3));
      expect(find.widgetWithText(TextButton, 'Load more'), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'scrolling to merged PRs and changing appearance preserves the focused link',
    (tester) async {
      final git = manyPrFixture();
      final opened = <Uri>[];
      await tester.pumpWidget(
        grid.BrightnessScope(
          child: MaterialApp(
            home: Scaffold(
              body: SessionWorkDialog(
                agent: workAgent(git: git),
                online: false,
                read: (_) async => throw StateError('Offline'),
                open: (uri) async {
                  opened.add(uri);
                  return true;
                },
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      final target = find.byKey(
        const ValueKey('work-pr-https://github.com/acme/app/pull/122'),
      );
      await tester.scrollUntilVisible(
        target,
        100,
        scrollable: find.descendant(
          of: find.byKey(const ValueKey('git-prs-list')),
          matching: find.byType(Scrollable),
        ),
      );
      await tester.tap(target);
      await tester.pumpAndSettle();
      expect(opened, [Uri.parse('https://github.com/acme/app/pull/122')]);
      final buttonContext = tester.element(
        find.descendant(of: target, matching: find.byType(Row)).first,
      );
      Focus.of(buttonContext).requestFocus();
      await tester.pumpAndSettle();
      final focus = FocusManager.instance.primaryFocus;
      final rowRect = tester.getRect(target);
      final dialogRect = tester.getRect(
        find.byKey(const ValueKey('work-dialog-surface')),
      );
      final palette = grid.AppTheme.palette.value;
      final theme = terminalThemeStore.value;
      final font = terminalFontStore.value;
      addTearDown(() {
        grid.AppTheme.palette.value = palette;
        terminalThemeStore.value = theme;
        terminalFontStore.value = font;
      });
      grid.AppTheme.palette.value = HarnessPalette.midnight;
      terminalThemeStore.value = TerminalThemeChoice.tango;
      terminalFontStore.value = TerminalStyle(
        fontFamily: font.fontFamily,
        fontSize: font.fontSize + 1,
      );
      await tester.pumpAndSettle();
      expect(FocusManager.instance.primaryFocus, same(focus));
      expect(target.hitTestable(), findsOneWidget);
      expect(tester.getRect(target), rowRect);
      expect(
        tester.getRect(find.byKey(const ValueKey('work-dialog-surface'))),
        dialogRect,
      );
      expect(find.textContaining('completed'), findsNothing);
      expect(tester.takeException(), isNull);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(opened, [
        Uri.parse('https://github.com/acme/app/pull/122'),
        Uri.parse('https://github.com/acme/app/pull/122'),
      ]);
    },
  );

  testWidgets(
    'page keys scroll the active list, including overflowing branches',
    (tester) async {
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(420, 420);
      addTearDown(tester.view.reset);
      final git = manyPrFixture();
      (git['history']['branches'] as List).addAll(<Map<String, String>>[
        for (var i = 0; i < 30; i++)
          {
            'cwd': '/ship-hn',
            'remote': 'github.com/acme/app',
            'branch': 'feature/iteration-${i.toString().padLeft(2, '0')}',
            'at': '2026-09-27T13:00:00Z',
          },
        {
          'cwd': '/ship-hn',
          'remote': 'github.com/acme/app',
          'branch': 'z-last-branch',
          'at': '2026-09-27T13:00:00Z',
        },
      ]);
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context)
                .copyWith(textScaler: const TextScaler.linear(1.6)),
            child: child!,
          ),
          home: Scaffold(
            body: SessionWorkDialog(
              agent: workAgent(git: git),
              online: false,
              read: (_) => throw StateError('Offline must not request data'),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      ScrollPosition position(String key) => tester
          .state<ScrollableState>(
            find.descendant(
              of: find.byKey(ValueKey(key)),
              matching: find.byType(Scrollable),
            ),
          )
          .position;
      final prs = position('git-prs-list');
      expect(prs.maxScrollExtent, greaterThan(0));
      await tester.sendKeyEvent(LogicalKeyboardKey.pageDown);
      await tester.pumpAndSettle();
      expect(prs.pixels, greaterThan(0));
      await tester.tap(find.byKey(const ValueKey('git-branches-tab')));
      await tester.pumpAndSettle();
      tester
          .widget<DesktopPill>(find.byKey(const ValueKey('git-branches-tab')))
          .focusNode!
          .requestFocus();
      await tester.pumpAndSettle();
      final branches = position('git-branches-list');
      expect(branches.maxScrollExtent, greaterThan(branches.viewportDimension));
      expect(branches.pixels, 0);
      await tester.sendKeyEvent(LogicalKeyboardKey.pageDown);
      await tester.pumpAndSettle();
      expect(branches.pixels, greaterThan(0));
      for (
        var i = 0;
        i < 60 && branches.pixels < branches.maxScrollExtent;
        i++
      ) {
        await tester.sendKeyEvent(LogicalKeyboardKey.pageDown);
        await tester.pumpAndSettle();
      }
      expect(find.text('z-last-branch').hitTestable(), findsOneWidget);
      for (var i = 0; i < 60 && branches.pixels > 0; i++) {
        await tester.sendKeyEvent(LogicalKeyboardKey.pageUp);
        await tester.pumpAndSettle();
      }
      expect(branches.pixels, 0);
      expect(
        find.text(git['current']['branch'] as String).hitTestable(),
        findsOneWidget,
      );
      await tester.tap(find.byKey(const ValueKey('git-prs-tab')));
      await tester.pumpAndSettle();
      tester
          .widget<DesktopPill>(find.byKey(const ValueKey('git-prs-tab')))
          .focusNode!
          .requestFocus();
      await tester.pumpAndSettle();
      final activePrs = position('git-prs-list');
      final prOffset = activePrs.pixels;
      await tester.sendKeyEvent(LogicalKeyboardKey.pageDown);
      await tester.pumpAndSettle();
      expect(activePrs.pixels, greaterThan(prOffset));
      await tester.sendKeyEvent(LogicalKeyboardKey.pageUp);
      await tester.pumpAndSettle();
      expect(activePrs.pixels, closeTo(prOffset, .01));
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'late replies after dismissal cannot reopen or replace another view',
    (tester) async {
      final reply = Completer<Map<String, dynamic>>();
      final focus = FocusNode();
      addTearDown(focus.dispose);
      await tester.pumpWidget(
        MaterialApp(
          home: Builder(
            builder: (context) => Scaffold(
              body: TextButton(
                focusNode: focus,
                autofocus: true,
                onPressed: () => showDialog<void>(
                  context: context,
                  builder: (_) => SessionWorkDialog(
                    agent: workAgent(git: gitFixture()),
                    read: (_) => reply.future,
                  ),
                ),
                child: const Text('Inspect'),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(find.byType(SessionWorkDialog), findsOneWidget);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(find.byType(SessionWorkDialog), findsNothing);
      expect(focus.hasFocus, isTrue);
      reply.complete({'status': 'unavailable'});
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
    },
  );

  for (final brightness in Brightness.values) {
    for (final palette in [HarnessPalette.graphite, HarnessPalette.midnight]) {
      for (final size in [const Size(1000, 720), const Size(420, 680)]) {
        testWidgets(
          'work details fit ${size.width} ${palette.name} ${brightness.name}, including enlarged text',
          (tester) async {
            tester.view.devicePixelRatio = 1;
            tester.view.physicalSize = size;
            addTearDown(tester.view.reset);
            final oldPalette = grid.AppTheme.palette.value;
            final oldBrightness = grid.AppTheme.brightness.value;
            grid.AppTheme.palette.value = palette;
            grid.AppTheme.brightness.value = brightness;
            addTearDown(() {
              grid.AppTheme.palette.value = oldPalette;
              grid.AppTheme.brightness.value = oldBrightness;
            });
            final boundary = GlobalKey();
            await tester.pumpWidget(
              grid.BrightnessScope(
                child: RepaintBoundary(
                  key: boundary,
                  child: MaterialApp(
                    debugShowCheckedModeBanner: false,
                    theme: grid.buildAppTheme(brightness: brightness),
                    builder: (context, child) => MediaQuery(
                      data: MediaQuery.of(context).copyWith(
                        textScaler: TextScaler.linear(
                          size.width < 500 ? 1.6 : 1,
                        ),
                      ),
                      child: child!,
                    ),
                    home: Scaffold(
                      body: SessionWorkDialog(
                        agent: workAgent(git: manyPrFixture()),
                        online: false,
                        read: (_) =>
                            throw StateError('Offline must not request data'),
                      ),
                    ),
                  ),
                ),
              ),
            );
            await tester.pumpAndSettle();
            expect(find.text('Offline'), findsOneWidget);
            expect(find.text('Pull requests (7)'), findsOneWidget);
            expect(tester.takeException(), isNull);
            final surface = tester.getRect(
              find.byKey(const ValueKey('work-dialog-surface')),
            );
            expect(surface.left, greaterThanOrEqualTo(16));
            expect(surface.right, lessThanOrEqualTo(size.width - 16));
            expect(surface.top, greaterThanOrEqualTo(16));
            expect(surface.bottom, lessThanOrEqualTo(size.height - 16));
            final name =
                'work-${size.width.toInt()}-${palette.name}-${brightness.name}';
            await captureDialog(tester, boundary, name);
            if (size.width < 500 && palette == HarnessPalette.graphite) {
              final last = find.byKey(
                const ValueKey('work-pr-https://github.com/acme/app/pull/126'),
              );
              await tester.scrollUntilVisible(
                last,
                100,
                scrollable: find.descendant(
                  of: find.byKey(const ValueKey('git-prs-list')),
                  matching: find.byType(Scrollable),
                ),
              );
              final rowContext = tester.element(
                find.descendant(of: last, matching: find.byType(Row)).first,
              );
              Focus.of(rowContext).requestFocus();
              await tester.pumpAndSettle();
              expect(last.hitTestable(), findsOneWidget);
              expect(tester.takeException(), isNull);
              await captureDialog(tester, boundary, '$name-focused');
            }
            await tester.tap(find.byKey(const ValueKey('git-branches-tab')));
            await tester.pumpAndSettle();
            expect(find.text('Checked out'), findsOneWidget);
            expect(tester.takeException(), isNull);
            await captureDialog(tester, boundary, '$name-branches');
          },
        );
      }
    }

    testWidgets('work loading and errors stay readable in ${brightness.name}', (
      tester,
    ) async {
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(420, 680);
      addTearDown(tester.view.reset);
      final oldBrightness = grid.AppTheme.brightness.value;
      grid.AppTheme.brightness.value = brightness;
      addTearDown(() => grid.AppTheme.brightness.value = oldBrightness);
      final replies = [
        Completer<Map<String, dynamic>>(),
        Completer<Map<String, dynamic>>(),
      ];
      final offsets = <int>[];
      final boundary = GlobalKey();
      await tester.pumpWidget(
        RepaintBoundary(
          key: boundary,
          child: MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: grid.buildAppTheme(brightness: brightness),
            builder: (context, child) => MediaQuery(
              data: MediaQuery.of(context)
                  .copyWith(textScaler: const TextScaler.linear(1.6)),
              child: child!,
            ),
            home: Scaffold(
              body: SessionWorkDialog(
                agent: workAgent(),
                read: (offset) {
                  offsets.add(offset);
                  return replies[offsets.length - 1].future;
                },
                open: (_) async => false,
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Loading…'), findsOneWidget);
      expect(
        tester
            .widget<TextButton>(find.widgetWithText(TextButton, 'Refreshing…'))
            .onPressed,
        isNull,
      );
      await captureDialog(tester, boundary, 'work-loading-${brightness.name}');
      replies.first.complete({'status': 'unavailable'});
      await tester.pumpAndSettle();
      expect(find.text('No pull requests'), findsNothing);
      expect(find.text('Work history is unavailable'), findsOneWidget);
      expect(find.text('Pull requests (0)'), findsNothing);
      expect(find.text('Could not refresh'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await captureDialog(
        tester,
        boundary,
        'work-empty-error-${brightness.name}',
      );
      await tester.tap(find.byKey(const ValueKey('git-branches-tab')));
      await tester.pumpAndSettle();
      expect(find.text('No branches'), findsNothing);
      expect(find.text('Work history is unavailable'), findsOneWidget);
      expect(find.text('Branches (0)'), findsNothing);
      await tester.tap(find.byKey(const ValueKey('git-prs-tab')));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(TextButton, 'Refresh'));
      await tester.pumpAndSettle();
      final git = gitFixture();
      replies.last.complete({'gitContext': git, 'history': git['history']});
      await tester.pumpAndSettle();
      expect(offsets, [0, 0]);
      expect(find.text('Could not refresh'), findsNothing);
      await tester.tap(
        find.byKey(
          const ValueKey('work-pr-https://github.com/acme/app/pull/12'),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Could not open GitHub'), findsOneWidget);
      expect(find.text('#12'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await captureDialog(
        tester,
        boundary,
        'work-open-error-${brightness.name}',
      );
    });
  }
}
