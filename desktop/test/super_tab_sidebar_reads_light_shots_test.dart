// Task #2427 (Huy, 11-03): the sidebar Huy compared with Slack's Channels, for the PR's before/after pictures. Writes
// nothing unless SIDEBAR_LIGHT_SHOTS names a folder.
import 'dart:io';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/project_sidebar.dart';

import 'support/capture.dart';
import 'support/super_tab_fixture.dart';

final shots = Platform.environment['SIDEBAR_LIGHT_SHOTS'];

void main() {
  setUpAll(() => loadCaptureFonts(shots));

  for (final brightness in Brightness.values) {
    testWidgets('Huy\'s sidebar in ${brightness.name}', (tester) async {
      if (shots == null) return;
      final previous = grid.AppTheme.brightness.value;
      grid.AppTheme.brightness.value = brightness;
      addTearDown(() => grid.AppTheme.brightness.value = previous);
      tester.view.devicePixelRatio = 2;
      tester.view.physicalSize = const Size(1240, 1000);
      addTearDown(tester.view.reset);
      final now = DateTime.now().millisecondsSinceEpoch;
      final server = ConversationServer();
      final conversations = server.state['conversations'] as List;
      final projects = <Map<String, dynamic>>[];
      for (final name in ['computer', 'garage-pod', 'lampos', 'openharness']) {
        projects.add(projectFixture(name, name, 'chat-$name'));
        conversations.add({
          ...conversationFixture('chat-$name', name),
          'projectId': name,
        });
      }
      server.state['projects'] = projects;
      void task(
        int number,
        String title, {
        String status = 'working',
        int minutes = 9,
      }) => conversations.add({
        ...conversationFixture('t$number', title),
        'projectId': 'openharness',
        'number': number,
        'agentIds': ['lead'],
        'assignment': {
          'id': 'a$number',
          'agentId': 'lead',
          'status': status,
          'result': status == 'needs_human' ? 'Which machine?' : null,
          'progressAt': now - minutes * 60000,
        },
      });
      task(2419, 'Swarm chat: consecutive messages group under one name');
      task(2418, 'Desktop: a machine\'s Team account setup prompt', minutes: 1);
      task(
        2394,
        'Agents start on large repositories',
        status: 'needs_human',
        minutes: 4,
      );
      task(
        2390,
        'Machines: a machine\'s owner chooses its projects',
        minutes: 22,
      );
      task(2388, 'Phone: reads the three Swarm tabs', minutes: 31);
      // Agents' progress on every task; a person's question on 2418.
      for (final id in ['t2419', 't2418', 't2394', 't2390', 't2388']) {
        server.append(
          'Pushed the next commit.',
          conversationId: id,
          agent: true,
        );
      }
      server.append(
        'Can you check the prompt on a fresh Mac?',
        conversationId: 't2418',
      );
      final c = server.controller(
        initial: {
          'tabId': 'tab',
          'accountId': 'owner',
          'expandedProjects': ['openharness'],
          'selectedId': 'chat-openharness',
        },
      );
      await c.refresh();
      await tester.pumpWidget(
        MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: grid.buildAppTheme(brightness: brightness),
          home: Scaffold(
            body: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SizedBox(
                  width: 300,
                  child: ProjectSidebar(
                    controller: c,
                    onSelect: c.select,
                    needsHuman: (g) => g.id == 't2394' ? 1 : 0,
                  ),
                ),
                const Expanded(child: SizedBox()),
              ],
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await captureWindow(tester, shots, 'sidebar-${brightness.name}');
      final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
      addTearDown(mouse.removePointer);
      await mouse.addPointer(location: Offset.zero);
      await mouse.moveTo(
        tester.getCenter(find.byKey(const ValueKey('super-group-t2418'))),
      );
      await tester.pumpAndSettle(const Duration(seconds: 2));
      await captureWindow(tester, shots, 'sidebar-tooltip-${brightness.name}');
      await mouse.moveTo(Offset.zero);
      await tester.pumpAndSettle(const Duration(seconds: 2));
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      c.dispose();
    }, variant: TargetPlatformVariant.only(TargetPlatform.macOS));
  }
}
