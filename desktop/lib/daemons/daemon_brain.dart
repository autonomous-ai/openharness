/// The window's half of the pair brain (`daemons/BRAIN.md`, "Frames" and
/// "As built"). harnessd senses every harness on every machine and thinks on
/// the computer you are at; this window hears what it decided and answers.
/// Frame shapes are `cli/src/pair/protocol.ts` and `cli/src/pair/brain.ts`.
///
/// In (local frames from this computer's own harnessd only):
///   `daemon_state { pair, needs[], working, failing[], machines[], done,
///     asks[], acted[] }`
///   `daemon_say { id, about, mood, line, actions[{key,label,choice}], ttlMs }`
///   `daemon_unsay { id, reason }`
///   `daemon_brief { desk, line, items[] }`
///   `daemon_act_result { requestId, id, ok, open?, error?, detail? }`
///   `daemon_talk_result { requestId, ok, agentId?, started? | resumed? |
///     sent?, error?, detail? }`
///   `pair_result { requestId, ... }`: the answer to a `pair` request
/// Out (only on the socket bound to this computer's harnessd):
///   `daemon_act { requestId, id, choice }`
///   `daemon_talk { requestId, text }`
///   `pair { requestId, verb, ... }`: the control interface's local request
///     (`harness pair lessons ...` uses the same path)
///   `daemon_presence { active?, awayMs?, desk, pair?, autonomy?,
///     focusMachineId?, focusAgentId?, doneSeen? }`: the pane in front of you
///     is never spoken about
///
/// An older harnessd sends none of these; the face then keeps the roster's
/// lines and the window's own view of its harnesses. A harnessd whose daemons
/// are switched off (daemons/README.md, "Off switches") answers every request
/// with `error: 'DAEMONS_OFF'`: the window hears [DaemonBrain.switchedOff] and
/// hides everything.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter/foundation.dart';

import '../core/local_key_value_store.dart';
import 'roster.dart';

typedef DaemonAction = ({String key, String label, String choice});

List<DaemonAction> _actions(Object? raw) => [
  for (final a in raw is List ? raw : const [])
    if (a is Map &&
        a['key'] is String &&
        (a['key'] as String).isNotEmpty &&
        a['label'] is String)
      (
        key: (a['key'] as String).toLowerCase(),
        label: a['label'] as String,
        choice: a['choice'] is String
            ? a['choice'] as String
            : a['key'] as String,
      ),
];

String _str(Object? value) => value is String ? value : '';
String? _opt(Object? value) =>
    value is String && value.isNotEmpty ? value : null;
int _int(Object? value) => value is num ? value.toInt() : 0;
DateTime? _at(Object? value) =>
    value is num ? DateTime.fromMillisecondsSinceEpoch(value.toInt()) : null;

/// The keys a line offers, first, as the brain writes them (`voice.ts`
/// `keysPrefix`): `[y/n/s/g] `, in that order, only the ones offered. `s`
/// shows a lesson.
String daemonKeysPrefix(List<DaemonAction> actions) {
  final keys = [
    for (final k in const ['y', 'n', 's', 'g'])
      if (actions.any((a) => a.key == k)) k,
  ];
  return keys.isEmpty ? '' : '[${keys.join('/')}] ';
}

final _keysAtStart = RegExp(r'^\[([a-z](?:/[a-z])*)\] ');

/// A line split into the keys it starts with and the rest: `[y/n/g] api:
/// npm test` is `(['y','n','g'], 'api: npm test')`. A line that offers
/// answers but does not start with its keys gets them put first, so a key is
/// always where the eye starts.
({List<String> keys, String rest}) splitDaemonKeys(
  String line,
  List<DaemonAction> actions,
) {
  final match = _keysAtStart.firstMatch(line);
  if (match != null) {
    return (keys: match.group(1)!.split('/'), rest: line.substring(match.end));
  }
  final prefix = daemonKeysPrefix(actions);
  if (prefix.isEmpty) return (keys: const [], rest: line);
  return (keys: prefix.substring(1, prefix.length - 2).split('/'), rest: line);
}

/// What a line is about: a harness on a machine, and the question on it.
@immutable
class DaemonAbout {
  const DaemonAbout(this.machineId, this.agentId, {this.requestId});
  final String machineId, agentId;
  final String? requestId;

  /// `machineId/agentId`, the window's id for a harness; null when the line
  /// is about no harness in particular (a return, a batch of proposals).
  String? get key =>
      machineId.isEmpty || agentId.isEmpty ? null : '$machineId/$agentId';

  static DaemonAbout? fromJson(Object? raw) {
    if (raw is! Map) return null;
    return DaemonAbout(
      _str(raw['machineId']),
      _str(raw['agentId']),
      requestId: _opt(raw['requestId']),
    );
  }
}

/// The harness a proposal or a line is about, named the way the person names
/// it (`protocol.ts` `DaemonHarness`): every approval shows it.
@immutable
class DaemonHarness {
  const DaemonHarness({
    required this.name,
    this.machineId = '',
    this.machine = '',
    this.agentId,
  });
  final String machineId, machine, name;
  final String? agentId;

  /// `api@office`.
  String get label => machine.isEmpty ? name : '$name@$machine';

  static DaemonHarness? fromJson(Object? raw) {
    if (raw is! Map || raw['name'] is! String) return null;
    return DaemonHarness(
      machineId: _str(raw['machineId']),
      machine: _str(raw['machine']),
      agentId: _opt(raw['agentId']),
      name: raw['name'] as String,
    );
  }
}

/// A setting that waits for the person's yes at a window (`pair/gate.ts`):
/// a raise of the dial above `suggest`, or a pair.jsonc that turns rules, the
/// model or a learning opt-in on. Answered with `daemon_confirm`, never
/// `daemon_act`.
@immutable
class DaemonConfirm {
  const DaemonConfirm({
    required this.kind,
    required this.nonce,
    this.id = '',
    this.line = '',
    this.detail = '',
    this.actions = const [],
    this.at,
    this.level,
  });

  /// `autonomy` or `rules`.
  final String kind, nonce;

  /// `confirm:<kind>:<nonce>`: what `daemon_shown` names.
  final String id;
  final String line;

  /// Exactly what a yes turns on: the level and what it lets the daemon do,
  /// or the whole pair.jsonc.
  final String detail;
  final List<DaemonAction> actions;
  final DateTime? at;

