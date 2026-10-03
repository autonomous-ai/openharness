/// The paired daemon's face on the phone: its mood, its blinks, and the frames
/// it draws while agents work (`daemons/README.md`, Moods, Motion and blinks).
///
/// The phone's face is smaller than a window's. It knows only what the phone
/// already sees, and decides in this order:
///
///  1. `boop` for 900 ms after a tap;
///  2. `need` while any harness waits on you (an open question);
///  3. `work` while any harness works;
///  4. `fail` while a harness you have open failed to start — a machine that
///     is asleep or unreachable is not a failure, and changes nothing;
///  5. `idle`.
///
/// No `done`, `back` or `nap`: the phone does not see whose turn finished, and
/// a pocket is not a break. Moods come from work, never from the clock: there
/// is no idle timer and no animation timer. A work frame steps once per real
/// agent event ([pulse]: a tool starting, output arriving), at most twice a
/// second, so a baton that stops turning is an agent that stopped. Other
/// timers only end a boop and run one blink. Blinks answer something — `ack`
/// when something it watches changes, `look` when you open its sheet (at most
/// once per 2.5 s), `slow` when you meet it or it grows — and never while
/// working or booped. Reduce Motion and the background stop every frame and
/// blink; the face still changes.
///
/// The paired daemon is an individual (README "Individuals"): its sprite is
/// its own one-liner (a rare extra's variant, `renderIndividualSprite`), and a
/// fidgety one turns two work frames a step, its `workMs` halved. Before any
/// daemon the chip is the egg nearest to hatching, in one line (`eggLine`): a
/// ready egg that peeks and blinks, else the egg furthest along.
library;

import 'dart:async';

import 'package:flutter/foundation.dart';

import 'eggs.dart';
import 'plates.dart';
import 'render.dart';
import 'roster.dart';
import 'zoo.dart';
import 'zoo_client.dart';

/// What the phone sees, as the daemon watches it. Each set holds stable keys
/// (`machine/agent`, plus the question's id for a need), so a new key is a new
/// thing to answer and a key that leaves is something that ended.
@immutable
class DaemonWatch {
  const DaemonWatch({
    this.needs = const {},
    this.working = const {},
    this.failing = const {},
  });

  /// Open questions: harnesses waiting on you.
  final Set<String> needs;

  /// Harnesses mid-turn.
  final Set<String> working;

  /// Harnesses you have open that failed to start.
  final Set<String> failing;
}

class DaemonFace extends ChangeNotifier {
  DaemonFace(this.zoo, {DateTime Function()? now})
    : _now = now ?? DateTime.now {
    zoo.addListener(_zooChanged);
    _events = zoo.events.listen(_zooEvent);
    _pairKey = zoo.paired?.uid;
  }

  final ZooClient zoo;
  final DateTime Function() _now;
  late final StreamSubscription<ZooEvent> _events;

  static const lookEvery = Duration(milliseconds: 2500);
  static const ackAfter = Duration(milliseconds: 160);

  /// At most two work steps a second, however busy the agents are.
  static const stepEvery = Duration(milliseconds: 500);

  DaemonRoster get roster => zoo.roster;

  bool _disposed = false;
  bool _foreground = true, _reduceMotion = false;

  DaemonWatch _watch = const DaemonWatch();
  bool _baselined = false;
  String? _pairKey;

  bool _booped = false;
  Timer? _boopTimer;
  DateTime? _lastLook;

  String? _lid;
  Timer? _blinkTimer;

  /// Work steps taken since work began.
  int _step = 0;
  DateTime? _lastStep;
  Timer? _trailingStep;

  /// Whether a hatch reveal is running: the chip keeps the egg until it ends,
  /// so nothing names the hatchling before the reveal does.
  bool _revealing = false;
  String? _revealKind;

  // ── what it shows ──────────────────────────────────────────────────────────

  bool get visible => zoo.loaded;
  bool get motionEnabled => _foreground && !_reduceMotion;
  bool get reduceMotion => _reduceMotion;
  bool get revealing => _revealing;

  /// The paired individual, withheld while its hatch reveal runs.
  ZooDaemon? get daemon => _revealing ? null : zoo.paired;

  /// Its species.
  DaemonDef? get def => roster.byId(daemon?.id);

  /// Its traits, rolled from its seed; null for a species without a
  /// catalogue.
  DaemonTraits? get traits => daemon?.traits(roster);

  /// The species as this individual shows it in the status line: its extra's
  /// sprites, its temper's pace.
  DaemonDef? get individualDef {
    final d = daemon;
    if (d == null || def == null) return null;
    return individualDaemon(roster, d.id, traits);
  }

  /// What it is called in a sentence: its name when it has one, else its
  /// species.
  String get name => daemon?.called ?? '';

