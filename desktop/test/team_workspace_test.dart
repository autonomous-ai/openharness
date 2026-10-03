import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/teams/team_controller.dart';
import 'package:harness/teams/team_workspace.dart';
import 'package:harness/terminal/terminal_font_store.dart';
import 'package:xterm/xterm.dart' show TerminalStyle;

import 'support/real_fonts.dart';
import 'support/team_fixture.dart';

const candidates = [
  TeamCandidate(
    machineId: 'host',
    agentId: 'mobile-session',
    name: 'Mobile',
    machineName: 'Mac',
    engine: 'claude',
    status: 'Available',
    available: true,
  ),
  TeamCandidate(
    machineId: 'host',
    agentId: 'daemon-session',
    name: 'Daemons',
    machineName: 'Mac',
    engine: 'codex',
    status: 'Available',
    available: true,
  ),
];

void main() {
  setUpAll(loadRealFonts);
  testWidgets('large terminal font keeps creation and asking usable', (
    tester,
  ) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(600, 760);
    final originalFont = terminalFontStore.value;
    terminalFontStore.value = const TerminalStyle(
      fontSize: 22,
      fontFamily: 'SF Mono',
    );
    addTearDown(() {
      terminalFontStore.value = originalFont;
      tester.view.reset();
    });
    final calls = <Map<String, dynamic>>[];
    String? createdId;
    final model = TeamController(
      request: (p) async {
        calls.add(p);
        if (p['action'] == 'list') return {'teams': []};
        if (p['action'] == 'create') createdId = p['id'] as String;
        return {
          'team': {...teamFixture(answered: false), 'id': createdId},
        };
      },
    );
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: Scaffold(
          body: TeamWorkspace(
            controller: model,
            candidates: candidates,
            machineName: 'Mac',
            onClose: () {},
            onOpen: (_, _) {},
          ),
        ),
      ),
    );
    addTearDown(() async {
      await tester.pumpWidget(const SizedBox());
      model.dispose();
    });
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('team-new')));
    await tester.pumpAndSettle();
    for (final candidate in candidates) {
      final row = find.byKey(ValueKey('team-candidate-${candidate.agentId}'));
      await tester.scrollUntilVisible(
        row,
        100,
        scrollable: find
            .descendant(
              of: find.byKey(const Key('team-candidates')),
              matching: find.byType(Scrollable),
            )
            .first,
      );
      await tester.tap(row);
      await tester.pumpAndSettle();
    }
    expect(calls.map((p) => p['action']), everyElement('list'));
    final connect = find.byKey(const Key('team-connect'));
    await tester.ensureVisible(connect);
    await tester.tap(connect);
    await tester.pumpAndSettle();
    expect(calls.where((p) => p['action'] == 'create'), hasLength(1));
    final question = find.byKey(const Key('team-question'));
    await tester.ensureVisible(question);
    await tester.enterText(question, 'Keep this draft through refresh.');
    await model.refresh();
    await tester.pumpAndSettle();
    expect(find.text('Keep this draft through refresh.'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
  for (final size in [
    const Size(1280, 850),
    const Size(600, 760),
    const Size(390, 740),
  ]) {
    for (final brightness in Brightness.values) {
      testWidgets('team exchange fits $size in $brightness', (tester) async {
        tester.view.devicePixelRatio = 1;
        tester.view.physicalSize = size;
        addTearDown(tester.view.reset);
        final calls = <Map<String, dynamic>>[];
        final model = TeamController(
          request: (p) async {
            calls.add(p);
            return {'team': teamFixture()};
          },
        );
        await model.select(teamId);
        model.selectedExchange = questionId;
        final key = GlobalKey();
        var closed = false;
        grid.AppTheme.brightness.value = brightness;
        await tester.pumpWidget(
          RepaintBoundary(
            key: key,
            child: MaterialApp(
              debugShowCheckedModeBanner: false,
              theme: grid.buildAppTheme(brightness: brightness),
              home: Scaffold(
                body: TeamWorkspace(
                  controller: model,
                  candidates: candidates,
                  machineName: 'Mac',
                  onClose: () {
                    closed = true;
                  },
                  onOpen: (_, _) {},
                ),
              ),
            ),
          ),
        );
        addTearDown(() async {
          await tester.pumpWidget(const SizedBox());
          model.dispose();
        });
        await tester.pumpAndSettle();
        expect(find.textContaining('Use GET /api/daemons.'), findsOneWidget);
        expect(find.textContaining('Waiting for draft'), findsOneWidget);
        expect(tester.takeException(), isNull);
        final output = Platform.environment['HARNESS_TEAM_CAPTURE_DIR'];
        if (output != null) {
          final boundary =
              key.currentContext!.findRenderObject()! as RenderRepaintBoundary;
          await tester.runAsync(() async {
            final image = await boundary.toImage(pixelRatio: 1);
            final bytes = await image.toByteData(
              format: ui.ImageByteFormat.png,
            );
            await Directory(output).create(recursive: true);
            await File(
              '$output/team-${brightness.name}-${size.width.toInt()}.png',
            ).writeAsBytes(bytes!.buffer.asUint8List());
            image.dispose();
          });
        }
        await tester.tap(find.byKey(const Key('team-compose')));
        await tester.pumpAndSettle();
        await tester.enterText(
          find.byKey(const Key('team-question')),
          'How should reconnect work?',
        );
        await model.refresh();
        await tester.pumpAndSettle();
        expect(find.text('How should reconnect work?'), findsOneWidget);
        expect(calls.every((p) => p['action'] == 'get'), isTrue);
        await tester.sendKeyEvent(LogicalKeyboardKey.escape);
        expect(closed, isTrue);
      });
    }
  }
}