  /// On an autonomy request: the level asked for.
  final String? level;

  /// The id the daemon records a line under: `confirm:<kind>:<nonce>`.
  static String idFor(String kind, String nonce) => 'confirm:$kind:$nonce';

  static DaemonConfirm? fromJson(Object? raw) {
    if (raw is! Map || raw['kind'] is! String || raw['nonce'] is! String) {
      return null;
    }
    final kind = raw['kind'] as String, nonce = raw['nonce'] as String;
    if (kind.isEmpty || nonce.isEmpty) return null;
    return DaemonConfirm(
      kind: kind,
      nonce: nonce,
      id: _opt(raw['id']) ?? idFor(kind, nonce),
      line: _str(raw['line']),
      detail: _str(raw['detail']),
      actions: _actions(raw['actions']),
      at: _at(raw['at']),
      level: _opt(raw['level']),
    );
  }
}

/// The mood a `daemon_say` was sent with (`protocol.ts` `DaemonMood`).
/// `auto` (a rule or the pair acted) is drawn like done, `say` (the pair
/// talking) like idle, `ask` (a proposal waiting for your key) like need.
enum DaemonSayMood {
  need,
  done,
  fail,
  back,
  auto,
  say,
  ask;

  static DaemonSayMood? named(Object? name) =>
      values.where((m) => m.name == name).firstOrNull;

  /// The face the line wants (BRAIN.md, "As built").
  DaemonMood get face => switch (this) {
    need || ask => DaemonMood.need,
    done || auto => DaemonMood.done,
    fail => DaemonMood.fail,
    back => DaemonMood.back,
    say => DaemonMood.idle,
  };
}

/// A harness waiting on you, as the brain sees it (on any machine).
@immutable
class DaemonNeed {
  const DaemonNeed({
    required this.machineId,
    required this.agentId,
    required this.requestId,
    this.machine = '',
    this.name = '',
    this.engine = '',
    this.question = '',
    this.deny = false,
    this.allow = false,
    this.options = const [],
    this.detail,
    this.since,
    this.sayId,
    this.line,
    this.actions = const [],
  });
  final String machineId, agentId, requestId, machine, name, engine, question;
  final bool deny, allow;
  final List<String> options;

  /// The whole dialog as painted: the exact command, or the edit's preview.
  /// What a `[y]` on its line would approve, shown in full before a key.
  final String? detail;
  final DateTime? since;

  /// `api@office`.
  String get who => machine.isEmpty ? name : '$name@$machine';

  /// Its line and keys, only while its line shows (the brain drops them
  /// after `ttlMs`; after that the need is listed for you to open).
  final String? sayId, line;
  final List<DaemonAction> actions;

  /// The same id the window gives a question it sees itself.
  String get key => '$machineId/$agentId#$requestId';

  /// `machineId/agentId`.
  String get harness => '$machineId/$agentId';

  static DaemonNeed? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final machineId = raw['machineId'], agentId = raw['agentId'];
    final requestId = raw['requestId'];
    if (machineId is! String || agentId is! String || requestId is! String) {
      return null;
    }
    return DaemonNeed(
      machineId: machineId,
      agentId: agentId,
      requestId: requestId,
      machine: _str(raw['machine']),
      name: _str(raw['name']),
      engine: _str(raw['engine']),
      question: _str(raw['question']),
      deny: raw['deny'] == true,
      allow: raw['allow'] == true,
      options: [
        for (final o in raw['options'] is List ? raw['options'] as List : [])
          if (o is String) o,
      ],
      detail: _opt(raw['detail']),
      since: _at(raw['since']),
      sayId: _opt(raw['id']),
      line: _opt(raw['line']),
      actions: _actions(raw['actions']),
    );
  }
}

/// One machine of the fleet. `asleep` (the account lists it offline) and
/// `unreachable` are calm facts, never a failure.
@immutable
class DaemonMachine {
  const DaemonMachine({
    required this.name,
    this.machineId = '',
    this.status = 'ok',
    this.local = false,
  });
  final String machineId, name;

  /// `ok`, `connecting`, `unreachable`, `asleep`, `unlinked`, `old`, `off`.
  final String status;
  final bool local;

  /// Something to say about it in the panel: everything but `ok` and a link
  /// still coming up.
  bool get away => status != 'ok' && status != 'connecting';

  static DaemonMachine? fromJson(Object? raw) {
    if (raw is! Map || raw['name'] is! String) return null;
    return DaemonMachine(
      machineId: _str(raw['machineId']),
      name: raw['name'] as String,
      status: _opt(raw['status']) ?? 'ok',
      local: raw['local'] == true,
    );
  }
}

/// How the panel says a machine that is not `ok`, calmly. `offline` is what
/// the window alone can tell: it cannot reach it.
String daemonMachineLine(String name, String status) => switch (status) {
  'asleep' => '$name is asleep. its harnesses wait.',
  'unreachable' => '$name is out of reach. its harnesses wait.',
  'unlinked' => '$name is not linked to this computer.',
  'old' => '$name runs an older harness. update it to see its harnesses.',
  'off' => '$name has pairing off.',
  _ => '$name is asleep or unreachable. its harnesses wait.',
};

/// A harness whose last turn failed, or that failed to start.
@immutable
class DaemonFailing {
  const DaemonFailing({
    this.machineId = '',
    this.machine = '',
    this.agentId = '',
    this.name = '',
    this.reason = '',
  });
  final String machineId, machine, agentId, name, reason;

  static DaemonFailing? fromJson(Object? raw) => raw is Map
      ? DaemonFailing(
          machineId: _str(raw['machineId']),
          machine: _str(raw['machine']),
          agentId: _str(raw['agentId']),
          name: _str(raw['name']),
          reason: _str(raw['reason']),
        )
      : null;
}

/// A turn that finished since you last looked (`daemon_state.done.last`).
@immutable
class DaemonDone {
  const DaemonDone({
    this.machineId = '',
    this.machine = '',
    this.agentId = '',
    this.name = '',
    this.recap,
    this.at,
  });
  final String machineId, machine, agentId, name;
  final String? recap;
  final DateTime? at;

  /// `api@office finished: tests pass.`
  String get line =>
      '$name finished${recap == null ? '.' : ': ${recap!.trim()}'}';