  /// What it is called where it is listed: `pip the tim`, `tim #0042`.
  String get title => daemon?.title ?? '';

  /// The paired daemon is shiny: it wears its shiny colour, and the chip
  /// marks it `*`.
  bool get shiny => daemon?.shiny == true;

  /// Today, for what depends on the date (a drop's release).
  DateTime now() => _now();

  int get versionIndex => roster.versionIndex(daemon?.version);

  /// An egg is waiting and no daemon has hatched yet.
  bool get eggReady => daemon == null && zoo.readyEgg != null;

  /// The egg the chip shows before any daemon: the one nearest to hatching.
  EggProgress? get nearest => nearestEgg(roster, zoo.zoo, _now());

  DaemonMood get mood {
    if (_booped) return DaemonMood.boop;
    if (_watch.needs.isNotEmpty) return DaemonMood.need;
    if (_watch.working.isNotEmpty) return DaemonMood.work;
    if (_watch.failing.isNotEmpty) return DaemonMood.fail;
    return DaemonMood.idle;
  }

  DaemonWatch get watch => _watch;

  /// The blink lid for this instant, or null.
  String? get lid => _lid;

  /// Work steps taken, for the frame drawn now.
  int get step => _step;

  /// The sprite's clock: one step is one frame of the species' 2.0 work
  /// cycle (two of a fidgety individual's), or one turn of a younger
  /// version's borrowed baton.
  int get spriteT {
    final d = def;
    if (d == null) return 0;
    final last = versionIndex == roster.rules.versions.length - 1;
    return _step * (last ? d.workMs : 130);
  }

  /// The portrait's clock: one step moves each part one frame.
  int get portraitT {
    final d = def;
    if (d == null || d.parts.isEmpty) return 0;
    final ms = d.parts.values.map((p) => p.ms).reduce((a, b) => a < b ? a : b);
    return _step * ms;
  }

  /// What the chip draws: the individual's sprite, or before any daemon the
  /// egg nearest to hatching in one line — ready, it peeks and blinks; while
  /// the reveal runs, the egg being opened.
  String get glyph {
    if (!visible) return '';
    final d = individualDef;
    if (d == null) {
      if (_revealing) {
        return eggLine(roster, _revealKind ?? 'first', 'rock');
      }
      final egg = nearest;
      if (egg == null) return eggLine(roster, 'first', 'p0');
      return eggLine(roster, egg.kind, egg.stage, lid: _lid);
    }
    return renderSprite(
      roster,
      d,
      versionIndex,
      mood,
      t: spriteT,
      lid: _lid,
      motion: motionEnabled,
    );
  }

  /// The glyph in its slot: eight cells and a gutter each side, the sprite
  /// centred on its base width so a baton never shifts the face.
  String get cell {
    final d = individualDef;
    final g = glyph;
    if (d == null) return statusCell(roster, g);
    return statusCell(roster, g, baseWidth(roster, d, versionIndex));
  }

  /// The portrait at its version and mood. A daemon drawn filled has no line
  /// portrait: this is then its portrait plate's first frame at the mood, and
  /// the sheet runs the loop itself (`DaemonPlateView`), a frame every
  /// `frameMs` — the one motion that is not a step of real work.
  List<String> get portrait {
    final d = def;
    if (d == null) return const [];
    if (d.plate) {
      final loop = daemonPlates.frames(
        d.id,
        PlateSize.portrait,
        daemon!.version,
        mood,
      );
      return loop.isEmpty ? const [] : loop.first;
    }
    return renderPortrait(
      roster,
      d,
      daemon!.version,
      mood,
      t: portraitT,
      lid: _lid,
      motion: motionEnabled,
    );
  }

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

  /// What a screen reader hears for the chip.
  String get semantics {
    if (!visible) return '';
    if (_revealing) return 'Hatching';
    final d = def;
    if (d != null) {
      final eggs = zoo.zoo.eggs.length;
      return '$title, ${d.id} ${daemon!.version}${shiny ? ', shiny' : ''}, '
          '${moodWords[mood]}'
          '${eggs == 0 ? '' : ', $eggs ${eggs == 1 ? 'egg' : 'eggs'} waiting'}';
    }
    if (eggReady) return 'An egg, ready to hatch';
    final egg = nearest;
    if (egg == null) return 'A daemon is incubating';
    return egg.kind == 'first' || egg.kind == 'setup'
        ? 'A daemon is incubating: ${egg.done} of ${egg.need} habits'
        : 'A ${egg.kind} egg is incubating: ${egg.done} of ${egg.need}';
  }

  // ── inputs ─────────────────────────────────────────────────────────────────

