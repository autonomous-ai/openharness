import 'dart:async';

import 'package:flutter/foundation.dart';

import 'workspace_onboarding.dart';

part 'companion_dialogue.dart';

enum CompanionMood {
  content,
  curious,
  focused,
  waiting,
  happy,
  celebrating,
  puzzled,
  grumpy,
  sad,
  startled,
  affectionate,
  asleep,
}

/// Printable, single-line ASCII. Eight cells fit every expression and gesture.
enum CompanionSpecies {
  cat(
    "Cat",
    "dry humor · quietly affectionate",
    "whisker twitch",
    [
      "=^o.o^=",
      "=^o.o^=?",
      "=^>.<^=",
      "=^o_o^=",
      "=^n.n^=",
      "=^*.*^=",
      "=^o.O^=",
      "=^>_>^=",
      "=^;.;^=",
      "=^O.O^=",
      "=^u.u^=",
      "=^-.-^=",
    ],
    [
      "i'll be here. supervising.",
      "what does that little thing do?",
      "shh. the humans are thinking.",
      "i have reserved this warm spot.",
      "acceptable. very acceptable.",
      "i always knew you had it.",
      "that is certainly one way to do it.",
      "i would like to speak to the compiler.",
      "a small sigh. then we try again.",
      "oh. we meant to do that?",
      "oh. you came back.",
      "wake me when you need me.",
    ],
    "=^-.-^=",
    ["=^o.o^=", "-^o.o^-", "=^o.o^=", "=^o.-^=", "=^o.o^="],
  ),
  mouse(
    "Mouse",
    "curious · easily fascinated",
    "tail curl",
    [
      "<:3)~~~",
      "<o3)~~?",
      "<.3)---",
      "<:3)__~",
      "<^3)~~~",
      "<*3)~~!",
      "<o3)~?~",
      "<-3)===",
      "<;3)___",
      "<O3)!!!",
      "<^3)~~<3",
      "<-3)___",
    ],
    [
      "there is probably something interesting in here.",
      "can we look inside?",
      "tiny paws. serious work.",
      "i found a crumb. we can share.",
      "oh! that worked!",
      "we did the thing! the whole thing!",
      "i may have taken the wrong tunnel.",
      "this cable has offended me.",
      "that was a little bump.",
      "that was a very big noise.",
      "i saved the best crumb for you.",
      "one tiny nap.",
    ],
    "<-3)~~~",
    ["<:3)~~~", "<:3)~~_", "<:3)~_~", "<:3)~~@", "<^3)~~~"],
  ),
  snail(
    "Snail",
    "calm · quietly wise",
    "slow stretch",
    [
      "__@/oo",
      "__@/oO",
      "__@/..",
      "___@/oo",
      "__@/^^",
      "~_@/^^!",
      "__@/o?",
      "__@/--",
      "__@/;;",
      "__@/OO!",
      "__@/uu",
      "__@___z",
    ],
    [
      "we have time.",
      "let us have a closer look.",
      "one small step. then another.",
      "waiting is one of my skills.",
      "a little further than yesterday.",
      "a historic day for small feet.",
      "perhaps another path around it.",
      "i am retreating to my office.",
      "some days are uphill.",
      "i was not prepared for speed.",
      "anywhere with you is a good pace.",
      "home is right here.",
    ],
    "__@/--",
    ["__@___", "__@/..", "__@/oo", "_@_/oo", "__@/oo"],
  ),
  fish(
    "Fish",
    "excitable · easily distracted",
    "one bubble",
    [
      "><(o)>",
      "><(o)>?",
      "><(.)>",
      "><(o)>.",
      "><(^)>",
      "><(*)>o",
      "><(?)>",
      "><(-)>",
      "><(;)>",
      "><(O)>!",
      "><(u)><3",
      "><(-)>z",
    ],
    [
      "just swimming through.",
      "ooh. shiny.",
      "i have one thought. holding it.",
      "blub.",
      "that went swimmingly.",
      "BIG bubble moment.",
      "have we been around this rock before?",
      "blub. with emphasis.",
      "a little rain in my ocean.",
      "BLUB?!",
      "my favorite part of the pond is here.",
      "drifting.",
    ],
    "><(-)>",
    ["><(o)>", "><(o)>.", "><(o)>o", "><(o)>O", "><(o)>"],
  ),
  spider(
    "Spider",
    "meticulous · loves making things",
    "weave a thread",
    [
      "/\\oo/\\",
      "/\\oO/\\",
      "/\\../\\",
      "/_oo_\\",
      "/\\^^/\\",
      "\\/^^\\/",
      "/\\o?/\\",
      "/\\--/\\",
      "/_;;_\\",
      "\\\\OO//",
      "/\\uu/\\",
      "/_--_\\",
    ],
    [
      "a good corner to build in.",
      "how is that held together?",
      "every thread has a purpose.",
      "i can hold this end.",
      "all the threads line up.",
      "look what we made!",
      "there is a knot somewhere.",
      "someone touched my perfectly good web.",
      "we can mend this.",
      "that was not in the blueprint.",
      "i made you a little corner.",
      "eight feet off duty.",
    ],
    "/\\--/\\",
    ["/\\oo/\\", "/|oo|\\", "/\\oo/\\-", "/|oo|\\--", "/\\oo/\\"],
  ),
  bat(
    "Bat",
    "mischievous · fond of quiet hours",
    "wing flutter",
    [
      "\\^oo^/",
      "\\^oO^/",
      "\\^..^/",
      "/^oo^\\",
      "\\^nn^/",
      "\\^**^/",
      "\\^o?^/",
      "\\^--^/",
      "/^;;^\\",
      "\\^OO^/",
      "\\^uu^/",
      "/^--^\\",
    ],
    [
      "nice cave you have here.",
      "i heard something interesting.",
      "echo. echo. found it.",
      "just hanging around.",
      "a very good little adventure.",
      "a completely necessary victory lap.",
      "the echo came back funny.",
      "i object. very quietly.",
      "a quiet corner for a moment.",
      "who turned on the sun?",
      "my favorite person to hang with.",
      "folding up for a while.",
    ],
    "\\^--^/",
    ["/^oo^\\", "-^oo^-", "\\^oo^/", "-^oo^-", "/^oo^\\"],
  );

