import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart' as grid;
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/phone/session_work_page.dart';

import 'session_git_context_test.dart';
import '../../desktop/test/support/real_fonts.dart';

void main() {
  setUpAll(() async {
    await loadRealFonts();
    await (FontLoader('packages/lucide_icons_flutter/Lucide300')..addFont(
          rootBundle.load(
            'packages/lucide_icons_flutter/assets/build_font/LucideVariable-w300.ttf',
          ),
        ))
        .load();
  });
  testWidgets(
    'phone shows current work and launch location and opens only the selected PR',
    (tester) async {
      final git = gitFixture(), opened = <Uri>[];
      await tester.pumpWidget(
        MaterialApp(
          home: SessionWorkPage(
            agent: workAgent(git: git),
            read: (_) async => {'gitContext': git, 'history': git['history']},
            open: (uri) async {
              opened.add(uri);
              return true;
            },
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('/silent-beacon'), findsOneWidget);
      expect(find.text('hn/preview-fix'), findsOneWidget);
      final pr = find.byKey(
        const ValueKey('work-pr-https://github.com/acme/app/pull/12'),
      );
      await tester.ensureVisible(pr);
      await tester.tap(pr);
      await tester.pumpAndSettle();
      expect(opened, [Uri.parse('https://github.com/acme/app/pull/12')]);
      expect(tester.takeException(), isNull);
    },
  );

  for (final brightness in Brightness.values) {
    for (final scale in [1.0, 1.6]) {
      testWidgets('phone work fits ${brightness.name} at $scale text scale', (
        tester,
      ) async {
        tester.view.devicePixelRatio = 1;
        tester.view.physicalSize = const Size(390, 760);
        addTearDown(tester.view.reset);
        final previous = grid.AppTheme.brightness.value;
        grid.AppTheme.brightness.value = brightness;
        addTearDown(() => grid.AppTheme.brightness.value = previous);
        final boundary = GlobalKey();
        await tester.pumpWidget(
          RepaintBoundary(
            key: boundary,
            child: MaterialApp(
              debugShowCheckedModeBanner: false,
              theme: grid.buildAppTheme(brightness: brightness),
              builder: (context, child) => MediaQuery(
                data: MediaQuery.of(context)
                    .copyWith(textScaler: TextScaler.linear(scale)),
                child: child!,
              ),
              home: SessionWorkPage(
                agent: workAgent(git: manyPrFixture()),
                online: false,
                read: (_) => throw StateError(
                  'An offline page must not read the daemon',
                ),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        expect(find.text('Offline · last known work'), findsOneWidget);
        expect(tester.takeException(), isNull);
        final output = Platform.environment['HARNESS_GIT_CONTEXT_CAPTURE_DIR'];
        if (output != null) {
          await tester.runAsync(() async {
            final render =
                boundary.currentContext!.findRenderObject()!
                    as RenderRepaintBoundary;
            final picture = await render.toImage(pixelRatio: 1);
            final bytes = await picture.toByteData(
              format: ui.ImageByteFormat.png,
            );
            await Directory(output).create(recursive: true);
            await File('$output/phone-${brightness.name}-$scale.png')
                .writeAsBytes(bytes!.buffer.asUint8List());
            picture.dispose();
          });
        }
        // The footer and remaining history stay reachable at large accessibility sizes.
        await tester.scrollUntilVisible(
          find.text('Show more'),
          250,
          scrollable: find.byType(Scrollable).first,
        );
        await tester.tap(find.text('Show more'));
        await tester.pumpAndSettle();
        await tester.scrollUntilVisible(
          find.text('Observed branches'),
          250,
          scrollable: find.byType(Scrollable).first,
        );
        expect(tester.takeException(), isNull);
      });
    }
  }

  testWidgets('late phone refresh after leaving the page is discarded', (
    tester,
  ) async {
    final reply = Completer<Map<String, dynamic>>();
    await tester.pumpWidget(
      MaterialApp(
        home: SessionWorkPage(
          agent: workAgent(git: gitFixture()),
          read: (_) => reply.future,
        ),
      ),
    );
    await tester.pump();
    await tester.pumpWidget(const SizedBox());
    reply.complete({'status': 'unavailable'});
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
  });
}