  static DaemonDone? fromJson(Object? raw) => raw is Map
      ? DaemonDone(
          machineId: _str(raw['machineId']),
          machine: _str(raw['machine']),
          agentId: _str(raw['agentId']),
          name: _str(raw['name']),
          recap: _opt(raw['recap']),
          at: _at(raw['at']),
        )
      : null;
}

/// A proposal waiting for your key (`daemon_state.asks`): the pair wants to
/// do something and the dial says to ask, or a lesson waits for the person.
/// Its keys work for ten minutes. One proposal, one key: there are no
/// batches.
@immutable
class DaemonAsk {
  const DaemonAsk({
    required this.id,
    required this.line,
    this.actions = const [],
    this.detail,
    this.harness,
    this.from,
    this.verb,
    this.at,
  });
  final String id, line;
  final List<DaemonAction> actions;

  /// What a key would do, exactly and in full: the command, the whole
  /// prompt, a start's folder and first prompt; a lesson's whole text.
  final String? detail;

  /// The harness it is about, by name and machine.
  final DaemonHarness? harness;

  /// `pair` when the pair harness asks (a model's request, not a fact).
  final String? from;
  final String? verb;
  final DateTime? at;

  bool get fromPair => from == 'pair';

  /// A lesson's line: `lesson:<lessonId>:<nonce>`. Its id is a one-time
  /// nonce, sent only to windows: a key on it is the person's alone.
  bool get isLesson => id.startsWith('lesson:');

  /// The lesson it proposes, for a lesson's line.
  String? get lessonId {
    if (!isLesson) return null;
    final parts = id.split(':');
    return parts.length >= 3 && parts[1].isNotEmpty ? parts[1] : null;
  }

  static DaemonAsk? fromJson(Object? raw) {
    if (raw is! Map || raw['id'] is! String || raw['line'] is! String) {
      return null;
    }
    return DaemonAsk(
      id: raw['id'] as String,
      line: raw['line'] as String,
      actions: _actions(raw['actions']),
      detail: _opt(raw['detail']),
      harness: DaemonHarness.fromJson(raw['harness']),
      from: _opt(raw['from']),
      verb: _opt(raw['verb']),
      at: _at(raw['at']),
    );
  }
}

/// Something a rule or the pair did on its own, reported afterwards.
@immutable
class DaemonActed {
  const DaemonActed({
    this.machineId = '',
    this.machine = '',
    this.agentId = '',
    this.name = '',
    this.by = '',
    this.action = '',
    this.text = '',
    this.at,
  });
  final String machineId, machine, agentId, name;

  /// `rule` or `pair`.
  final String by;
  final String action, text;
  final DateTime? at;

  /// `rule: api@office answered "Yes"`, as the brain's `auto` line says it.
  String get line =>
      '$by: $name ${text.isNotEmpty
          ? text
          : action.isNotEmpty
          ? action
          : 'acted'}';

  static DaemonActed? fromJson(Object? raw) => raw is Map
      ? DaemonActed(
          machineId: _str(raw['machineId']),
          machine: _str(raw['machine']),
          agentId: _str(raw['agentId']),
          name: _str(raw['name']),
          by: _str(raw['by']),
          action: _str(raw['action']),
          text: _str(raw['text']),
          at: _at(raw['at']),
        )
      : null;
}

@immutable
class DaemonBrainState {
  const DaemonBrainState({
    this.pair,
    this.needs = const [],
    this.workingCount = 0,
    this.failing = const [],
    this.machines = const [],
    this.doneCount = 0,
    this.doneLast = const [],
    this.asks = const [],
    this.acted = const [],
    this.autonomy,
    this.autonomyRequested,
    this.confirms = const [],
  });

  /// The daemon the brain pairs with; null means "use the roster lines".
  final String? pair;

  /// The level the daemon acts at right now, and a higher one the zoo asks
  /// for that waits for the person's yes (`pair/gate.ts`). Null from a
  /// harnessd that predates the gate.
  final String? autonomy, autonomyRequested;

  /// What waits for the person's yes: a raise of the dial, a pair.jsonc.
  final List<DaemonConfirm> confirms;
  final List<DaemonNeed> needs;

  /// Harnesses working (not waiting on a question), on every machine.
  final int workingCount;
  bool get working => workingCount > 0;
  final List<DaemonFailing> failing;
  final List<DaemonMachine> machines;

  /// Turns finished since you last looked (the `+n`), and the last few.
  final int doneCount;
  final List<DaemonDone> doneLast;

  /// Proposals waiting for your key.
  final List<DaemonAsk> asks;

  /// What a rule or the pair did on its own, newest first.
  final List<DaemonActed> acted;

  static List<T> _list<T>(Object? raw, T? Function(Object?) parse) => [
    for (final item in raw is List ? raw : const []) ?parse(item),
  ];

  static DaemonBrainState fromJson(Map raw) {
    final done = raw['done'] is Map ? raw['done'] as Map : const {};
    final working = raw['working'];
    return DaemonBrainState(
      pair: _opt(raw['pair']),
      needs: _list(raw['needs'], DaemonNeed.fromJson),
      workingCount: working is num
          ? max(0, working.toInt())
          : working == true
          ? 1
          : 0,
      failing: _list(raw['failing'], DaemonFailing.fromJson),
      machines: _list(raw['machines'], DaemonMachine.fromJson),
      doneCount: max(0, _int(done['count'])),
      doneLast: _list(done['last'], DaemonDone.fromJson),
      asks: _list(raw['asks'], DaemonAsk.fromJson),
      acted: _list(raw['acted'], DaemonActed.fromJson),
      autonomy: _opt(raw['autonomy']),
      autonomyRequested: _opt(raw['autonomyRequested']),
      confirms: _list(raw['confirms'], DaemonConfirm.fromJson),
    );
  }
}

/// One line the brain wants said, maybe with answers.
@immutable
class DaemonSay {
  const DaemonSay({
    required this.id,
    required this.line,
    this.about,
    this.mood,
    this.actions = const [],
    this.ttl,
    this.from,
    this.detail,
    this.harness,
    this.confirm,
    this.reply,
    this.companionUid,
  });
  final String id, line;
  final String? reply, companionUid;
  final DaemonAbout? about;
  final DaemonSayMood? mood;
  final List<DaemonAction> actions;
  final Duration? ttl;

  /// Who is speaking: `pair` is the pair harness (a model's words or
  /// request, drawn as it speaking); absent is the daemon's own facts.
  final String? from;

