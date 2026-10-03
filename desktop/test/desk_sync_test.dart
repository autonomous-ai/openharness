// The desk: the account's tabs, the same on every computer. The pure half
// (diff and replay) and the window's half (a document becomes `swarms`, an
// edit becomes ops, and what a window keeps for itself stays put).
import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/api/api_client.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/state/desk_sync.dart';
import 'package:harness/state/pane_arrangement.dart';
import 'package:harness/state/pane_layout_store.dart';
import 'package:harness/state/pane_preset.dart';
import 'package:harness/state/swarm.dart';
import 'package:harness/state/terminal_pane.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/terminal/terminal_session.dart';
import 'package:harness/widgets/pane_grid.dart';
import 'package:xterm/xterm.dart';

import 'swarm_state_test.dart' show MemoryStore, createApp;
import 'swarm_screen_test.dart' show terminal;
import 'box_render_preview_test.dart' show loadPreviewFonts;

DeskTab tab(
  String id, {
  String name = 'Tab',
  bool custom = false,
  List<String> agents = const [],
}) => DeskTab(
  id: id,
  name: name,
  nameIsCustom: custom,
  panes: [for (final a in agents) DeskPaneRef(machineId: 'm', agentId: a)],
);

/// The daemon's desk proxy, scripted: a document to hand out, the ops it was
/// asked to apply (applied with the same rules the backend uses), or a failure.
class _DeskApi extends ApiClient {
  _DeskApi() : super(config: AppConfig.dev, session: AuthSession());
  DeskDoc? doc = const DeskDoc(revision: 0, tabs: []);
  bool available = true;
  Object? failWith;
  Completer<void>? readGate;
  final batches = <List<Map<String, dynamic>>>[];

  Map<String, dynamic>? _json(DeskDoc d) => {
    'revision': d.revision,
    'tabs': [for (final t in d.tabs) t.toJson()],
  };

  @override
  Future<Map<String, dynamic>?> desk() async {
    if (failWith != null) throw failWith!;
    if (!available || doc == null) return null;
    final snapshot = _json(doc!);
    if (readGate case final gate?) await gate.future;
    return snapshot;
  }

  @override
  Future<Map<String, dynamic>?> deskOps(List<Map<String, dynamic>> ops) async {
    if (failWith != null) throw failWith!;
    if (!available || doc == null) return null;
    batches.add(ops);
    final next = applyDeskOps(doc!.tabs, ops);
    doc = DeskDoc(revision: doc!.revision + 1, tabs: next);
    return _json(doc!);
  }
}

