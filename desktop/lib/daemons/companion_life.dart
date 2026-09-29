/// The companion's emotional life, shared by the desktop and its USB display.
/// Only structured work outcomes become reactions. Rest and fatigue describe
/// the character, never a person's wellbeing or an agent's remaining capacity.
library;

enum CompanionEmotion {
  content,
  curious,
  bored,
  playful,
  working,
  focused,
  happy,
  excited,
  proud,
  relieved,
  frustrated,
  angry,
  sad,
  tired,
  exhausted,
  attentive,
  asleep,
  offline,
  listening,
  affectionate,
  hatching,
}

enum CompanionEvent {
  completed,
  failed,
  bug,
  recovered,
  merged,
  hatched,
  grew,
  returned,
  pet,
}

class CompanionFeeling {
  const CompanionFeeling({
    required this.emotion,
    required this.reason,
    this.intensity = 1,
    this.reactionId,
    this.remainingMs = 0,
  });

  final CompanionEmotion emotion;

  /// A bounded semantic code. Terminal prose never travels with an emotion.
  final String reason;
  final int intensity;
  final String? reactionId;
  final int remainingMs;

  Map<String, Object> toJson() => {
    'emotion': emotion.name,
    'reason': reason,
    'intensity': intensity,
    'reactionId': ?reactionId,
    if (reactionId != null) 'remainingMs': remainingMs,
  };
}

class _Reaction {
  const _Reaction(
    this.event,
    this.id,
    this.emotion,
    this.until,
    this.priority,
    this.intensity,
  );
  final CompanionEvent event;
  final String id;
  final CompanionEmotion emotion;
  final DateTime until;
  final int priority, intensity;
}

/// No timers, persistence or I/O. The presenter owns a single low-frequency
/// clock; the device owns animation frames. Fake clocks exercise an entire day.
class CompanionLife {
  CompanionLife({DateTime Function()? now}) : _now = now ?? DateTime.now {
    _last = _idleSince = _now();
  }

  final DateTime Function() _now;
  late DateTime _last, _idleSince;
  int _working = 0, _needs = 0, _failures = 0;
  bool _connected = true, _asleep = false;
  int _effortMs = 0;
  final _seen = <String>{};
  final _bugs = <DateTime>[];
  final _lastReaction = <CompanionEvent, DateTime>{};
  _Reaction? _reaction;

  void reset() {
    _working = _needs = _failures = _effortMs = 0;
    _connected = true;
    _asleep = false;
    _last = _idleSince = _now();
    _seen.clear();
    _bugs.clear();
    _lastReaction.clear();
    _reaction = null;
  }

  void _advance(DateTime now) {
    // A wall-clock correction cannot make the character younger or bank
    // negative work. A disconnected desktop is never still doing work.
    final elapsed = now.difference(_last).inMilliseconds;
    if (elapsed <= 0) return;
    _last = now;
    _effortMs =
        (_effortMs +
                (_connected && !_asleep && _working > 0
                    ? elapsed
                    : -elapsed * 3))
            .clamp(0, const Duration(hours: 6).inMilliseconds);
    _bugs.removeWhere((at) => now.difference(at) > const Duration(minutes: 5));
    if (_reaction != null && !now.isBefore(_reaction!.until)) _reaction = null;
  }

  /// Inventories are state, never events. Attaching to a failing or completed
  /// session must not play a fresh failure or victory animation.
  void observe({
    required int working,
    required int needs,
    required int failures,
    bool connected = true,
    bool asleep = false,
  }) {
    final now = _now();
    _advance(now);
    final nextWorking = working.clamp(0, 1024);
    if (_working == 0 &&
        nextWorking > 0 &&
        (_reaction?.event == CompanionEvent.failed ||
            _reaction?.event == CompanionEvent.bug)) {
      // A new attempt gets his attention. Keep the failure history so a
      // successful retry still produces relief.
      _reaction = null;
    }
    if ((_working > 0 && nextWorking == 0) ||
        (!_connected && connected) ||
        (_asleep && !asleep)) {
      _idleSince = now;
    }
    _working = nextWorking;
    _needs = needs.clamp(0, 1024);
    _failures = failures.clamp(0, 1024);
    _connected = connected;
    _asleep = asleep;
    if (!connected || asleep) _reaction = null;
  }

