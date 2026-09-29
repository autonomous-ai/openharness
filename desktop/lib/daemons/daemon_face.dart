/// The paired daemon's face in the status line: its mood, its blinks, the
/// frames it steps through while agents work and the one line it says.
///
/// The rules are the README's (`daemons/README.md`, Moods, Motion and blinks,
/// Voice). Work supplies reactions; experimental Tim also has an idle rhythm.
///
/// - **Motion** is driven by work, not by time: while agents work, the work
///   frame steps once per real agent event ([pulse]), at most twice a second,
///   so a baton that stops means an agent that stopped. The only timers end a
///   held reaction, run a blink or the return wave, end a nap and clear a line.
///   Reduce Motion, a background window and the Motion setting stop them all;
///   the face still changes.
/// - **Interruptions**: only a harness waiting on you and a failure take over
///   the status line, in the message yellow, at most one line nobody asked for
///   every two minutes, never about the pane in front of you, and only after
///   Enter, a pane switch or 8 s without a key. Finished turns become `3 done`
///   beside the daemon, cleared when you look. Replies (a boop, its first
///   words, why an answer failed, the pair answering you) are dim. Quiet
///   silences everything.
/// - **The pair brain's lines** (`daemon_say`) are shown exactly as sent,
///   keys first (`[y/n/g] api@office Bash: npm test`), for their `ttlMs`:
///   their keys work only while the line shows, and only once the window has
///   drawn it and its `detail` (the daemon's `daemon_shown` rule). A line the
///   pair harness wrote (`from: 'pair'`) is drawn as it speaking.
library;

import 'dart:async';

import 'package:flutter/foundation.dart';

import 'daemon_brain.dart';
import 'companion_life.dart';
import 'daemon_lines.dart';
import 'daemon_plate_client.dart';
import 'daemon_settings.dart';
import 'individuals.dart';
import 'render.dart';
import 'roster.dart';
import 'zoo.dart';
import 'zoo_controller.dart';

/// A harness a line may be about: `machineId/agentId`, with what the window
/// knows of it to fill a line's slots.
@immutable
class DaemonSubject {
  const DaemonSubject(this.key, {this.who, this.q, this.recap, this.since});

  /// `machineId/agentId`.
  final String key;

  /// `engine@machine`.
  final String? who;

  /// Its question, its turn's recap, and since when it has waited.
  final String? q, recap;
  final DateTime? since;
}

/// A turn that ended in a harness this window can see, newest last.
@immutable
class DaemonTurnEnd {
  const DaemonTurnEnd(this.subject, {this.failed = false});
  final DaemonSubject subject;
  final bool failed;
}

/// What the workspace is doing, as the daemon watches it.
@immutable
class DaemonWatch {
  const DaemonWatch({
    this.working = false,
    this.connected = true,
    this.workingCount = 0,
    this.needIds = const {},
    this.needs = const {},
    this.failing = false,
    this.failed = const [],
    this.turns = const {},
    this.fails = const {},
    this.ended = const {},
    this.idleCount = 0,
    this.focus,
    this.away = const [],
    this.asks = 0,
    this.doneCount,
    this.doneLast = const [],
    this.autonomy,
    this.autonomyRequested,
  });

  /// Any agent is working, and how many.
  final bool working, connected;
  final int workingCount;

  /// Harnesses waiting on you, by a stable id per question
  /// (`machineId/agentId#requestId`), and what is known of each.
  final Set<String> needIds;
  final Map<String, DaemonSubject> needs;

  /// A harness you have open failed to start or its last turn failed. A
  /// machine that is asleep or unreachable is not a failure ([away]).
  final bool failing;
  final List<DaemonSubject> failed;

  /// Finished and failed turns you started, counted per machine, and the
  /// last few that ended per machine (who they were).
  final Map<String, int> turns, fails;
  final Map<String, List<DaemonTurnEnd>> ended;

  /// Open harnesses with nothing to do.
  final int idleCount;

  /// The pane in front of you, `machineId/agentId`: never spoken about.
  final String? focus;

  /// Machines that are asleep, out of reach or otherwise not there: shown
  /// calmly, never as a failure (`offline` when only the window can tell).
  final List<DaemonMachine> away;

  /// Proposals from the pair waiting for your key (`daemon_state.asks`): it
  /// asks you something, so the face is `need`.
  final int asks;

  /// The brain's count of turns finished since you looked
  /// (`daemon_state.done.count`, every machine), when there is a brain; the
  /// window counts its own otherwise. And the last few, as lines.
  final int? doneCount;
  final List<String> doneLast;

  /// The level the daemon acts at (`daemon_state.autonomy`), and a higher one
  /// waiting for the person's yes. Null without a brain that says.
  final String? autonomy, autonomyRequested;
}

enum _LineKind {
  /// Something needs you or failed: the message line, in yellow. Nobody
  /// asked for it: at most one every two minutes, never mid-thought.
  alert,

  /// The pair asks for your key on something you asked it to do: yellow,
  /// and at once (its keys work only while it shows).
  ask,

  /// Something a rule or the pair did on its own (`auto`): dim, and like an
  /// alert nobody asked for it.
  report,

  /// You asked (a boop, a hatch, an answer, a talk): dim, in the status
  /// line's ink, at once.
  reply;

  bool get yellow => this == alert || this == ask;
  bool get unsolicited => this == alert || this == report;
}

class DaemonFace extends ChangeNotifier {
  DaemonFace(
    this.zoo, {
    DaemonRoster? roster,
    DateTime Function()? now,
    DaemonSettings? settings,
  }) : roster = roster ?? zoo.roster,
       settings = settings ?? DaemonSettings(),
       _ownsSettings = settings == null,
       _now = now ?? DateTime.now {
    zoo.addListener(_zooChanged);
    this.settings.addListener(_settingsChanged);
    _events = zoo.events.listen(_zooEvent);
  }

  final ZooController zoo;
  final DaemonSettings settings;

  /// Individuals' own plates from this computer's harness process, when the
  /// window has a way to ask (the panel's portraits and cards).
  DaemonPlateClient? plates;
  final bool _ownsSettings;
  late final StreamSubscription<ZooEvent> _events;

  /// How long a new egg shows in the slot before the daemon comes back.
  static const eggShowFor = Duration(seconds: 3);
  final DaemonRoster roster;
  final DateTime Function() _now;

