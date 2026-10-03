// The daemon's face: moods in the README's order, blinks only as answers,
// work frames stepped by agent events, activity details, and the
// interruption rules for its one line. Every test runs in fake time and ends
// with no timer left: nothing runs on its own.
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/local_key_value_store.dart';
import 'package:harness/daemons/daemon_brain.dart';
import 'package:harness/daemons/daemon_face.dart';
import 'package:harness/daemons/daemon_settings.dart';
import 'package:harness/daemons/roster.dart';
import 'package:harness/daemons/roster.g.dart';
import 'package:harness/daemons/zoo.dart';
import 'package:harness/daemons/zoo_controller.dart';

class _Memory implements LocalKeyValueStore {
  final values = <String, String>{};
  @override
  Future<String?> read(String key) async => values[key];
  @override
  Future<void> write(String key, String value) async => values[key] = value;
  @override
  Future<void> delete(String key) async => values.remove(key);
}

class _Clock {
  DateTime value = DateTime(2026, 9, 26, 9);
  DateTime call() => value;
}

/// The roster with tim's lines as templates, the way the roster is moving.
DaemonRoster _templated() {
  final raw = jsonDecode(daemonRosterJson) as Map<String, dynamic>;
  raw['rules']['lineSlots'] = ['who', 'q', 'recap', 'n', 'summary'];
  final tim = (raw['daemons'] as List).firstWhere((d) => d['id'] == 'tim');
  tim['lines'] = {
    ...tim['lines'] as Map,
    'idle': '{n} idle. nothing needs you.',
    'need': 'bell in {who}: {q}',
    'fail': '{who} exited. {recap}',
    'back': 'welcome back. {summary}',
  };
  tim['examples'] = {'idle': '2 idle. nothing needs you.'};
  return DaemonRoster.parse(jsonEncode(raw));
}

const _need = DaemonSubject(
  'office/a1',
  who: 'codex@office',
  q: 'run the migration?',
);

