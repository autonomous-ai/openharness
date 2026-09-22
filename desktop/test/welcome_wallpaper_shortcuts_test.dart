import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/local_key_value_store.dart';
import 'package:harness/settings/appearance/wallpaper_section.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/theme/appearance_prefs_store.dart';
import 'package:harness/shared/theme/harness_background.dart';
import 'package:harness/shortcuts/app_keymap.dart';
import 'package:harness/shortcuts/keyboard_practice.dart';
import 'package:harness/shortcuts/shortcuts_browser.dart';
import 'package:harness/terminal/terminal_text.dart';
import 'package:harness/widgets/shortcuts_sheet.dart';
import 'package:harness/widgets/workspace_welcome.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:xterm/xterm.dart';

import 'keymap_host_test.dart' show MemoryKeymap, key;
import 'support/real_fonts.dart';

class _Storage implements LocalKeyValueStore {
  final values = <String, String>{};
  @override
  Future<String?> read(String key) async => values[key];
  @override
  Future<void> write(String key, String value) async => values[key] = value;
  @override
  Future<void> delete(String key) async => values.remove(key);
}

void main() {
  final boundary = GlobalKey();
  late TerminalStyle savedFont;
  late AppearancePrefs savedAppearance;
  late Brightness savedBrightness;

  setUp(() {
    savedBrightness = grid.AppTheme.brightness.value;
    savedFont = terminalFontStore.value;
    savedAppearance = appearancePrefsStore.value;
    appearancePrefsStore.value = const AppearancePrefs();
    PackageInfo.setMockInitialValues(
      appName: 'Harness',
      packageName: 'ai.autonomous.harness',
      version: '1.1.25',
      buildNumber: '25',
      buildSignature: '',
    );
  });
  tearDown(() {
    grid.AppTheme.brightness.value = savedBrightness;
    terminalFontStore.value = savedFont;
    appearancePrefsStore.value = savedAppearance;
  });

  void font(double size) {
    terminalFontStore.value = TerminalStyle(
      fontSize: size,
      fontFamily: 'Menlo',
      fontFamilyFallback: const ['monospace'],
    );
  }

  Future<void> mount(
    WidgetTester tester,
    Widget child, {
    Size size = const Size(1280, 800),
    Brightness brightness = Brightness.dark,
  }) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = size;
    addTearDown(tester.view.reset);
    grid.AppTheme.brightness.value = brightness;
    await tester.runAsync(() async {
      if (Platform.isMacOS) {
        final loader = FontLoader('Menlo');
        final bytes = await File('/System/Library/Fonts/Menlo.ttc')
            .readAsBytes();
        loader.addFont(Future.value(ByteData.sublistView(bytes)));
        await loader.load();
      } else {
        await loadRealFonts();
      }
      final icons = FontLoader('MaterialIcons');
      icons.addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'));
      await icons.load();
    });
    await tester.pumpWidget(
      ListenableBuilder(
        listenable: terminalFontStore,
        builder: (context, _) => MaterialApp(
          debugShowCheckedModeBanner: false,
          themeAnimationDuration: Duration.zero,
          theme: grid.buildAppTheme(brightness: brightness),
          builder: (context, child) => grid.BrightnessScope(child: child!),
          home: RepaintBoundary(key: boundary, child: child),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  Future<void> capture(WidgetTester tester, String name) async {
    final output = Platform.environment['HARNESS_REFINEMENT_CAPTURE_DIR'];
    if (output == null) return;
    await tester.runAsync(() async {
      final image =
          await (boundary.currentContext!.findRenderObject()
                  as RenderRepaintBoundary)
              .toImage();
      final data = await image.toByteData(format: ui.ImageByteFormat.png);
      Directory(output).createSync(recursive: true);
      File('$output/$name.png').writeAsBytesSync(data!.buffer.asUint8List());
      image.dispose();
    });
  }

  void expectUniformText(WidgetTester tester) {
    void check(InlineSpan span, TextStyle parent) {
      final style = parent.merge(span.style);
      if (span is TextSpan) {
        if (span.text?.trim().isNotEmpty == true &&
            style.fontFamily != 'MaterialIcons') {
          expect(style.fontSize, terminalFontStore.size, reason: span.text);
          expect(
            style.fontFamily,
            terminalFontStore.value.fontFamily,
            reason: span.text,
          );
        }
        for (final child in span.children ?? <InlineSpan>[]) {
          check(child, style);
        }
      }
    }

    for (final rich in tester.widgetList<RichText>(find.byType(RichText))) {
      check(rich.text, const TextStyle());
    }
    for (final input in tester.widgetList<EditableText>(
      find.byType(EditableText),
    )) {
      expect(input.style.fontSize, terminalFontStore.size);
      expect(input.style.fontFamily, terminalFontStore.value.fontFamily);
    }
    expect(tester.takeException(), isNull);
  }

  testWidgets(
    'wallpapers keep a centered welcome and the selected terminal type',
    (tester) async {
      font(14);
      final commands = <String>[];
      await mount(tester, WorkspaceWelcome(onCommand: commands.add));
      final text = find.byKey(const ValueKey('workspace-welcome-text'));
      final textRect = tester.getRect(text);
      expect(
        tester
            .widget<Material>(find.byKey(const ValueKey('workspace-welcome')))
            .color,
        grid.AppTheme.palette.value.workspace,
      );
      expect(find.byType(Image), findsNothing);
      for (final choice in HarnessBackground.gallery) {
        if (choice.asset != null) {
          await tester.runAsync(
            () => precacheImage(
              ResizeImage(AssetImage(choice.asset!), width: 1920),
              tester.element(text),
            ),
          );
        }
        appearancePrefsStore.value = appearancePrefsStore.value.copyWith(
          background: choice,
        );
        await tester.pumpAndSettle();
        expect(tester.getRect(text), textRect);
        expectUniformText(tester);
        if (choice.asset != null) {
          expect(
            tester.widget<RawImage>(find.byType(RawImage)).image,
            isNotNull,
            reason: choice.asset,
          );
        }
        await capture(tester, 'welcome-${choice.name}');
      }
      await tester.tap(find.byKey(const ValueKey('welcome-customize')));
      expect(commands, ['app.customize']);
      font(22);
      tester.view.physicalSize = const Size(960, 640);
      await tester.pumpAndSettle();
      expectUniformText(tester);
      expect(tester.getCenter(text), const Offset(480, 320));
      for (final choice in HarnessBackground.gallery.skip(1)) {
        appearancePrefsStore.value = appearancePrefsStore.value.copyWith(
          background: choice,
        );
        await tester.pumpAndSettle();
        expect(tester.getCenter(text), const Offset(480, 320));
        expectUniformText(tester);
        await capture(tester, 'welcome-${choice.name}-large');
      }
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'wallpaper gallery persists a choice and restores the blank default',
    (tester) async {
      final storage = _Storage();
      final prefs = AppearancePrefsStore(storage: storage);
      addTearDown(prefs.dispose);
      font(22);
      await mount(
        tester,
        Material(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(20),
            child: WallpaperSection(store: prefs),
          ),
        ),
        size: const Size(440, 850),
      );
      expect(prefs.value.background, HarnessBackground.plain);
      for (final choice in HarnessBackground.gallery) {
        final card = find.byKey(ValueKey('wallpaper-${choice.name}'));
        await tester.ensureVisible(card);
        await tester.tap(card);
        await tester.pumpAndSettle();
        expect(prefs.value.background, choice);
        expect(tester.takeException(), isNull);
      }
      final restored = AppearancePrefsStore(storage: storage);
      addTearDown(restored.dispose);
      await restored.load();
      expect(restored.value.background, HarnessBackground.terminalStars);
      final blank = find.byKey(const ValueKey('wallpaper-plain'));
      await tester.ensureVisible(blank);
      await tester.tap(blank);
      await tester.pumpAndSettle();
      await restored.load();
      expect(restored.value.background, HarnessBackground.plain);
      await capture(tester, 'wallpaper-gallery');
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'shortcut browser searches live bindings and practices the selected row',
    (tester) async {
      final map = MemoryKeymap();
      addTearDown(map.dispose);
      font(14);
      await mount(
        tester,
        KeymapProvider(
          keymap: map,
          child: const Material(child: ShortcutsBrowser(autofocus: true)),
        ),
      );
      final search = find.byKey(const ValueKey('shortcuts-search'));
      await capture(tester, 'shortcuts-dark');
      expectUniformText(tester);
      await tester.enterText(search, 'clone');
      await tester.pump();
      expect(find.text('Clone Harness'), findsOneWidget);
      expect(find.text('New Tab'), findsNothing);
      await tester.enterText(search, 'unknown shortcut');
      await tester.pump();
      expect(find.textContaining('No shortcuts found'), findsOneWidget);
      map.apply(
        '{"bindings":[{"keys":"cmd+t","command":null},{"keys":"cmd+y","command":"swarm.new"}]}',
      );
      await tester.enterText(search, 'cmd+y');
      await tester.pump();
      expect(find.text('New Tab'), findsOneWidget);
      expect(find.text('Y'), findsOneWidget);
      await key(tester, LogicalKeyboardKey.arrowDown);
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(find.byType(KeyboardPractice), findsOneWidget);
      await key(tester, LogicalKeyboardKey.keyY, cmd: true);
      await tester.pumpAndSettle();
      expect(find.text('[x] New Tab'), findsOneWidget);
      await key(tester, LogicalKeyboardKey.escape);
      await key(tester, LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(find.byType(KeyboardPractice), findsNothing);
      expect(tester.widget<TextField>(search).focusNode!.hasFocus, isTrue);
      await tester.enterText(search, '');
      font(22);
      tester.view.physicalSize = const Size(420, 740);
      await tester.pumpAndSettle();
      expectUniformText(tester);
      await capture(tester, 'shortcuts-narrow-large');
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('shortcut popup fits and closes with Escape', (tester) async {
    font(14);
    late BuildContext host;
    await mount(
      tester,
      Builder(
        builder: (context) {
          host = context;
          return const Material();
        },
      ),
      brightness: Brightness.light,
    );
    showShortcutsSheet(host);
    await tester.pumpAndSettle();
    expect(find.byType(ShortcutsBrowser), findsOneWidget);
    expectUniformText(tester);
    // Dialog lives above the page's boundary; capture it directly when requested.
    final output = Platform.environment['HARNESS_REFINEMENT_CAPTURE_DIR'];
    if (output != null) {
      await expectLater(
        find.byType(MaterialApp),
        matchesGoldenFile(Uri.file('$output/shortcuts-popup.png')),
      );
    }
    await key(tester, LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    expect(find.byType(Dialog), findsNothing);
  });
}