  late final life = CompanionLife(now: _now);
  bool _living = false;
  String? _lifeScope;
  Timer? _lifeTimer;
  String? _lifeKey;
  int _lifeEvent = 0;

  /// The richer experimental performance is authored for Tim first.
  bool get livingTim => _living && daemon?.id == 'tim';

  void setLiving(bool enabled) {
    if (_living == enabled) return;
    _living = enabled;
    if (!enabled) life.reset();
    _syncLifeTimer();
    _update(force: true);
  }

  CompanionFeeling get feeling {
    life.observe(
      working: _working ? _workingCount.clamp(1, 1024) : 0,
      needs: _needIds.length + _asks,
      failures: _failing ? 1 : 0,
      asleep: napping,
      connected: _connected,
    );
    return life.feeling;
  }

  void react(CompanionEvent event, String id) {
    if (_disposed || !_living || !visible) return;
    life.record(event, id);
    _update(force: true);
  }

  void _syncLifeTimer() {
    if (!_living || !visible) {
      _lifeTimer?.cancel();
      _lifeTimer = null;
      _lifeKey = null;
      return;
    }
    _lifeTimer ??= Timer.periodic(const Duration(seconds: 1), (_) {
      if (_disposed) return;
      final value = feeling;
      final key = '${value.emotion}/${value.reason}/${value.reactionId}';
      if (key == _lifeKey) return;
      _lifeKey = key;
      _update(force: true);
    });
  }

  /// Complete presentation, independent of native titlebar visibility. The
  /// publisher adds window epoch/revision; this carries no conversation text.
  Map<String, dynamic> get companionPresentation {
    final individual = zoo.paired;
    final egg = nearestEgg;
    final supported = individual == null || individual.id == 'tim';
    if (!_living || !visible || !supported) return {'enabled': false};
    return {
      'enabled': true,
      'phase': _revealing
          ? 'hatching'
          : individual != null
          ? 'creature'
          : 'egg',
      'motion': !_reduceMotion && settings.motion && !settings.quiet,
      'feeling': feeling.toJson(),
      if (individual != null)
        'creature': {
          'uid': individual.uid,
          'id': individual.id,
          'seed': individual.seed,
          'name': _companionName(individual.name),
          'version': individual.version,
          'shiny': individual.shiny,
        },
      if (_revealing || individual == null)
        'egg': {
          'kind': _revealing ? _revealKind : egg?.kind ?? 'first',
          'stage': _revealing ? _revealStage ?? 'p4' : egg?.stage ?? 'p0',
          if (!_revealing && egg?.egg != null) 'uid': egg!.egg!.id,
        },
    };
  }

  static String _companionName(String? name) {
    final ascii = (name ?? 'Tim')
        .replaceAll(RegExp(r'[^\x20-\x7e]'), '')
        .trim();
    return ascii.isEmpty
        ? 'Tim'
        : ascii.substring(0, ascii.length.clamp(0, 24));
  }

  static const doneCooldown = Duration(seconds: 20);
  static const backAfter = Duration(minutes: 15);
  static const napLength = Duration(minutes: 15);
  static const lookEvery = Duration(milliseconds: 2500);
  static const voiceFor = Duration(milliseconds: 5200);

  /// A line nobody asked for waits until 8 s after the last key (or Enter,
  /// or a pane switch), and is dropped if it still waits after 20 s.
  static const typingQuiet = Duration(seconds: 8);
  static const voiceExpires = Duration(seconds: 20);

  /// At most one line nobody asked for this often.
  static const unsolicitedEvery = Duration(minutes: 2);

  /// Work frames step at most this often.
  static const stepEvery = Duration(milliseconds: 500);

  /// How long a roster line waits for the brain's own line about the same
  /// moment (`daemons/BRAIN.md`: prefer a `daemon_say` within 2.5 s).
  static const brainWait = Duration(milliseconds: 2500);

  /// A line with answers stays up this long unless its `ttlMs` says otherwise
  /// or it is answered, withdrawn or dismissed.
  static const askFor = Duration(seconds: 30);

  bool _disposed = false;
  bool _foreground = true, _reduceMotion = false;
  bool _revealing = false;

  // What it watches.
  bool _working = false, _failing = false, _connected = true;
  int _workingCount = 0, _idleCount = 0;
  Set<String> _needIds = const {};
  Map<String, DaemonSubject> _needs = const {};
  List<DaemonSubject> _failed = const [];
  List<DaemonMachine> _away = const [];
  int _asks = 0;
  String? _autonomy, _autonomyRequested;
  int? _brainDone;
  List<String> _doneLast = const [];
  String? _focus;
  final _heardNeeds = <String>{};
  final _turns = <String, int>{}, _fails = <String, int>{};
  bool _baselined = false;

  // Activity details: finished turns since you looked, and while you were away.
  int _doneCount = 0, _doneWhileAway = 0;
  Timer? _seenTimer;

  /// You looked at the finished-turn count: the brain hears `doneSeen`.
  VoidCallback? onSeen;

  /// Coming back to the window is a look at the finished-turn count, once it
  /// has been in front this long.
  static const seenAfterFocus = Duration(seconds: 4);

  // Held faces.
  DaemonMood? _held;
  Timer? _holdTimer;
  bool _booped = false;
  Timer? _boopTimer;
  DateTime? _napUntil;
  Timer? _napTimer;
  DateTime? _awayAt, _lastDone, _lastLook;

  // Blinks, work steps and the wave.
  String? _lid;
  Timer? _blinkTimer;
  int _step = 0;
  DateTime? _lastStep;
  Timer? _stepTimer;
  int _backT = 0;
  Timer? _backTimer;

  // Voice.
  final _voice = ValueNotifier<String?>(null);
  Timer? _voiceTimer;
  _Line? _pendingVoice;
  _Line? _spoken;
  DateTime? _lastUnsolicited;

  /// Whether this harnessd's pair brain is talking (it sent `daemon_state`).
  bool brainActive = false;
  Timer? _pendingTimer;
  DateTime? _lastKey;

  /// A dialog, picker or the reveal is open: lines wait.
  bool Function() dialogOpen = _never;
  static bool _never() => false;

  String? _pairKey;
  ZooEgg? _arriving;
  Timer? _arrivingTimer;

  // ── what it shows ──────────────────────────────────────────────────────────

  bool get visible => zoo.loaded;
  bool get motionEnabled => _foreground && !_reduceMotion && settings.motion;
  bool get revealing => _revealing;
  bool get napping => _napUntil != null;
  bool get quiet => settings.quiet;

