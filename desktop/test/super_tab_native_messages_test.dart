import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/view.dart';

import 'support/super_tab_fixture.dart';

void main() {
  final capture = Platform.environment['HARNESS_SUPER_TAB_CAPTURE'];
  setUpAll(() async {
    if (capture == null || !Platform.isMacOS) return;
    final bytes = ByteData.sublistView(
      await File('/System/Library/Fonts/SFNS.ttf').readAsBytes(),
    );
    for (final family in ['.AppleSystemUIFont', 'Roboto']) {
      await (FontLoader(family)..addFont(Future.value(bytes))).load();
    }
    await (FontLoader(grid.AppType.monoFamily)
          ..addFont(rootBundle.load('assets/fonts/roboto-mono/RobotoMono.ttf')))
        .load();
    await (FontLoader('packages/lucide_icons_flutter/Lucide400')..addFont(
          rootBundle.load(
            'packages/lucide_icons_flutter/assets/build_font/LucideVariable-w400.ttf',
          ),
        ))
        .load();
  });
  for (final profile in [
    (
      name: 'dark',
      brightness: Brightness.dark,
      size: const Size(1280, 800),
      scale: 1.0,
    ),
    (
      name: 'light',
      brightness: Brightness.light,
      size: const Size(1280, 800),
      scale: 1.0,
    ),
    (
      name: 'large',
      brightness: Brightness.dark,
      size: const Size(800, 480),
      scale: 2.0,
    ),
  ]) {
    testWidgets(
      'native message sources use the shared conversation style in ${profile.name}',
      (tester) async {
        await tester.binding.setSurfaceSize(profile.size);
        addTearDown(() => tester.binding.setSurfaceSize(null));
        final previous = grid.AppTheme.brightness.value;
        grid.AppTheme.brightness.value = profile.brightness;
        addTearDown(() => grid.AppTheme.brightness.value = previous);
        final server = ConversationServer();
        (server.state['people'] as List).add({
          'id': 'leo',
          'email': 'leo@example.com',
          'role': 'collaborator',
        });
        server.state['agents'] = [
          {
            'id': 'lead-agent',
            'name': 'Lead',
            'machineId': 'm',
            'harnessId': 'native',
            'contributorId': 'owner',
            'configuration': {'engine': 'claude'},
          },
          for (final name in ['Builder', 'Reviewer'])
            {
              'id': name.toLowerCase(),
              'name': name,
              'machineId': 'm',
              'harnessId': name.toLowerCase(),
              'contributorId': 'leo',
              'configuration': {
                'engine': name == 'Builder' ? 'codex' : 'claude',
              },
            },
        ];
        final group = (server.state['conversations'] as List)[1] as Map;
        group['agentIds'] = ['lead-agent', 'builder', 'reviewer'];
        group['leadId'] = 'lead-agent';
        group['assignment'] = {
          'id': 'attempt',
          'agentId': 'builder',
          'status': 'needs_human',
          'result': 'Can someone verify offline editing on a real device?',
        };
        server.append(
          'Verify offline edits through a restart and reconnect.',
          conversationId: 'offline',
        );
        server.messages.last['author'] = {
          'kind': 'agent',
          'id': 'lead-agent',
          'name': 'Lead',
        };
        server.messages.last['source'] = {
          'kind': 'native',
          'phase': 'prompt',
          'operator': {'id': 'leo', 'name': 'leo@example.com'},
        };
        if (profile.scale == 1) {
          server.append(
            '@Builder, check persistence. @Reviewer, check account switching.',
            conversationId: 'offline',
          );
          server.messages.last['author'] = {
            'kind': 'agent',
            'id': 'lead-agent',
            'name': 'Lead',
          };
          server.messages.last['source'] = {
            'kind': 'native',
            'phase': 'answer',
          };
          server.append(
            '**Checks passed**\n'
            '- Restart preserves pending edits.\n'
            '- Reconnect syncs once, including interrupted writes.\n\n'
            '\u0060await queue.flush();\u0060',
            conversationId: 'offline',
          );
          server.messages.last['author'] = {
            'kind': 'agent',
            'id': 'builder',
            'name': 'Builder',
          };
          server.append(
            'Should pending edits survive sign-out?',
            conversationId: 'offline',
          );
          server.messages.last['author'] = {
            'kind': 'agent',
            'id': 'builder',
            'name': 'Builder',
          };
          final question = server.messages.last['id'];
          server.append(
            'Yes. Keep them on the device; ask before syncing to another account.',
            conversationId: 'offline',
          );
          server.messages.last['author'] = {
            'kind': 'person',
            'id': 'leo',
            'name': 'Leo',
          };
          server.messages.last['replyTo'] = question;
          server.append(
            'Can someone verify offline editing on a real device? The software checks passed.',
            conversationId: 'offline',
          );
          server.messages.last['author'] = {
            'kind': 'agent',
            'id': 'lead-agent',
            'name': 'Lead',
          };
        }
        final controller = server.controller(
          initial: {
            'tabId': 'tab',
            'accountId': 'owner',
            'selectedId': 'offline',
          },
        );
        await controller.refresh();
        final boundary = GlobalKey();
        await tester.pumpWidget(
          RepaintBoundary(
            key: boundary,
            child: MaterialApp(
              debugShowCheckedModeBanner: false,
              theme: grid.buildAppTheme(brightness: profile.brightness),
              builder: (context, child) => MediaQuery(
                data: MediaQuery.of(context).copyWith(
                  textScaler: TextScaler.linear(profile.scale),
                  highContrast: profile.scale > 1,
                ),
                child: child!,
              ),
              home: Scaffold(
                body: SuperTabView(
                  controller: controller,
                  onInvite: () {},
                  onAddAgent: (_) {},
                  onOpenTerminal: (_) {},
                  machineName: (_) => 'Team Mac',
                ),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        final source = find.text(
          'Terminal input · session opened by leo@example.com',
        );
        expect(source, findsOneWidget);
        await tester.ensureVisible(source);
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull);
        if (capture != null) {
          await tester.runAsync(
            () => precacheImage(
              const AssetImage('assets/engine-icons/codex.png'),
              tester.element(find.byType(SuperTabView)),
            ),
          );
          await tester.pump();
          final render =
              boundary.currentContext!.findRenderObject()!
                  as RenderRepaintBoundary;
          await tester.runAsync(() async {
            final image = await render.toImage(pixelRatio: 1.5);
            final bytes = await image.toByteData(
              format: ui.ImageByteFormat.png,
            );
            await Directory(capture).create(recursive: true);
            await File('$capture/native-${profile.name}.png')
                .writeAsBytes(bytes!.buffer.asUint8List());
            image.dispose();
          });
        }
        await tester.pumpWidget(const SizedBox());
        await controller.flush();
        controller.dispose();
      },
    );
  }
}
