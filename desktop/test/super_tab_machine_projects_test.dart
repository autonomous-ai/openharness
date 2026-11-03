// Task #2390 (Tony, 11-03): a machine's owner chooses which of the Swarm's projects may run agents on it, in its details in
// Manage > Machines (backend machines.ts machine.projects). Default all; a teammate sees the choice and cannot change it.
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/machine_projects.dart';

import 'box_render_preview_test.dart' show loadPreviewFonts;

/// Set to a folder to write the PR's screenshots there.
final shots = Platform.environment['MACHINE_PROJECT_SHOTS'];

const projects = [
  (id: 'oh', name: 'openharness'),
  (id: 'lampos', name: 'lampos'),
  (id: 'spaceship', name: 'spaceship'),
  (id: 'computer', name: 'computer'),
  (id: 'router', name: 'physical-router'),
];

Future<List<List<String>?>> _show(
  WidgetTester tester, {
  List<String>? kept,
  bool editable = true,
  Brightness brightness = Brightness.dark,
  GlobalKey? picture,
}) async {
  final sent = <List<String>?>[];
  // As the app's own scope sets the design tokens from the theme (main.dart _GridTokenScope).
  grid.AppTheme.brightness.value = brightness;
  addTearDown(() => grid.AppTheme.brightness.value = Brightness.light);
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: brightness),
      home: Scaffold(
        body: Center(
          child: RepaintBoundary(
            key: picture,
            child: Container(
              // The details dialog's card, which the setting sits on.
              color: grid.AppCard.base,
              width: 520,
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: SuperTabMachineProjects(
                  projects: projects,
                  kept: kept,
                  editable: editable,
                  onChanged: sent.add,
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return sent;
}

Checkbox _box(WidgetTester tester, String name) =>
    tester.widget<Checkbox>(find.byKey(ValueKey('machine-project-$name')));

void main() {
  testWidgets(
    'a machine nobody limited serves every project, and Only starts with every project ticked',
    (tester) async {
      final sent = await _show(tester);
      expect(find.text('Projects that may use it'), findsOneWidget);
      expect(find.text('All projects'), findsOneWidget);
      // No project boxes until the owner chooses Only.
      expect(find.byType(Checkbox), findsNothing);
      await tester.tap(find.byKey(const ValueKey('machine-projects-only')));
      await tester.pump();
      expect(sent, [
        ['oh', 'lampos', 'spaceship', 'computer', 'router'],
      ]);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'the owner ticks and unticks projects, never the last one, and All sends every project again',
    (tester) async {
      final sent = await _show(tester, kept: ['oh', 'lampos']);
      expect(_box(tester, 'oh').value, isTrue);
      expect(_box(tester, 'spaceship').value, isFalse);
      await tester.tap(find.byKey(const ValueKey('machine-project-lampos')));
      await tester.tap(find.byKey(const ValueKey('machine-project-computer')));
      await tester.tap(find.byKey(const ValueKey('machine-projects-all')));
      await tester.pump();
      expect(sent, [
        ['oh'],
        ['oh', 'lampos', 'computer'],
        null,
      ]);
      // The one project left ticked cannot be unticked: a machine kept for no project is no choice to offer.
      await _show(tester, kept: ['oh']);
      expect(_box(tester, 'oh').onChanged, isNull);
      expect(_box(tester, 'lampos').onChanged, isNotNull);
    },
  );

  testWidgets('a teammate sees which projects may use it, without controls', (
    tester,
  ) async {
    await _show(tester, kept: ['oh'], editable: false);
    expect(find.text('Projects that may use it'), findsOneWidget);
    expect(find.text('openharness'), findsOneWidget);
    expect(find.text('lampos'), findsNothing);
    expect(find.byType(Checkbox), findsNothing);
    expect(find.byType(Radio<bool>), findsNothing);
    await _show(tester, editable: false);
    expect(find.text('All projects'), findsOneWidget);
    expect(find.byType(Radio<bool>), findsNothing);
  });

  for (final brightness in Brightness.values) {
    testWidgets('screenshots for review (${brightness.name})', (tester) async {
      await loadPreviewFonts();
      final picture = GlobalKey();
      Future<void> shot(String name) => tester.runAsync(() async {
        final boundary =
            picture.currentContext!.findRenderObject()!
                as RenderRepaintBoundary;
        final image = await boundary.toImage(pixelRatio: 2);
        final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
        await Directory(shots!).create(recursive: true);
        await File('$shots/machine-projects-$name-${brightness.name}.png')
            .writeAsBytes(bytes!.buffer.asUint8List());
        image.dispose();
      });
      await _show(
        tester,
        kept: ['oh'],
        brightness: brightness,
        picture: picture,
      );
      await shot('owner-only');
      await _show(tester, brightness: brightness, picture: picture);
      await shot('owner-all');
      await _show(
        tester,
        kept: ['oh'],
        editable: false,
        brightness: brightness,
        picture: picture,
      );
      await shot('teammate');
    }, skip: shots == null);
  }
}