  /// What a key on this line would do, exactly and in full. Shown with the
  /// line before `daemon_shown`; `line` is only its one-line summary.
  final String? detail;

  /// The harness it is about, by name and machine.
  final DaemonHarness? harness;

  /// A setting waiting for the person's yes: its keys are `daemon_confirm`.
  final ({String kind, String nonce})? confirm;

  bool get fromPair => from == 'pair';

  /// `machineId/agentId` of the harness it is about, if any.
  String? get aboutKey => about?.key;

  static DaemonSay? fromJson(Map raw) {
    final id = raw['id'], line = raw['line'];
    if (id is! String || line is! String || line.trim().isEmpty) return null;
    final ttl = raw['ttlMs'];
    final mood = DaemonSayMood.named(raw['mood']);
    final from = _opt(raw['from']);
    final confirm = raw['confirm'];
    return DaemonSay(
      id: id,
      line: line.trim(),
      reply: _opt(raw['reply'])
          ?.substring(0, _str(raw['reply']).length.clamp(0, 8000)),
      companionUid: _opt(raw['companionUid']),
      about: DaemonAbout.fromJson(raw['about']),
      mood: mood,
      // The pair talking never carries a key, whatever it sends (BRAIN.md,
      // "Security" 5): only a proposal of its own does.
      actions: from == 'pair' && mood == DaemonSayMood.say
          ? const []
          : _actions(raw['actions']),
      ttl: ttl is num && ttl > 0 ? Duration(milliseconds: ttl.toInt()) : null,
      from: from,
      detail: _opt(raw['detail']),
      harness: DaemonHarness.fromJson(raw['harness']),
      confirm:
          confirm is Map &&
              confirm['kind'] is String &&
              confirm['nonce'] is String &&
              (confirm['nonce'] as String).isNotEmpty
          ? (kind: confirm['kind'] as String, nonce: confirm['nonce'] as String)
          : null,
    );
  }
}

/// One item of a brief: what waits on you (with its keys first), what
/// failed, a machine asleep or out of reach, what finished.
@immutable
class DaemonBriefItem {
  const DaemonBriefItem({
    required this.line,
    this.id = '',
    this.kind = '',
    this.machineId = '',
    this.machine = '',
    this.agentId,
    this.name,
    this.actions = const [],
    this.text,
    this.detail,
  });
  final String id, kind, machineId, machine, line;
  final String? agentId, name;
  final List<DaemonAction> actions;

  /// A `lesson` item's full text (the SKILL.md or note), shown on `[s]`.
  final String? text;

  /// What a waiting item's `[y]` would approve, in full.
  final String? detail;

  /// Everything a key on it would act on, to show before its keys arm: the
  /// dialog, or a lesson's whole text.
  String? get shows => detail ?? text;

  /// The harness it is about, when it is about one.
  DaemonAbout? get about => agentId == null || machineId.isEmpty
      ? null
      : DaemonAbout(machineId, agentId!);

  static DaemonBriefItem? fromJson(Object? raw) {
    if (raw is! Map || raw['line'] is! String) return null;
    return DaemonBriefItem(
      id: _str(raw['id']),
      kind: _str(raw['kind']),
      machineId: _str(raw['machineId']),
      machine: _str(raw['machine']),
      agentId: _opt(raw['agentId']),
      name: _opt(raw['name']),
      line: raw['line'] as String,
      actions: _actions(raw['actions']),
      text: raw['text'] is String ? raw['text'] as String : null,
      detail: _opt(raw['detail']),
    );
  }
}

/// What a key on a line did (`daemon_act_result`), for whoever showed it: a
/// lesson learned or skipped, its text, or why nothing happened.
@immutable
class DaemonActResult {
  const DaemonActResult({
    required this.id,
    required this.ok,
    this.error,
    this.detail,
    this.learned,
    this.skipped,
    this.lesson,
  });
  final String id;
  final bool ok;
  final String? error, detail;

  /// On a lesson's line: the name taught or skipped, or its text for `[s]`.
  final String? learned, skipped, lesson;
}

@immutable
class DaemonBrief {
  const DaemonBrief({required this.line, this.items = const [], this.at});

  /// A brief's keys work this long (`brain.ts` `BRIEF_KEYS_MS`).
  static const keysFor = Duration(seconds: 60);

  /// At most this many items (`brief.ts` `BRIEF_ITEMS_MAX`).
  static const maxItems = 5;
  final String line;
  final List<DaemonBriefItem> items;

  /// When it arrived.
  final DateTime? at;

  /// Its answer keys still work (`[g]` opens a harness at any time).
  bool keysLive(DateTime now) => at != null && now.difference(at!) < keysFor;
}

/// Where the talk with the pair harness is.
enum DaemonTalkPhase {
  /// Nothing said yet, or it has answered.
  idle,

  /// Sent; harnessd is starting, resuming or reaching the pair harness.
  waking,

  /// The pair harness was started for these words (a new conversation).
  started,

  /// It was paused and has been resumed.
  resumed,

  /// It was running: the words went straight in.
  sent,

  /// The words did not reach it ([DaemonBrain.talkError] says why).
  failed,
}

/// One turn of the talk: yours, or the daemon's reply (`daemon_say`, `say`).
typedef DaemonTalkEntry = ({bool you, String text});

class DaemonBrain extends ChangeNotifier {
  DaemonBrain({
    required this.send,
    this.storage,
    Random? random,
    DateTime Function()? now,
  }) : _random = random ?? Random.secure(),
       _now = now ?? DateTime.now;

  /// Sends one frame on the socket bound to this computer's harnessd; false
  /// when there is none (then nothing is sent anywhere else).
  final bool Function(String type, Map<String, dynamic> payload) send;
  final LocalKeyValueStore? storage;
  final Random _random;
  final DateTime Function() _now;
  static const deskKey = 'daemons.desk.v1';

  /// The talk keeps this many turns for the panel.
  static const talkKept = 80;

  /// A line's keys arm this long after the window said it drew it: the
  /// daemon's own 400 ms (`pair/shown.ts` `ARM_MS`), and a margin for the
  /// acknowledgement's trip, so a key the window offers is never too soon.
  static const armAfter = Duration(milliseconds: 450);

  /// Lines remembered as shown at once; the oldest go first (their keys
  /// stopped working long before).
  static const shownKept = 500;