  const CompanionSpecies(
    this.label,
    this.personality,
    this.habit,
    this.poses,
    this.quotes,
    this.blink,
    this.habitFrames,
  );
  final String label, personality, habit, blink;
  final List<String> poses, quotes, habitFrames;
  String pose(CompanionMood mood) => poses[mood.index];
  String quote(CompanionMood mood) => quotes[mood.index];
}

@immutable
class CompanionIdentity {
  const CompanionIdentity(this.species, this.name, {this.quiet = false});
  final CompanionSpecies species;
  final String name;
  final bool quiet;
  Map<String, Object> toJson() => {
    'species': species.name,
    'name': name,
    'quiet': quiet,
  };
  static CompanionIdentity? fromJson(Object? value) {
    if (value is! Map) return null;
    final species = CompanionSpecies.values
        .where((s) => s.name == value['species'])
        .firstOrNull;
    final name = value['name'];
    if (species == null || name is! String || !validName(name)) return null;
    return CompanionIdentity(
      species,
      name.trim(),
      quiet: value['quiet'] == true,
    );
  }

  static bool validName(String name) =>
      name.trim().isNotEmpty &&
      name.trim().runes.length <= 24 &&
      !RegExp(r'[\x00-\x1f\x7f]').hasMatch(name);
}

/// A small, event-driven companion. No terminal text, network calls, or model
/// inference: moods describe observable workspace activity, never the person.
class CompanionController extends ChangeNotifier {
  CompanionController(this.journey, {DateTime Function()? now})
    : _now = now ?? DateTime.now,
      _scope = journey.scope,
      _lastDiscoveryCount = journey.loaded ? journey.completedCount : null {
    _daypart = CompanionDaypart.at(_now());
    journey.addListener(_journeyChanged);
  }
  final WorkspaceOnboarding journey;
  final DateTime Function() _now;
  String? _scope;
  bool _disposed = false;
  bool _foreground = true, _reduceMotion = false;
  bool _working = false,
      _needsInput = false,
      _browsing = false,
      _blocked = false;
  bool _manualReaction = false, _knocking = false;
  int? _lastDiscoveryCount;
  late CompanionDaypart _daypart;
  // Checked only when a completed-turn event arrives; never schedules a wakeup.
  static const _completionCooldown = Duration(seconds: 20);
  DateTime? _awayAt, _napUntil, _lastMoment;
  int? _completion;
  final _turnsByMachine = <String, int>{};
  int _replyIndex = 0;
  CompanionMood? _reaction;
  String? _frame, _reply, _reactionReason, _eggReply;
  Timer? _reactionTimer, _frameTimer, _napTimer, _eggReplyTimer;
  bool hatching = false;

