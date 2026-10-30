import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_icons.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/message_row.dart';
import 'package:harness/super_tabs/terminal_row.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/capture.dart';
import 'support/super_tab_fixture.dart';

/// The rows the backend writes when a Lead types into a worker's terminal and
/// when a worker's machine alerts its Lead (spec/2026-10-23-lead-sees-agent-terminal.md):
/// shown as plain notes in the group, not as chat from the agent.
void main() {
  final captureDir = Platform.environment['HARNESS_SUPER_TAB_CAPTURE'];
  setUpAll(() async {
    await loadCaptureFonts(captureDir);
    // The typed text's face, as the native message test loads it.
    await (FontLoader(grid.AppType.monoFamily)
          ..addFont(rootBundle.load('assets/fonts/roboto-mono/RobotoMono.ttf')))
        .load();
  });

  for (final brightness in Brightness.values) {
    testWidgets(
      'terminal input and alert rows read as plain notes (${brightness.name})',
      (tester) async {
        await tester.binding.setSurfaceSize(const Size(900, 520));
        addTearDown(() => tester.binding.setSurfaceSize(null));
        final previous = grid.AppTheme.brightness.value;
        grid.AppTheme.brightness.value = brightness;
        addTearDown(() => grid.AppTheme.brightness.value = previous);
        final server = ConversationServer();
        server.state['agents'] = [
          for (final (id, name) in [
            ('lead-agent', 'Wren'),
            ('builder', 'Sage'),
          ])
            {
              'id': id,
              'name': id == 'builder' ? 'Builder' : 'Lead',
              'displayName': name,
              'machineId': 'm',
              'harnessId': id,
              'contributorId': 'owner',
              'configuration': {'engine': 'claude'},
              // Its prompt still waits: the backend clears this once it is answered.
              if (id == 'builder') 'alerting': ['prompt'],
            },
        ];
        final group = (server.state['conversations'] as List)[1] as Map;
        group['agentIds'] = ['lead-agent', 'builder'];
        group['leadId'] = 'lead-agent';
        void row(String text, String author, Map<String, Object> source) {
          server.append(text, conversationId: 'offline');
          server.messages.last['author'] = {
            'kind': 'agent',
            'id': author,
            'name': 'Agent',
          };
          server.messages.last['source'] = source;
        }

        server.append('Check the offline queue.', conversationId: 'offline');
        row('Sage is waiting at a prompt in its terminal.', 'builder', {
          'kind': 'terminal-alert',
          'agentId': 'builder',
          'alert': 'prompt',
        });
        row('Wren typed `2` + Enter in Sage\'s terminal', 'lead-agent', {
          'kind': 'terminal-input',
          'agentId': 'builder',
          'requestId': 'r1',
        });
        // Text the Lead typed may hold backticks of its own; only the backend's wrapper goes.
        row('Wren typed `echo `date`` in Sage\'s terminal', 'lead-agent', {
          'kind': 'terminal-input',
          'agentId': 'builder',
          'requestId': 'r2',
        });
        row(
          'Sage hit a usage limit. Routing skips it until 15:00 UTC.',
          'builder',
          {
            'kind': 'terminal-alert',
            'agentId': 'builder',
            'alert': 'limit',
            'limitedUntil': '2099-01-02T15:00:00.000Z',
          },
        );
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
              theme: grid.buildAppTheme(brightness: brightness),
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

        // One note per row, each with what happened and nothing else.
        final notes = find.byType(SuperTabTerminalRow);
        expect(notes, findsNWidgets(4));
        for (final text in [
          'Sage is waiting at a prompt in its terminal.',
          'Sage hit a usage limit. Routing skips it until 15:00 UTC.',
        ]) {
          expect(
            find.descendant(of: notes, matching: find.text(text)),
            findsOneWidget,
          );
        }
        // What was typed is set apart from the words around it; the backend's wrapper is not shown.
        final typed = find.descendant(
          of: notes,
          matching: find.text(
            'Wren typed 2 + Enter in Sage\'s terminal',
            findRichText: true,
          ),
        );
        expect(typed, findsOneWidget);
        expect(
          find.descendant(
            of: notes,
            matching: find.text(
              'Wren typed echo `date` in Sage\'s terminal',
              findRichText: true,
            ),
          ),
          findsOneWidget,
        );
        // Both inputs are keyboard notes; both alerts are warnings.
        expect(
          find.descendant(of: notes, matching: find.byIcon(AppIcons.keyboard)),
          findsNWidgets(2),
        );
        expect(
          find.descendant(
            of: notes,
            matching: find.byIcon(AppIcons.triangleAlert),
          ),
          findsNWidgets(2),
        );
        // They are not chat: the person's own message is the only message row, with its author heading.
        expect(find.byType(SuperTabMessageRow), findsOneWidget);
        expect(find.text('Agent'), findsNothing);
        expect(tester.takeException(), isNull);

        await captureBoundary(
          tester,
          boundary.currentContext!.findRenderObject()! as RenderRepaintBoundary,
          captureDir,
          'terminal-rows-${brightness.name}',
        );
        await tester.pumpWidget(const SizedBox());
        await controller.flush();
        controller.dispose();
      },
    );
  }

  // Scholes, 10-29: his Buddy's "waiting at a prompt" line stayed after the
  // prompt was answered, and a new one came under every message after it.
  testWidgets(
    'a prompt warning shows once, while its agent still waits, and goes once it is answered',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(900, 520));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final server = ConversationServer();
      final builder = <String, dynamic>{
        'id': 'builder',
        'name': 'Builder',
        'displayName': 'Sage',
        'machineId': 'm',
        'harnessId': 'builder',
        'contributorId': 'owner',
        'configuration': {'engine': 'claude'},
        'alerting': ['prompt'],
      };
      server.state['agents'] = [builder];
      final group = (server.state['conversations'] as List)[1] as Map;
      group['agentIds'] = ['builder'];
      String alert(String alert) {
        server.append(
          alert == 'prompt'
              ? 'Sage is waiting at a prompt in its terminal.'
              : 'Sage hit a usage limit. Routing skips it until 15:00 UTC.',
          conversationId: 'offline',
        );
        server.messages.last['author'] = {
          'kind': 'agent',
          'id': 'builder',
          'name': 'Builder',
        };
        server.messages.last['source'] = {
          'kind': 'terminal-alert',
          'agentId': 'builder',
          'alert': alert,
        };
        return server.messages.last['id'] as String;
      }

      final first = alert('prompt');
      server.append('Here is what I found.', conversationId: 'offline');
      final limit = alert('limit');
      final latest = alert('prompt');
      final controller = server.controller(
        initial: {
          'tabId': 'tab',
          'accountId': 'owner',
          'selectedId': 'offline',
        },
      );
      await controller.refresh();
      await tester.pumpWidget(
        MaterialApp(
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
      );
      await tester.pumpAndSettle();
      Finder row(String id) => find.byKey(ValueKey('super-message-$id'));

      // Still waiting: only the newest warning, and the usage limit's own note.
      expect(row(first), findsNothing);
      expect(row(latest), findsOneWidget);
      expect(row(limit), findsOneWidget);

      // Answered: the backend clears the agent's alert, and its warning goes.
      builder['alerting'] = <String>[];
      server.revision++;
      await controller.refresh();
      await tester.pumpAndSettle();
      expect(row(latest), findsNothing);
      expect(row(first), findsNothing);
      expect(row(limit), findsOneWidget);
      expect(find.text('Here is what I found.'), findsOneWidget);
      expect(tester.takeException(), isNull);

      await tester.pumpWidget(const SizedBox());
      await controller.flush();
      controller.dispose();
    },
  );
}