  DaemonBrainState? _state;
  DaemonBrief? _brief;
  final _pendingActs = <String, String>{}; // requestId -> say id
  final _pendingConfirms = <String, String>{}; // requestId -> confirm id
  final _requests = <String, Completer<Map<String, dynamic>>>{};

  /// When this window acknowledged each line as drawn (`daemon_shown`).
  final _shownAt = <String, DateTime>{};
  final _armTimers = <String, Timer>{};

  /// How long a `pair` request waits for its answer.
  static const requestTimeout = Duration(seconds: 15);
  final _said = StreamController<DaemonSay>.broadcast(sync: true);
  final _unsaid = StreamController<String>.broadcast(sync: true);
  final _errors = StreamController<String>.broadcast(sync: true);
  final _opens = StreamController<DaemonAbout>.broadcast(sync: true);
  final _results = StreamController<DaemonActResult>.broadcast(sync: true);
  final _switchedOff = StreamController<void>.broadcast(sync: true);
  String? _desk;
  bool _disposed = false;

  String? _talkRequest;
  bool _talkNeedsSetup = false;
  Timer? _talkTimer;
  DaemonTalkPhase _talkPhase = DaemonTalkPhase.idle;
  String? _talkError;
  String? _talkCost;
  DateTime? _talkRetryAt;
  Timer? _talkRetryTimer;
  String? _pairAgentId;
  String? _pairEngine;
  String? _conversationScope, _companionUid;
  int _conversationGeneration = 0;
  bool _historyLoading = false;
  Future<void> _savingTalk = Future.value();
  final _talk = <DaemonTalkEntry>[];
  final _heardReplies = <String>{};

  /// Whether this harnessd has a brain (it has sent `daemon_state`).
  bool get active => _state != null;

  /// Whether a daemon is paired: its lines, its talk and its asks are live.
  bool get paired => _state?.pair != null;
  DaemonBrainState? get state => _state;
  DaemonBrief? get brief => _brief;
  DateTime now() => _now();
  Stream<DaemonSay> get said => _said.stream;
  Stream<String> get unsaid => _unsaid.stream;

  /// A failed answer, worded for the status line.
  Stream<String> get errors => _errors.stream;

  /// A harness to open: the brain answered `[g]` with it.
  Stream<DaemonAbout> get opens => _opens.stream;

  /// What each key did (a lesson learned or skipped, or why not).
  Stream<DaemonActResult> get results => _results.stream;

  /// harnessd answered a request with `DAEMONS_OFF`: daemons are off here.
  Stream<void> get switchedOff => _switchedOff.stream;

  DaemonTalkPhase get talkPhase => _talkPhase;
  String? get talkError => _talkError;

  /// What a talk costs, as harnessd says it with every answer.
  String? get talkCost => _talkCost;

  /// How long until the talk box takes words again (six a minute, sixty an
  /// hour), or null when it does now.
  Duration? get talkWait {
    final at = _talkRetryAt;
    if (at == null) return null;
    final left = at.difference(_now());
    return left > Duration.zero ? left : null;
  }

  /// The pair harness's agent id on this computer, once a talk reached it.
  String? get pairAgentId => _pairAgentId;
  String? get pairEngine => _pairEngine;

  /// The talk so far, oldest first: what you said and what it answered.
  List<DaemonTalkEntry> get talk => List.unmodifiable(_talk);
  bool get talkNeedsSetup => _talkNeedsSetup;

  /// Legacy compact replies stay archived by individual. The real agent terminal
  /// belongs to the collection and stays attached while changing characters.
  void bindConversation(String? scope, String? uid) {
    if (scope == _conversationScope && uid == _companionUid) return;
    final sameCollection = scope != null && scope == _conversationScope;
    _conversationScope = scope;
    _companionUid = uid;
    final generation = ++_conversationGeneration;
    _talkRequest = null;
    _talkTimer?.cancel();
    _talkTimer = null;
    _talkPhase = DaemonTalkPhase.idle;
    _talkNeedsSetup = false;
    _talkError = null;
    if (!sameCollection || uid == null) {
      _pairAgentId = null;
      _pairEngine = null;
    }
    _talk.clear();
    _heardReplies.clear();
    notifyListeners();
    final key = _conversationKey;
    _historyLoading = key != null && storage != null;
    if (_historyLoading) unawaited(_loadConversation(key!, generation));
  }

  String? get _conversationKey =>
      _conversationScope == null || _companionUid == null
      ? null
      : 'daemons.chat.v1.${base64Url.encode(utf8.encode(jsonEncode([_conversationScope, _companionUid])))}';

  Future<void> _loadConversation(String key, int generation) async {
    List<DaemonTalkEntry> saved = const [];
    try {
      final encoded = await storage?.read(key);
      final raw = encoded == null ? null : jsonDecode(encoded);
      if (raw is List) {
        saved = [
          for (final item in raw.take(talkKept))
            if (item is Map &&
                item['you'] is bool &&
                item['text'] is String &&
                (item['text'] as String).length <= 8000)
              (you: item['you'] as bool, text: item['text'] as String),
        ];
      }
    } catch (_) {
      /* A missing or unreadable local history starts empty. */
    }
    if (_disposed || generation != _conversationGeneration) return;
    final arrived = List<DaemonTalkEntry>.of(_talk);
    _talk
      ..clear()
      ..addAll([...saved, ...arrived]);
    if (_talk.length > talkKept) _talk.removeRange(0, _talk.length - talkKept);
    _historyLoading = false;
    if (arrived.isNotEmpty) _saveConversation();
    notifyListeners();
  }

  void _saveConversation() {
    final key = _conversationKey;
    if (key == null || storage == null || _historyLoading) return;
    final value = jsonEncode([
      for (final entry in _talk) {'you': entry.you, 'text': entry.text},
    ]);
    _savingTalk = _savingTalk.then((_) async {
      try {
        await storage!.write(key, value);
      } catch (_) {
        /* Live chat still works. */
      }
    });
  }

  Future<void> flushConversation() => _savingTalk;

  /// The level the daemon acts at now (the badge), when harnessd says.
  String? get autonomy => _state?.autonomy;