  /// The paired individual, withheld while its hatch reveal is still
  /// running.
  ZooDaemon? get daemon => _revealing ? null : zoo.paired;

  /// Its species: its lines, its first words, its colour.
  DaemonDef? get def => roster.byId(daemon?.id);

  /// Its traits (README, "Individuals"), from its seed.
  DaemonTraits? get traits => zoo.traitsOf(daemon);

  /// The species as this individual shows it in the status line: a rare
  /// extra's sprites, a fidgety one's pace (render.mjs `individualDaemon`).
  DaemonDef? get spriteDef {
    final d = daemon;
    return d == null ? null : individualDaemon(roster, d.id, traits);
  }

  /// `pip`, the name it was given at the hatch, else its species.
  String get name => daemon?.name ?? def?.id ?? '';
  int get versionIndex => roster.versionIndex(daemon?.version);
  bool get shiny => daemon?.shiny == true;

  bool get eggReady => daemon == null && zoo.readyEgg != null;

  /// Work frames step at most this often: half as long for a fidgety
  /// individual, whose work frames turn at half `workMs`.
  Duration get stepInterval {
    final d = def, s = spriteDef;
    if (d == null || s == null || s.workMs >= d.workMs || d.workMs <= 0) {
      return stepEvery;
    }
    return stepEvery * (s.workMs / d.workMs);
  }

  DaemonMood get mood {
    if (_booped) return DaemonMood.boop;
    // A harness waiting on you, or the pair asking for your key.
    if (_needIds.isNotEmpty || _asks > 0) return DaemonMood.need;
    if (napping) return DaemonMood.nap;
    if (livingTim) {
      return switch (feeling.emotion) {
        CompanionEmotion.working ||
        CompanionEmotion.focused ||
        CompanionEmotion.tired ||
        CompanionEmotion.exhausted => DaemonMood.work,
        CompanionEmotion.happy ||
        CompanionEmotion.excited ||
        CompanionEmotion.proud ||
        CompanionEmotion.relieved ||
        CompanionEmotion.hatching => DaemonMood.done,
        CompanionEmotion.frustrated ||
        CompanionEmotion.angry ||
        CompanionEmotion.sad => DaemonMood.fail,
        CompanionEmotion.attentive ||
        CompanionEmotion.listening => DaemonMood.need,
        CompanionEmotion.asleep => DaemonMood.nap,
        CompanionEmotion.affectionate => DaemonMood.boop,
        CompanionEmotion.playful => DaemonMood.back,
        _ => DaemonMood.idle,
      };
    }
    if (_held case final held?) return held;
    if (_working) return DaemonMood.work;
    if (_failing) return DaemonMood.fail;
    return DaemonMood.idle;
  }

  /// The blink lid for this instant, or null.
  String? get lid => _lid;

  /// Milliseconds into the sprite's current motion: whole steps of its work
  /// frames (or the borrowed baton's), or of the return wave.
  int get t {
    final d = spriteDef;
    if (d == null) return 0;
    if (mood == DaemonMood.back) return _backT;
    if (mood != DaemonMood.work) return 0;
    final last = versionIndex == roster.rules.versions.length - 1;
    return _step * (last ? d.workMs : 130);
  }

  /// The same steps for the portrait's moving parts, one frame each.
  int get portraitT {
    final d = def;
    if (d == null || mood != DaemonMood.work) return 0;
    final ms = d.parts.values.firstOrNull?.ms ?? d.workMs;
    return _step * ms;
  }

  /// How many work steps have been taken since agents started working.
  int get steps => _step;

  /// An egg waiting in the nest as one line: ready (`p4`), blinking when a
  /// daemon would (`rules.eggLine`).
  String eggLineFor(ZooEgg egg, {String? lid}) =>
      eggLine(roster, egg.kind, 'p4', lid: lid);

  /// The egg the slot shows before the first hatch: the one nearest to
  /// hatching (a waiting one, else the one being earned furthest along).
  ZooEggProgress? get nearestEgg => zoo.nearestEgg;

  /// Where the hatch reveal is, as the slot shows it: `rock`, `burst`,
  /// `tumble`, `open`, then `hatchling` (its 0.1 sprite between the halves).
  String? _revealStage;
  String _revealKind = 'first';
  String _revealSprite = '';

  /// The reveal moved on: the slot follows it (`rules.eggLine`).
  void revealAt(String stage, {String? kind, String? sprite}) {
    if (_disposed || !_revealing) return;
    _revealStage = stage;
    if (kind != null) _revealKind = kind;
    if (sprite != null) _revealSprite = sprite;
    _update(force: true);
  }

  /// Eggs waiting to be hatched.
  int get eggsWaiting => zoo.zoo.eggs.length;

  /// Finished turns since you last looked: the brain's count, across every
  /// machine, when there is one; the window's own otherwise.
  int get doneCount => _brainDone ?? _doneCount;

  /// The last few that finished, as lines (`api@office finished: ...`).
  List<String> get doneLast => _doneLast;

  /// Machines asleep, out of reach or otherwise not there.
  List<DaemonMachine> get away => _away;

  /// The slot shows the daemon itself (not a new egg's moment in the nest).
  bool get showsDaemon => def != null && !_showsArrival;

  bool get _showsArrival =>
      _arriving != null && mood != DaemonMood.need && mood != DaemonMood.boop;

  /// The sprite or egg for the status slot (at most eight cells): the
  /// paired individual's one line (render.mjs `renderIndividualSprite`), or
  /// the egg nearest to hatching at its stage (`eggLine`), or, while a hatch
  /// reveal runs, the egg as it opens.
  String get glyph {
    if (!visible) return '';
    final d = spriteDef;
    if (d == null) {
      if (_revealing) {
        return eggLine(
          roster,
          _revealKind,
          _revealStage ?? 'p4',
          lid: _lid,
          sprite: _revealSprite,
        );
      }
      final egg = nearestEgg;
      if (egg == null) return '';
      return eggLine(roster, egg.kind, egg.stage, lid: _lid);
    }
    // A new egg sits in the nest for a moment, unless something needs you.
    if (_showsArrival) return eggLineFor(_arriving!, lid: _lid);
    return renderSprite(
      roster,
      d,
      versionIndex,
      mood,
      t: t,
      lid: _lid,
      motion: motionEnabled,
    );
  }

