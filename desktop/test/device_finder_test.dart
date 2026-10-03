import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/device_finder.dart';
import 'package:harness/state/device_form.dart';
import 'package:harness/state/swarm_search.dart';
import 'package:harness/terminal/terminal_binary.dart';

import 'swarm_screen_test.dart' show mount, terminal;
import 'swarm_state_test.dart' show createApp;

class FinderRemote {
  FinderRemote(this.t, this.app);
  final WidgetTester t;
  final AppNotifier app;
  var state = <String, dynamic>{};
  var serial = 0;
  String id = 'find-test';
  Future<Map<String, dynamic>> send(
    String op, {
    int delta = 0,
    int? revision,
    String? queryId,
    String? text,
    String surface = 'find',
  }) async {
    Map<String, dynamic>? response;
    final pending = app
        .formFromDevice('m', {
          'op': op,
          'surface': surface,
          'formId': id,
          'requestId': 'request-${++serial}',
          'expiresAt': DateTime.now().millisecondsSinceEpoch + 2000,
          'revision': revision ?? state['revision'] ?? 0,
          'delta': delta,
          'queryId': ?queryId,
          'text': ?text,
        })
        .then((v) => response = v);
    for (var i = 0; i < 20 && response == null; i++) {
      await t.pump(const Duration(milliseconds: 20));
    }
    await pending;
    state = response!;
    await t.pump(const Duration(milliseconds: 100));
    return state;
  }

  Future<void> say(String name) async {
    final id = 'voice-${serial + 1}';
    await send('query.begin', queryId: id);
    expect(state['queryId'], id);
    await send('query', queryId: id, text: name);
  }
}

void main() {
  testWidgets(
    'spoken lookup goes to an existing pane in another tab without duplicating it',
    (t) async {
      final app = createApp(connected: true), input = <TerminalBinaryFrame>[];
      app.adoptSessionForTest(terminal('a0', input));
      final origin = app.activeSwarmId;
      app.newSwarm(name: 'Elsewhere');
      final target = app.adoptSessionForTest(terminal('a69', input));
      final targetTab = app.activeSwarmId;
      app.selectSwarm(origin);
      try {
        await mount(t, app);
        final r = FinderRemote(t, app);
        expect((await r.send('open'))['title'], 'Find Harness');
        await r.say('Agent 69.');
        expect(r.state['label'], 'Agent 69');
        expect(r.state['enabled'], isTrue);
        expect(app.activeSwarmId, origin);
        final revision = r.state['revision'] as int;
        await r.send('activate');
        await r.send('state');
        expect(r.state['active'], isFalse);
        expect(app.focusedPane, same(target));
        expect(app.paneFocusByUser, isFalse);
        expect(app.activeSwarmId, targetTab);
        expect(app.allPanes, hasLength(2));
        await r.send('activate', revision: revision);
        expect(app.allPanes, hasLength(2));
        expect(input, isEmpty);
      } finally {
        await t.pumpWidget(const SizedBox());
        app.dispose();
      }
    },
  );

  testWidgets(
    'typing, navigation, disposal and cancellation defeat late speech',
    (t) async {
      final app = createApp(connected: true);
      app.adoptSessionForTest(terminal('a0', []));
      try {
        await mount(t, app);
        final r = FinderRemote(t, app);
        await r.send('open');
        expect((await r.send('state', surface: 'new'))['ok'], isFalse);
        expect((await r.send('state'))['title'], 'Find Harness');
        await r.send('query.begin', queryId: 'discard');
        await r.send('query.cancel', queryId: 'discard');
        expect(
          (await r.send('query', queryId: 'discard', text: 'Agent 69'))['ok'],
          isFalse,
        );
        await r.send('query.begin', queryId: 'typed');
        final before = r.state['revision'] as int;
        await t.enterText(
          find.byKey(const ValueKey('swarm-search-input')),
          'Agent 3',
        );
        expect(
          (await r.send(
            'query',
            revision: before,
            queryId: 'typed',
            text: 'Agent 69',
          ))['ok'],
          isFalse,
        );
        expect(r.state['query'], 'Agent 3');
        await r.say('> stop everything');
        expect(r.state['query'], 'Agent 3');
        expect(r.state['error'], contains('name'));
        await r.send('query.begin', queryId: 'closed');
        await r.send('close');
        expect(
          (await r.send(
            'query',
            queryId: 'closed',
            text: 'Agent 69',
          ))['active'],
          isFalse,
        );
        r.id = 'find-replacement';
        expect((await r.send('open'))['active'], isTrue);
        expect(r.state['query'], '');
      } finally {
        await t.pumpWidget(const SizedBox());
        app.dispose();
      }
    },
  );

  test('a status repaint preserves speech; a changed destination does not', () {
    final port = DeviceFormPort(explicitGuard: true);
    var identity = 'one', status = 'Working';
    String? text;
    port.attach(
      () => {
        'active': true,
        'canQuery': true,
        'guard': identity,
        'detail': status,
      },
      (_, _, value) => text = value,
    );
    var revision = port.snapshot()['revision'] as int;
    port.command('query.begin', revision, 0, queryId: 'speech');
    status = 'Idle';
    expect(
      port.command('query', revision, 0, queryId: 'speech', text: 'name')['ok'],
      isTrue,
    );
    expect(text, 'name');
    port.command('query.begin', revision, 0, queryId: 'moved');
    identity = 'two';
    expect(
      port.command(
        'query',
        revision,
        0,
        queryId: 'moved',
        text: 'different',
      )['ok'],
      isFalse,
    );
    expect(text, 'name');
  });

  test(
    'opening stays busy until navigation completes; failure is not a success',
    () async {
      final app = createApp(connected: true);
      final search = SwarmSearchController(app, [], activityFirst: true);
      final finished = Completer<bool>();
      late DeviceFinder remote;
      remote = DeviceFinder(
        search,
        choose: (_) {
          remote.close();
          return finished.future;
        },
        dismiss: () {},
        isComposing: () => false,
      );
      try {
        search.setQuery('Agent 69');
        final revision = remote.port.snapshot()['revision'] as int;
        expect(remote.port.command('activate', revision, 0)['busy'], isTrue);
        expect(remote.port.snapshot()['active'], isTrue);
        finished.complete(false);
        await Future<void>.delayed(Duration.zero);
        expect(remote.port.snapshot(), containsPair('ok', false));
        expect(remote.port.snapshot()['error'], contains('Could not open'));
      } finally {
        remote.close();
        search.dispose();
        app.dispose();
      }
    },
  );

  testWidgets('offline results cannot be opened from a stale highlight', (
    t,
  ) async {
    final app = createApp(connected: true);
    app.adoptSessionForTest(terminal('a0', []));
    try {
      await mount(t, app);
      final r = FinderRemote(t, app);
      await r.send('open');
      await r.say('Agent 69');
      final revision = r.state['revision'] as int;
      app.machineStates['m']!.connectionStatus = ConnectionStatus.disconnected;
      expect((await r.send('activate', revision: revision))['ok'], isFalse);
      expect(r.state['enabled'], isFalse);
      expect(app.focusedPane?.agentId, 'a0');
    } finally {
      await t.pumpWidget(const SizedBox());
      app.dispose();
    }
  });
}
