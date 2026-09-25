import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shortcuts/app_keymap.dart';
import 'package:harness/terminal/terminal_text.dart';
import 'package:harness/widgets/workspace_welcome.dart';
import 'package:xterm/xterm.dart';

import 'keymap_host_test.dart' show MemoryKeymap;
import 'support/real_fonts.dart';

void main() {
  late MemoryKeymap keymap;
  late TerminalStyle savedFont;
  late Brightness savedBrightness;
  final commands = <String>[];
  final boundary = GlobalKey();

  setUpAll(() async {
    if (Platform.isMacOS) {
      final bytes = await File('/System/Library/Fonts/Menlo.ttc').readAsBytes();
      await (FontLoader(
        'Menlo',
      )..addFont(Future.value(ByteData.sublistView(bytes)))).load();
    } else {
      await loadRealFonts();
    }
    await (FontLoader(
      'MaterialIcons',
    )..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'))).load();
  });
  setUp(() {
    keymap = MemoryKeymap();
    commands.clear();
    savedFont = terminalFontStore.value;
    savedBrightness = grid.AppTheme.brightness.value;
    terminalFontStore.value = const TerminalStyle(
      fontFamily: 'Menlo',
      fontSize: 18,
    );
  });
  tearDown(() {
    keymap.dispose();
    terminalFontStore.value = savedFont;
    grid.AppTheme.brightness.value = savedBrightness;
  });

  Future<void> mount(
    WidgetTester tester, {
    String tab = 'first',
    Size size = const Size(1120, 700),
    double scale = 1,
    Brightness brightness = Brightness.dark,
  }) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = size;
    addTearDown(tester.view.reset);
    grid.AppTheme.brightness.value = brightness;
    await tester.pumpWidget(
      MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: grid.buildAppTheme(brightness: brightness),
        builder: (context, child) => KeymapProvider(
          keymap: keymap,
          child: MediaQuery(
            data: MediaQuery.of(context)
                .copyWith(textScaler: TextScaler.linear(scale)),
            child: child!,
          ),
        ),
        home: RepaintBoundary(
          key: boundary,
          child: WorkspaceWelcome(key: ValueKey(tab), onCommand: commands.add),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
  }

  Future<void> capture(WidgetTester tester, String name) async {
    final directory = Platform.environment['HARNESS_WELCOME_CAPTURE_DIR'];
    if (directory == null) return;
    await tester.runAsync(() async {
      final image =
          await (boundary.currentContext!.findRenderObject()
                  as RenderRepaintBoundary)
              .toImage();
      final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
      await Directory(directory).create(recursive: true);
      await File('$directory/$name.png')
          .writeAsBytes(bytes!.buffer.asUint8List());
      image.dispose();
    });
  }

  testWidgets('first launch and new tabs show the same working shortcuts', (
    tester,
  ) async {
    for (final tab in ['first', 'next']) {
      await mount(tester, tab: tab);
      expect(find.text('Follow your curiosity.'), findsOneWidget);
      expect(find.text('✓'), findsNothing);
      expect(find.text('○'), findsNothing);
      for (final hint in ['⌘N', '⌘P', '⌘S']) {
        expect(find.text(hint), findsOneWidget);
      }
      expect(find.text('⌘O'), findsNothing);
      commands.clear();
      for (final command in ['agent.new', 'harnesses.list', 'app.store']) {
        await tester.tap(find.byKey(ValueKey('welcome-$command')));
      }
      expect(commands, ['agent.new', 'harnesses.list', 'app.store']);
      await capture(tester, 'new-tab-$tab');
    }
  });

  testWidgets('live remaps and unbinding keep the displayed actions honest', (
    tester,
  ) async {
    await mount(tester);
    keymap.apply('''{"bindings":[
      {"keys":"cmd+p","command":null},
      {"keys":"cmd+u","command":"harnesses.list"}
    ]}''');
    await tester.pump();
    expect(find.text('⌘P'), findsNothing);
    expect(find.text('⌘U'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('welcome-harnesses.list')));
    expect(commands, ['harnesses.list']);

    keymap.apply('{"bindings":[{"keys":"cmd+p","command":null}]}');
    await tester.pump();
    expect(find.text('click'), findsOneWidget);
    expect(find.text('Open Harness'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('welcome-harnesses.list')));
    expect(commands, ['harnesses.list', 'harnesses.list']);
    expect(tester.takeException(), isNull);
  });

  for (final brightness in Brightness.values) {
    testWidgets('welcome fits a narrow window with large text ($brightness)', (
      tester,
    ) async {
      await mount(
        tester,
        size: const Size(600, 500),
        scale: 1.7,
        brightness: brightness,
      );
      for (final command in ['agent.new', 'harnesses.list', 'app.store']) {
        final row = find.byKey(ValueKey('welcome-$command'));
        await tester.ensureVisible(row);
        await tester.pumpAndSettle();
        expect(row.hitTestable(), findsOneWidget);
        await tester.tap(row);
      }
      expect(commands, ['agent.new', 'harnesses.list', 'app.store']);
      final scroll = tester.getRect(
        find.byKey(const ValueKey('welcome-scroll')),
      );
      final customize = tester.getRect(
        find.byKey(const ValueKey('welcome-customize')),
      );
      expect(scroll.bottom, lessThan(customize.top));
      await capture(tester, 'new-tab-narrow-${brightness.name}');
    });
  }
}