  /// The slot's ten cells, exactly: the glyph centred on the version's base
  /// sprite (so a baton or a nap's `z` never moves the face), a gutter each
  /// side (a borrowed baton may run into the right one), and a shiny daemon's
  /// `*` in the left gutter.
  String get cell {
    final g = glyph;
    if (g.isEmpty) return '';
    final d = spriteDef;
    final daemonShown = d != null && !_showsArrival;
    final c = statusCell(
      roster,
      g,
      daemonShown ? baseWidth(roster, d, versionIndex) : null,
    );
    return daemonShown && shiny ? '*${c.substring(1)}' : c;
  }

  /// `tim: bell in codex@office: run the migration?` while it speaks; a line
  /// from the pair brain exactly as sent (`[y/n/g] api@office: npm test`).
  String? get voice => _voice.value;

  /// Only the spoken line, for what swaps the status line's context: it does
  /// not change on every work frame.
  ValueListenable<String?> get voiceLine => _voice;

  /// Whether the line being spoken is an alert (needs you, failed): the
  /// message yellow. Otherwise it is a reply, in the status line's own ink.
  bool get voiceAlert => _spoken?.kind.yellow ?? false;

  /// The brain's answers offered with the line being spoken: `[y] [n]`.
  List<DaemonAction> get voiceActions => _spoken?.actions ?? const [];

  /// The brain's id for the line being spoken, to answer it.
  String? get voiceSayId => _spoken?.sayId;

  /// The harness the line being spoken is about (its `[g]` opens it).
  DaemonAbout? get voiceTarget => _spoken?.target;

  /// What a key on the line being spoken would do, in full: shown under it
  /// before its keys arm.
  String? get voiceDetail => _spoken?.detail;

  /// The harness the line being spoken names, by name and machine.
  DaemonHarness? get voiceHarness => _spoken?.harness;

  /// The pair harness wrote the line being spoken (drawn as it speaking).
  bool get voiceFromPair => _spoken?.fromPair ?? false;

  /// The line being spoken waits for a yes to a setting: its keys are
  /// `daemon_confirm`.
  ({String kind, String nonce})? get voiceConfirm => _spoken?.confirm;

  /// The level the daemon acts at, as harnessd says; null without a brain.
  String? get autonomy => _autonomy;

  /// A higher level the zoo asks for, waiting for the person's yes.
  String? get autonomyRequested => _autonomyRequested;

  static const moodWords = {
    DaemonMood.idle: 'content',
    DaemonMood.work: 'agents working',
    DaemonMood.need: 'a harness needs you',
    DaemonMood.done: 'a turn finished',
    DaemonMood.fail: 'something failed',
    DaemonMood.back: 'welcome back',
    DaemonMood.nap: 'napping',
    DaemonMood.boop: 'booped',
  };

  String get label {
    if (_revealing) return 'Hatching';
    if (def != null) return name;
    return eggReady ? 'Egg, ready to hatch' : 'Egg';
  }

  String get detail {
    if (_revealing) return 'Hatching';
    final d = def;
    if (d != null) {
      final eggs = eggsWaiting;
      final done = doneCount;
      return '${d.id} ${daemon!.version}, ${moodWords[mood]}'
          '${done == 0 ? '' : ', $done finished since you looked'}'
          '${eggs == 0 ? '' : ', $eggs ${eggs == 1 ? 'egg' : 'eggs'} waiting'}';
    }
    if (eggReady) {
      return eggsWaiting > 1
          ? 'Ready to hatch, $eggsWaiting eggs'
          : 'Ready to hatch';
    }
    return '${zoo.habitsCounted} of ${zoo.habitsNeeded} habits';
  }

  String get tooltip {
    if (_revealing) return 'Hatching...';
    final d = def;
    if (d != null) {
      final eggs = zoo.zoo.eggs;
      final done = doneCount;
      return [
        '$name · ${moodWords[mood]}',
        '${d.id} ${daemon!.version}',
        if (done > 0)
          '+$done: ${done == 1 ? 'a turn' : 'turns'} finished '
              'since you looked',
        if (done > 0)
          for (final line in _doneLast.take(3)) '  $line',
        if (eggs.isNotEmpty)
          '${eggLineFor(eggs.first)} x${eggs.length} waiting. Click to open.',
        for (final machine in _away)
          daemonMachineLine(machine.name, machine.status),
        // Above `suggest` it acts on its own for you: always said.
        if (daemonAutonomyAboveSuggest(_autonomy))
          'autonomy: ${daemonAutonomyLabel(_autonomy!)}',
        if (_autonomyRequested case final asked? when asked != _autonomy)
          'asks for ${daemonAutonomyLabel(asked)}: waiting for your yes',
        if (quiet) 'Quiet: it says nothing until you turn Quiet off.',
      ].join('\n');
    }
    if (eggReady) {
      final egg = zoo.readyEgg!;
      return eggsWaiting > 1
          ? '${eggLineFor(egg)} x$eggsWaiting. Your egg is ready. '
                'Click to hatch it.'
          : 'Your egg is ready. Click to hatch it.';
    }
    final egg = nearestEgg;
    if (egg != null && egg.kind != 'first') {
      return 'A ${eggName(egg.kind)} is on its way: ${egg.done} of '
          '${egg.need}.\nClick to see your eggs.';
    }
    return 'A daemon is incubating: ${zoo.habitsCounted} of '
        '${zoo.habitsNeeded} habits.\n${_capital(zoo.firstEggRule)}.\n'
        'Click to see them.';
  }

  static String _capital(String s) =>
      s.isEmpty ? s : '${s[0].toUpperCase()}${s.substring(1)}';

  // ── lines ──────────────────────────────────────────────────────────────────

  /// What the window knows right now for a line's slots.
  Map<String, String?> slotsFor(DaemonMood mood, [DaemonSubject? subject]) {
    final about =
        subject ??
        switch (mood) {
          DaemonMood.need => _needs.values.firstOrNull,
          DaemonMood.fail => _failed.firstOrNull,
          _ => null,
        };
    return {
      'who': slotValue(about?.who, limit: 32),
      'q': slotValue(about?.q, limit: 48),
      'recap': slotValue(about?.recap, limit: 60),
      'n': switch (mood) {
        DaemonMood.work => _workingCount > 0 ? '$_workingCount' : null,
        DaemonMood.need => _needIds.isEmpty ? null : '${_needIds.length}',
        DaemonMood.idle => '$_idleCount',
        DaemonMood.fail =>
          _failed.isNotEmpty
              ? '${_failed.length}'
              : subject != null
              ? '1'
              : null,
        DaemonMood.done => doneCount > 0 ? '$doneCount' : null,
        _ => null,
      },
      'summary': mood == DaemonMood.back ? _summary() : null,
    };
  }

