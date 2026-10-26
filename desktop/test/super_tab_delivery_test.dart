import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/view.dart';
import 'package:harness/super_tabs/workspace.dart';

import 'support/super_tab_fixture.dart';

void main() {
  testWidgets(
    'queued and claimed messages have no queue label; uncertain review remains',
    (tester) async {
      final server = ConversationServer();
      for (final status in ['queued', 'claimed', 'uncertain']) {
        server.append('$status message');
        server.messages.last['deliveries'] = [
          {'id': status, 'agentId': 'lead-agent', 'status': status},
        ];
      }
      final controller = server.controller();
      addTearDown(controller.dispose);
      await controller.refresh();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SuperTabView(
              controller: controller,
              onInvite: () {},
              onAddAgent: (_) {},
              onOpenTerminal: (_) {},
              machineName: (_) => 'Test Mac',
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('queued message'), findsOneWidget);
      expect(find.text('claimed message'), findsOneWidget);
      expect(find.text('Queued'), findsNothing);
      // The uncertain review is now the latest message's receipt and its actions (message_receipt.dart).
      expect(find.text("Couldn't confirm delivery"), findsOneWidget);
      expect(find.text('Send again'), findsOneWidget);
    },
  );

  final capture = Platform.environment['HARNESS_SUPER_TAB_CAPTURE'];
  setUpAll(() async {
    if (capture == null || !Platform.isMacOS) return;
    final bytes = ByteData.sublistView(
      await File('/System/Library/Fonts/SFNS.ttf').readAsBytes(),
    );
    for (final family in ['.AppleSystemUIFont', 'Roboto']) {
      await (FontLoader(family)..addFont(Future.value(bytes))).load();
    }
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
      'uncertain input requires an explicit human choice in ${profile.name} appearance',
      (tester) async {
        await tester.binding.setSurfaceSize(profile.size);
        addTearDown(() => tester.binding.setSurfaceSize(null));
        final previous = grid.AppTheme.brightness.value;
        grid.AppTheme.brightness.value = profile.brightness;
        addTearDown(() => grid.AppTheme.brightness.value = previous);
        final server = ConversationServer();
        server.state['agents'] = [
          {
            'id': 'lead-agent',
            'name': 'Lead',
            'machineId': 'm',
            'harnessId': 'native',
            'contributorId': 'owner',
            'configuration': {'engine': 'claude'},
          },
        ];
        (server.state['people'] as List).addAll(
          List.generate(
            19,
            (i) => {
              'id': 'person-$i',
              'email': 'person$i@example.com',
              'role': 'collaborator',
            },
          ),
        );
        (server.state['conversations'] as List).add(
          conversationFixture('onboarding', 'Onboarding'),
        );
        (server.state['conversations'] as List)[0]['agentIds'] = ['lead-agent'];
        (server.state['conversations'] as List)[0]['leadId'] = 'lead-agent';
        server.append(
          'Let’s agree on the offline editing behavior before building.',
        );
        server.messages.last['author'] = {
          'kind': 'agent',
          'id': 'lead-agent',
          'name': 'Lead',
        };
        server.append(
          'Keep changes on the device and sync when the connection returns.',
        );
        server.messages.last['deliveries'] = [
          {'id': 'delivery', 'agentId': 'lead-agent', 'status': 'uncertain'},
        ];
        final controller = server.controller();
        await controller.refresh();
        String? opened;
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
                body: Builder(
                  builder: (context) => SuperTabView(
                    controller: controller,
                    onInvite: () => showSuperTabPeople(context, controller),
                    onAddAgent: (_) {},
                    onOpenTerminal: (agent) => opened = agent.id,
                    machineName: (_) => 'Team Mac',
                  ),
                ),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        Future<void> shot(String name) async {
          if (capture == null) return;
          final render =
              boundary.currentContext!.findRenderObject()!
                  as RenderRepaintBoundary;
          await tester.runAsync(() async {
            final image = await render.toImage(pixelRatio: 1.5);
            final bytes = await image.toByteData(
              format: ui.ImageByteFormat.png,
            );
            await Directory(capture).create(recursive: true);
            await File('$capture/${profile.name}-$name.png')
                .writeAsBytes(bytes!.buffer.asUint8List());
            image.dispose();
          });
        }

        await shot('conversation');
        if (find.byTooltip('Members and machines').evaluate().isNotEmpty) {
          await tester.tap(find.byTooltip('Members and machines'));
          await tester.pumpAndSettle();
        }
        await tester.tap(find.byTooltip('Invite people'));
        await tester.pumpAndSettle();
        expect(
          tester
              .widget<EditableText>(
                find
                    .descendant(
                      of: find.byType(Dialog),
                      matching: find.byType(EditableText),
                    )
                    .first,
              )
              .focusNode
              .hasFocus,
          isTrue,
        );
        await shot('people');
        await tester.tap(find.byTooltip('Close'));
        await tester.pumpAndSettle();
        if (find.byTooltip('Members and machines').evaluate().isNotEmpty) {
          await tester.sendKeyEvent(LogicalKeyboardKey.escape);
          await tester.pumpAndSettle();
        }
        await shot('delivery');
        expect(server.posts, isEmpty);
        await tester.tap(find.text('Open terminal'));
        await tester.pumpAndSettle();
        expect(opened, 'lead-agent');
        expect(server.posts, isEmpty);
        await tester.tap(find.text('It arrived'));
        await tester.pumpAndSettle();
        expect((server.posts.single['command'] as Map), {
          'type': 'delivery.resolve',
          'deliveryId': 'delivery',
          'resolution': 'received',
        });
        expect(
          server.messages,
          hasLength(2),
          reason:
              'Confirmation does not submit the original instruction again.',
        );
        controller.revokeAccess('Access removed.');
        await tester.pumpAndSettle();
        expect(find.byType(SelectableText), findsNothing);
        expect(find.text('Send again'), findsNothing);
        expect(server.posts, hasLength(1));
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        await controller.flush();
        controller.dispose();
      },
    );
  }
}
