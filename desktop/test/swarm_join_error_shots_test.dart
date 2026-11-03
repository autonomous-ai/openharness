import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/new_harness.dart';
import 'package:harness/widgets/new_harness_form.dart';

import 'box_render_preview_test.dart' show loadPreviewFonts;
import 'swarm_launch_recovery_test.dart' show reopen, stuckProject;

/// Set to a folder to write the PR's screenshots there.
final shots = Platform.environment['SWARM_JOIN_ERROR_SHOTS'];

/// Tony, 11-03 (#2458): a join that failed said only "An internal server
/// error occurred". The New Harness box now says what happened and what to do,
/// for a server error and for a refusal with its reason.
void main() {
  setUpAll(() async {
    if (shots != null) await loadPreviewFonts();
  });

  const cases = {
    'server-error': (
      code: 'INTERNAL_ERROR',
      message: 'An internal server error occurred',
      status: 500,
      shows: 'the Harness server had an error adding it to the project',
    ),
    'refused': (
      code: 'TEAM_ACCOUNT_HELD',
      message:
          'This machine\'s Harness Team account runs another project\'s '
          'Product Manager, so it takes only that project\'s work for now.',
      status: 403,
      shows: 'but the project did not take it: This machine\'s Harness Team',
    ),
  };

  for (final brightness in Brightness.values) {
    for (final MapEntry(key: name, value: refusal) in cases.entries) {
      testWidgets('the New Harness box after a $name join '
          '(${brightness.name})', (tester) async {
        grid.AppTheme.brightness.value = brightness;
        addTearDown(() => grid.AppTheme.brightness.value = Brightness.light);
        final picture = GlobalKey();
        late NewHarnessController box;
        await tester.runAsync(() async {
          final f = await stuckProject();
          box = await reopen(f);
          f.connection.server
            ..refuse = {'code': refusal.code, 'message': refusal.message}
            ..refuseStatus = refusal.status;
          expect(await box.create(), NewHarnessOutcome.failed);
        });
        await tester.binding.setSurfaceSize(const Size(900, 560));
        addTearDown(() => tester.binding.setSurfaceSize(null));
        await tester.pumpWidget(
          MaterialApp(
            theme: grid.buildAppTheme(brightness: brightness),
            builder: (context, child) =>
                RepaintBoundary(key: picture, child: child),
            home: Scaffold(
              body: Center(
                child: SizedBox(
                  width: 850,
                  height: 520,
                  child: NewHarnessForm(
                    controller: box,
                    desktop: true,
                    onClose: () {},
                    onCreated: () {},
                  ),
                ),
              ),
            ),
          ),
        );
        await tester.pump();
        expect(find.textContaining(refusal.shows), findsOneWidget);
        expect(find.text('Discard request'), findsOneWidget);
        expect(find.text('Check status'), findsOneWidget);
        if (shots != null) {
          await tester.runAsync(() async {
            final boundary =
                picture.currentContext!.findRenderObject()!
                    as RenderRepaintBoundary;
            final image = await boundary.toImage(pixelRatio: 1.5);
            final bytes = await image.toByteData(
              format: ui.ImageByteFormat.png,
            );
            await Directory(shots!).create(recursive: true);
            await File('$shots/join-$name-${brightness.name}.png')
                .writeAsBytes(bytes!.buffer.asUint8List());
            image.dispose();
          });
        }
        await tester.pumpWidget(const SizedBox());
      });
    }
  }
}
