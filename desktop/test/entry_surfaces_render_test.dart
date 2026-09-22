import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/engine_availability.dart';
import 'package:harness/core/models.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/theme/color_palette.dart';
import 'package:harness/state/app_state.dart';

import 'support/real_fonts.dart';
import 'swarm_interactions_test.dart' show chord;

class _RenderApp extends AppNotifier {
  _RenderApp()
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      ) {
    hasNavigationRail = false;
    for (final id in ['local', 'remote']) {
      final machine = Machine(
        machineId: id,
        name: id == 'local' ? 'MacBook Pro' : 'Solid',
        authMode: MachineAuthMode.remote,
      );
      machines.add(machine);
      machineStates[id] = MachineState(machine)
        ..localOnly = id == 'local'
        ..nodeOnline = true
        ..agentLoadStatus = AgentLoadStatus.loaded
        ..agents = [
          for (var i = 0; i < 10; i++)
            Agent(
              id: '$id-$i',
              name: 'Workshop: building the next version $i',
              engine: 'claude',
              terminalAvailable: true,
            ),
        ];
      machineStates[id]!.engines.replace(const [
        EngineAvailability(engine: 'claude', installed: true),
      ]);
    }
  }

  @override
  Future<void> probeEngines(String machineId, {bool force = false}) async {}
}

void main() {
  setUpAll(() async {
    await loadRealFonts();
    await (FontLoader(
      'MaterialIcons',
    )..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'))).load();
    await (FontLoader('packages/lucide_icons_flutter/Lucide')..addFont(
          rootBundle.load('packages/lucide_icons_flutter/assets/lucide.ttf'),
        ))
        .load();
    await (FontLoader('packages/lucide_icons_flutter/Lucide300')..addFont(
          rootBundle.load(
            'packages/lucide_icons_flutter/assets/build_font/LucideVariable-w300.ttf',
          ),
        ))
        .load();
    await (FontLoader('packages/cupertino_icons/CupertinoIcons')..addFont(
          rootBundle.load('packages/cupertino_icons/assets/CupertinoIcons.ttf'),
        ))
        .load();
  });
  for (final palette in HarnessPalette.values) {
    for (final scale in [1.0, 2.0]) {
      testWidgets('entry surfaces ${palette.name} at text scale $scale', (
        tester,
      ) async {
        tester.view.devicePixelRatio = 1;
        tester.view.physicalSize = const Size(880, 560);
        addTearDown(tester.view.reset);
        final previousShadows = debugDisableShadows;
        debugDisableShadows = false;
        addTearDown(() => debugDisableShadows = previousShadows);
        const nativeTabs = MethodChannel('harness/swarm_tabs');
        tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          nativeTabs,
          (_) async => true,
        );
        addTearDown(
          () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
            nativeTabs,
            null,
          ),
        );
        final previousPalette = grid.AppTheme.palette.value;
        grid.AppTheme.palette.value = palette;
        addTearDown(() => grid.AppTheme.palette.value = previousPalette);
        final app = _RenderApp();
        addTearDown(() async {
          await tester.pumpWidget(const SizedBox());
          app.dispose();
        });
        final boundaryKey = GlobalKey();
        await tester.pumpWidget(
          RepaintBoundary(
            key: boundaryKey,
            child: MaterialApp(
              debugShowCheckedModeBanner: false,
              theme: grid.buildAppTheme(brightness: Brightness.dark),
              builder: (context, child) => MediaQuery(
                data: MediaQuery.of(context)
                    .copyWith(textScaler: TextScaler.linear(scale)),
                child: child!,
              ),
              home: SwarmScreen(notifier: app, nativeTabs: true),
            ),
          ),
        );
        await tester.pumpAndSettle();

        Future<void> capture(String surface) async {
          final output = Platform.environment['HARNESS_ENTRY_CAPTURE_DIR'];
          if (output == null) return;
          await tester.runAsync(() async {
            for (final asset in [
              'assets/engine-icons/codex.png',
              'assets/engine-icons/cursor.png',
              'assets/harness_device_studio.png',
            ]) {
              await precacheImage(
                AssetImage(asset),
                boundaryKey.currentContext!,
              );
            }
          });
          await tester.pumpAndSettle();
          final boundary =
              boundaryKey.currentContext!.findRenderObject()!
                  as RenderRepaintBoundary;
          await tester.runAsync(() async {
            final image = await boundary.toImage(pixelRatio: 1);
            final bytes = await image.toByteData(
              format: ui.ImageByteFormat.png,
            );
            await Directory(output).create(recursive: true);
            await File('$output/${palette.name}-$scale-$surface.png')
                .writeAsBytes(bytes!.buffer.asUint8List());
            image.dispose();
          });
        }

        await capture('start');
        await tester.tap(find.byKey(const ValueKey('harness-start-search')));
        await tester.pumpAndSettle();
        await capture('inline');
        for (var i = 0; i < 5; i++) {
          await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
          await tester.pump();
        }
        await capture('inline-selected');
        final selected = find.byWidgetPredicate(
          (widget) => widget is ListTile && widget.selected,
        );
        final selectedRect = tester.getRect(selected);
        final issues = <String>[
          if (selectedRect.bottom > 560 || selectedRect.top < 0)
            'Selected result is outside the window: $selectedRect',
        ];
        tester.view.physicalSize = const Size(1280, 800);
        await tester.pumpAndSettle();
        await capture('inline-wide');
        for (var i = 0; i < 5; i++) {
          await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
          await tester.pump();
        }
        tester.view.physicalSize = const Size(880, 560);
        await tester.pumpAndSettle();
        await capture('inline-resized');
        final resultsRect = tester.getRect(
          find.byKey(const ValueKey('harness-start-results')),
        );
        if (selected.evaluate().isEmpty) {
          issues.add('Resize moves the selected result outside the built list');
        } else {
          final resizedRect = tester.getRect(selected);
          if (resizedRect.bottom > resultsRect.bottom ||
              resizedRect.top < resultsRect.top) {
            issues.add(
              'Resize hides the selection: $resizedRect in $resultsRect',
            );
          }
        }
        await tester.sendKeyEvent(LogicalKeyboardKey.escape);
        await chord(tester, LogicalKeyboardKey.keyO);
        await tester.pumpAndSettle();
        await capture('open');
        await tester.sendKeyEvent(LogicalKeyboardKey.escape);
        await chord(tester, LogicalKeyboardKey.keyN);
        await tester.pumpAndSettle();
        await capture('new');
        debugDisableShadows = previousShadows;
        expect(tester.takeException(), isNull);
        // The agent bar's pill names the chosen agent: never cut short.
        for (final paragraph in tester.renderObjectList<RenderParagraph>(
          find.descendant(
            of: find.byKey(const Key('new-agent-agent-choice')),
            matching: find.byType(RichText),
          ),
        )) {
          if (paragraph.didExceedMaxLines) {
            issues.add(
              '${paragraph.text.toPlainText()} is truncated in the agent bar',
            );
          }
        }
        expect(issues, isEmpty);
      });
    }
  }
}