  /// A stable event id deduplicates retries and multiple observations. Callers
  /// exclude replay before calling this. No queue: surprises that happened
  /// while offline/asleep or under a more important reaction are not replayed.
  void record(CompanionEvent event, String id) {
    if (id.isEmpty || id.length > 256 || !_seen.add(id)) return;
    if (_seen.length > 256) _seen.remove(_seen.first);
    final now = _now();
    _advance(now);
    if (!_connected || _asleep) return;

    var emotion = CompanionEmotion.happy;
    var duration = const Duration(seconds: 5);
    var priority = 2;
    var intensity = 1;
    var cooldown = const Duration(seconds: 12);
    switch (event) {
      case CompanionEvent.failed:
      case CompanionEvent.bug:
        _bugs.add(now);
        if (_bugs.length > 32) _bugs.removeAt(0);
        emotion = _bugs.length >= 3
            ? CompanionEmotion.angry
            : CompanionEmotion.frustrated;
        intensity = _bugs.length.clamp(1, 3);
        priority = 4;
        duration = const Duration(seconds: 7);
        cooldown = const Duration(seconds: 3);
      case CompanionEvent.completed:
        emotion = _bugs.isEmpty
            ? CompanionEmotion.happy
            : CompanionEmotion.relieved;
        if (_bugs.isNotEmpty) {
          _bugs.clear();
          priority = 5;
          cooldown = Duration.zero;
        }
      case CompanionEvent.recovered:
        emotion = CompanionEmotion.relieved;
        _bugs.clear();
        priority = 5;
      case CompanionEvent.merged:
        emotion = CompanionEmotion.excited;
        duration = const Duration(seconds: 9);
        priority = 6;
        intensity = 3;
        cooldown = const Duration(seconds: 3);
      case CompanionEvent.hatched:
        emotion = CompanionEmotion.hatching;
        priority = 8;
        duration = const Duration(seconds: 8);
      case CompanionEvent.grew:
        emotion = CompanionEmotion.proud;
        priority = 5;
        duration = const Duration(seconds: 7);
      case CompanionEvent.returned:
        emotion = CompanionEmotion.playful;
        duration = const Duration(seconds: 5);
        cooldown = const Duration(minutes: 5);
      case CompanionEvent.pet:
        emotion = CompanionEmotion.affectionate;
        priority = 7;
        duration = const Duration(seconds: 3);
        cooldown = const Duration(milliseconds: 800);
    }
    final previous = _lastReaction[event];
    if (previous != null && now.difference(previous) < cooldown) return;
    if (_reaction case final current?) {
      if (current.priority > priority) return;
    }
    _lastReaction[event] = now;
    _reaction = _Reaction(
      event,
      id,
      emotion,
      now.add(duration),
      priority,
      intensity,
    );
  }

  CompanionFeeling get feeling {
    final now = _now();
    _advance(now);
    if (!_connected) {
      return const CompanionFeeling(
        emotion: CompanionEmotion.offline,
        reason: 'disconnected',
      );
    }
    if (_asleep) {
      return const CompanionFeeling(
        emotion: CompanionEmotion.asleep,
        reason: 'resting',
      );
    }
    // A waiting question always has a legible attentive face. Its arrival
    // doesn't extend or defer any reaction underneath it.
    if (_needs > 0) {
      return CompanionFeeling(
        emotion: CompanionEmotion.attentive,
        reason: 'needs-you',
        intensity: _needs.clamp(1, 3),
      );
    }
    if (_reaction case final reaction?) {
      return CompanionFeeling(
        emotion: reaction.emotion,
        reason: reaction.event.name,
        intensity: reaction.intensity,
        reactionId: reaction.id,
        remainingMs: reaction.until.difference(now).inMilliseconds,
      );
    }
    if (_working > 0) {
      if (_effortMs >= const Duration(hours: 4).inMilliseconds) {
        return const CompanionFeeling(
          emotion: CompanionEmotion.exhausted,
          reason: 'long-workday',
        );
      }
      if (_effortMs >= const Duration(hours: 2).inMilliseconds) {
        return const CompanionFeeling(
          emotion: CompanionEmotion.tired,
          reason: 'sustained-work',
        );
      }
      return CompanionFeeling(
        emotion: _working >= 3
            ? CompanionEmotion.focused
            : CompanionEmotion.working,
        reason: 'agents-working',
        intensity: _working.clamp(1, 3),
      );
    }
    if (_failures > 0) {
      return CompanionFeeling(
        emotion: CompanionEmotion.sad,
        reason: 'unresolved-failure',
        intensity: _failures.clamp(1, 3),
      );
    }
    final idle = now.difference(_idleSince);
    if (idle >= const Duration(minutes: 15)) {
      return const CompanionFeeling(
        emotion: CompanionEmotion.asleep,
        reason: 'quiet-desk',
      );
    }
    if (idle >= const Duration(minutes: 3)) {
      // A little stretch every couple of minutes; mostly a quiet bored pose.
      final stretching = idle.inSeconds % 120 < 5;
      return CompanionFeeling(
        emotion: stretching ? CompanionEmotion.playful : CompanionEmotion.bored,
        reason: stretching ? 'stretch' : 'idle',
      );
    }
    if (idle >= const Duration(seconds: 45)) {
      return const CompanionFeeling(
        emotion: CompanionEmotion.curious,
        reason: 'looking-around',
      );
    }
    return const CompanionFeeling(
      emotion: CompanionEmotion.content,
      reason: 'settled',
    );
  }
}
