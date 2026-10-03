import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:xterm/xterm.dart';

import 'device_finder_test.dart' show FinderRemote;
import 'device_passage_test.dart' show command;
import 'device_visit_test.dart' show visit;
import 'swarm_screen_test.dart' show mount, terminal;
import 'swarm_state_test.dart' show createApp;
import 'terminal_find_test.dart' show output;

void main() {
  testWidgets(
    'carried passage survives latest, an alert, and a reading return',
    (t) async {
      final app = createApp(connected: true), input = <TerminalBinaryFrame>[];
      final source = terminal('a0', input), target = terminal('a69', input);
      source.terminal.write(
        List.generate(
          180,
          (i) => 'Source line $i: context to carry\r\n',
        ).join(),
      );
      final origin = app.adoptSessionForTest(source);
      final originTab = app.activeSwarmId;
      app.newSwarm(name: 'Needs attention');
      final destination = app.adoptSessionForTest(target);
      app.selectSwarm(originTab);
      try {
        await mount(t, app);
        final finder = find.byWidgetPredicate(
          (w) => w is TerminalView && w.terminal == source.terminal,
        );
        final renderer = t.state(finder);
        final scroll = t.widget<TerminalView>(finder).scrollController!;
        scroll.jumpTo(360.25);
        await t.pump();
        expect(
          app.selectDevicePassage('m', command('begin', 1))!['ok'],
          isTrue,
        );
        final pinned = app.selectDevicePassage('m', command('pin', 2))!;
        final text = pinned['text'] as String;
        expect(text, contains('Source line'));
        app.selectDevicePassage('m', command('cancel', 3));
        await t.pump();
        final before = scroll.offset;
        expect(
          app.visitFromDevice('m', visit('latest', target: 'a0'))!['ok'],
          isTrue,
        );
        await t.pump();
        expect(scroll.offset, closeTo(scroll.position.maxScrollExtent, .01));
        expect(
          app.visitFromDevice('m', visit('open', target: 'a69'))!['ok'],
          isTrue,
        );
        await t.pump();
        expect(app.focusedPane, same(destination));
        source.terminal.write('New output while visiting the other agent\r\n');
        await t.pump();
        final returned = app.visitFromDevice('m', visit('back'))!;
        expect(returned['ok'], isTrue);
        expect(returned, isNot(contains('note')));
        await t.pump();
        expect(app.focusedPane, same(origin));
        expect(app.activeSwarmId, originTab);
        expect(scroll.offset, closeTo(before, .01));
        expect(t.state(finder), same(renderer));
        expect(pinned['text'], text);
        expect(text, isNot(contains('New output')));
        expect(app.allPanes, hasLength(2));
        expect(input, isEmpty);
        expect(t.takeException(), isNull);
      } finally {
        await t.pumpWidget(const SizedBox());
        app.dispose();
      }
    },
  );

  testWidgets('carry freezes source text before Finder changes recipients', (
    t,
  ) async {
    final app = createApp(connected: true), input = <TerminalBinaryFrame>[];
    final source = terminal('a0', input), target = terminal('a69', input);
    await output(
      source,
      0,
      List.generate(30, (i) => 'Source line $i: context to carry').join('\r\n'),
      keyframe: true,
    );
    app.adoptSessionForTest(source);
    final origin = app.activeSwarmId;
    app.newSwarm(name: 'Recipient');
    final destination = app.adoptSessionForTest(target);
    app.selectSwarm(origin);
    try {
      await mount(t, app);
      expect(app.selectDevicePassage('m', command('begin', 1))!['ok'], isTrue);
      final pinned = app.selectDevicePassage('m', command('pin', 2))!;
      final text = pinned['text'] as String;
      expect(text, contains('Source line'));
      app.selectDevicePassage('m', command('cancel', 3));
      await t.pump();
      final finder = FinderRemote(t, app);
      await finder.send('open');
      await finder.say('Agent 69.');
      expect(app.focusedPane?.agentId, 'a0');
      await output(source, 1, 'The source has moved on.\r\n', keyframe: true);
      await finder.send('activate');
      await finder.send('state');
      expect(app.focusedPane, same(destination));
      expect(app.paneFocusByUser, isFalse);
      expect(pinned['text'], text);
      expect(text, isNot(contains('moved on')));
      expect(input, isEmpty);
      expect(app.allPanes, hasLength(2));
      expect(t.takeException(), isNull);
    } finally {
      await t.pumpWidget(const SizedBox());
      app.dispose();
    }
  });
}
