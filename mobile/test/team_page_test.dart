import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/phone/team_page.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart' as grid;
import 'package:harness_mobile/teams/team_controller.dart';

import 'support/real_fonts.dart';
import 'support/team_fixture.dart';

const candidates = [
  PhoneTeamCandidate(
    machineId: 'host',
    agentId: 'mobile-session',
    name: 'Mobile',
    engine: 'claude',
    available: true,
  ),
  PhoneTeamCandidate(
    machineId: 'host',
    agentId: 'daemon-session',
    name: 'Daemons',
    engine: 'codex',
    available: true,
  ),
];
void main() {
  setUpAll(loadRealFonts);
  testWidgets(
    'phone connects only after explicit selection and keeps sends correlated',
    (tester) async {
      final calls = <Map<String, dynamic>>[];
      final model = TeamController(
        request: (p) async {
          calls.add(p);
          if (p['action'] == 'list') return {'teams': []};
          if (p['action'] == 'create') {
            return {
              'team': {...teamFixture(answered: false), 'id': p['id']},
            };
          }
          return {
            'team': {...teamFixture(answered: false), 'id': modelId(calls)},
          };
        },
      );
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: PhoneTeamView(
            controller: model,
            machineName: 'Mac',
            candidates: candidates,
            onOpen: (_, _) {},
          ),
        ),
      );
      addTearDown(() async {
        await tester.pumpWidget(const SizedBox());
        model.dispose();
      });
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('phone-team-new')));
      await tester.pumpAndSettle();
      for (final id in ['mobile-session', 'daemon-session']) {
        final candidate = find.byKey(ValueKey('phone-team-candidate-$id'));
        await tester.ensureVisible(candidate);
        await tester.tap(candidate);
        await tester.pumpAndSettle();
      }
      expect(calls.map((p) => p['action']), everyElement('list'));
      final connect = find.byKey(const Key('phone-team-connect'));
      await tester.ensureVisible(connect);
      await tester.tap(connect);
      await tester.pumpAndSettle();
      expect(calls.where((p) => p['action'] == 'create'), hasLength(1));
      expect(
        calls.firstWhere((p) => p['action'] == 'create')['members'],
        hasLength(2),
      );
      expect(tester.takeException(), isNull);
    },
  );

  for (final width in [320.0, 390.0]) {
    testWidgets('phone shows the answer and continuation at width $width', (
      tester,
    ) async {
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = Size(width, 844);
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
      await tester.pumpWidget(
        RepaintBoundary(
          key: key,
          child: MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: grid.buildAppTheme(brightness: Brightness.dark),
            home: PhoneTeamView(
              controller: model,
              machineName: 'Mac',
              candidates: candidates,
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
      await tester.ensureVisible(find.textContaining('Agent question'));
      await tester.pumpAndSettle();
      expect(find.textContaining('Use GET /api/daemons.'), findsOneWidget);
      expect(find.textContaining('Waiting for draft'), findsOneWidget);
      expect(calls.every((p) => p['action'] == 'get'), isTrue);
      expect(tester.takeException(), isNull);
      final output = Platform.environment['HARNESS_TEAM_CAPTURE_DIR'];
      if (output != null) {
        await tester.runAsync(() async {
          final boundary =
              key.currentContext!.findRenderObject()! as RenderRepaintBoundary;
          final image = await boundary.toImage(pixelRatio: 1);
          final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
          await Directory(output).create(recursive: true);
          await File('$output/phone-team-${width.toInt()}.png')
              .writeAsBytes(bytes!.buffer.asUint8List());
          image.dispose();
        });
      }
    });
  }
}

String modelId(List<Map<String, dynamic>> calls) =>
    calls.firstWhere((p) => p['action'] == 'create')['id'] as String;