  /// The brief's facts, as far as this window knows them:
  /// `2 done, 1 waiting 40m`. Null when there are none.
  String? _summary() {
    final waiting = _needIds.length;
    DateTime? oldest;
    for (final need in _needs.values) {
      final since = need.since;
      if (since != null && (oldest == null || since.isBefore(oldest))) {
        oldest = since;
      }
    }
    final parts = [
      if (_doneWhileAway > 0) '$_doneWhileAway done',
      if (waiting > 0)
        '$waiting waiting'
            '${oldest == null ? '' : ' ${_age(_now().difference(oldest))}'}',
    ];
    return parts.isEmpty ? null : parts.join(', ');
  }

  static String _age(Duration d) => d.inHours >= 1
      ? '${d.inHours}h'
      : d.inMinutes >= 1
      ? '${d.inMinutes}m'
      : '${d.inSeconds}s';

  /// The line for [mood] now, for the panel: filled from what is known, the
  /// roster's example while nothing is going on, never a made-up fact.
  String currentLine(DaemonMood mood) {
    final d = def;
    if (d == null) return '';
    final values = slotsFor(mood);
    return mood == DaemonMood.idle
        ? daemonPreviewLine(d, mood, values)
        : daemonLine(d, mood, values);
  }

  // ── inputs ─────────────────────────────────────────────────────────────────

  void setEnvironment({required bool foreground, required bool reduceMotion}) {
    if (_disposed) return;
    final was = _foreground;
    final changed = _foreground != foreground || _reduceMotion != reduceMotion;
    _foreground = foreground;
    _reduceMotion = reduceMotion;
    if (!changed) return;
    if (!foreground) {
      if (_awayAt == null) {
        _awayAt = _now();
        _doneWhileAway = 0;
      }
      _seenTimer?.cancel();
      _seenTimer = null;
      _stopBlink();
    } else if (!was) {
      final away = _awayAt;
      _awayAt = null;
      if (away != null && _now().difference(away) >= backAfter) {
        _back();
      } else {
        look(force: true);
      }
      // Back at the window: finished turns are seen after a moment in front.
      _seenTimer?.cancel();
      _seenTimer = doneCount == 0
          ? null
          : Timer(seenAfterFocus, () {
              _seenTimer = null;
              if (_foreground) seen();
            });
    }
    if (!motionEnabled) _stopBlink();
    _update(force: true);
  }

  void sync(DaemonWatch watch) {
    if (_disposed) return;
    final before = mood;
    final newNeeds = watch.needIds.difference(_heardNeeds);
    final finished = _newEnds(_turns, watch.turns, watch.ended, failed: false);
    final failed = _newEnds(_fails, watch.fails, watch.ended, failed: true);
    _working = watch.working;
    _connected = watch.connected;
    _workingCount = watch.workingCount;
    _failing = watch.failing;
    _failed = watch.failed;
    _needIds = watch.needIds;
    _needs = watch.needs;
    _idleCount = watch.idleCount;
    final awayChanged =
        watch.away.length != _away.length ||
        [
          for (var i = 0; i < _away.length; i++)
            watch.away[i].name != _away[i].name ||
                watch.away[i].status != _away[i].status,
        ].any((changed) => changed);
    _away = watch.away;
    final countsChanged =
        watch.asks != _asks ||
        watch.doneCount != _brainDone ||
        !listEquals(watch.doneLast, _doneLast);
    final dialChanged =
        watch.autonomy != _autonomy ||
        watch.autonomyRequested != _autonomyRequested;
    _autonomy = watch.autonomy;
    _autonomyRequested = watch.autonomyRequested;
    _asks = watch.asks;
    _brainDone = watch.doneCount;
    _doneLast = watch.doneLast;
    final focusChanged = watch.focus != _focus;
    _focus = watch.focus;
    _heardNeeds.addAll(watch.needIds);
    if (_heardNeeds.length > 512) _heardNeeds.retainAll(watch.needIds);
    if (focusChanged) {
      // A pane switch is a pause in thought: a waiting line may speak now.
      // A line about the pane you just switched to has done its job.
      if (_spoken?.about != null && _spoken!.about == _focus) _silence();
      _lastKey = null;
      if (_pendingVoice != null) _trySpeak();
    }
    // Restored state, imported history and reconnects are baselines.
    if (!_baselined || def == null) {
      _baselined = def != null;
      _update(
        before: before,
        force: awayChanged || countsChanged || dialChanged,
      );
      return;
    }
    final d = def!;
    if (newNeeds.isNotEmpty) {
      _napUntil = null;
      _napTimer?.cancel();
      _blink('ack', delay: const Duration(milliseconds: 160));
      // About a harness you are not looking at, if there is one.
      final id = newNeeds.firstWhere(
        (id) => _aboutOf(id) != _focus,
        orElse: () => newNeeds.first,
      );
      final subject = _needs[id];
      _say(
        daemonLine(d, DaemonMood.need, slotsFor(DaemonMood.need, subject)),
        mood: DaemonMood.need,
        kind: _LineKind.alert,
        about: subject?.key ?? _aboutOf(id),
      );
    }
    if (failed.isNotEmpty) {
      _hold(DaemonMood.fail);
      _blink('ack', delay: const Duration(milliseconds: 160));
      final subject = failed.whereType<DaemonSubject>().lastOrNull;
      if (newNeeds.isEmpty) {
        _say(
          daemonLine(d, DaemonMood.fail, slotsFor(DaemonMood.fail, subject)),
          mood: DaemonMood.fail,
          kind: _LineKind.alert,
          about: subject?.key,
        );
      }
    } else if (finished.isNotEmpty) {
      _blink('ack', delay: const Duration(milliseconds: 160));
      // Finished turns are a count beside the slot, never a line; the pane
      // in front of you is already seen.
      final unseen = finished.where((s) => s == null || s.key != _focus);
      _doneCount += unseen.length;
      if (!_foreground) _doneWhileAway += unseen.length;
      final now = _now();
      if (_lastDone == null || now.difference(_lastDone!) >= doneCooldown) {
        _lastDone = now;
        _hold(DaemonMood.done);
      }
    }
    _update(
      before: before,
      force: finished.isNotEmpty || awayChanged || countsChanged || dialChanged,
    );
  }