void main() {
  late _Clock clock;
  late ZooController zoo;
  late DaemonFace face;
  late DaemonSettings settings;

  Future<void> mount(
    WidgetTester tester, {
    String id = 'tim',
    String version = '2.0',
    bool shiny = false,
    bool illustrations = false,
    Zoo? custom,
    DaemonRoster? roster,
    LocalKeyValueStore? settingsStore,
  }) async {
    clock = _Clock();
    final storage = _Memory();
    final seeded =
        custom ??
        Zoo(
          daemons: [
            ZooDaemon(
              id: id,
              hatched: '2026-09-26T09:00:00Z',
              egg: 'first',
              version: version,
              shiny: shiny,
              // Bond and version follow xp: 0.1, 1.0 at level 2, 2.0 at 4.
              xp: const {'0.1': 0, '1.0': 150, '2.0': 600}[version]!,
            ),
          ],
          pair: id,
          habits: const ['turn', 'split', 'find', 'machine', 'store'],
          firstEgg: true,
        );
    storage.values[ZooController.localZooKey] = jsonEncode({
      'zoo': seeded.toJson(),
      'seeded': true,
    });
    zoo = ZooController(storage: storage, now: clock.call, roster: roster);
    settings = DaemonSettings(storage: settingsStore);
    face = DaemonFace(
      zoo,
      now: clock.call,
      settings: settings,
      animateIllustrations: illustrations,
    );
    addTearDown(() {
      face.dispose();
      settings.dispose();
      zoo.dispose();
    });
    zoo.bind('guest');
    await tester.pump();
    face.sync(const DaemonWatch());
  }

  /// Advance the injected clock and fake time together.
  Future<void> pass(WidgetTester tester, Duration d) async {
    clock.value = clock.value.add(d);
    await tester.pump(d);
  }

  /// Let every line and hold run out, and the two-minute window pass.
  Future<void> settle(WidgetTester tester) async {
    face.sync(const DaemonWatch());
    await pass(tester, const Duration(minutes: 3));
  }

  testWidgets('nothing shows until the zoo has loaded', (tester) async {
    final zoo = ZooController(storage: _Memory());
    final face = DaemonFace(zoo);
    addTearDown(() {
      face.dispose();
      zoo.dispose();
    });
    expect(face.visible, isFalse);
    expect(face.glyph, '');
    expect(face.cell, '');
    zoo.bind('guest');
    await tester.pump();
    expect(face.visible, isTrue);
    expect(face.glyph, r'\_(  )_/');
    expect(
      face.cell.length,
      10,
      reason: 'the first egg uses the same fixed slot',
    );
  });

  testWidgets('moods follow the README precedence', (tester) async {
    await mount(tester);
    expect(face.mood, DaemonMood.idle);
    expect(face.glyph, '~(o o)~');
    face.sync(const DaemonWatch(failing: true));
    expect(face.mood, DaemonMood.fail);
    face.sync(const DaemonWatch(failing: true, working: true));
    expect(face.mood, DaemonMood.work);
    face.nap();
    expect(face.mood, DaemonMood.nap);
    expect(face.glyph, '~(- -)~z');
    face.sync(const DaemonWatch(working: true, needIds: {'m/a#1'}));
    expect(face.mood, DaemonMood.need, reason: 'need wins and wakes a nap');
    expect(face.napping, isFalse);
    face.boop();
    expect(face.mood, DaemonMood.boop);
    await pass(tester, const Duration(milliseconds: 900));
    expect(face.mood, DaemonMood.need);
    await settle(tester);
  });

  testWidgets('an unreachable machine is calm: it never fails the face', (
    tester,
  ) async {
    await mount(tester);
    face.sync(
      const DaemonWatch(
        away: [
          DaemonMachine(name: 'office', status: 'offline'),
          DaemonMachine(name: 'laptop', status: 'asleep'),
          DaemonMachine(name: 'studio', status: 'unreachable'),
        ],
      ),
    );
    expect(face.mood, DaemonMood.idle);
    expect(face.away.map((m) => m.name), ['office', 'laptop', 'studio']);
    expect(face.tooltip, contains('office is asleep or unreachable.'));
    expect(face.tooltip, contains('laptop is asleep. its harnesses wait.'));
    expect(face.tooltip, contains('studio is out of reach.'));
    expect(face.voice, isNull);
  });

  testWidgets('the dial above suggest is in the tooltip, and a raise that '
      'waits for a yes', (tester) async {
    await mount(tester);
    face.sync(const DaemonWatch(autonomy: 'suggest'));
    expect(face.tooltip, isNot(contains('autonomy')));
    var changes = 0;
    face.addListener(() => changes++);
    face.sync(
      const DaemonWatch(
        autonomy: 'suggest',
        autonomyRequested: 'act-within-rules',
      ),
    );
    expect(changes, greaterThan(0), reason: 'the tooltip changed');
    expect(
      face.tooltip,
      contains('asks for act within rules: waiting for your yes'),
    );
    face.sync(const DaemonWatch(autonomy: 'act-on-key'));
    expect(face.tooltip, contains('autonomy: act on key'));
    expect(face.autonomy, 'act-on-key');
  });

  testWidgets('a brain line carries its detail, harness, speaker and setting', (
    tester,
  ) async {
    await mount(tester);
    face.sayFromBrain(
      DaemonSay.fromJson({
        'id': 'confirm:rules:n1',
        'about': {'machineId': 'm', 'agentId': ''},
        'mood': 'ask',
        'from': 'daemon',
        'line': '[y/n] use pair.jsonc as it is now?',
        'detail': 'pair.jsonc (1 rule):\n{}',
        'confirm': {'kind': 'rules', 'nonce': 'n1'},
        'actions': [
          {'key': 'y', 'label': 'confirm', 'choice': 'y'},
          {'key': 'n', 'label': 'keep it as it is', 'choice': 'n'},
        ],
        'ttlMs': 5200,
      })!,
    );
    expect(face.voice, '[y/n] use pair.jsonc as it is now?');
    expect(face.voiceAlert, isTrue, reason: 'it asks: yellow');
    expect(face.voiceDetail, startsWith('pair.jsonc (1 rule)'));
    expect(face.voiceConfirm, (kind: 'rules', nonce: 'n1'));
    expect(face.voiceFromPair, isFalse);
    face.dismissVoice();
    face.sayFromBrain(
      DaemonSay.fromJson({
        'id': 'ask:2',
        'about': {'machineId': 'm', 'agentId': ''},
        'mood': 'ask',
        'from': 'pair',
        'line': '[y/n] send "run the tests" to api?',
        'harness': {'machineId': 'm', 'machine': 'laptop', 'name': 'api'},
        'detail': 'send to api@laptop:\nrun the tests',
        'actions': [
          {'key': 'y', 'label': 'send', 'choice': 'y'},
        ],
        'ttlMs': 5200,
      })!,
    );
    expect(face.voiceFromPair, isTrue);
    expect(face.voiceHarness!.label, 'api@laptop');
    await settle(tester);
  });

  testWidgets('restored state is a baseline, then a new need speaks once', (
    tester,
  ) async {
    await mount(tester);
    face.sync(const DaemonWatch(needIds: {'m/old#1'}));
    expect(face.voice, isNotNull, reason: 'a question after the baseline');
    expect(face.voiceAlert, isTrue, reason: 'the message yellow');
    await pass(tester, const Duration(seconds: 6));
    expect(face.voice, isNull);
    face.sync(const DaemonWatch());
    await pass(tester, const Duration(minutes: 3));
    face.sync(const DaemonWatch(needIds: {'m/old#1'}));
    expect(face.voice, isNull, reason: 'a reconnect re-announcing it is not');
    await settle(tester);
  });

  testWidgets('a finished turn: ack blink, done for 3 s, activity details '
      'and no line', (tester) async {
    await mount(tester);
    face.sync(const DaemonWatch(turns: {'m': 4}));
    expect(face.mood, DaemonMood.idle, reason: 'a first count is a baseline');
    face.sync(const DaemonWatch(turns: {'m': 5}));
    expect(face.mood, DaemonMood.done);
    expect(face.voice, isNull, reason: 'a finished turn never takes over');
    expect(face.doneCount, 1);
    expect(face.lid, isNull);
    await pass(tester, const Duration(milliseconds: 170));
    expect(face.lid, '-');
    expect(face.glyph, '~(- -)~');
    await pass(tester, const Duration(milliseconds: 130));
    expect(face.lid, isNull);
    await pass(tester, const Duration(seconds: 3));
    expect(face.mood, DaemonMood.idle);
    face.sync(const DaemonWatch(turns: {'m': 7}));
    expect(face.mood, DaemonMood.idle, reason: 'the 20 s cooldown');
    expect(face.doneCount, 3, reason: 'every finish counts');
    expect(face.detail, contains('3 finished since you looked'));
    face.seen();
    expect(face.doneCount, 0, reason: 'cleared when you look');
    await pass(tester, const Duration(seconds: 20));
    face.sync(const DaemonWatch(turns: {'m': 8}));
    expect(face.mood, DaemonMood.done);
    await settle(tester);
  });

  testWidgets('the pane in front of you is never counted or spoken about', (
    tester,
  ) async {
    await mount(tester);
    const here = DaemonSubject('m/a1', who: 'claude@m');
    const there = DaemonSubject('m/a2', who: 'codex@m');
    face.sync(const DaemonWatch(turns: {'m': 0}, focus: 'm/a1'));
    face.sync(
      const DaemonWatch(
        turns: {'m': 2},
        ended: {
          'm': [DaemonTurnEnd(here), DaemonTurnEnd(there)],
        },
        focus: 'm/a1',
      ),
    );
    expect(face.doneCount, 1, reason: 'only the one you were not looking at');
    face.sync(
      const DaemonWatch(
        turns: {'m': 2},
        needIds: {'m/a1#q'},
        needs: {'m/a1#q': here},
        focus: 'm/a1',
      ),
    );
    expect(face.mood, DaemonMood.need, reason: 'the face still knows');
    expect(face.voice, isNull, reason: 'you are looking at it');
    await settle(tester);
  });

  testWidgets('a failed turn holds fail for 4.2 s and says who, in yellow', (
    tester,
  ) async {
    await mount(tester, roster: _templated());
    face.sync(const DaemonWatch(fails: {'m': 0}));
    face.sync(
      const DaemonWatch(
        fails: {'m': 1},
        ended: {
          'm': [
            DaemonTurnEnd(DaemonSubject('m/a1', who: 'claude@m'), failed: true),
          ],
        },
      ),
    );
    expect(face.mood, DaemonMood.fail);
    expect(face.glyph, '~(x x)~');
    // No recap is known: its clause goes, never a made-up one.
    expect(face.voice, 'tim: claude@m exited.');
    expect(face.voiceAlert, isTrue);
    await pass(tester, const Duration(milliseconds: 4100));
    expect(face.mood, DaemonMood.fail);
    await pass(tester, const Duration(milliseconds: 200));
    expect(face.mood, DaemonMood.idle);
    await settle(tester);
  });

  testWidgets('templates are filled from what the window knows', (
    tester,
  ) async {
    await mount(tester, roster: _templated());
    face.sync(
      const DaemonWatch(
        needIds: {'office/a1#r1'},
        needs: {'office/a1#r1': _need},
      ),
    );
    expect(face.voice, 'tim: bell in codex@office: run the migration?');
    await settle(tester);
    // Without the question, the clause that needs it goes.
    face.sync(
      const DaemonWatch(
        needIds: {'office/a2#r2'},
        needs: {
          'office/a2#r2': DaemonSubject('office/a2', who: 'codex@office'),
        },
      ),
    );
    expect(face.voice, 'tim: bell in codex@office');
    await settle(tester);
    // Nothing known at all: the neutral line, never `{who}`.
    face.sync(const DaemonWatch(needIds: {'office/a3#r3'}));
    expect(face.voice, 'tim: a harness needs you.');
    await settle(tester);
    // The panel's idle line: filled when it can be.
    face.sync(const DaemonWatch(idleCount: 3));
    expect(face.currentLine(DaemonMood.idle), '3 idle. nothing needs you.');
  });

  testWidgets('work frames step once per agent event, at most twice a '
      'second, and never on their own', (tester) async {
    await mount(tester);
    face.sync(const DaemonWatch(working: true, workingCount: 2));
    expect(face.glyph, '~(= =)~');
    await pass(tester, const Duration(seconds: 2));
    expect(face.glyph, '~(= =)~', reason: 'no events, no motion');
    face.pulse();
    expect(face.glyph, 'S(= =)~', reason: 'one event, one step');
    face.pulse();
    await pass(tester, const Duration(milliseconds: 100));
    expect(face.glyph, 'S(= =)~', reason: 'at most two steps a second');
    for (var i = 0; i < 10; i++) {
      face.pulse();
    }
    await pass(tester, const Duration(milliseconds: 400));
    expect(face.glyph, 'S(= =)S', reason: 'a burst is one step');
    await pass(tester, const Duration(seconds: 2));
    expect(face.glyph, 'S(= =)S', reason: 'a stalled agent: a still baton');
    expect(face.steps, 2);
    // A line portrait's parts step with it (tim's plate loops on its own).
    expect(face.portraitT, 2 * face.def!.workMs);
    // Reduce Motion, a background window and the Motion setting stop steps;
    // the face still changes.
    face.setEnvironment(foreground: true, reduceMotion: true);
    final still = face.glyph;
    face.pulse();
    await pass(tester, const Duration(seconds: 1));
    expect(face.glyph, still);
    expect(face.mood, DaemonMood.work, reason: 'the face still changes');
    face.setEnvironment(foreground: true, reduceMotion: false);
    settings.motion = false;
    face.pulse();
    await pass(tester, const Duration(seconds: 1));
    expect(face.steps, 0);
    settings.motion = true;
    face.pulse();
    expect(face.steps, 1);
    face.sync(const DaemonWatch());
    expect(face.glyph, '~(o o)~', reason: 'rest when work ends');
    expect(face.steps, 0);
    await pass(tester, const Duration(seconds: 3));
  });

  testWidgets('younger versions borrow the baton; the face never shifts', (
    tester,
  ) async {
    await mount(tester, version: '0.1');
    final idle = face.cell;
    face.sync(const DaemonWatch(working: true));
    expect(face.glyph, '(= =) |');
    face.pulse();
    expect(face.glyph, '(= =) /');
    expect(face.cell.indexOf('('), idle.indexOf('('));
    expect(face.cell.length, 10);
    face.sync(const DaemonWatch());
    expect(face.glyph, '(o o)');
  });

  testWidgets('a shiny daemon wears a * in the gutter', (tester) async {
    await mount(tester, shiny: true);
    expect(face.shiny, isTrue);
    expect(face.cell, startsWith('*'));
    expect(face.cell.length, 10);
    expect(face.cell.substring(1).trim(), '~(o o)~');
  });

  testWidgets('coming back after 15 minutes: the wave, then a slow blink, '
      'and no line', (tester) async {
    await mount(tester);
    face.setEnvironment(foreground: false, reduceMotion: false);
    await pass(tester, const Duration(minutes: 16));
    face.setEnvironment(foreground: true, reduceMotion: false);
    expect(face.mood, DaemonMood.back);
    expect(face.voice, isNull, reason: 'the brief carries the facts');
    await pass(tester, const Duration(milliseconds: 1300));
    expect(face.mood, DaemonMood.idle);
    await pass(tester, const Duration(milliseconds: 130));
    expect(face.lid, '_');
    await pass(tester, const Duration(milliseconds: 180));
    expect(face.lid, '-');
    await pass(tester, const Duration(milliseconds: 520));
    expect(face.lid, '_');
    await pass(tester, const Duration(milliseconds: 180));
    expect(face.lid, isNull);
    // A quick switch away is only a look.
    face.setEnvironment(foreground: false, reduceMotion: false);
    await pass(tester, const Duration(minutes: 1));
    face.setEnvironment(foreground: true, reduceMotion: false);
    expect(face.mood, DaemonMood.idle);
    await pass(tester, const Duration(milliseconds: 260));
    expect(face.lid, '-');
    await pass(tester, const Duration(milliseconds: 200));
  });

  testWidgets('looks blink at most once per 2.5 s and never while working', (
    tester,
  ) async {
    await mount(tester);
    face.look();
    expect(face.lid, '-');
    await pass(tester, const Duration(milliseconds: 200));
    face.look();
    expect(face.lid, isNull);
    await pass(tester, const Duration(milliseconds: 2500));
    face.sync(const DaemonWatch(working: true));
    face.look();
    expect(face.lid, isNull);
    expect(face.glyph, '~(= =)~');
    face.sync(const DaemonWatch());
    await pass(tester, const Duration(milliseconds: 200));
  });

  testWidgets('a line nobody asked for waits for Enter, a pane switch or '
      '8 s without a key, and for a dialog', (tester) async {
    await mount(tester);
    face.noteKey();
    face.sync(const DaemonWatch(needIds: {'m/a#1'}));
    await pass(tester, const Duration(seconds: 3));
    expect(face.voice, isNull, reason: 'mid-thought');
    face.noteKey(enter: true);
    expect(face.voice, isNotNull, reason: 'Enter ends the thought');
    await settle(tester);

    face.noteKey();
    face.sync(const DaemonWatch(needIds: {'m/a#2'}));
    await pass(tester, const Duration(seconds: 7));
    expect(face.voice, isNull);
    await pass(tester, const Duration(seconds: 1));
    expect(face.voice, isNotNull, reason: '8 s without a key');
    await settle(tester);

    face.noteKey();
    face.sync(const DaemonWatch(needIds: {'m/a#3'}, focus: 'm/b'));
    expect(face.voice, isNotNull, reason: 'a pane switch');
    await settle(tester);

    var dialog = true;
    face.dialogOpen = () => dialog;
    face.sync(const DaemonWatch(needIds: {'m/a#4'}));
    await pass(tester, const Duration(seconds: 2));
    expect(face.voice, isNull, reason: 'a dialog is open');
    dialog = false;
    await pass(tester, const Duration(milliseconds: 600));
    expect(face.voice, isNotNull);
    await settle(tester);
  });

  testWidgets('replies speak at once, dim', (tester) async {
    await mount(tester);
    face.noteKey();
    face.boop();
    expect(face.voice, "tim: hey. that's my status line. (ink)");
    expect(face.voiceAlert, isFalse, reason: 'a reply is not the alert yellow');
    await pass(tester, const Duration(milliseconds: 5200));
    expect(face.voice, isNull);
    await settle(tester);
  });

  testWidgets('at most one line nobody asked for every two minutes', (
    tester,
  ) async {
    await mount(tester);
    face.sync(const DaemonWatch(needIds: {'m/a#1'}));
    expect(face.voice, isNotNull);
    await pass(tester, const Duration(seconds: 30));
    face.sync(const DaemonWatch(needIds: {'m/a#1', 'm/b#2'}));
    expect(face.voice, isNull, reason: 'within two minutes of the last');
    expect(face.mood, DaemonMood.need, reason: 'the face still says so');
    await pass(tester, const Duration(minutes: 2));
    face.sync(const DaemonWatch(needIds: {'m/a#1', 'm/b#2', 'm/c#3'}));
    expect(face.voice, isNotNull);
    await settle(tester);
  });

  testWidgets('an answer given lets the next question through at once', (
    tester,
  ) async {
    await mount(tester);
    face.sync(const DaemonWatch(needIds: {'m/a#1'}));
    expect(face.voice, isNotNull);
    face.answered();
    expect(face.voice, isNull);
    face.sync(const DaemonWatch(needIds: {'m/a#1', 'm/b#2'}));
    expect(face.voice, isNotNull, reason: 'you are already with the daemon');
    face.dismissVoice();
    face.sync(const DaemonWatch(needIds: {'m/a#1', 'm/b#2', 'm/c#3'}));
    expect(face.voice, isNull, reason: 'Escape is not an answer');
    await settle(tester);
  });

  testWidgets('Quiet keeps every line in until it is turned off, and is '
      'kept', (tester) async {
    final store = _Memory();
    await mount(tester, settingsStore: store);
    settings.quiet = true;
    face.sync(const DaemonWatch(needIds: {'m/a#1'}));
    expect(face.voice, isNull);
    face.boop();
    expect(face.voice, isNull);
    expect(face.tooltip, contains('Quiet'));
    await pass(tester, const Duration(minutes: 20));
    expect(settings.quiet, isTrue, reason: 'unlike a nap, it lasts');
    // The panel's last tab is kept the same way; an unknown one is not.
    settings.tab = 'lessons';
    settings.tab = 'nonsense';
    await settings.flush();
    final again = DaemonSettings(storage: store);
    addTearDown(again.dispose);
    await again.load();
    expect(again.quiet, isTrue);
    expect(again.motion, isTrue);
    expect(again.tab, 'lessons');
    settings.quiet = false;
    face.sync(const DaemonWatch(needIds: {'m/a#1', 'm/b#2'}));
    expect(face.voice, isNotNull);
    await settle(tester);
  });

  testWidgets('a stale line expires instead of speaking late', (tester) async {
    await mount(tester);
    face.dialogOpen = () => true;
    face.sync(const DaemonWatch(needIds: {'m/a#1'}));
    await pass(tester, const Duration(seconds: 21));
    face.dialogOpen = () => false;
    await pass(tester, const Duration(seconds: 1));
    expect(face.voice, isNull);
    await settle(tester);
  });

  testWidgets('nap lasts 15 minutes or until a boop', (tester) async {
    await mount(tester);
    face.nap();
    expect(face.glyph, '~(- -)~z');
    await pass(tester, const Duration(minutes: 15));
    expect(face.napping, isFalse);
    face.nap();
    face.boop();
    expect(face.napping, isFalse);
    await pass(tester, const Duration(seconds: 6));
  });

  testWidgets('the reveal withholds the hatchling until it ends', (
    tester,
  ) async {
    await mount(
      tester,
      custom: Zoo(
        habits: ['turn', 'split', 'find', 'machine', 'store'],
        firstEgg: true,
        eggs: [ZooEgg(id: 'egg1', kind: 'first', grantedAt: '')],
      ),
    );
    expect(face.eggReady, isTrue);
    expect(face.glyph, r'\_(oo)_/');
    // Drop init is out from 2026-09-27 (UTC): only then can an egg hatch.
    clock.value = DateTime(2026, 9, 28, 12);
    face.beginReveal();
    final hatched = await zoo.hatch('egg1');
    expect(hatched, isNotNull);
    expect(zoo.paired?.id, hatched!.daemonId);
    expect(face.daemon, isNull);
    expect(face.glyph, r'\_(oo)_/');
    expect(face.label, 'Hatching');
    expect(face.tooltip.contains(hatched.daemonId), isFalse);
    face.endReveal();
    final def = daemonRoster.byId(hatched.daemonId)!;
    expect(face.label, def.id);
    expect(face.glyph, isNot(r'\_(oo)_/'));
    expect(face.voice, '${def.id}: ${def.first}');
    expect(face.voiceAlert, isFalse);
    await pass(tester, const Duration(seconds: 6));
  });

  testWidgets('the nest shows habits done', (tester) async {
    await mount(tester, custom: const Zoo(habits: ['split']));
    expect(face.glyph, r'\_(/\)_/');
    expect(face.label, 'Egg');
    expect(face.detail, '1 of 3 habits');
    expect(
      face.tooltip,
      contains('Finish a turn in a harness, and any 2 more.'),
    );
    zoo.habit('find');
    zoo.habit('store');
    expect(
      face.glyph,
      r"\_(*')_/",
      reason: 'without a finished turn, two count',
    );
    expect(face.detail, '2 of 3 habits');
    zoo.habit('turn');
    expect(face.glyph, r'\_(oo)_/');
    expect(face.eggReady, isTrue);
  });

  testWidgets('a new egg shows in the slot for a moment, then waits beside '
      'it as 1 egg until it is opened', (tester) async {
    // At 1.0 (150 xp), two days of turns (200 xp) stay below the next level.
    await mount(tester, version: '1.0');
    // A guest's 40th counted turn earns a turn egg; two days at the cap
    // (after drop 1's release, so it can hatch, and clear of 09-27's history
    // egg, open for a week).
    clock.value = DateTime(2026, 10, 5, 12);
    zoo.recordTurns(20, machineId: 'm');
    await tester.pump(const Duration(seconds: 6));
    clock.value = DateTime(2026, 10, 6, 12);
    zoo.recordTurns(20, machineId: 'm');
    expect(zoo.zoo.eggs.single.kind, 'turn');
    expect(face.glyph, r'\_(oo)_/');
    expect(face.voice, isNull, reason: 'an egg is not an interruption');
    expect(face.eggsWaiting, 1);
    expect(face.tooltip, contains(r'\_(oo)_/ x1 waiting'));
    await pass(tester, const Duration(seconds: 3));
    expect(face.glyph, ',(o o),', reason: 'the daemon comes back');
    expect(face.eggsWaiting, 1, reason: 'the egg still waits');
    await zoo.hatch(zoo.zoo.eggs.single.id);
    expect(face.eggsWaiting, 0, reason: 'opened');
    await pass(tester, const Duration(seconds: 6));
  });

  testWidgets(
    'illustrated idle and finite boop clocks stop in quiet and the background',
    (tester) async {
      await mount(tester, illustrations: true);
      final initial = face.artFrame;
      await pass(tester, const Duration(milliseconds: 210));
      expect(face.artFrame, isNot(initial));
      face.boop();
      await pass(tester, const Duration(milliseconds: 520));
      expect(face.artFrame, 3);
      face.setEnvironment(foreground: false, reduceMotion: false);
      await pass(tester, const Duration(hours: 8));
      expect(face.artFrame, 0);
      face.setEnvironment(foreground: true, reduceMotion: true);
      await pass(tester, const Duration(seconds: 2));
      expect(face.artFrame, 0);
      face.setEnvironment(foreground: false, reduceMotion: false);
    },
  );

  testWidgets('a level-up is a slow blink and no line', (tester) async {
    await mount(tester, version: '0.1');
    clock.value = DateTime(2026, 9, 21, 12);
    // 20 turns + the day's 5 = 25 xp; two days reach level 1 (50 xp).
    zoo.recordTurns(20, machineId: 'm');
    await pass(tester, const Duration(seconds: 6));
    clock.value = DateTime(2026, 9, 22, 12);
    zoo.recordTurns(20, machineId: 'm');
    expect(zoo.paired!.bond, 1);
    expect(face.voice, isNull);
    await pass(tester, const Duration(milliseconds: 210));
    expect(face.lid, '_', reason: 'a slow blink');
    await pass(tester, const Duration(seconds: 6));
    // Days later, level 2 releases 1.0 and the slot draws it.
    for (var d = 23; d <= 27; d++) {
      clock.value = DateTime(2026, 9, d, 12);
      zoo.recordTurns(20, machineId: 'm');
      await pass(tester, const Duration(seconds: 6));
    }
    expect(zoo.paired!.version, '1.0');
    expect(face.glyph, ',(o o),');
    await pass(tester, const Duration(seconds: 6));
  });

  testWidgets("with a brain, a roster alert waits 2.5 s for the brain's own", (
    tester,
  ) async {
    await mount(tester);
    face.brainActive = true;
    face.sync(const DaemonWatch(needIds: {'office/a1#r1'}));
    expect(face.mood, DaemonMood.need, reason: 'the face does not wait');
    expect(face.voice, isNull, reason: 'the line waits for the brain');
    await pass(tester, const Duration(seconds: 1));
    face.sayFromBrain(
      const DaemonSay(
        id: 's1',
        about: DaemonAbout('office', 'a1', requestId: 'r1'),
        line: '[g] bell in codex@office: run the migration?',
        mood: DaemonSayMood.need,
        actions: [(key: 'g', label: 'open', choice: 'open')],
        ttl: Duration(milliseconds: 5200),
      ),
    );
    expect(
      face.voice,
      '[g] bell in codex@office: run the migration?',
      reason: 'exactly as sent, keys first',
    );
    await settle(tester);
    // No brain line in time: the roster's line after 2.5 s.
    face.sync(const DaemonWatch(needIds: {'office/a2#r2'}));
    await pass(tester, const Duration(milliseconds: 2400));
    expect(face.voice, isNull);
    await pass(tester, const Duration(milliseconds: 200));
    expect(face.voice, startsWith('tim: '));
    // The brain's line about the same harness replaces it in place.
    face.sayFromBrain(
      const DaemonSay(
        id: 's2',
        about: DaemonAbout('office', 'a2'),
        line: 'codex@office asks which branch.',
        mood: DaemonSayMood.need,
      ),
    );
    expect(face.voice, 'codex@office asks which branch.');
    await settle(tester);
    // Its finished turns and returns do not take over.
    face.sayFromBrain(
      const DaemonSay(
        id: 's3',
        line: 'claude finished.',
        mood: DaemonSayMood.done,
      ),
    );
    face.sayFromBrain(
      const DaemonSay(
        id: 's4',
        line: 'reattached. 2 done.',
        mood: DaemonSayMood.back,
      ),
    );
    expect(face.voice, isNull);
    await settle(tester);
  });

  testWidgets('a brain line shows for its ttlMs, keys working only while it '
      'shows; the same id replaces it in place', (tester) async {
    await mount(tester);
    const say = DaemonSay(
      id: 'q1',
      about: DaemonAbout('office', 'a1', requestId: 'r1'),
      line: '[y/n/g] api@office Bash: npm test',
      mood: DaemonSayMood.need,
      actions: [
        (key: 'y', label: 'Yes', choice: '1. Yes'),
        (key: 'n', label: 'No', choice: '3. No'),
        (key: 'g', label: 'open', choice: 'open'),
      ],
      ttl: Duration(milliseconds: 5200),
    );
    face.sayFromBrain(say);
    expect(face.voice, '[y/n/g] api@office Bash: npm test');
    expect(face.voiceAlert, isTrue);
    expect(face.voiceActions.map((a) => a.key), ['y', 'n', 'g']);
    expect(face.voiceSayId, 'q1');
    await pass(tester, const Duration(seconds: 3));
    // The model's better words, with the time the brain says is left.
    face.sayFromBrain(
      const DaemonSay(
        id: 'q1',
        about: DaemonAbout('office', 'a1', requestId: 'r1'),
        line: '[y/n/g] api@office wants to run the tests.',
        mood: DaemonSayMood.need,
        actions: [(key: 'y', label: 'Yes', choice: '1. Yes')],
        ttl: Duration(milliseconds: 2200),
      ),
    );
    expect(face.voice, '[y/n/g] api@office wants to run the tests.');
    await pass(tester, const Duration(milliseconds: 2100));
    expect(face.voice, isNotNull);
    await pass(tester, const Duration(milliseconds: 200));
    expect(face.voice, isNull, reason: 'its ttl ran out: the keys with it');
    expect(face.voiceActions, isEmpty);
    await pass(tester, const Duration(minutes: 2));
    face.sayFromBrain(say);
    face.unsay('q1');
    expect(face.voice, isNull, reason: 'withdrawn');
    await pass(tester, const Duration(minutes: 2));
    // A line that waited (a key was just pressed) shows only what is left.
    face.noteKey();
    face.sayFromBrain(say);
    await pass(tester, const Duration(seconds: 6));
    expect(face.voice, isNull, reason: 'its keys died while it waited');
    face.sayNote('that question changed before the answer landed.');
    expect(
      face.voice,
      'tim: that question changed before the answer landed.',
      reason: 'a reply to what you did, not held back',
    );
    await settle(tester);
  });

  testWidgets('ask: yellow at once, even mid-thought; the face needs you '
      'while asks wait', (tester) async {
    await mount(tester);
    face.sync(const DaemonWatch(asks: 1));
    expect(face.mood, DaemonMood.need, reason: 'the pair asks you something');
    face.noteKey();
    face.sayFromBrain(
      const DaemonSay(
        id: 'ask:1',
        about: DaemonAbout('m', ''),
        line: '[y/n] start codex in ~/api?',
        mood: DaemonSayMood.ask,
        actions: [
          (key: 'y', label: 'do it', choice: 'y'),
          (key: 'n', label: 'skip', choice: 'n'),
        ],
        ttl: Duration(milliseconds: 5200),
      ),
    );
    expect(face.voice, '[y/n] start codex in ~/api?');
    expect(face.voiceAlert, isTrue);
    face.sync(const DaemonWatch());
    expect(face.mood, DaemonMood.idle);
    await settle(tester);
  });

  testWidgets('say is the pair answering you: dim, at once; auto is what it '
      'did: done, dim, and counted as a line nobody asked for', (tester) async {
    await mount(tester);
    face.sayFromBrain(
      const DaemonSay(
        id: 'say:1',
        about: DaemonAbout('m', ''),
        line: 'two harnesses wait; api since 40m.',
        mood: DaemonSayMood.say,
        ttl: Duration(seconds: 30),
      ),
    );
    expect(face.voice, 'two harnesses wait; api since 40m.');
    expect(face.voiceAlert, isFalse);
    expect(face.mood, DaemonMood.idle);
    await settle(tester);
    face.sayFromBrain(
      const DaemonSay(
        id: 'auto:1',
        about: DaemonAbout('office', 'a1'),
        line: 'rule: api@office answered "1. Yes"',
        mood: DaemonSayMood.auto,
        ttl: Duration(milliseconds: 5200),
      ),
    );
    expect(face.mood, DaemonMood.done, reason: 'drawn like done');
    expect(face.voice, 'rule: api@office answered "1. Yes"');
    expect(face.voiceAlert, isFalse);
    await pass(tester, const Duration(seconds: 6));
    // Within two minutes, another line nobody asked for waits its turn.
    face.sayFromBrain(
      const DaemonSay(
        id: 'auto:2',
        line: 'rule: web answered "1. Yes"',
        mood: DaemonSayMood.auto,
      ),
    );
    expect(face.voice, isNull);
    await settle(tester);
  });

  testWidgets(
    'activity details and waiting eggs keep the same ten-cell sprite',
    (tester) async {
      await mount(
        tester,
        custom: Zoo(
          daemons: [ZooDaemon(id: 'gnu', hatched: '', egg: 'first')],
          pair: 'gnu',
          firstEgg: true,
          eggs: const [
            ZooEgg(id: 'one', kind: 'turn', grantedAt: ''),
            ZooEgg(id: 'two', kind: 'week', grantedAt: ''),
          ],
        ),
      );
      face.sync(const DaemonWatch(doneCount: 1));
      final cell = face.cell;
      expect(cell.length, 10);
      expect(face.doneCount, 1);
      expect(face.eggsWaiting, 2);
      face.sync(const DaemonWatch(doneCount: 1234));
      expect(face.cell, cell);
      expect(face.tooltip, contains('1234'));
      expect(face.detail, contains('1234 finished'));
      face.seen();
      expect(
        face.eggsWaiting,
        2,
        reason: 'looking clears work, never unhatched eggs',
      );
      expect(face.doneCount, 0);
      expect(face.cell, cell);
      await settle(tester);
    },
  );

  testWidgets('the brain counts finished turns everywhere; a look clears it '
      'and tells the brain', (tester) async {
    await mount(tester);
    var told = 0;
    face.onSeen = () => told++;
    face.sync(
      const DaemonWatch(
        doneCount: 3,
        doneLast: ['api@office finished: tests pass.'],
      ),
    );
    expect(face.doneCount, 3);
    expect(face.tooltip, contains('api@office finished: tests pass.'));
    face.seen();
    expect(face.doneCount, 0);
    expect(told, 1);
    face.seen();
    expect(told, 1, reason: 'nothing left to clear');
    // Back at the window: seen once it has been in front a moment.
    face.sync(const DaemonWatch(doneCount: 2));
    face.setEnvironment(foreground: false, reduceMotion: false);
    await pass(tester, const Duration(minutes: 1));
    face.setEnvironment(foreground: true, reduceMotion: false);
    expect(face.doneCount, 2);
    await pass(tester, const Duration(seconds: 3));
    expect(face.doneCount, 2);
    await pass(tester, const Duration(seconds: 2));
    expect(face.doneCount, 0);
    expect(told, 2);
    await settle(tester);
  });
}