  /// Reduce Motion, and whether the app is in front of anybody.
  void setEnvironment({required bool foreground, required bool reduceMotion}) {
    if (_disposed) return;
    if (_foreground == foreground && _reduceMotion == reduceMotion) return;
    _foreground = foreground;
    _reduceMotion = reduceMotion;
    if (!motionEnabled) {
      _stopBlink();
      _trailingStep?.cancel();
      _trailingStep = null;
    }
    _update();
  }

  /// What the phone sees now. The first sync with a daemon is a baseline:
  /// restored state and reconnects are never fresh news.
  void sync(DaemonWatch next) {
    if (_disposed) return;
    final before = _watch;
    _watch = next;
    if (!_baselined || def == null) {
      _baselined = def != null;
      _update();
      return;
    }
    final newNeed = next.needs.difference(before.needs).isNotEmpty;
    final newFail = next.failing.difference(before.failing).isNotEmpty;
    final finished = before.working.difference(next.working).isNotEmpty;
    if (newNeed || newFail || finished) _blink('ack', delay: ackAfter);
    _update();
  }

  /// A real agent event arrived (a tool starting, output arriving): while
  /// something works, the frame steps once — at most twice a second.
  void pulse() {
    if (_disposed || def == null || !motionEnabled) return;
    if (mood != DaemonMood.work) return;
    final now = _now();
    final last = _lastStep;
    if (last == null || now.difference(last) >= stepEvery) {
      _takeStep(now);
      return;
    }
    // Inside the half second: one step at its end, for however many events
    // arrive until then.
    _trailingStep ??= Timer(stepEvery - now.difference(last), () {
      _trailingStep = null;
      if (_disposed || !motionEnabled || mood != DaemonMood.work) return;
      _takeStep(_now());
    });
  }

  void _takeStep(DateTime now) {
    _lastStep = now;
    _step++;
    notifyListeners();
  }

  /// A tap on the chip.
  void boop() {
    if (_disposed || def == null) return;
    _booped = true;
    _stopBlink();
    _boopTimer?.cancel();
    _boopTimer = Timer(roster.rules.hold(DaemonMood.boop), () {
      _boopTimer = null;
      _booped = false;
      _update();
    });
    _update();
  }

  /// "I see you": its sheet opening. At most once per 2.5 s. A ready egg
  /// looks back too: its eyes peek from the chip.
  void look() {
    if (_disposed || (def == null && !eggReady)) return;
    final now = _now();
    if (_lastLook != null && now.difference(_lastLook!) < lookEvery) return;
    _lastLook = now;
    _blink('look', delay: const Duration(milliseconds: 250));
  }

  /// The hatch reveal is running: the chip keeps the egg (of [kind]) until
  /// [endReveal].
  void beginReveal({String? kind}) {
    if (_disposed || _revealing) return;
    _revealing = true;
    _revealKind = kind;
    _update();
  }

  /// The reveal finished or was closed. The daemon arrives with a slow blink:
  /// you have just met.
  void endReveal() {
    if (_disposed || !_revealing) return;
    _revealing = false;
    _pairKey = daemon?.uid;
    _baselined = false;
    sync(_watch);
    _blink('slow', delay: const Duration(milliseconds: 300));
    _update();
  }

  void _zooChanged() {
    if (_disposed) return;
    final key = daemon?.uid;
    if (key != _pairKey) {
      // A different pair: what it watches starts again from a baseline.
      _pairKey = key;
      _baselined = false;
      sync(_watch);
      return;
    }
    _update();
  }

  void _zooEvent(ZooEvent event) {
    if (_disposed || def == null) return;
    switch (event) {
      case ZooEggArrived() || ZooXpGranted():
        _blink('ack', delay: ackAfter);
      case ZooDaemonGrew(:final daemon):
        // "I trust you": a slow blink when the pair grows.
        if (daemon.uid == this.daemon?.uid) {
          _blink('slow', delay: const Duration(milliseconds: 200));
        }
    }
  }

  // ── blinks ─────────────────────────────────────────────────────────────────

  void _blink(String kind, {Duration? delay}) {
    final steps = roster.rules.blinks[kind];
    if (steps == null || !motionEnabled || (def == null && !eggReady)) return;
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

  /// Whether a blink or a step is still to run (tests: every motion ends).
  @visibleForTesting
  bool get animating =>
      _blinkTimer != null || _trailingStep != null || _boopTimer != null;

  void _update() {
    if (_disposed) return;
    if (mood != DaemonMood.work || !motionEnabled) {
      // Every motion ends at rest.
      _step = 0;
      _lastStep = null;
      _trailingStep?.cancel();
      _trailingStep = null;
    }
    notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    zoo.removeListener(_zooChanged);
    unawaited(_events.cancel());
    for (final timer in [_boopTimer, _blinkTimer, _trailingStep]) {
      timer?.cancel();
    }
    super.dispose();
  }
}
