import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/buddies.dart';
import 'package:harness/super_tabs/right_pane_row.dart';

import 'super_tab_activity_lists_test.dart' show swarm;
import 'super_tab_right_pane_row_test.dart' show buddy;
import 'support/capture.dart';

final shots = Platform.environment['HARNESS_SUPER_TAB_CAPTURE'];
Finder key(String value) => find.byKey(ValueKey(value));

void main() {
  setUpAll(() => loadCaptureFonts(shots));
  for (final brightness in Brightness.values) {
    for (final width in [280.0, 600.0]) {
      testWidgets('selected Buddy header at $width in ${brightness.name}', (tester) async {
        await tester.binding.setSurfaceSize(Size(width, 260));
        addTearDown(() => tester.binding.setSurfaceSize(null));
        final server = swarm();
        server.state['swarmBuddy'] = true;
        server.state['buddyCap'] = 5;
        (server.state['conversations'] as List).add(<String, dynamic>{
          ...buddy('buddy', 'Research and planning', first: true), 'agentIds': ['agent'],
        });
        server.state['agents'] = <Map<String, dynamic>>[{
          'id': 'agent', 'name': 'Research and planning', 'machineId': 'mac',
          'harnessId': 'session', 'contributorId': 'owner',
          'buddyOf': {'personId': 'owner'}, 'buddyScope': 'swarm',
          'configuration': {'engine': 'claude'},
        }];
        server.state['machines'] = <Map<String, dynamic>>[{
          'machineId': 'mac', 'name': 'Scholes’s very long MacBook Pro machine name',
          'contributorId': 'owner',
        }];
        final c = server.controller(account: 'owner', initial: {
          'tabId': 'tab', 'accountId': 'owner', 'selectedId': 'buddy',
        });
        await tester.runAsync(c.refresh);
        await tester.pumpWidget(MaterialApp(
          theme: grid.buildAppTheme(brightness: brightness),
          home: Scaffold(body: Column(crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              SuperTabRightPaneRow(controller: c, onOpenTerminal: (_) {}),
              SuperTabBuddyBar(controller: c, chat: c.selected!, compact: true),
              const Divider(height: 1),
              const Expanded(child: Center(child: Text('Your conversation'))),
            ])),
        ));
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull);
        expect(tester.getTopLeft(find.text('Research and planning')).dy,
          lessThan(tester.getTopLeft(key('super-buddy-context')).dy));
        expect(tester.getSize(key('super-buddy-context')).height, lessThan(36));
        expect(find.byTooltip('Reads all your projects · Only you can read this chat'), findsOneWidget);
        expect(find.text('Open terminal'), findsOneWidget);
        expect(tester.getRect(key('super-buddy-open-terminal')).right,
          lessThanOrEqualTo(tester.getRect(key('super-buddy-menu')).left));
        await captureWindow(tester, shots, 'buddy-header-${width.toInt()}-${brightness.name}');
        await tester.pumpWidget(const SizedBox());
        c.dispose();
        await tester.pump(const Duration(seconds: 1));
      });
    }
  }
}
