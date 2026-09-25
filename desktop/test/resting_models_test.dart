// What the app reads and says about models on computers that rest to save resources
// (grid-reads-without-waking, issue 03, desktop half): the additive fields of the wire contract,
// the one set of sentences every surface shares, the explicit wake, and the watch behind the pane
// chip. The surfaces themselves are in resting_model_picker_test, resting_models_panel_test and
// pane_model_status_test.
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/models/local_model.dart';
import 'package:harness/state/model_start_watch.dart';
import 'package:harness/widgets/resting_model_words.dart';

import 'support/resting_models.dart';
import 'swarm_state_test.dart' show createApp;

GridSection _only(Map<String, Object?> raw) =>
    GridModels.fromReply(modelsReply([raw])).sections.single;

void main() {
  group('the additive fields', () {
    test('a row, a section and an agent read everything issue 03 adds', () {
      final reply = modelsReply([
        section(
          'team',
          state: 'waking',
          wakeOutcome: 'not_started',
          models: [row('Qwen3.6-35B-A3B', 'studio', offlineMachine: 'Studio')],
        ),
      ]);
      final team = GridModels.fromReply(reply).sections.single;
      expect(team.state, GridSectionState.waking);
      expect(team.wakeOutcome, GridWakeOutcome.notStarted);
      final unavailable = team.models.single.unavailable!;
      expect(unavailable.machine, 'Studio');
      expect(unavailable.since, DateTime.utc(2026, 9, 25, 8));
      // The row keeps a plain node beside the label — the label is not folded into it.
      expect(team.models.single.node, 'studio');

      final agent = Agent.fromJson({
        'id': 'a',
        'name': 'Agent',
        'grid': {
          'model': 'Qwen3.6-35B-A3B',
          'state': 'asleep',
          'note': {
            'reason': 'offline',
            'model': 'Qwen3.6-35B-A3B',
            'machine': 'Studio',
          },
        },
      });
      expect(agent.gridState, GridSectionState.asleep);
      expect(
        agent.gridNote,
        isA<GridNoteOffline>().having((n) => n.machine, 'machine', 'Studio'),
      );
      // A copy keeps them: a rename must not wipe the pane's note.
      expect(
        agent.copyWith(name: 'Renamed').gridNote?.model,
        'Qwen3.6-35B-A3B',
      );
      expect(
        agent.copyWith(name: 'Renamed').gridState,
        GridSectionState.asleep,
      );

      final notServed = Agent.fromJson({
        'id': 'a',
        'name': 'Agent',
        'grid': {
          'model': 'Qwen',
          'note': {'reason': 'not_served', 'model': 'Qwen'},
        },
      });
      expect(notServed.gridNote, isA<GridNoteNotServed>());
      expect(notServed.gridNote?.model, 'Qwen');

      final parked = LocalModel.fromJson({
        'id': 'qwen',
        'name': 'Qwen',
        'state': 'running',
        'gridAsleep': true,
      });
      expect(parked.resting, isTrue);
    });

    test('an older daemon that sends none of them claims nothing', () {
      final team = _only(
        section('team', models: [row('Qwen', 'studio · seems offline')]),
      );
      expect(team.wakeOutcome, isNull);
      expect(team.models.single.unavailable, isNull);
      expect(team.models.single.node, 'studio · seems offline');
      final agent = Agent.fromJson({
        'id': 'a',
        'name': 'Agent',
        'grid': {'model': 'Qwen', 'webSearch': 'on'},
      });
      expect(agent.gridState, isNull);
      expect(agent.gridNote, isNull);
      expect(
        LocalModel.fromJson({'id': 'q', 'name': 'Q', 'state': 'running'})
            .resting,
        isFalse,
      );
    });

    test('words this build has not heard of, and notes missing a name, are no claim', () {
      final odd = _only({
        ...section('team', wakeOutcome: 'exploded'),
        'models': [
          {
            'id': 'Qwen',
            'node': 'studio',
            'unavailable': {'reason': 'maintenance', 'machine': 'Studio'},
          },
          {
            'id': 'Gemma',
            'node': 'studio',
            'unavailable': {'reason': 'offline'},
          },
        ],
      });
      expect(odd.wakeOutcome, isNull);
      expect(odd.models.map((m) => m.unavailable), [isNull, isNull]);
      for (final note in [
        {'reason': 'offline', 'model': 'Qwen'},
        {'reason': 'not_served'},
        {'reason': 'melted', 'model': 'Qwen'},
        'offline',
      ]) {
        final agent = Agent.fromJson({
          'id': 'a',
          'name': 'Agent',
          'grid': {'model': 'Qwen', 'note': note},
        });
        expect(agent.gridNote, isNull, reason: '$note');
      }
    });
  });

  group('the words', () {
    test('a list age reads in minutes, hours and days, rounded down', () {
      expect(listAge(0), 'just now');
      expect(listAge(59), 'just now');
      expect(listAge(60), '1 min ago');
      expect(listAge(3599), '59 min ago');
      expect(listAge(9 * 3600 + 1800), '9 h ago');
      expect(listAge(86399), '23 h ago');
      expect(listAge(3 * 86400), '3 d ago');
    });

    test('each state of the contract table reads as the table says', () {
      final served = [row('Qwen', 'studio')];
      final asleep = sectionWords(
        _only(
          section(
            'team',
            state: 'asleep',
            lastKnownAge: 9 * 3600,
            models: served,
          ),
        ),
      );
      expect(
        asleep.subtitle,
        'Asleep · starts when you send a message (about 10–30 s) · list from 9 h ago',
      );
      expect(
        asleep.tooltip,
        'Resting to save resources. It starts by itself when you send a message.',
      );
      expect(asleep.sentence, isNull);
      expect(asleep.offerWake, isFalse);

      final noRecord = sectionWords(_only(section('team', state: 'asleep')));
      expect(noRecord.offerWake, isTrue);
      expect(noRecord.sentence, isNull);
      // The round trip of a wake this surface sent: promised at once, never offered twice.
      final asking = sectionWords(
        _only(section('team', state: 'asleep')),
        asking: true,
      );
      expect(asking.offerWake, isFalse);
      expect(asking.sentence, 'Starting up… usually 15–40 s');

      expect(
        sectionWords(_only(section('team', state: 'asleep', lastKnownAge: 60)))
            .sentence,
        'Nobody was serving here when it went to sleep',
      );
      for (final known in [
        section('team', state: 'unknown', models: served),
        section('team', state: 'unknown', seenAt: '2026-09-24T08:00:00.000Z'),
        section('team', state: 'unknown', lastKnownAge: 60),
      ]) {
        expect(sectionWords(_only(known)).sentence, 'Not answering right now');
      }
      // Unknown with nothing known has nothing to be "above".
      expect(
        sectionWords(_only(section('team', state: 'unknown'))),
        SectionWords.none,
      );
      expect(
        sectionWords(_only(section('team', state: 'waking'))).sentence,
        'Starting up… usually 15–40 s',
      );
      expect(
        sectionWords(
          _only(section('team', state: 'asleep', wakeOutcome: 'not_started')),
        ).sentence,
        "Couldn't start team right now — it will start on your next message",
      );
      expect(
        sectionWords(
          _only(
            section(
              'home',
              own: true,
              state: 'asleep',
              wakeOutcome: 'not_started',
            ),
          ),
        ).sentence,
        "Couldn't start your models right now — it will start on your next message",
      );
      expect(
        sectionWords(
          _only(section('team', state: 'awake', wakeOutcome: 'nobody_serving')),
        ).sentence,
        'Nobody is serving a model here right now',
      );
      // Awake, and a daemon that sent no state at all, say nothing.
      expect(
        sectionWords(_only(section('team', state: 'awake', models: served))),
        SectionWords.none,
      );
      expect(
        sectionWords(_only(section('team', models: served))),
        SectionWords.none,
      );
      expect(sectionWords(_only(section('team'))), SectionWords.none);
    });

    test('rows and notes', () {
      expect(
        offlineRowSentence('Studio'),
        'Studio seems offline — its models come back when it does',
      );
      // What the daemon itself sends a client that does not ask for row state.
      expect(offlineNodeLabel('Studio'), 'Studio · seems offline');
      expect(
        noteSentence(const GridNoteOffline('Qwen', machine: 'Studio')),
        "Studio seems offline — Qwen won't answer until it's back",
      );
      expect(
        noteSentence(const GridNoteNotServed('Qwen')),
        "Qwen isn't being served right now",
      );
    });

    test('no sentence this adds says "grid", in any case', () {
      const own = GridSection(name: 'home', own: true, models: []);
      const shared = GridSection(name: 'team', own: false, models: []);
      final every = <String>[
        kRestingTooltip,
        kShowModels,
        kShowModelsWait,
        kStartingUpWait,
        kNobodyWasServing,
        kNotAnswering,
        kNobodyServing,
        kStartingUp,
        kStillStarting,
        kPickAnother,
        kSwitchAnyway,
        kSwitchAnywayAction,
        kRestingUntilNextMessage,
        restingSubtitle(null),
        for (final age in [0, 60, 3600, 86400]) restingSubtitle(age),
        couldNotStart(own),
        couldNotStart(shared),
        offlineRowSentence('Studio'),
        offlineNoteSentence('Studio', 'Qwen'),
        offlineNodeLabel('Studio'),
        notServedNoteSentence('Qwen'),
      ];
      for (final sentence in every) {
        expect(
          sentence.toLowerCase(),
          isNot(contains('grid')),
          reason: sentence,
        );
      }
    });
  });

  group('the requests', () {
    test('every read asks for row state', () async {
      final daemon = RecordingDaemon(modelsReply([section('home', own: true)]));
      final app = createApp(connectionForTest: (_) => daemon);
      addTearDown(app.dispose);
      await app.gridModels('m');
      await app.refreshGridModels('m');
      await app.readGridPicture('m');
      expect(daemon.asks, isNotEmpty);
      for (final ask in daemon.asks) {
        expect(ask, {'rowState': true});
      }
    });

    testWidgets(
      'Show models asks that one section to wake, takes the answer, and follows it to the end',
      (tester) async {
        final daemon = RecordingDaemon(
          modelsReply([
            section('home', own: true),
            section('team', state: 'asleep'),
          ]),
        );
        final app = createApp(connectionForTest: (_) => daemon);
        addTearDown(app.dispose);
        await app.refreshGridModels('m');
        daemon.wakeReply = modelsReply([
          section('home', own: true),
          section('team', state: 'waking'),
        ]);
        // The daemon answers at once with the section waking; the outcome comes from asking again
        // (a window that gets no push), which a plain read does.
        daemon.reply = daemon.wakeReply!;

        final answer = await app.wakeGridModels('m', 'team');
        expect(daemon.asks.last, {
          'rowState': true,
          'wake': ['team'],
        });
        expect(answer.sections.last.state, GridSectionState.waking);
        expect(
          app.gridPictures['m']!.sections.last.state,
          GridSectionState.waking,
        );

        final asked = daemon.asks.length;
        await tester.pump(const Duration(seconds: 5));
        expect(daemon.asks.length, asked + 1);
        expect(daemon.asks.last, {'rowState': true});

        daemon.reply = modelsReply([
          section('home', own: true),
          section('team', state: 'awake', models: [row('Qwen', 'studio')]),
        ]);
        await tester.pump(const Duration(seconds: 5));
        expect(app.gridPictures['m']!.sections.last.models.single.id, 'Qwen');
        // Nothing is waking any more, so nothing is asked again — and no timer is left behind.
        final settled = daemon.asks.length;
        await tester.pump(const Duration(seconds: 30));
        expect(daemon.asks.length, settled);
      },
    );

    testWidgets('a wake that cannot reach the machine is not adopted', (
      tester,
    ) async {
      final daemon = RecordingDaemon(
        modelsReply([
          section('home', own: true),
          section('team', state: 'asleep'),
        ]),
      );
      final app = createApp(connectionForTest: (_) => daemon);
      addTearDown(app.dispose);
      await app.refreshGridModels('m');
      daemon.wakeReply = {'error': 'GRID_MODELS_FAILED'};
      final answer = await app.wakeGridModels('m', 'team');
      expect(answer.reachable, isFalse);
      expect(app.gridPictures['m']!.reachable, isTrue);
      expect(
        app.gridPictures['m']!.sections.last.state,
        GridSectionState.asleep,
      );
      // Nothing is waking in the picture, so nothing follows it.
      final asked = daemon.asks.length;
      await tester.pump(const Duration(seconds: 30));
      expect(daemon.asks.length, asked);
    });
  });

  group('the start watch', () {
    testWidgets(
      'starting, then still starting after a minute, then gone on output',
      (tester) async {
        final watch = ModelStartWatch();
        addTearDown(watch.dispose);
        var changes = 0;
        watch.addListener(() => changes++);

        watch.start('m', 'a');
        expect(watch.phaseOf('m', 'a'), ModelStartPhase.starting);
        await tester.pump(const Duration(seconds: 59));
        expect(watch.phaseOf('m', 'a'), ModelStartPhase.starting);
        // A second message while the first is waiting keeps the first one's clock.
        watch.start('m', 'a');
        await tester.pump(const Duration(seconds: 1));
        expect(watch.phaseOf('m', 'a'), ModelStartPhase.stillStarting);
        expect(watch.phaseOf('m', 'other'), isNull);

        watch.end('m', 'a');
        expect(watch.phaseOf('m', 'a'), isNull);
        expect(changes, 3);
      },
    );

    testWidgets('never outlives its cap', (tester) async {
      final watch = ModelStartWatch();
      addTearDown(watch.dispose);
      watch.start('m', 'a');
      await tester.pump(kStartWatchCap - const Duration(seconds: 1));
      expect(watch.phaseOf('m', 'a'), ModelStartPhase.stillStarting);
      await tester.pump(const Duration(seconds: 1));
      expect(watch.phaseOf('m', 'a'), isNull);
    });

    testWidgets('a sign-out forgets every wait', (tester) async {
      final watch = ModelStartWatch();
      addTearDown(watch.dispose);
      watch
        ..start('m', 'a')
        ..start('m', 'b')
        ..clear();
      expect(watch.phaseOf('m', 'a'), isNull);
      expect(watch.phaseOf('m', 'b'), isNull);
    });
  });
}