  /// A stable id for this computer's desk, so a brief is not repeated.
  Future<String> desk() async {
    if (_desk case final desk?) return desk;
    try {
      final stored = await storage?.read(deskKey);
      if (stored != null && stored.isNotEmpty) return _desk = stored;
    } catch (_) {}
    final id = _id(16);
    _desk = id;
    try {
      await storage?.write(deskKey, id);
    } catch (_) {}
    return id;
  }

  String _id(int bytes) => List.generate(
    bytes,
    (_) => _random.nextInt(256).toRadixString(16).padLeft(2, '0'),
  ).join();

  // ── shown, then armed ───────────────────────────────────────────────────

  /// Whether this window said it drew [id].
  bool wasShown(String id) => _shownAt.containsKey(id);

  /// Whether a key on [id] counts now: this window drew it, and its detail,
  /// at least [armAfter] ago. Until then its keys are drawn but do nothing.
  bool armed(String id) {
    final at = _shownAt[id];
    return at != null && !_now().isBefore(at.add(armAfter));
  }

  /// This window has drawn [id] and everything a key on it would act on
  /// (its `detail` in full). harnessd hears `daemon_shown` once; the line's
  /// keys arm [armAfter] later. Listeners hear both.
  void shown(String id) {
    if (_disposed || id.isEmpty || _shownAt.containsKey(id)) return;
    if (!send('daemon_shown', {'id': id})) return;
    _shownAt[id] = _now();
    while (_shownAt.length > shownKept) {
      final oldest = _shownAt.keys.first;
      _shownAt.remove(oldest);
      _armTimers.remove(oldest)?.cancel();
    }
    _armTimers[id]?.cancel();
    _armTimers[id] = Timer(armAfter, () {
      _armTimers.remove(id);
      if (!_disposed) notifyListeners();
    });
    // Whatever draws its keys hears that they are not armed yet.
    notifyListeners();
  }

  /// harnessd did not count a key as shown (a new connection, or the key came
  /// a moment early): acknowledge the line again, and arm it again.
  void _showAgain(String id) {
    _shownAt.remove(id);
    _armTimers.remove(id)?.cancel();
    shown(id);
    if (!_disposed) notifyListeners();
  }

  /// The replies to what this window asked (`daemon_act_result`,
  /// `daemon_confirm_result`, `daemon_talk_result`, `pair_result`).
  static const replies = {
    'daemon_act_result',
    'daemon_confirm_result',
    'daemon_talk_result',
    'daemon_open_result',
    'pair_result',
  };

  /// A local frame from this computer's harnessd.
  void receive(String type, Map<String, dynamic> payload) {
    if (_disposed) return;
    if (replies.contains(type) && payload['error'] == 'DAEMONS_OFF') {
      // Switched off in harnessd: nothing heard so far holds, and the
      // window hides everything. A `pair` request hears its own answer.
      final waiting = _requests.remove(payload['requestId']);
      if (waiting != null && !waiting.isCompleted) {
        waiting.complete({...payload}..remove('requestId'));
      }
      reset();
      _switchedOff.add(null);
      return;
    }
    switch (type) {
      case 'daemon_state':
        _state = DaemonBrainState.fromJson(payload);
        final harness = payload['companionHarness'];
        if (harness is Map) {
          _pairAgentId = _opt(harness['agentId']);
          _pairEngine = _opt(harness['engine']);
        }
        notifyListeners();
      case 'daemon_say':
        final say = DaemonSay.fromJson(payload);
        if (say == null) return;
        if (say.companionUid != null &&
            _companionUid != null &&
            say.companionUid != _companionUid) {
          return;
        }
        if (say.mood == DaemonSayMood.say && _heardReplies.add(say.id)) {
          if (_heardReplies.length > shownKept) {
            _heardReplies.remove(_heardReplies.first);
          }
          _heard(say.fromPair ? say.reply ?? say.line : say.line);
        }
        _said.add(say);
      case 'daemon_unsay':
        final id = payload['id'];
        if (id is String) _unsaid.add(id);
      case 'daemon_brief':
        final items = payload['items'];
        _brief = DaemonBrief(
          line: _str(payload['line']),
          items: [
            for (final item in items is List ? items : const [])
              ?DaemonBriefItem.fromJson(item),
          ].take(DaemonBrief.maxItems).toList(),
          at: _now(),
        );
        notifyListeners();
      case 'daemon_act_result':
        final requestId = payload['requestId'];
        if (requestId is! String) return;
        final id = _pendingActs.remove(requestId);
        if (id == null) return;
        final error = _opt(payload['error']);
        _results.add(
          DaemonActResult(
            id: id,
            ok: payload['ok'] == true,
            error: error,
            detail: _opt(payload['detail']),
            learned: _opt(payload['learned']),
            skipped: _opt(payload['skipped']),
            lesson: _opt(payload['lesson']),
          ),
        );
        if (payload['ok'] == true) {
          final about = DaemonAbout.fromJson(payload['open']);
          if (about?.key != null) _opens.add(about!);
          return;
        }
        if (error == 'NOT_SHOWN' || error == 'TOO_SOON') _showAgain(id);
        _errors.add(actError(error, _opt(payload['detail'])));
      case 'daemon_confirm_result':
        final requestId = payload['requestId'];
        if (requestId is! String) return;
        final id = _pendingConfirms.remove(requestId);
        if (id == null) return;
        final error = _opt(payload['error']);
        _results.add(
          DaemonActResult(
            id: id,
            ok: payload['ok'] == true,
            error: error,
            detail: _opt(payload['detail']),
          ),
        );
        if (payload['ok'] == true) {
          notifyListeners();
          return;
        }
        if (error == 'NOT_SHOWN' || error == 'TOO_SOON') _showAgain(id);
        _errors.add(actError(error, _opt(payload['detail'])));
      case 'daemon_open_result':
      case 'pair_result':
        final requestId = payload['requestId'];
        if (requestId is! String) return;
        final waiting = _requests.remove(requestId);
        if (waiting == null || waiting.isCompleted) return;
        waiting.complete({...payload}..remove('requestId'));
      case 'daemon_talk_result':
        final requestId = payload['requestId'];
        if (_talkRequest == null || requestId != _talkRequest) return;
        _talkRequest = null;
        _talkTimer?.cancel();
        _talkTimer = null;
        _talkCost = _opt(payload['cost']) ?? _talkCost;
        _talkNeedsSetup =
            payload['setupRequired'] == true ||
            payload['error'] == 'SETUP_REQUIRED';
        _pairAgentId = _opt(payload['agentId']) ?? _pairAgentId;
        final retry = payload['retryAfterMs'];
        if (retry is num && retry > 0) _holdTalk(retry.toInt());
        if (payload['ok'] == true) {
          _talkError = null;
          _pairAgentId = _opt(payload['agentId']) ?? _pairAgentId;
          _talkPhase = payload['started'] == true
              ? DaemonTalkPhase.started
              : payload['resumed'] == true
              ? DaemonTalkPhase.resumed
              : DaemonTalkPhase.sent;
        } else {
          _talkPhase = DaemonTalkPhase.failed;
          _talkError = talkErrorWords(
            payload['error'] as String?,
            _opt(payload['detail']),
          );
        }
        notifyListeners();
    }
  }