  CompanionIdentity? get identity => journey.companion;
  bool get napping => _napUntil != null;
  bool get motionEnabled =>
      !_reduceMotion && identity?.quiet != true && _foreground;
  CompanionDaypart get daypart => _daypart;
  CompanionMood get _ambient => napping
      ? CompanionMood.asleep
      : _needsInput
      ? CompanionMood.waiting
      : _working
      ? CompanionMood.focused
      : _blocked
      ? CompanionMood.puzzled
      : _browsing
      ? CompanionMood.curious
      : CompanionMood.content;
  CompanionMood get mood => _needsInput && !_manualReaction && !napping
      ? CompanionMood.waiting
      : _reaction ?? _ambient;
  String get glyph => _frame ?? identity?.species.pose(mood) ?? '';
  String get quote =>
      _reply ??
      (mood == CompanionMood.content
          ? identity?.species.dayQuote(_daypart)
          : identity?.species.quote(mood)) ??
      '';
  String get reason =>
      _reaction != null && mood == _reaction && _reactionReason != null
      ? _reactionReason!
      : napping
      ? 'A little nap. Wake me whenever.'
      : switch (mood) {
          CompanionMood.waiting => 'A harness is waiting for your input.',
          CompanionMood.focused => 'Keeping you company while work runs.',
          CompanionMood.puzzled =>
            'An open harness needs a connection or retry.',
          CompanionMood.curious => 'Exploring something new with you.',
          CompanionMood.asleep => 'Just resting my eyes.',
          _ => _daypart.description,
        };
  static const egg = r'\_O_/';
  static const readyEgg = r'\_o.o_/';
  // The nest stays intact while each discovery reveals a little more life.
  // These faces are anonymous; the species is only revealed after hatching.
  static const eggStages = [egg, r'~\_O_/~', r'\_.._/', readyEgg];
  int get _eggStage => journey.completedCount.clamp(0, eggStages.length - 1);
  String get _restingEgg => eggStages[_eggStage];
  String? get eggReply => identity == null ? _eggReply : null;
  String get statusGlyph => _frame ?? (identity == null ? _restingEgg : glyph);
  int get statusColumns => 8;
  double get statusOpacity => identity != null || journey.complete
      ? 1
      : .85 + .15 * journey.completedCount / journey.total;
  String get statusLabel => hatching
      ? 'Hatching your companion'
      : identity?.name ?? 'Hatch your companion';
  String get statusDetail => identity == null
      ? '${journey.completedCount} of ${journey.total} discoveries complete${journey.complete ? ' · Ready to hatch' : ''}'
      : hatching
      ? 'Hatching...'
      : '${mood.name} · $reason';
  String get statusTooltip => identity == null
      ? '${journey.complete ? 'Your companion is ready. Click to hatch.' : 'A companion is inside. Click to explore.'}\n$statusDetail'
      : '$statusLabel\n$statusDetail';