  static String _aboutOf(String needId) {
    final hash = needId.indexOf('#');
    return hash < 0 ? needId : needId.substring(0, hash);
  }

  /// The turns that ended since the last count, one entry each: who they
  /// were when the window knows (newest last), null when it does not.
  static List<DaemonSubject?> _newEnds(
    Map<String, int> seen,
    Map<String, int> now,
    Map<String, List<DaemonTurnEnd>> ended, {
    required bool failed,
  }) {
    final out = <DaemonSubject?>[];
    for (final entry in now.entries) {
      final previous = seen[entry.key];
      seen[entry.key] = entry.value;
      if (previous == null || entry.value <= previous) continue;
      final count = entry.value - previous;
      final known = [
        for (final end in ended[entry.key] ?? const <DaemonTurnEnd>[])
          if (end.failed == failed) end.subject,
      ];
      final recent = known.length > count
          ? known.sublist(known.length - count)
          : known;
      out
        ..addAll(List<DaemonSubject?>.filled(count - recent.length, null))
        ..addAll(recent);
    }
    return out;
  }

  /// A real agent event (a tool starting, output arriving, a turn starting
  /// or ending): the work frame steps once, at most twice a second (four
  /// times for a fidgety individual).
  void pulse() {
    if (_disposed ||
        def == null ||
        !motionEnabled ||
        mood != DaemonMood.work ||
        _stepTimer != null) {
      return;
    }
    final since = _lastStep == null ? null : _now().difference(_lastStep!);
    final every = stepInterval;
    if (since == null || since >= every) {
      _advance();
      return;
    }
    _stepTimer = Timer(every - since, () {
      _stepTimer = null;
      _advance();
    });
  }

  void _advance() {
    if (_disposed || def == null || !motionEnabled || mood != DaemonMood.work) {
      return;
    }
    _step++;
    _lastStep = _now();
    _lastGlyph = glyph;
    notifyListeners();
  }

  /// A key went down somewhere in the window. Enter ends a thought: a line
  /// waiting for you may speak now. Any other key holds it for 8 s more.
  void noteKey({bool enter = false}) {
    if (enter) {
      _lastKey = null;
      if (_pendingVoice != null) _trySpeak();
    } else {
      _lastKey = _now();
    }
  }

  /// You looked at the slot (hover, its panel, the window coming back): the
  /// tally of finished turns has been seen, here and by the brain.
  void seen() {
    if (_disposed || doneCount == 0) return;
    _doneCount = 0;
    if ((_brainDone ?? 0) > 0) {
      _brainDone = 0;
      onSeen?.call();
    }
    notifyListeners();
  }

  /// A click on the daemon.
  void boop() {
    if (_disposed || def == null) return;
    wake(notify: false);
    if (_living) life.record(CompanionEvent.pet, 'pet:${++_lifeEvent}');
    _booped = true;
    _boopTimer?.cancel();
    _boopTimer = Timer(roster.rules.hold(DaemonMood.boop), () {
      _booped = false;
      _update(force: true);
    });
    _say(
      def!.line(DaemonMood.boop),
      mood: DaemonMood.boop,
      kind: _LineKind.reply,
    );
    _update(force: true);
  }

  /// "I see you": hover, its panel opening, the window coming back.
  void look({bool force = false}) {
    if (_disposed || !_blinks) return;
    final now = _now();
    if (_lastLook != null && now.difference(_lastLook!) < lookEvery) return;
    _lastLook = now;
    _blink('look', delay: force ? const Duration(milliseconds: 250) : null);
  }

  void nap() {
    if (_disposed || def == null) return;
    _napUntil = _now().add(napLength);
    _napTimer?.cancel();
    _napTimer = Timer(napLength, () => wake());
    _update(force: true);
  }

  void wake({bool notify = true}) {
    if (_napUntil == null) return;
    _napUntil = null;
    _napTimer?.cancel();
    _napTimer = null;
    if (notify) _update(force: true);
  }

  /// The hatch reveal is running: the status slot keeps the egg and nothing
  /// names the hatchling until [endReveal].
  void beginReveal({String? kind}) {
    if (_disposed || _revealing) return;
    _revealing = true;
    _revealStage = null;
    _revealKind = kind ?? zoo.readyEgg?.kind ?? 'first';
    _revealSprite = '';
    _update(force: true);
  }

  /// The reveal finished or was dismissed. The daemon arrives and says its
  /// first words, with a slow blink: they have just met.
  void endReveal() {
    if (_disposed || !_revealing) return;
    _revealing = false;
    _revealStage = null;
    _baselined = false;
    final d = def;
    if (d != null) {
      _pairKey = daemon?.uid;
      if (_living) {
        life.record(CompanionEvent.hatched, 'hatched:${daemon?.uid}');
      }
      _blink('slow', delay: const Duration(milliseconds: 300));
      _say(d.first, mood: null, kind: _LineKind.reply);
    }
    _update(force: true);
  }

  void _zooChanged() {
    if (_disposed) return;
    if (_lifeScope != zoo.scope) {
      _lifeScope = zoo.scope;
      life.reset();
    }
    _syncLifeTimer();
    final key = daemon?.uid;
    if (key != _pairKey) {
      // A different pair: what it watches starts again from a baseline.
      life.reset();
      _pairKey = key;
      _baselined = false;
      _held = null;
      _holdTimer?.cancel();
    }
    _update(force: true);
  }

  void _settingsChanged() {
    if (_disposed) return;
    if (settings.quiet) {
      _pendingVoice = null;
      _pendingTimer?.cancel();
      _silence();
    }
    if (!motionEnabled) _stopBlink();
    _update(force: true);
  }

  /// A new egg or a level-up, here or on another client. Neither is a line:
  /// the egg waits after the slot (`1 egg`) until it is opened, and a
  /// level-up is a slow blink.
  void _zooEvent(ZooEvent event) {
    if (_disposed) return;
    final d = def;
    switch (event) {
      case ZooEggArrived(:final egg):
        // Before the first hatch the slot already shows the egg itself.
        if (d == null) return;
        _arriving = egg;
        _arrivingTimer?.cancel();
        _arrivingTimer = Timer(eggShowFor, () {
          _arriving = null;
          _update(force: true);
        });
        _blink('ack', delay: const Duration(milliseconds: 160));
        _update(force: true);
      case ZooDaemonGrew(:final daemon):
        if (d == null || daemon.uid != this.daemon?.uid) return;
        if (_living) {
          life.record(
            CompanionEvent.grew,
            'grew:${daemon.uid}:${daemon.version}:${daemon.bond}',
          );
        }
        // "I trust you": a slow blink.
        _blink('slow', delay: const Duration(milliseconds: 200));
        _update(force: true);
    }
  }

