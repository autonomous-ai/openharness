import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/test_run.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/widgets/app_dialog.dart';
import 'package:harness/super_tabs/join_dialog.dart';
import 'package:harness/super_tabs/join_link.dart';
import 'package:harness/super_tabs/sharing.dart';
import 'package:integration_test/integration_test.dart';
import 'package:window_manager/window_manager.dart';

import '../test/swarm_sharing_test.dart' show SwarmSharingServer;

/// Real macOS controls with synthetic membership and an in-memory server only.
/// This fixture never signs in, calls a production backend or starts an agent.
void main() {
  if (!kUnderTest) throw StateError('Requires FLUTTER_TEST=1');
  IntegrationTestWidgetsFlutterBinding.ensureInitialized().framePolicy =
      LiveTestWidgetsFlutterBindingFramePolicy.onlyPumps;
  testWidgets(
    'native sharing saves access and join requires a separate human action',
    (tester) async {
      await windowManager.ensureInitialized().timeout(
        const Duration(seconds: 10),
      );
      await windowManager
          .setSize(const Size(980, 760))
          .timeout(const Duration(seconds: 10));
      await windowManager.show().timeout(const Duration(seconds: 10));
      await windowManager.focus().timeout(const Duration(seconds: 10));
      final server = SwarmSharingServer();
      final controller = server.controller();
      await controller.refresh();
      final boundary = GlobalKey();
      var joins = 0, opened = false;
      Future<void> shot(String name) async {
        final root = Platform.environment['HARNESS_SWARM_SHARING_NATIVE_SHOTS'];
        if (root == null) return;
        final render =
            boundary.currentContext!.findRenderObject()!
                as RenderRepaintBoundary;
        final image = await render.toImage(pixelRatio: 1.5);
        final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
        await Directory(root).create(recursive: true);
        await File('$root/$name.png').writeAsBytes(bytes!.buffer.asUint8List());
        image.dispose();
      }

      Future<void> app(Brightness brightness) async {
        grid.AppTheme.brightness.value = brightness;
        await tester.pumpWidget(
          RepaintBoundary(
            key: boundary,
            child: MaterialApp(
              debugShowCheckedModeBanner: false,
              theme: grid.buildAppTheme(brightness: brightness),
              home: Scaffold(
                body: Builder(
                  builder: (context) => Column(
                    children: [
                      TextButton(
                        onPressed: () =>
                            showSuperTabSharing(context, controller),
                        child: const Text('Share'),
                      ),
                      TextButton(
                        onPressed: () => showAppDialog<void>(
                          context: context,
                          builder: (_) => SwarmJoinDialog(
                            link: SwarmJoinLink.parse(
                              server.settings['joinUrl'] as String,
                            )!,
                            accountEmail: 'leo@example.com',
                            isCurrent: () => true,
                            request: (_, path, {body}) async {
                              if (path.endsWith('/preview')) {
                                return {
                                  'id': 'tab',
                                  'name': 'Studio',
                                  'role': 'collaborator',
                                  'alreadyMember': false,
                                };
                              }
                              joins++;
                              return {'id': 'tab', 'role': 'collaborator'};
                            },
                            onJoined: (id, name) {
                              opened = id == 'tab' && name == 'Studio';
                            },
                          ),
                        ),
                        child: const Text('Open invitation'),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
      }

      await app(Brightness.dark);
      await tester.tap(find.text('Share'));
      await tester.pumpAndSettle();
      await shot('dark-invited');
      await tester.tap(find.byKey(const Key('swarm-general-access')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Anyone with the link').last);
      await tester.pumpAndSettle();
      expect(server.sharingPosts, isEmpty);
      await tester.tap(find.byKey(const Key('swarm-sharing-save')));
      await tester.pumpAndSettle();
      expect(server.access['mode'], 'link');
      expect(find.byKey(const Key('swarm-copy-link')), findsOneWidget);
      await shot('dark-link');
      await tester.tap(find.text('Done'));
      await tester.pumpAndSettle();
      await app(Brightness.light);
      await tester.tap(find.text('Share'));
      await tester.pumpAndSettle();
      await shot('light-link');
      await tester.tap(find.text('Done'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Open invitation'));
      await tester.pumpAndSettle();
      expect(joins, 0);
      expect(opened, false);
      await shot('join-preview');
      await tester.tap(find.byKey(const Key('swarm-join-confirm')));
      await tester.pumpAndSettle();
      expect(joins, 1);
      expect(opened, true);
      expect(find.byType(SwarmJoinDialog), findsNothing);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
      controller.dispose();
    },
  );
}