  /// No more talk until [ms] from now: the box says how long, and opens
  /// again by itself.
  void _holdTalk(int ms) {
    _talkRetryAt = _now().add(Duration(milliseconds: ms));
    _talkRetryTimer?.cancel();
    _talkRetryTimer = Timer(Duration(milliseconds: ms), () {
      _talkRetryTimer = null;
      _talkRetryAt = null;
      if (!_disposed) notifyListeners();
    });
  }

  /// Why a key did nothing, in one line. The window's own words for what it
  /// knows; harnessd's `detail` for anything newer.
  static String actError(String? code, [String? detail]) => switch (code) {
    'STALE_QUESTION' =>
      'that question changed before the answer landed. nothing was typed.',
    'GONE' => 'that is gone: answered, or its time ran out.',
    'STALE_CONFIRM' => 'that request is no longer waiting.',
    'NOT_SHOWN' || 'TOO_SOON' => 'a moment: read it, then press again.',
    'PERSON_ONLY' =>
      'only you teach a lesson, and this daemon cannot tell it was you. '
          'approve it at a terminal.',
    'INSIDE_HARNESS' => 'a key from inside a harness never teaches a lesson.',
    'NONCE_REQUIRED' || 'UNVERIFIED' =>
      'that needs you: press its key on its line, or run it at a terminal.',
    'PAIR_OFF' => 'pairing is off.',
    'NOT_OFFERED' => 'that answer was not offered.',
    'DENY_CLASS' => 'that one needs you at the harness.',
    'NOT_ALLOW_CLASS' =>
      'only a read, test, build or in-project edit gets a yes from here. '
          'open it.',
    'REMOTE_ANSWERS_ONLY' =>
      'on another machine only a read, test or build is answered from here. '
          'open it.',
    'RATE_LIMITED' => 'too many answers at once. try again in a minute.',
    'PERSISTENT' => 'only you can choose an answer for more than this once.',
    'AUTONOMY_WATCH' => 'it only watches. turn the dial in its panel.',
    'UNTOUCHABLE' => 'the daemon never drives that one.',
    'UI_ONLY' || 'LOCAL_SOCKET_REQUIRED' =>
      'keys count only from a window on this computer.',
    'UNSUPPORTED' => 'harnessd cannot answer that yet.',
    final String code when code.startsWith('MACHINE_') =>
      'that machine is ${code.substring(8).toLowerCase()}.',
    _ => detail ?? 'the answer did not go through.',
  };

  static String talkErrorWords(
    String? code, [
    String? detail,
  ]) => switch (code) {
    'PAIR_OFF' => 'nothing is paired: pair a daemon first.',
    'NO_ENGINE' => 'the pair runs on Claude Code or Codex; neither is here.',
    'INSTALL_FAILED' => 'the pair harness could not be installed. try again.',
    'EMPTY' => 'say something first.',
    'RATE_LIMITED' => 'six talks a minute, sixty an hour.',
    'UI_ONLY' => 'talk comes only from a window on this computer.',
    'UNSUPPORTED' => 'this harnessd cannot talk yet. update it.',
    _ => detail ?? 'the words did not reach it.',
  };

  /// Answer a line (or an ask, or a brief item) with one of its actions.
  /// Only once it is armed: this window drew it, and what it would do, a
  /// moment ago (BRAIN.md, "Security" 1). Nothing is sent before that.
  bool act(String sayId, String choice) {
    if (_disposed || sayId.isEmpty || !armed(sayId)) return false;
    final requestId = _id(12);
    final sent = send('daemon_act', {
      'requestId': requestId,
      'id': sayId,
      'choice': choice,
    });
    if (sent) {
      _pendingActs[requestId] = sayId;
    } else {
      _errors.add('harnessd is not reachable.');
    }
    return sent;
  }

  /// The person's answer to a setting that waits for it (`pair/gate.ts`): a
  /// raise of the dial, or pair.jsonc as it is now. Only once the request is
  /// armed, like any key.
  bool confirm(String kind, String nonce, {required bool accept}) {
    final id = DaemonConfirm.idFor(kind, nonce);
    if (_disposed || !armed(id)) return false;
    final requestId = _id(12);
    final sent = send('daemon_confirm', {
      'requestId': requestId,
      'kind': kind,
      'nonce': nonce,
      'accept': accept,
    });
    if (sent) {
      _pendingConfirms[requestId] = id;
    } else {
      _errors.add('harnessd is not reachable.');
    }
    return sent;
  }

  /// One `pair` request (the control interface, `pair/control.ts`) to this
  /// computer's harnessd, answered by its `pair_result`: `{ ok, ... }` or
  /// `{ error, detail? }`. Never throws; a harnessd that cannot be reached or
  /// does not answer is an error like any other.
  Future<Map<String, dynamic>> request(
    String verb, [
    Map<String, dynamic> payload = const {},
  ]) => _requestFrame('pair', {...payload, 'verb': verb});

  /// Opening a DSH starts/resumes its terminal without sending any words or
  /// Enter key. Trust, login and permissions remain in the engine's own UI.
  Future<Map<String, dynamic>> openConversation({String? engine}) async {
    final generation = _conversationGeneration;
    final uid = _companionUid;
    if (uid == null) return {'ok': false, 'error': 'PAIR_OFF'};
    final result = await _requestFrame('daemon_open', {
      'companionUid': uid,
      'engine': ?engine,
    });
    if (_disposed || generation != _conversationGeneration) {
      return {'ok': false, 'error': 'STALE_COMPANION'};
    }
    if (result['ok'] == true) {
      _pairAgentId = _opt(result['agentId']);
      _pairEngine = _opt(result['engine']) ?? _pairEngine;
      notifyListeners();
    }
    return result;
  }