void main() {
  final captureDir = Platform.environment['HARNESS_SHARED_LAYOUT_CAPTURE_DIR'];
  setUpAll(() async {
    if (captureDir != null) await loadPreviewFonts();
  });
  test(
    'closing syncs the default layout and reopening restores split order',
    () async {
      final api = _DeskApi();
      final app = createApp()..api = api;
      addTearDown(app.dispose);
      await app.deskStartForTest();
      for (var i = 0; i < 5; i++) {
        await app.addAgentToSwarm('m', 'a$i');
      }
      final work = app.activeSwarm;
      final panes = work.panes.toList();
      final split = PaneArrangement(const [
        Rect.fromLTRB(0, 0, .5, .25),
        Rect.fromLTRB(0, .25, .5, .5),
        Rect.fromLTRB(.5, 0, 1, .5),
        Rect.fromLTRB(0, .5, .5, 1),
        Rect.fromLTRB(.5, .5, 1, 1),
      ]);
      work.savePaneSizes('5:manual', split);
      app.togglePinPane(panes[4].id);

      await app.closePane(panes[3].id);
      await app.deskFlushForTest();

      expect(work.panes.map((p) => p.agentId), ['a0', 'a2', 'a1', 'a4']);
      expect(work.manualLayout!.tiles, PanePreset.quad.tilesFor(4));
      final synced = api.doc!.tabs.singleWhere((t) => t.id == work.id);
      expect(synced.panes.map((p) => p.agentId), ['a0', 'a2', 'a1', 'a4']);
      expect(synced.layout!.sizes['4:manual'], work.manualLayout!.toJson());

      expect(app.reopenClosed(), isTrue);
      expect(work.panes.map((p) => p.agentId), ['a0', 'a1', 'a2', 'a3', 'a4']);
      expect(work.manualLayout!.tiles, split.tiles);
      expect(app.pinnedSlotFor(panes[4]), 4);
      await app.deskFlushForTest();
      expect(
        api.doc!.tabs
            .singleWhere((t) => t.id == work.id)
            .layout!
            .sizes['5:manual'],
        split.toJson(),
      );
    },
  );

  testWidgets(
    'shared slots survive viewport, focus and zoom changes without writes or terminal remounts',
    (tester) async {
      final api = _DeskApi();
      final app = createApp()..api = api;
      app.machineStates['m']!.nodeOnline = true;
      for (var i = 0; i < 5; i++) {
        final session = terminal('Shared pane ${i + 1}', []);
        session.terminal.write(
          'Shared pane ${i + 1}\r\n\r\nSame position and proportions\r\non desktop and hn.\r\n',
        );
        app.adoptSessionForTest(session);
      }
      await app.deskStartForTest();
      app.setPreset(5, PanePreset.middleMain);
      app.focusPane(app.panes[1].id);
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(1600, 1000);
      addTearDown(tester.view.reset);
      final capture = GlobalKey();
      await tester.pumpWidget(
        RepaintBoundary(
          key: capture,
          child: MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: grid.buildAppTheme(brightness: Brightness.dark),
            home: Scaffold(
              backgroundColor: grid.AppPalette.swarmField,
              body: PaneGrid(notifier: app, swarmMode: true),
            ),
          ),
        ),
      );
      await tester.pump();
      if (captureDir != null) {
        await tester.runAsync(() async {
          final boundary =
              capture.currentContext!.findRenderObject()!
                  as RenderRepaintBoundary;
          final image = await boundary.toImage();
          final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
          await Directory(captureDir).create(recursive: true);
          await File('$captureDir/desktop-five.png')
              .writeAsBytes(bytes!.buffer.asUint8List());
          image.dispose();
        });
      }
      final swarm = app.activeSwarm;
      final source = swarm.manualLayout!.tiles;
      final views = [
        for (final pane in app.panes)
          find.byWidgetPredicate(
            (w) => w is TerminalView && w.terminal == pane.session!.terminal,
          ),
      ];
      final states = [for (final view in views) tester.state(view)];
      api.batches.clear();
      for (final size in [
        const Size(800, 1200),
        const Size(2400, 800),
        const Size(1600, 1000),
      ]) {
        tester.view.physicalSize = size;
        await tester.pump();
        expect(swarm.arranged?.tiles, source);
        expect(swarm.manualLayout!.tiles, source);
        for (var i = 0; i < views.length; i++) {
          expect(tester.state(views[i]), same(states[i]));
        }
      }
      app.focusPane(app.panes.last.id);
      app.toggleZoomPane();
      await tester.pump();
      app.toggleZoomPane();
      await tester.pump();
      expect(swarm.arranged?.tiles, source);
      expect(api.batches, isEmpty);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );

  test(
    'shared defaults and presets freeze for every supported count',
    () async {
      for (var count = 2; count <= 9; count++) {
        final id = 'shared-$count';
        final api = _DeskApi()
          ..doc = DeskDoc(
            revision: 1,
            tabs: [tab(id, agents: List.generate(count, (i) => 'a$i'))],
          );
        final app = createApp()..api = api;
        await app.deskStartForTest();
        app.selectSwarm(id);
        expect(app.activeSwarm.manualLayout, isNotNull);
        for (final preset in PanePreset.forCount(count)) {
          app.setPreset(count, preset);
          await Future<void>.delayed(Duration.zero);
          final expected = PaneArrangement(preset.tilesFor(count)).toJson();
          expect(
            api.doc!.tabs
                .singleWhere((tab) => tab.id == id)
                .layout
                ?.sizes['$count:manual'],
            expected,
          );
          expect(app.activeSwarm.manualLayout?.toJson(), expected);
        }
        api.batches.clear();
        await app.deskFetchForTest();
        expect(api.batches, isEmpty);
        app.dispose();
      }
    },
  );

  group('deskDiff', () {
    test('creates a tab with its panes, closes, renames only what the person named, and reorders', () {
      final before = [
        tab('a', agents: ['x']),
        tab('b', name: 'derived'),
      ];
      final after = [
        tab('b', name: 'Home', custom: true),
        tab('c', name: 'New', agents: ['y', 'z']),
      ];
      final ops = deskDiff(before, after);
      expect(ops.map((o) => o['op']), [
        'tab.close',
        'tab.create',
        'pane.add',
        'pane.add',
        'tab.rename',
      ]);
      expect(ops[1], {
        'op': 'tab.create',
        'id': 'c',
        'name': 'New',
        'index': 1,
      });
      expect(ops[2], {
        'op': 'pane.add',
        'tabId': 'c',
        'machineId': 'm',
        'agentId': 'y',
        'index': 0,
      });
      expect(ops[4], {
        'op': 'tab.rename',
        'id': 'b',
        'name': 'Home',
        'nameIsCustom': true,
      });
      // A derived name that differs is each window's own to derive — no op.
      expect(
        deskDiff([tab('b', name: 'one')], [tab('b', name: 'two')]),
        isEmpty,
      );
      // Order of tabs both sides have.
      expect(
        deskDiff(
          [tab('a'), tab('b')],
          [tab('b'), tab('a')],
        ).map((o) => o['op']),
        ['tab.move', 'tab.move'],
      );
    });

    test('adds, removes and moves panes within a tab', () {
      final ops = deskDiff(
        [
          tab('a', agents: ['x', 'y']),
        ],
        [
          tab('a', agents: ['y', 'z']),
        ],
      );
      expect(ops, [
        {'op': 'pane.remove', 'tabId': 'a', 'machineId': 'm', 'agentId': 'x'},
        {
          'op': 'pane.add',
          'tabId': 'a',
          'machineId': 'm',
          'agentId': 'z',
          'index': 1,
        },
      ]);
      final moved = deskDiff(
        [
          tab('a', agents: ['x', 'y']),
        ],
        [
          tab('a', agents: ['y', 'x']),
        ],
      );
      expect(moved.map((o) => o['op']), ['pane.move', 'pane.move']);
      expect(
        deskDiff(
          [
            tab('a', agents: ['x']),
          ],
          [
            tab('a', agents: ['x']),
          ],
        ),
        isEmpty,
      );
    });

    test(
      'replays like the backend: idempotent, and nothing on a tab that is gone',
      () {
        final tabs = applyDeskOps(
          [tab('a')],
          [
            {'op': 'pane.add', 'tabId': 'a', 'machineId': 'm', 'agentId': 'x'},
            {'op': 'pane.add', 'tabId': 'a', 'machineId': 'm', 'agentId': 'x'},
            {'op': 'tab.close', 'id': 'a'},
            {'op': 'pane.add', 'tabId': 'a', 'machineId': 'm', 'agentId': 'y'},
            {'op': 'tab.create', 'id': 'b', 'name': 'B', 'index': 0},
            {'op': 'tab.create', 'id': 'b', 'name': 'B'},
          ],
        );
        expect(tabs.map((t) => t.id), ['b']);
        // A diff, replayed, is the "after" it was taken from.
        final before = [
          tab('a', agents: ['x', 'y']),
          tab('b'),
        ];
        final after = [
          tab('b', name: 'Home', custom: true),
          tab('a', agents: ['y']),
          tab('c', agents: ['z']),
        ];
        final replayed = applyDeskOps(before, deskDiff(before, after));
        expect(
          [for (final t in replayed) t.toJson()],
          [for (final t in after) t.toJson()],
        );
      },
    );

    test(
      'desk ids are 32 hex characters; a window\'s own numbering is not one',
      () {
        expect(isDeskId(newDeskId()), isTrue);
        expect(newDeskId(), isNot(newDeskId()));
        expect(isDeskId('swarm-3'), isFalse);
      },
    );
  });

  group('the window and the desk', () {
    for (final destinationFirst in [false, true]) {
      for (final closeSource in [false, true]) {
        test(
          'a remote pane move preserves its terminal (destination first: $destinationFirst, source closed: $closeSource)',
          () async {
            final api = _DeskApi();
            final app = createApp()..api = api;
            addTearDown(app.dispose);
            final sent = <String>[];
            final session =
                TerminalSession(
                    machineId: 'm',
                    agentId: 'a0',
                    agentName: 'Agent 0',
                    engineId: 'codex',
                    send: (type, _) async {
                      sent.add(type);
                      return true;
                    },
                    sendBinary: (_) async => true,
                  )
                  ..status = TerminalSessionStatus.controlling
                  ..streamId = 'existing-stream';
            session.terminal.write('output before the move');
            final moved = app.adoptSessionForTest(session);
            final source = app.activeSwarm;
            app.newSwarm(name: 'Destination');
            final destination = app.activeSwarm;
            app.selectSwarm(source.id);
            await app.deskStartForTest();
            final tabs = [
              if (!closeSource) tab(source.id),
              tab(
                destination.id,
                name: 'Destination',
                custom: true,
                agents: ['a0'],
              ),
            ];
            api.doc = DeskDoc(
              revision: api.doc!.revision + 1,
              tabs: destinationFirst ? tabs.reversed.toList() : tabs,
            );

            await app.deskFetchForTest();

            expect(destination.panes.single, same(moved));
            expect(moved.session, same(session));
            expect(session.streamId, 'existing-stream');
            expect(
              session.terminal.buffer.getText(),
              contains('output before the move'),
            );
            expect(
              sent.where(
                (type) => type == 'terminal_close' || type == 'terminal_open',
              ),
              isEmpty,
            );
          },
        );
      }
    }

    test(
      'a remote move changing the focused pane does not claim terminal control',
      () async {
        final api = _DeskApi();
        final app = createApp()..api = api;
        addTearDown(app.dispose);
        await app.addAgentToSwarm('m', 'a0');
        await app.addAgentToSwarm('m', 'a1');
        final source = app.activeSwarm;
        app.newSwarm(name: 'Destination');
        final destination = app.activeSwarm;
        app.selectSwarm(source.id);
        app.focusPane(source.panes.first.id);
        await app.deskStartForTest();
        expect(app.paneFocusByUser, isTrue);
        api.doc = DeskDoc(
          revision: api.doc!.revision + 1,
          tabs: [
            tab(source.id, agents: ['a1']),
            tab(
              destination.id,
              name: 'Destination',
              custom: true,
              agents: ['a0'],
            ),
          ],
        );

        await app.deskFetchForTest();

        expect(app.focusedPane?.agentId, 'a1');
        expect(app.paneFocusByUser, isFalse);
      },
    );

    test('joins the desk: its own tabs get desk ids and are seeded, the desk\'s tabs appear as intent', () async {
      final api = _DeskApi()
        ..doc = DeskDoc(
          revision: 4,
          tabs: [
            tab(
              'd1',
              name: 'From the other Mac',
              custom: true,
              agents: ['a5', 'a6'],
            ),
          ],
        );
      final app = createApp()..api = api;
      addTearDown(app.dispose);
      await app.addAgentToSwarm(
        'm',
        'a0',
      ); // this window's own tab, numbered swarm-N
      final own = app.activeSwarm;
      expect(isDeskId(own.id), isFalse);

      await app.deskStartForTest();

      expect(
        isDeskId(own.id),
        isTrue,
        reason: 'the local tab was given a desk id',
      );
      expect(api.batches.expand((batch) => batch).map((op) => op['op']), [
        'seed',
        'tab.layout',
      ]);
      expect(api.doc!.tabs.first.layout?.sizes['2:manual'], [
        [0.0, 0.0, .5, 1.0],
        [.5, 0.0, 1.0, 1.0],
      ]);
      // The desk's own tabs first, this computer's after them — that is where the seed puts them.
      expect(app.swarms.map((s) => s.id), ['d1', own.id]);
      final remote = app.swarms.first;
      expect(remote.name, 'From the other Mac');
      expect(remote.panes.map((p) => p.agentId), ['a5', 'a6']);
      expect(
        remote.panes.every((p) => p.session == null),
        isTrue,
        reason: 'intent only until the machine answers',
      );
      expect(
        app.activeSwarmId,
        own.id,
        reason: 'the active tab is this window\'s',
      );
      expect(app.deskSyncForTest.revision, 5);
      expect(app.deskSyncForTest.pending, isEmpty);
    });

    test(
      'says every edit as ops: new tab, a pane, a rename, an order, a close',
      () async {
        final api = _DeskApi();
        final app = createApp()..api = api;
        addTearDown(app.dispose);
        await app.deskStartForTest();
        api.batches.clear();

        app.newSwarm(name: 'Work');
        final work = app.activeSwarm;
        expect(isDeskId(work.id), isTrue);
        await app.addAgentToSwarm('m', 'a1');
        app.renameSwarm(work.id, 'Real work');
        app.newSwarm(name: 'Second');
        final second = app.activeSwarm;
        app.reorderSwarm(second.id, 0);
        await app.closeSwarm(work.id);
        await Future<void>.delayed(Duration.zero);

        final sent = api.batches.expand((b) => b).map((o) => o['op']).toList();
        expect(
          sent,
          containsAllInOrder([
            'tab.create',
            'pane.add',
            'tab.rename',
            'tab.create',
            'tab.move',
            'tab.close',
          ]),
        );
        // The starter tab this window opened with is on the desk too (empty, unnamed) — a tab is a tab.
        final ids = api.doc!.tabs.map((t) => t.id).toList();
        expect(ids, contains(second.id));
        expect(ids, isNot(contains(work.id)));
        expect(
          ids,
          app.swarms.map((s) => s.id).toList(),
          reason: 'the desk and the window agree on order',
        );
        expect(app.deskSyncForTest.pending, isEmpty);
      },
    );

    test('a pending desk join preserves a rename and neighboring tab closure', () async {
      final officeId = newDeskId(), termId = newDeskId();
      final office = Swarm(id: officeId, name: 'term');
      final term = Swarm(id: termId, name: 'term');
      final api = _DeskApi()
        ..doc = DeskDoc(
          revision: 1,
          tabs: [
            tab(termId, name: 'term', custom: true),
            tab(officeId, name: 'term', custom: true),
          ],
        )
        ..readGate = Completer<void>();
      final app = createApp()..api = api;
      addTearDown(app.dispose);
      app.swarms
        ..clear()
        ..addAll([term, office]);
      app.selectSwarm(termId);
      final joining = app.deskStartForTest();

      app.renameSwarm(officeId, 'office');
      await app.closeSwarm(termId);
      expect(app.activeSwarm, same(office));
      expect(office.name, 'office');

      api.readGate!.complete();
      await joining;
      expect(office.name, 'office');
      expect(app.swarms, [office]);
      expect(api.doc!.tabs.single.id, officeId);
      expect(api.doc!.tabs.single.name, 'office');
      expect(api.doc!.tabs.single.nameIsCustom, isTrue);
      expect(app.deskSyncForTest.pending, isEmpty);
    });

    test('a pending join keeps remote renames and seeds new tabs with local edits', () async {
      final officeId = newDeskId(), termId = newDeskId();
      final office = Swarm(id: officeId, name: 'term');
      final term = Swarm(id: termId, name: 'term');
      final api = _DeskApi()
        ..doc = DeskDoc(
          revision: 2,
          tabs: [
            tab(termId, name: 'term', custom: true),
            tab(officeId, name: 'office', custom: true),
          ],
        )
        ..readGate = Completer<void>();
      final app = createApp()..api = api;
      addTearDown(app.dispose);
      app.swarms
        ..clear()
        ..addAll([term, office]);
      app.selectSwarm(termId);
      final joining = app.deskStartForTest();

      await app.closeSwarm(termId);
      app.newSwarm(name: 'scratch');
      final scratch = app.activeSwarm;
      api.readGate!.complete();
      await joining;

      expect(office.name, 'office');
      expect(app.swarms, [office, scratch]);
      expect(app.activeSwarm, same(scratch));
      expect(isDeskId(scratch.id), isTrue);
      expect(api.doc!.tabs.map((tab) => tab.name), ['office', 'scratch']);
      expect(
        api.batches
            .expand((batch) => batch)
            .where((op) => op['op'] == 'tab.rename'),
        isEmpty,
        reason: 'An unchanged local name must not undo a rename on another machine',
      );
    });

    test('closing term preserves office through an older desk reply and retry', () async {
      final officeId = newDeskId(), termId = newDeskId();
      final api = _DeskApi()
        ..doc = DeskDoc(
          revision: 1,
          tabs: [
            tab(termId, name: 'term', custom: true, agents: ['a2']),
            tab(officeId, name: 'office', custom: true, agents: ['a0', 'a1']),
          ],
        );
      final app = createApp()..api = api;
      addTearDown(app.dispose);
      await app.deskStartForTest();
      final office = app.swarms.singleWhere((tab) => tab.id == officeId);
      final panes = office.panes.toList();
      app.selectSwarm(termId);
      api.batches.clear();
      api.failWith = StateError('offline');
      await app.closeSwarm(termId);
      await Future<void>.delayed(Duration.zero);
      expect(app.activeSwarm, same(office));

      api.failWith = null;
      await app.deskFetchForTest();
      expect(app.swarms.any((tab) => tab.id == termId), isFalse);
      expect(office.name, 'office');
      expect(office.nameIsCustom, isTrue);
      expect(office.panes, orderedEquals(panes));
      expect(app.deskSyncForTest.pending, [
        {'op': 'tab.close', 'id': termId},
      ]);

      await app.deskFlushForTest();
      expect(app.deskSyncForTest.pending, isEmpty);
      expect(office.name, 'office');
      expect(
        api.doc!.tabs.singleWhere((tab) => tab.id == officeId).name,
        'office',
      );
      expect(api.batches.expand((batch) => batch), [
        {'op': 'tab.close', 'id': termId},
      ]);
    });

    test('a desk_changed push closes a tab closed elsewhere and opens one opened elsewhere, keeping this window\'s focus', () async {
      final api = _DeskApi()
        ..doc = DeskDoc(
          revision: 1,
          tabs: [
            tab('d1', name: 'One', custom: true, agents: ['a1', 'a2']),
            tab('d2', name: 'Two', custom: true, agents: ['a3']),
          ],
        );
      final app = createApp()..api = api;
      addTearDown(app.dispose);
      await app.deskStartForTest();
      api.batches.clear();
      app.selectSwarm('d1');
      final d1 = app.activeSwarm;
      final second = d1.panes[1];
      app.focusPane(second.id);
      expect(d1.focusedPaneId, second.id);

      // The other Mac: closed Two, renamed One, added a pane to One, opened Three.
      api.doc = DeskDoc(
        revision: 9,
        tabs: [
          tab('d3', name: 'Three', custom: true, agents: ['a9']),
          tab(
            'd1',
            name: 'One, really',
            custom: true,
            agents: ['a1', 'a2', 'a4'],
          ),
        ],
      );
      await app.handleEventForTest('m', {
        'type': 'desk_changed',
        'payload': {'revision': 9},
      });
      await Future<void>.delayed(Duration.zero);

      // This window's starter tab went too: the other Mac's document did not have it.
      expect(app.swarms.map((s) => s.id), ['d3', 'd1']);
      expect(app.activeSwarmId, 'd1');
      expect(d1.name, 'One, really');
      expect(d1.panes.map((p) => p.agentId), ['a1', 'a2', 'a4']);
      expect(d1.focusedPaneId, second.id, reason: 'focus is this window\'s');
      expect(api.batches.expand((batch) => batch).map((op) => op['op']), ['tab.layout'],
          reason: 'the legacy new pane count gets shared geometry once');
      api.batches.clear();
      await app.deskFetchForTest();
      expect(api.batches, isEmpty, reason: 'canonical geometry never echoes');
    });

    test('a document that did not move a tab\'s order leaves this window\'s tiles, sizes and pins alone', () async {
      final api = _DeskApi()
        ..doc = DeskDoc(
          revision: 1,
          tabs: [
            tab('d1', name: 'One', custom: true, agents: ['a1', 'a2']),
          ],
        );
      final app = createApp()..api = api;
      addTearDown(app.dispose);
      await app.deskStartForTest();
      app.selectSwarm('d1');
      final d1 = app.activeSwarm;
      // This window's own furniture: a viewer between the two agents, a size the
      // person dragged, a pin on the second agent.
      final viewer = TerminalPane(
        id: 900,
        machineId: 'm',
        kind: PaneKind.web,
        ownerAgentId: 'a1',
        url: 'http://127.0.0.1:1/',
      );
      d1.panes.insert(1, viewer);
      final sizes = PaneArrangement([
        Rect.fromLTWH(0, 0, 0.5, 1),
        Rect.fromLTWH(0.5, 0, 0.5, 0.5),
        Rect.fromLTWH(0.5, 0.5, 0.5, 0.5),
      ]);
      d1.savePaneSizes('3:manual', sizes);
      app.togglePinPane(d1.panes[2].id);
      await Future<void>.delayed(Duration.zero);
      api.batches.clear();

      // The 15 s poll, and a push about another tab: the same order for this one
      // (and, as the server would, the layout this window already sent up).
      api.doc = DeskDoc(
        revision: 5,
        tabs: [
          api.doc!.tabs.firstWhere((t) => t.id == 'd1'),
          tab('d2', name: 'Two', custom: true, agents: ['a3']),
        ],
      );
      await app.deskFetchForTest();
      await app.handleEventForTest('m', {
        'type': 'desk_changed',
        'payload': {'revision': 6},
      });
      await Future<void>.delayed(Duration.zero);

      expect(d1.panes.map((p) => p.agentId ?? 'viewer'), [
        'a1',
        'viewer',
        'a2',
      ]);
      expect(identical(d1.paneSizes['3:manual'], sizes), isTrue);
      expect(d1.pinnedSlots, {d1.panes[2].id: 2});
      expect(api.batches, isEmpty, reason: 'nothing to say back');
    });

    test('a reorder made elsewhere moves the agent panes into their slots and nothing else', () async {
      final api = _DeskApi()
        ..doc = DeskDoc(
          revision: 1,
          tabs: [
            tab('d1', name: 'One', custom: true, agents: ['a1', 'a2', 'a3']),
          ],
        );
      final app = createApp()..api = api;
      addTearDown(app.dispose);
      await app.deskStartForTest();
      app.selectSwarm('d1');
      final d1 = app.activeSwarm;
      final viewer = TerminalPane(
        id: 900,
        machineId: 'm',
        kind: PaneKind.web,
        ownerAgentId: 'a1',
        url: 'http://127.0.0.1:1/',
      );
      d1.panes.insert(1, viewer);
      final sizes = PaneArrangement([
        Rect.fromLTWH(0, 0, 0.5, 1),
        Rect.fromLTWH(0.5, 0, 0.5, 0.5),
        Rect.fromLTWH(0.5, 0.5, 0.25, 0.5),
        Rect.fromLTWH(0.75, 0.5, 0.25, 0.5),
      ]);
      d1.savePaneSizes('4:manual', sizes);
      final a3 = d1.panes[3];
      app.togglePinPane(a3.id); // pinned in slot 3
      await Future<void>.delayed(Duration.zero);
      api.batches.clear();

      // The other Mac dragged a3 to the front (the layout as the server holds it rides along).
      api.doc = DeskDoc(
        revision: 7,
        tabs: [
          api.doc!.tabs
              .firstWhere((t) => t.id == 'd1')
              .copyWith(
                panes: [
                  for (final a in ['a3', 'a1', 'a2'])
                    DeskPaneRef(machineId: 'm', agentId: a),
                ],
              ),
        ],
      );
      await app.handleEventForTest('m', {
        'type': 'desk_changed',
        'payload': {'revision': 7},
      });
      await Future<void>.delayed(Duration.zero);

      // Agent panes take the agent slots (0, 2, 3) in the desk's order; the
      // viewer keeps slot 1; the size arrangement is untouched; the pin
      // followed a3 to its new slot.
      expect(d1.panes.map((p) => p.agentId ?? 'viewer'), [
        'a3',
        'viewer',
        'a1',
        'a2',
      ]);
      expect(identical(d1.paneSizes['4:manual'], sizes), isTrue);
      expect(d1.pinnedSlots, {a3.id: 0});
      expect(app.deskSyncForTest.pending, isEmpty);
      expect(
        api.batches,
        isEmpty,
        reason: 'the order came from the desk; nothing to send back',
      );
    });

    test(
      'at the join the desk\'s order wins over the layout this window restored',
      () async {
        final id = newDeskId();
        final api = _DeskApi()
          ..doc = DeskDoc(
            revision: 3,
            tabs: [
              tab(id, name: 'One', custom: true, agents: ['a2', 'a1']),
            ],
          );
        final app = createApp()..api = api;
        addTearDown(app.dispose);
        // Restored from before: the same tab, the other way round.
        app.newSwarm(name: 'One');
        final local = app.activeSwarm..id = id;
        await app.addAgentToSwarm('m', 'a1', swarmId: id);
        await app.addAgentToSwarm('m', 'a2', swarmId: id);
        expect(local.panes.map((p) => p.agentId), ['a1', 'a2']);

        await app.deskStartForTest();
        expect(app.swarms.where((s) => s.id == id).length, 1);
        expect(local.panes.map((p) => p.agentId), ['a2', 'a1']);
        expect(
          api.batches.expand((b) => b).where((o) => o['op'] == 'pane.move'),
          isEmpty,
          reason: 'this window changed nothing',
        );
      },
    );

    test('a restart keeps the window\'s layout: preset, sizes, pins, focus and zoom survive the join', () async {
      // The desk holds membership, order and names; everything else is this
      // window's and lives in its saved layout. Restoring that layout and then
      // joining a desk that already has the tab must change none of it.
      final id = newDeskId();
      final storage = MemoryStore();
      final store = PaneLayoutStore(storage: storage);
      final sizes = PaneArrangement([
        Rect.fromLTWH(0, 0, 0.3, 1),
        Rect.fromLTWH(0.3, 0, 0.7, 1),
      ]);
      final saved = Swarm(id: id, name: 'Work', nameIsCustom: true)
        ..panes.addAll([
          TerminalPane(id: 1, machineId: 'm', agentId: 'a1'),
          TerminalPane(id: 2, machineId: 'm', agentId: 'a2'),
        ])
        ..presets[2] = PanePreset.rows
        ..savePaneSizes('2:manual', sizes)
        ..focusedPaneId = 2
        ..zoomedPaneId = 2;
      saved.pinnedSlots[2] = 1;
      await store.saveSwarms([saved], id);

      final api = _DeskApi()
        ..doc = DeskDoc(
          revision: 20,
          tabs: [
            tab(id, name: 'Work', custom: true, agents: ['a1', 'a2']),
          ],
        );
      final app = createApp(store: storage)..api = api;
      addTearDown(app.dispose);
      await app.restorePaneLayoutForTest();
      final work = app.swarms.singleWhere((s) => s.id == id);
      expect(work.presets[2], PanePreset.rows);
      final focused = work.focusedPaneId, zoomed = work.zoomedPaneId;
      expect(focused, isNotNull);
      expect(zoomed, isNotNull);

      await app.deskStartForTest();
      await Future<void>.delayed(Duration.zero);

      expect(app.swarms.map((s) => s.id), [id]);
      expect(work.panes.map((p) => p.agentId), ['a1', 'a2']);
      expect(
        work.presets[2],
        PanePreset.rows,
        reason: 'the preset is the window\'s',
      );
      expect(work.paneSizes['2:manual']?.tiles, sizes.tiles);
      expect(work.focusedPaneId, focused);
      expect(work.zoomedPaneId, zoomed);
      expect(work.pinnedSlots.values, [1]);
      // The desk held no layout for the tab: it learns this window's, once.
      final sent = api.batches.expand((b) => b).toList();
      expect(sent.map((o) => o['op']), ['tab.layout']);
      expect(api.doc!.tabs.single.layout?.presets, {'2': 'rows'});
    });

    test('a preset chosen or a split dragged here is the layout on the other Mac too', () async {
      // The desk carries presets and arrangements since 2026-09-22 ("máy kia
      // không có layout"). Focus, zoom and pins stay this window's.
      final api = _DeskApi();
      final app = createApp()..api = api;
      addTearDown(app.dispose);
      await app.deskStartForTest();
      app.newSwarm(name: 'Work');
      final work = app.activeSwarm;
      await app.addAgentToSwarm('m', 'a1', swarmId: work.id);
      await app.addAgentToSwarm('m', 'a2', swarmId: work.id);
      await Future<void>.delayed(Duration.zero);
      api.batches.clear();

      app.setPreset(2, PanePreset.rows);
      await Future<void>.delayed(Duration.zero);
      DeskLayout? onDesk() =>
          api.doc!.tabs.singleWhere((t) => t.id == work.id).layout;
      expect(onDesk()?.presets, {'2': 'rows'});
      expect(
        api.batches.expand((b) => b).where((o) => o['op'] == 'tab.layout'),
        hasLength(1),
      );

      // A drag: the arrangement travels as fractions of the canvas.
      final sizes = PaneArrangement([
        Rect.fromLTWH(0, 0, 0.3, 1),
        Rect.fromLTWH(0.3, 0, 0.7, 1),
      ]);
      work.savePaneSizes('2:manual', sizes);
      app.persistLayoutForTest();
      await Future<void>.delayed(Duration.zero);
      expect(onDesk()?.sizes['2:manual'], sizes.toJson());

      // The other Mac, joining: the same tab with the same preset and split.
      final other = createApp()..api = api;
      addTearDown(other.dispose);
      await other.deskStartForTest();
      final theirs = other.swarms.singleWhere((s) => s.id == work.id);
      expect(theirs.presets[2], PanePreset.rows);
      expect(theirs.paneSizes['2:manual']?.tiles, sizes.tiles);
      expect(
        theirs.focusedPaneId,
        isNot(work.focusedPaneId),
        reason: 'focus is each window\'s own',
      );
    });

    test('a document that did not move the layout leaves a drag in progress alone; one that did applies it', () async {
      final id = newDeskId();
      final api = _DeskApi()
        ..doc = DeskDoc(
          revision: 1,
          tabs: [
            tab(id, name: 'Work', custom: true, agents: ['a1', 'a2']),
          ],
        );
      final app = createApp()..api = api;
      addTearDown(app.dispose);
      await app.deskStartForTest();
      app.selectSwarm(id);
      final work = app.activeSwarm;
      // This window drags while the backend is unreachable: the op waits, the
      // arrangement stands.
      api.failWith = StateError('offline');
      final mine = PaneArrangement([
        Rect.fromLTWH(0, 0, 0.6, 1),
        Rect.fromLTWH(0.6, 0, 0.4, 1),
      ]);
      work.savePaneSizes('2:manual', mine);
      app.persistLayoutForTest();
      await Future<void>.delayed(Duration.zero);
      api.failWith = null;
      // A push about something else (a new tab) — the layout on the desk for this tab did not move.
      api.doc = DeskDoc(
        revision: 3,
        tabs: [
          tab(id, name: 'Work', custom: true, agents: ['a1', 'a2']),
          tab('other', name: 'Other', custom: true),
        ],
      );
      await app.handleEventForTest('m', {
        'type': 'desk_changed',
        'payload': {'revision': 3},
      });
      await Future<void>.delayed(Duration.zero);
      expect(work.paneSizes['2:manual']?.tiles, mine.tiles);
      await app.deskFlushForTest();
      expect(api.doc!.tabs.first.layout?.sizes['2:manual'], mine.toJson());

      // The other Mac chose a preset for this tab: it applies here.
      api.doc = DeskDoc(
        revision: 9,
        tabs: [
          DeskTab(
            id: id,
            name: 'Work',
            nameIsCustom: true,
            panes: [
              const DeskPaneRef(machineId: 'm', agentId: 'a1'),
              const DeskPaneRef(machineId: 'm', agentId: 'a2'),
            ],
            layout: const DeskLayout(presets: {'2': 'rows'}),
          ),
          tab('other', name: 'Other', custom: true),
        ],
      );
      await app.handleEventForTest('m', {
        'type': 'desk_changed',
        'payload': {'revision': 9},
      });
      await Future<void>.delayed(Duration.zero);
      expect(work.presets[2], PanePreset.rows);
      expect(
        work.manualLayout?.tiles,
        PanePreset.rows.tilesFor(2),
        reason: 'the preset replaces the split with shared normalized slots',
      );
    });

    test('keeps its ops while the backend is unreachable and sends them once it is back', () async {
      final api = _DeskApi();
      final app = createApp()..api = api;
      addTearDown(app.dispose);
      await app.deskStartForTest();
      api.failWith = StateError('offline');
      app.newSwarm(name: 'Offline work');
      final offline = app.activeSwarm;
      await Future<void>.delayed(Duration.zero);
      expect(app.deskSyncForTest.pending, isNotEmpty);
      expect(api.doc!.tabs.map((t) => t.id), isNot(contains(offline.id)));

      api.failWith = null;
      await app.deskFlushForTest();
      expect(api.doc!.tabs.map((t) => t.id), contains(offline.id));
      expect(app.deskSyncForTest.pending, isEmpty);
    });

    test(
      'a daemon without a desk leaves the window as it was: local ids, no ops',
      () async {
        final api = _DeskApi()..available = false;
        final app = createApp()..api = api;
        addTearDown(app.dispose);
        await app.addAgentToSwarm('m', 'a0');
        await app.deskStartForTest();
        expect(app.deskSyncForTest.enabled, isFalse);
        app.newSwarm(name: 'Local');
        expect(isDeskId(app.activeSwarm.id), isFalse);
        expect(api.batches, isEmpty);
      },
    );
  });
}