  // ── reactions ──────────────────────────────────────────────────────────────

  void _hold(DaemonMood held) {
    _held = held;
    _holdTimer?.cancel();
    _holdTimer = Timer(roster.rules.hold(held), () {
      _held = null;
      _update(force: true);
    });
  }

  /// Back after 15 minutes or more: it waves and blinks slowly. The brief
  /// (or the panel) carries the facts; no line takes over the status line.
  void _back() {
    if (def == null || _needIds.isNotEmpty || napping) return;
    if (_living) life.record(CompanionEvent.returned, 'return:${++_lifeEvent}');
    _hold(DaemonMood.back);
    _blink(
      'slow',
      delay:
          roster.rules.hold(DaemonMood.back) +
          const Duration(milliseconds: 120),
    );
  }

  /// Whether the slot shows something that blinks: the daemon, or a ready
  /// egg (its eyes peek from the chip).
  bool get _blinks =>
      def != null ||
      (_revealing
          ? (_revealStage ?? 'p4') == 'p4' || _revealStage == 'rock'
          : nearestEgg?.ready == true);

  void _blink(String kind, {Duration? delay}) {
    final steps = roster.rules.blinks[kind];
    if (steps == null || !motionEnabled || !_blinks) return;
    _stopBlink();
    var index = 0;
    void step() {
      if (_disposed) return;
      if (index >= steps.length || !motionEnabled) {
        _lid = null;
        _blinkTimer = null;
        notifyListeners();
        return;
      }
      final (lid, ms) = steps[index++];
      // No blinks while working, napping or booped.
      _lid = roster.rules.noBlinkMoods.contains(mood.name) ? null : lid;
      notifyListeners();
      _blinkTimer = Timer(Duration(milliseconds: ms), step);
    }

    if (delay == null || delay == Duration.zero) {
      step();
    } else {
      _blinkTimer = Timer(delay, step);
    }
  }

  void _stopBlink() {
    _blinkTimer?.cancel();
    _blinkTimer = null;
    _lid = null;
  }

  // ── voice ──────────────────────────────────────────────────────────────────

  void _say(
    String line, {
    required DaemonMood? mood,
    required _LineKind kind,
    String? about,
  }) {
    if (line.isEmpty || quiet) return;
    _dropExpired();
    // A reply never pushes aside an alert waiting to be said.
    if (kind == _LineKind.reply && (_pendingVoice?.kind.unsolicited ?? false)) {
      return;
    }
    final now = _now();
    // With a brain, a roster alert waits a moment for the brain's own words.
    final waits = brainActive && kind == _LineKind.alert;
    _pendingVoice = _Line(
      line,
      at: now,
      mood: mood,
      kind: kind,
      about: about,
      holdUntil: waits ? now.add(brainWait) : null,
    );
    _trySpeak();
  }

  /// The brain's line (`daemon_say`), shown exactly as sent, keys first, for
  /// its `ttlMs`. `need` and `fail` take over the status line in yellow like
  /// the window's own alerts; `ask` (the pair wants your key) is yellow and at
  /// once; `say` (the pair answering you) is a dim reply; `auto` (a rule or
  /// the pair acted) is dim, and the face shows it as done. A finished turn
  /// or a return is never a line (the expression and brief carry them). A
  /// second line with the same id replaces it in place, with the time the
  /// brain says it has left.
  void sayFromBrain(DaemonSay say) {
    if (_disposed || def == null) return;
    final mood = say.mood;
    if (mood == DaemonSayMood.auto) {
      // It did something on its own: a moment of `done`, and an ack.
      if (_living) {
        life.record(
          CompanionEvent.completed,
          'auto:${say.id.hashCode.toUnsigned(32)}',
        );
      }
      _hold(DaemonMood.done);
      _blink('ack', delay: const Duration(milliseconds: 160));
      _update(force: true);
    }
    if (quiet) return;
    _dropExpired();
    final kind = switch (mood) {
      DaemonSayMood.need || DaemonSayMood.fail => _LineKind.alert,
      DaemonSayMood.ask => _LineKind.ask,
      DaemonSayMood.auto => _LineKind.report,
      DaemonSayMood.say => _LineKind.reply,
      // An older brain's line with answers still needs you.
      _ when say.actions.isNotEmpty => _LineKind.alert,
      _ => null,
    };
    if (kind == null) return;
    final line = _Line(
      say.line,
      at: _now(),
      mood: mood?.face,
      kind: kind,
      about: say.aboutKey,
      sayId: say.id,
      target: say.about?.key == null ? null : say.about,
      actions: say.actions,
      ttl: say.ttl ?? voiceFor,
      exact: true,
      detail: say.detail,
      harness: say.harness,
      fromPair: say.fromPair,
      confirm: say.confirm,
    );
    final spoken = _spoken;
    // The same line again (the model's better words): in place.
    if (spoken != null && spoken.sayId == say.id) {
      _show(line, countsAsUnsolicited: false);
      return;
    }
    if (_pendingVoice?.sayId == say.id) {
      _pendingVoice = line;
      _trySpeak();
      return;
    }
    // A roster alert about the same harness is replaced by the brain's words.
    if (spoken != null &&
        spoken.kind == _LineKind.alert &&
        spoken.sayId == null &&
        line.about != null &&
        spoken.about == line.about) {
      _show(line, countsAsUnsolicited: false);
      return;
    }
    // A reply never pushes aside an alert waiting to be said (the talk keeps
    // it in the panel). A proposal does: its keys work only while it shows,
    // and the need it displaces stays on the face and in the panel.
    if (kind == _LineKind.reply && (_pendingVoice?.kind.unsolicited ?? false)) {
      return;
    }
    _pendingVoice = line;
    _trySpeak();
  }

  /// A line still waiting whose time ran out while it waited is gone.
  void _dropExpired() {
    final pending = _pendingVoice;
    if (pending != null &&
        _now().difference(pending.at) >= (pending.ttl ?? voiceExpires)) {
      _pendingVoice = null;
      _pendingTimer?.cancel();
      _pendingTimer = null;
    }
  }