  void _journeyChanged() {
    if (_disposed) return;
    if (_scope != journey.scope) {
      _scope = journey.scope;
      _cancelTimers();
      _completion = null;
      _lastDiscoveryCount = null;
      _turnsByMachine.clear();
      _reaction = null;
      _frame = null;
      _reply = null;
      _reactionReason = null;
      _napUntil = null;
      _lastMoment = null;
      _awayAt = null;
      _working = _needsInput = _browsing = _blocked = false;
      _daypart = CompanionDaypart.at(_now());
      hatching = false;
    }
    final previousDiscoveryCount = _lastDiscoveryCount;
    _lastDiscoveryCount = journey.loaded ? journey.completedCount : null;
    final discoveryEarned =
        identity == null &&
        previousDiscoveryCount != null &&
        _lastDiscoveryCount != null &&
        _lastDiscoveryCount! > previousDiscoveryCount;
    if (!motionEnabled) {
      _stopFrames();
      hatching = false;
    }
    if (identity != null) _clearEggReply();
    if (discoveryEarned && _foreground) {
      _eggReaction(switch (journey.completedCount) {
        1 => 'something stirred in here.',
        2 => 'oh. hello out there.',
        _ => 'i think i am ready. hello?',
      });
      return;
    }
    notifyListeners();
  }

  /// A small hello through the shell. It never earns or stores a discovery.
  void knock() {
    if (_disposed ||
        !journey.loaded ||
        identity != null ||
        journey.complete ||
        !_foreground ||
        _knocking) {
      return;
    }
    _eggReaction('a tiny rustle from inside.', knock: true);
  }

  void _eggReaction(String reply, {bool knock = false}) {
    _lastMoment = _now();
    _clearEggReply();
    _knocking = knock;
    _eggReply = reply;
    _eggReplyTimer = Timer(const Duration(seconds: 3), () {
      _eggReplyTimer = null;
      _eggReply = null;
      _knocking = false;
      if (!_disposed) notifyListeners();
    });
    if (motionEnabled) {
      _animate(_eggFrames(), const Duration(milliseconds: 160));
    } else {
      _stopFrames();
      notifyListeners();
    }
  }

  List<String> _eggFrames() {
    final nest = _restingEgg;
    return switch (_eggStage) {
      2 => [nest, r'\_--_/', nest],
      3 => [nest, r'\_-.-_/', nest, r'\_^.^_/', nest],
      _ => [' $nest', nest, '$nest ', nest],
    };
  }

  void _clearEggReply() {
    _eggReplyTimer?.cancel();
    _eggReplyTimer = null;
    _eggReply = null;
    _knocking = false;
  }

  void sync({
    required bool working,
    required bool needsInput,
    required bool browsing,
    required int completedTurns,
    bool blocked = false,
    Map<String, int>? turnsByMachine,
  }) {
    if (_disposed) return;
    final previous = mood;
    final changed =
        _working != working ||
        _needsInput != needsInput ||
        _browsing != browsing ||
        _blocked != blocked;
    final finished = turnsByMachine == null
        ? _completion != null && completedTurns > _completion!
        : turnsByMachine.entries.any(
            (e) =>
                _turnsByMachine.containsKey(e.key) &&
                e.value > _turnsByMachine[e.key]!,
          );
    _completion = completedTurns;
    if (turnsByMachine != null) _turnsByMachine.addAll(turnsByMachine);
    _working = working;
    _needsInput = needsInput;
    _browsing = browsing;
    _blocked = blocked;
    if (changed && identity != null && !hatching && !_manualReaction) {
      _stopFrames();
    }
    if (needsInput && !_manualReaction) _clearReaction();
    final daypartChanged = _refreshDaypart();
    if (finished &&
        journey.loaded &&
        !needsInput &&
        !napping &&
        !hatching &&
        _reaction == null &&
        _eggReplyTimer == null &&
        _foreground &&
        (_lastMoment == null ||
            _now().difference(_lastMoment!) >= _completionCooldown)) {
      if (identity == null) {
        _eggReaction('a little cheer from inside.');
      } else {
        _greet(
          CompanionMood.celebrating,
          'A harness finished a turn. Nice work.',
        );
      }
      return;
    }
    if (previous != mood || changed || daypartChanged) notifyListeners();
  }