  Future<Map<String, dynamic>> _requestFrame(
    String type,
    Map<String, dynamic> payload,
  ) async {
    if (_disposed) return {'ok': false, 'error': 'CLOSED'};
    final requestId = _id(12);
    final done = Completer<Map<String, dynamic>>();
    _requests[requestId] = done;
    final sent = send(type, {...payload, 'requestId': requestId});
    if (!sent) {
      _requests.remove(requestId);
      return {'ok': false, 'error': 'UNREACHABLE'};
    }
    return done.future.timeout(
      requestTimeout,
      onTimeout: () {
        _requests.remove(requestId);
        return {'ok': false, 'error': 'TIMEOUT'};
      },
    );
  }

  /// Your words to the paired daemon: harnessd starts, resumes or reaches the
  /// pair harness, and its answer comes back as a `daemon_say` (`say`). Not
  /// while harnessd asked to wait ([talkWait]).
  bool talkTo(String text) {
    final words = text.trim();
    if (_disposed ||
        words.isEmpty ||
        talkWait != null ||
        _talkRequest != null) {
      return false;
    }
    final requestId = _id(12);
    final sent = send('daemon_talk', {
      'requestId': requestId,
      'text': words,
      if (_companionUid != null) 'companionUid': _companionUid,
    });
    _remember((you: true, text: words));
    if (sent) {
      _talkRequest = requestId;
      _talkPhase = DaemonTalkPhase.waking;
      _talkNeedsSetup = false;
      _talkError = null;
      _talkTimer = Timer(const Duration(seconds: 45), () {
        if (_disposed || _talkRequest != requestId) return;
        _talkRequest = null;
        _talkTimer = null;
        _talkPhase = DaemonTalkPhase.failed;
        _talkError = 'The companion is taking longer to connect. Open the full conversation to check before sending again.';
        notifyListeners();
      });
    } else {
      _talkRequest = null;
      _talkPhase = DaemonTalkPhase.failed;
      _talkError = 'harnessd is not reachable.';
    }
    notifyListeners();
    return sent;
  }

  void _heard(String line) {
    final completedSetup = _talkNeedsSetup;
    _talkNeedsSetup = false;
    _remember((you: false, text: line));
    if (_talkPhase != DaemonTalkPhase.failed || completedSetup) {
      _talkPhase = DaemonTalkPhase.idle;
      _talkError = null;
    }
    notifyListeners();
  }

  void _remember(DaemonTalkEntry entry) {
    _talk.add(entry);
    if (_talk.length > talkKept) _talk.removeAt(0);
    _saveConversation();
  }

  /// Whether you are at this window, and for how long you were away, with the
  /// pane in front of you (null clears it: the brain says nothing about what
  /// you are looking at). A guest adds which daemon its local zoo pairs, its
  /// dial and whether the person agreed to being watched.
  Future<void> presence({
    required bool active,
    Duration? away,
    String? pair,
    Map<String, dynamic>? companion,
    String? autonomy,
    bool? consent,
    String? focusMachineId,
    String? focusAgentId,
  }) async {
    final desk = await this.desk();
    if (_disposed) return;
    send('daemon_presence', {
      'active': active,
      if (away != null) 'awayMs': away.inMilliseconds,
      'desk': desk,
      if (pair != null || consent != null) 'pair': pair,
      'companion': ?companion,
      'autonomy': ?autonomy,
      'consent': ?consent,
      'focusMachineId': focusAgentId == null ? null : focusMachineId,
      'focusAgentId': focusAgentId,
    });
  }

  /// The pane in front of you changed, and nothing else did.
  Future<void> focus({String? machineId, String? agentId}) async {
    final desk = await this.desk();
    if (_disposed) return;
    send('daemon_presence', {
      'desk': desk,
      'focusMachineId': agentId == null ? null : machineId,
      'focusAgentId': agentId,
    });
  }

  /// You looked at the `+n`: the brain clears its count of finished turns.
  Future<void> doneSeen() async {
    final desk = await this.desk();
    if (_disposed) return;
    send('daemon_presence', {'desk': desk, 'doneSeen': true});
  }

  /// A guest's local zoo changed its pair, dial or consent: the brain hears
  /// it.
  Future<void> guest({
    String? pair,
    Map<String, dynamic>? companion,
    String? autonomy,
    bool? consent,
  }) async {
    final desk = await this.desk();
    if (_disposed) return;
    send('daemon_presence', {
      'desk': desk,
      'pair': pair,
      'companion': ?companion,
      'autonomy': autonomy,
      'consent': ?consent,
    });
  }

  /// A new account or harnessd: nothing heard so far still holds.
  void reset() {
    _talkNeedsSetup = false;
    _conversationGeneration++;
    _conversationScope = null;
    _companionUid = null;
    _historyLoading = false;
    _talkTimer?.cancel();
    _talkTimer = null;
    _heardReplies.clear();
    _state = null;
    _brief = null;
    _pendingActs.clear();
    _pendingConfirms.clear();
    _shownAt.clear();
    for (final timer in _armTimers.values) {
      timer.cancel();
    }
    _armTimers.clear();
    for (final waiting in _requests.values) {
      if (!waiting.isCompleted) {
        waiting.complete({'ok': false, 'error': 'GONE'});
      }
    }
    _requests.clear();
    _talkRequest = null;
    _talkPhase = DaemonTalkPhase.idle;
    _talkError = null;
    _talkRetryTimer?.cancel();
    _talkRetryTimer = null;
    _talkRetryAt = null;
    _pairAgentId = null;
    _pairEngine = null;
    _talk.clear();
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _talkTimer?.cancel();
    _disposed = true;
    for (final waiting in _requests.values) {
      if (!waiting.isCompleted) {
        waiting.complete({'ok': false, 'error': 'CLOSED'});
      }
    }
    _requests.clear();
    for (final timer in _armTimers.values) {
      timer.cancel();
    }
    _armTimers.clear();
    _talkRetryTimer?.cancel();
    unawaited(_said.close());
    unawaited(_unsaid.close());
    unawaited(_errors.close());
    unawaited(_opens.close());
    unawaited(_results.close());
    unawaited(_switchedOff.close());
    super.dispose();
  }
}