  /// A line of the window's own, such as why an answer did not go through.
  void sayNote(String line) {
    if (_disposed || def == null) return;
    _say(line, mood: null, kind: _LineKind.reply);
  }

  /// `daemon_unsay`: answered elsewhere, gone, done or stale.
  void unsay(String id) {
    if (_pendingVoice?.sayId == id) _pendingVoice = null;
    if (_spoken?.sayId == id) _silence();
  }

  /// Escape: the line goes.
  void dismissVoice() => _silence();

  /// You answered the line: it goes, and since you are already with the
  /// daemon, the next question may follow without the two-minute wait.
  void answered() {
    _lastUnsolicited = null;
    _silence();
  }

  void _silence() {
    _voiceTimer?.cancel();
    _voiceTimer = null;
    _spoken = null;
    if (_voice.value == null) return;
    _voice.value = null;
    if (!_disposed) notifyListeners();
  }

  void _trySpeak() {
    _pendingTimer?.cancel();
    _pendingTimer = null;
    final pending = _pendingVoice;
    if (pending == null || _disposed) return;
    final now = _now();
    final unsolicited = pending.kind.unsolicited;
    final stale =
        now.difference(pending.at) >= (pending.ttl ?? voiceExpires) ||
        (pending.mood == DaemonMood.need &&
            pending.sayId == null &&
            _needIds.isEmpty) ||
        def == null ||
        quiet ||
        // Nothing about the pane in front of you.
        (pending.about != null && pending.about == _focus) ||
        // A nap keeps it quiet, except for what needs you.
        (napping && pending.mood != DaemonMood.need && unsolicited) ||
        // At most one line nobody asked for every two minutes.
        (unsolicited &&
            _lastUnsolicited != null &&
            now.difference(_lastUnsolicited!) < unsolicitedEvery);
    if (stale) {
      _pendingVoice = null;
      return;
    }
    Duration? wait;
    if (pending.holdUntil case final until? when now.isBefore(until)) {
      wait = until.difference(now);
    } else if (_lastKey case final key?
        when unsolicited && now.difference(key) < typingQuiet) {
      // Never mid-thought: after Enter, a pane switch or 8 s without a key.
      wait = typingQuiet - now.difference(key);
    } else if ((pending.kind != _LineKind.ask && dialogOpen()) ||
        !_foreground) {
      wait = const Duration(milliseconds: 500);
    }
    if (wait != null) {
      _pendingTimer = Timer(wait, _trySpeak);
      return;
    }
    _pendingVoice = null;
    _show(pending, countsAsUnsolicited: unsolicited);
  }

  void _show(_Line line, {required bool countsAsUnsolicited}) {
    // A brain line's keys work only while the brain still holds it: it shows
    // for what is left of its `ttlMs` since it arrived.
    final showFor = line.sayId != null
        ? (line.ttl ?? voiceFor) - _now().difference(line.at)
        : line.actions.isEmpty
        ? voiceFor
        : line.ttl ?? askFor;
    if (showFor <= Duration.zero) return;
    _spoken = line;
    if (countsAsUnsolicited) _lastUnsolicited = _now();
    _voice.value = line.exact ? line.line : '$name: ${line.line}';
    _voiceTimer?.cancel();
    _voiceTimer = Timer(showFor, _silence);
    notifyListeners();
  }

  // ── frames ─────────────────────────────────────────────────────────────────

  DaemonMood? _lastMood;
  String? _lastGlyph;

  void _update({DaemonMood? before, bool force = false}) {
    if (_disposed) return;
    final now = mood;
    _runMotion(now);
    final glyph = this.glyph;
    if (force || now != (before ?? _lastMood) || glyph != _lastGlyph) {
      _lastMood = now;
      _lastGlyph = glyph;
      notifyListeners();
    }
  }

  void _runMotion(DaemonMood now) {
    final d = def;
    // Work frames step only on agent events; leaving work puts them at rest.
    if (d == null || !motionEnabled || now != DaemonMood.work) {
      _stepTimer?.cancel();
      _stepTimer = null;
      _step = 0;
      _lastStep = null;
    }
    // The return wave is finite: it runs while `back` is held.
    final waving = d != null && motionEnabled && now == DaemonMood.back;
    if (!waving) {
      _backTimer?.cancel();
      _backTimer = null;
      _backT = 0;
      return;
    }
    if (_backTimer != null) return;
    final last = versionIndex == roster.rules.versions.length - 1;
    final ms = last ? roster.rules.backFrameMs : 130;
    _backTimer = Timer.periodic(Duration(milliseconds: ms), (_) {
      if (_disposed) return;
      _backT += ms;
      final glyph = this.glyph;
      if (glyph != _lastGlyph) {
        _lastGlyph = glyph;
        notifyListeners();
      }
    });
  }

  @override
  void dispose() {
    _disposed = true;
    zoo.removeListener(_zooChanged);
    settings.removeListener(_settingsChanged);
    if (_ownsSettings) settings.dispose();
    unawaited(_events.cancel());
    for (final timer in [
      _lifeTimer,
      _arrivingTimer,
      _holdTimer,
      _boopTimer,
      _napTimer,
      _blinkTimer,
      _stepTimer,
      _backTimer,
      _voiceTimer,
      _pendingTimer,
      _seenTimer,
    ]) {
      timer?.cancel();
    }
    _voice.dispose();
    super.dispose();
  }
}

class _Line {
  const _Line(
    this.line, {
    required this.at,
    required this.kind,
    this.mood,
    this.about,
    this.sayId,
    this.actions = const [],
    this.ttl,
    this.holdUntil,
    this.exact = false,
    this.target,
    this.detail,
    this.harness,
    this.fromPair = false,
    this.confirm,
  });
  final String line;
  final DateTime at;
  final _LineKind kind;
  final DaemonMood? mood;

  /// Shown exactly as sent (the brain's line, keys first), not as
  /// `name: line`.
  final bool exact;

  /// The harness a brain line is about.
  final DaemonAbout? target;

  /// `machineId/agentId` of the harness it is about, when it is about one.
  final String? about;
  final String? sayId;
  final List<DaemonAction> actions;
  final Duration? ttl;

  /// A roster line waiting for the brain's words until then.
  final DateTime? holdUntil;

  /// A brain line's full `detail`, the harness it names, whether the pair
  /// harness wrote it, and the setting it waits on.
  final String? detail;
  final DaemonHarness? harness;
  final bool fromPair;
  final ({String kind, String nonce})? confirm;
}