  void setEnvironment({required bool foreground, bool reduceMotion = false}) {
    if (_disposed) return;
    final wasForeground = _foreground;
    final daypartChanged = _refreshDaypart();
    final changed = _foreground != foreground || _reduceMotion != reduceMotion;
    _foreground = foreground;
    _reduceMotion = reduceMotion;
    if (!foreground) {
      _awayAt ??= _now();
      _cancelTimers();
      _reaction = null;
      _manualReaction = false;
      _frame = null;
      _reply = null;
      hatching = false;
    } else {
      final returned =
          !wasForeground &&
          _awayAt != null &&
          _now().difference(_awayAt!) >= const Duration(minutes: 15);
      _awayAt = null;
      if (_napUntil != null && !_now().isBefore(_napUntil!)) _napUntil = null;
      if (!motionEnabled) {
        _stopFrames();
        hatching = false;
      }
      _scheduleNap();
      if (returned && journey.loaded && !napping && !_needsInput && !hatching) {
        if (identity == null) {
          _eggReaction('oh. you came back.');
        } else {
          _greet(CompanionMood.affectionate, 'Welcome back. I kept your spot.');
        }
        return;
      }
    }
    if (changed || daypartChanged) notifyListeners();
  }

  bool _refreshDaypart() {
    final next = CompanionDaypart.at(_now());
    if (next == _daypart) return false;
    _daypart = next;
    return true;
  }

  // A single blink accompanies a meaningful moment, then the new expression
  // rests. Finishing an animation never schedules another one.
  void _greet(CompanionMood value, String reason) {
    react(value, manual: false, reason: reason);
    if (motionEnabled) {
      _animate([identity!.species.blink], const Duration(milliseconds: 160));
    }
  }

  void react(
    CompanionMood value, {
    Duration duration = const Duration(seconds: 6),
    bool manual = true,
    String? reason,
  }) {
    if (_disposed || identity == null || hatching || !_foreground) return;
    _lastMoment = _now();
    _refreshDaypart();
    _clearReaction();
    _stopFrames();
    _reaction = value;
    _manualReaction = manual;
    _reactionReason = reason ?? value.trigger;
    if (manual) _reply = identity!.species.quote(value);
    notifyListeners();
    _reactionTimer = Timer(duration, () {
      _reactionTimer = null;
      _reaction = null;
      _reactionReason = null;
      _manualReaction = false;
      _reply = null;
      if (!_disposed) notifyListeners();
    });
  }

  void pet() {
    if (_disposed || identity == null || hatching || !_foreground) return;
    wake();
    react(
      CompanionMood.affectionate,
      reason: 'A little affection goes a long way.',
    );
  }

  void playHabit({bool reduceMotion = false}) {
    if (_disposed || identity == null || hatching || !_foreground) return;
    wake();
    react(CompanionMood.happy, reason: identity!.species.habit);
    if (!reduceMotion && motionEnabled) {
      _animate(
        identity!.species.habitFrames,
        const Duration(milliseconds: 320),
      );
    }
  }

  void nap() {
    if (_disposed || identity == null || hatching || !_foreground) return;
    _clearReaction();
    _stopFrames();
    _refreshDaypart();
    _napTimer?.cancel();
    _napTimer = null;
    _napUntil = _now().add(const Duration(minutes: 15));
    _reply = identity!.species.quote(CompanionMood.asleep);
    _scheduleNap();
    notifyListeners();
  }

  void wake() {
    if (_disposed || identity == null || !_foreground) return;
    _napTimer?.cancel();
    _napTimer = null;
    _napUntil = null;
    _reply = null;
    _refreshDaypart();
    notifyListeners();
  }

