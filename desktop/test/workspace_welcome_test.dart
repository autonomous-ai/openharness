import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shortcuts/app_keymap.dart';
import 'package:harness/state/workspace_onboarding.dart';
import 'package:harness/terminal/terminal_text.dart';
import 'package:harness/widgets/workspace_welcome.dart';
import 'package:xterm/xterm.dart';

import 'keymap_host_test.dart' show MemoryKeymap;
import 'support/real_fonts.dart';
import 'swarm_state_test.dart' show MemoryStore;

class _HeldStore extends MemoryStore {
  final reads = <String, Completer<String?>>{};
  @override
  Future<String?> read(String key) =>
      (reads[key] = Completer<String?>()).future;
}

void main() {
  late WorkspaceOnboarding journey;
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
    journey.dispose();
    keymap.dispose();
    terminalFontStore.value = savedFont;
    grid.AppTheme.brightness.value = savedBrightness;
  });

  void observe(Set<OnboardingStep> steps, {String scope = 'review'}) {
    journey.sync(
      scope: scope,
      observed: steps,
      otherComputer: false,
      modelsAvailable: true,
    );
  }

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
          child: WorkspaceWelcome(
            key: ValueKey(tab),
            onboarding: journey,
            onCommand: commands.add,
          ),
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

  testWidgets('actual progress stays visible until the next new tab', (
    tester,
  ) async {
    journey = WorkspaceOnboarding();
    observe({});
    await mount(tester);
    expect(find.text('HARNESS'), findsNothing);
    expect(find.text('Harness like a boss.'), findsOneWidget);
    expect(find.text('○'), findsNWidgets(3));
    for (final hint in ['⌘N', '⌘M', '⌘I']) {
      expect(find.text(hint), findsOneWidget);
    }
    await capture(tester, 'new-tab-first');
    for (final command in ['agent.new', 'machines.list', 'models.list']) {
      await tester.tap(find.byKey(ValueKey('welcome-$command')));
    }
    expect(commands, ['agent.new', 'machines.list', 'models.list']);
    journey.acknowledge(OnboardingStep.harnesses);
    await tester.pump();
    expect(find.text('✓'), findsNothing);
    observe({OnboardingStep.harnesses});
    await tester.pump();
    expect(find.text('✓'), findsOneWidget);
    expect(find.text('○'), findsNWidgets(2));
    await capture(tester, 'new-tab-progress');
    observe({OnboardingStep.machines, OnboardingStep.models});
    await tester.pump();
    expect(find.text('✓'), findsNWidgets(3));
    expect(find.text('Harness like a boss.'), findsOneWidget);
    await capture(tester, 'new-tab-completed');

    // A regular rebuild does not remove the user's last check.
    await mount(tester);
    expect(find.text('✓'), findsNWidgets(3));
    await mount(tester, tab: 'next');
    expect(find.text('Follow your curiosity.'), findsOneWidget);
    expect(find.text('✓'), findsNothing);
    expect(find.text('○'), findsNothing);
    for (final hint in ['⌘N', '⌘O', '⌘S']) {
      expect(find.text(hint), findsOneWidget);
    }
    commands.clear();
    for (final command in ['agent.new', 'agent.open', 'app.store']) {
      await tester.tap(find.byKey(ValueKey('welcome-$command')));
    }
    expect(commands, ['agent.new', 'agent.open', 'app.store']);
    await capture(tester, 'new-tab-everyday');
  });

  testWidgets(
    'saved progress loads before choosing the visit and stays account scoped',
    (tester) async {
      final storage = _HeldStore();
      journey = WorkspaceOnboarding(storage: storage);
      observe({});
      await mount(tester);
      storage.reads[WorkspaceOnboarding.storageKey('review')]!.complete(
        '{"completed":["harnesses","machines","models"]}',
      );
      await tester.pumpAndSettle();
      expect(find.text('Follow your curiosity.'), findsOneWidget);

      observe({}, scope: 'another-account');
      await tester.pump();
      expect(find.text('✓'), findsNothing);
      storage.reads[WorkspaceOnboarding.storageKey('another-account')]!
          .complete('{"completed":["harnesses"]}');
      await tester.pumpAndSettle();
      expect(find.text('Harness like a boss.'), findsOneWidget);
      expect(find.text('✓'), findsOneWidget);
      expect(find.text('○'), findsNWidgets(2));
    },
  );

  testWidgets('live remaps and unbinding keep the displayed actions honest', (
    tester,
  ) async {
    journey = WorkspaceOnboarding();
    observe({});
    await mount(tester);
    keymap.apply('''{"bindings":[
      {"keys":"cmd+i","command":null},
      {"keys":"cmd+u","command":"models.list"}
    ]}''');
    await tester.pump();
    expect(find.text('⌘I'), findsNothing);
    expect(find.text('⌘U'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('welcome-models.list')));
    expect(commands, ['models.list']);

    keymap.apply('{"bindings":[{"keys":"cmd+i","command":null}]}');
    await tester.pump();
    expect(find.text('click'), findsOneWidget);
    expect(find.text('Models'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('welcome-models.list')));
    expect(commands, ['models.list', 'models.list']);
    expect(tester.takeException(), isNull);
  });

  for (final brightness in Brightness.values) {
    testWidgets(
      'onboarding fits a narrow window with large text ($brightness)',
      (tester) async {
        journey = WorkspaceOnboarding();
        observe({OnboardingStep.harnesses});
        await mount(
          tester,
          size: const Size(600, 500),
          scale: 1.7,
          brightness: brightness,
        );
        expect(find.text('✓'), findsOneWidget);
        for (final command in ['agent.new', 'machines.list', 'models.list']) {
          final row = find.byKey(ValueKey('welcome-$command'));
          await tester.ensureVisible(row);
          await tester.pumpAndSettle();
          expect(row.hitTestable(), findsOneWidget);
          await tester.tap(row);
        }
        expect(commands, ['agent.new', 'machines.list', 'models.list']);
        final scroll = tester.getRect(
          find.byKey(const ValueKey('welcome-scroll')),
        );
        final customize = tester.getRect(
          find.byKey(const ValueKey('welcome-customize')),
        );
        expect(scroll.bottom, lessThan(customize.top));
        await capture(tester, 'new-tab-narrow-${brightness.name}');
      },
    );
  }
}
