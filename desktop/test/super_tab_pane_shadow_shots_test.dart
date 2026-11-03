import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/roster.dart';
import 'package:harness/super_tabs/view.dart';

import 'box_render_preview_test.dart' show loadPreviewFonts;
import 'support/super_tab_fixture.dart';

/// Set to a folder to write the PR's screenshots there.
final shots = Platform.environment['SUPER_TAB_PANE_SHADOW_SHOTS'];

const _updates = [
  'Reading the offline queue before the reconnect.',
  'The reconnect keeps every queued edit in order.',
  'Two devices editing at once settle on the newest edit.',
  'Pushed the branch; the checks are running.',
];

/// Huy, 11-03: a thread, and Members, open on the right with a soft shadow on
/// their left edge, as in Slack: beside the chat in a wide window, and over it
/// as a drawer in a narrow one. Each takes the one shared shadow.
void main() {
  setUpAll(() async {
    if (shots != null) await loadPreviewFonts();
  });

  for (final brightness in Brightness.values) {
    for (final (name, size, members) in [
      ('thread', const Size(1400, 800), false),
      ('thread-drawer', const Size(900, 700), false),
      ('members', const Size(1400, 800), true),
      ('members-drawer', const Size(900, 700), true),
    ]) {
      testWidgets('$name casts the shared shadow (${brightness.name})', (
        tester,
      ) async {
        final picture = GlobalKey();
        const peer = {
          'kind': 'person',
          'id': 'peer',
          'name': 'peer@example.com',
        };
        final server = ConversationServer()..threads = true;
        (server.state['people'] as List).add({
          'id': 'peer',
          'email': 'peer@example.com',
          'role': 'collaborator',
        });
        server.append('Should we do thread replies?');
        for (var i = 1; i <= 6; i++) {
          server.append(_updates[i % _updates.length]);
          server.messages.last
            ..['thread'] = 'message-1'
            ..['replyTo'] = 'message-1'
            ..['author'] = peer;
        }
        for (var i = 1; i <= 12; i++) {
          server.append(_updates[i % _updates.length]);
          server.messages.last['author'] = {
            'kind': 'agent',
            'id': 'lead-agent',
            'name': 'Lead',
          };
        }
        final c = server.controller();
        addTearDown(c.dispose);
        await c.refresh();
        grid.AppTheme.brightness.value = brightness;
        addTearDown(() => grid.AppTheme.brightness.value = Brightness.light);
        await tester.binding.setSurfaceSize(size);
        addTearDown(() => tester.binding.setSurfaceSize(null));
        await tester.pumpWidget(
          MaterialApp(
            theme: grid.buildAppTheme(brightness: brightness),
            builder: (context, child) =>
                RepaintBoundary(key: picture, child: child),
            home: Scaffold(
              body: SuperTabView(
                controller: c,
                onInvite: () {},
                onAddAgent: (_) {},
                onOpenTerminal: (_) {},
                machineName: (_) => 'Mac Studio',
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        if (members) {
          await tester.tap(find.byKey(const ValueKey('super-members-button')));
        } else {
          c.openThread('message-1');
        }
        await tester.pumpAndSettle();

        final pane = members
            ? find.byType(SuperTabRoster)
            : find.byKey(const ValueKey('super-thread-panel'));
        expect(pane, findsOne);
        // Written before the check, so a base without the shadow gives the
        // before pictures.
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
            await File('$shots/pane-shadow-$name-${brightness.name}.png')
                .writeAsBytes(bytes!.buffer.asUint8List());
            image.dispose();
          });
        }
        final shadows = [
          for (final box in tester.widgetList<DecoratedBox>(
            find.ancestor(of: pane, matching: find.byType(DecoratedBox)),
          ))
            if (box.decoration case BoxDecoration(:final boxShadow?))
              ...boxShadow,
        ];
        expect(shadows, grid.AppDesktop.paneEdgeShadow);

        await tester.pumpWidget(const SizedBox());
        await c.flush();
      });
    }
  }
}