  /// Little local replies; input is bounded and is never stored or transmitted.
  bool say(String text) {
    if (_disposed || identity == null || hatching || !_foreground) return false;
    final message = text.trim();
    if (message.isEmpty ||
        message.runes.length > 160 ||
        RegExp(r'[\x00-\x1f\x7f]').hasMatch(message)) {
      return false;
    }
    final words = message.toLowerCase();
    bool has(String pattern) =>
        RegExp(pattern, caseSensitive: false).hasMatch(words);
    if (has(r'^/?(nap|sleep|goodnight|good night)(\b|$)')) {
      nap();
      return true;
    }
    if (has(r'^/?(wake|wake up)(\b|$)')) {
      wake();
      _answer(CompanionMood.content, identity!.species.dayQuote(_daypart));
      return true;
    }
    if (has(r'^/?(play|dance|trick)(\b|$)')) {
      playHabit();
      return true;
    }
    if (has(r'^/?pet(\b|$)')) {
      pet();
      return true;
    }
    if (words.startsWith('/name ')) {
      final name = message.substring(6).trim();
      wake();
      final named = journey.nameCompanion(name);
      _answer(
        named ? CompanionMood.affectionate : CompanionMood.curious,
        named ? 'you can call me $name.' : 'a name needs 1 to 24 characters.',
      );
      return true;
    }
    wake();
    final prompt = has(r'(^|\s)/?help$')
        ? CompanionPrompt.help
        : has(r'\b(boop|boo|poke)\b')
        ? CompanionPrompt.boop
        : has(r'\b(pep talk|stuck|stressed|stress|tired|encourage|hard day)\b')
        ? CompanionPrompt.encouragement
        : has(r'\b(sad|rough day|bad day|sigh)\b')
        ? CompanionPrompt.comfort
        : has(r'\b(complain|vent|grumpy)\b')
        ? CompanionPrompt.complaint
        : has(r'\b(error|bug|broken|oops)\b')
        ? CompanionPrompt.puzzle
        : has(r'\b(yay|shipped|hooray|celebrate|we did it)\b')
        ? CompanionPrompt.celebration
        : has(
            r'\b(thanks|thank you|love|good (cat|mouse|snail|fish|spider|bat))\b',
          )
        ? CompanionPrompt.thanks
        : has(r'\b(joke|funny)\b')
        ? CompanionPrompt.joke
        : has(r'\b(hello|hi|hey|morning|evening)\b')
        ? CompanionPrompt.greeting
        : CompanionPrompt.unknown;
    _answer(prompt.mood, identity!.species.reply(prompt, _replyIndex++));
    return true;
  }

  void _answer(CompanionMood mood, String reply) {
    react(
      mood,
      duration: const Duration(seconds: 12),
      reason: 'A little chat with you.',
    );
    _reply = reply;
    notifyListeners();
  }

  void hatch({bool reduceMotion = false}) {
    if (_disposed ||
        hatching ||
        !journey.complete ||
        identity != null ||
        !_foreground) {
      return;
    }
    hatching = !(reduceMotion || !motionEnabled);
    if (!journey.hatchCompanion()) {
      hatching = false;
      return;
    }
    if (!hatching) {
      react(
        CompanionMood.happy,
        reason: 'Hello, world. Your companion is here.',
      );
      return;
    }
    final species = identity!.species;
    _animate(
      [
        readyEgg,
        readyEgg,
        r'\_-.-_/',
        readyEgg,
        r'\_^.^_/',
        species.pose(CompanionMood.startled),
        species.pose(CompanionMood.startled),
        species.blink,
        species.pose(CompanionMood.happy),
      ],
      const Duration(milliseconds: 200),
      onDone: () {
        hatching = false;
        react(
          CompanionMood.happy,
          reason: 'Hello, world. Your companion is here.',
        );
      },
    );
  }

  void _animate(
    List<String> frames,
    Duration interval, {
    VoidCallback? onDone,
  }) {
    _stopFrames();
    var index = 0;
    _frame = frames[index++];
    notifyListeners();
    _frameTimer = Timer.periodic(interval, (timer) {
      if (_disposed || index == frames.length) {
        timer.cancel();
        _frameTimer = null;
        _frame = null;
        if (!_disposed) {
          onDone?.call();
          notifyListeners();
        }
      } else {
        _frame = frames[index++];
        notifyListeners();
      }
    });
  }

  void _scheduleNap() {
    if (!napping || !_foreground || _napTimer != null) return;
    final remaining = _napUntil!.difference(_now());
    _napTimer = Timer(remaining.isNegative ? Duration.zero : remaining, wake);
  }

  void _clearReaction() {
    _reactionTimer?.cancel();
    _reactionTimer = null;
    _reaction = null;
    _reactionReason = null;
    _manualReaction = false;
    _reply = null;
  }

  void _stopFrames() {
    _frameTimer?.cancel();
    _frameTimer = null;
    _frame = null;
  }

  void _cancelTimers() {
    _clearReaction();
    _stopFrames();
    _napTimer?.cancel();
    _napTimer = null;
    _clearEggReply();
  }

  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    journey.removeListener(_journeyChanged);
    _cancelTimers();
    super.dispose();
  }
}
