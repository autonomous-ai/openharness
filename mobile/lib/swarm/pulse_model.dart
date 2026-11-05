/// A project's board pulse (task #3384), as the server works it out at read
/// time and sends it in the read's `derived.pulse[projectId]` (backend
/// superTabs/pulse.ts; contract in docs/plans/2026-11-05-board-pulse-plan.md):
/// what waits for the project's PM, who works, and what is next up, lost and
/// held. The phone holds no threshold: a rule is red once the server's
/// `redAt` for it has come ([SuperTabPulse.isRed]).
library;

/// The rules that turn a part of the pulse red, by their `redAt` key: an ask
/// waiting too long ([asks]), nobody working while work waits ([idle], on
/// Working), a task with no agent ([lost]) and a hold with no reason ([held]).
enum SuperTabPulseRule { asks, idle, lost, held }

/// One message a person sent the PM that the PM has not settled yet.
typedef SuperTabPulseAsk = ({
  String conversationId,
  String messageId,
  String? personId,
  DateTime? at,
});

/// A held task and why it is held: null when nobody said.
typedef SuperTabPulseHold = ({String conversationId, String? reason});

class SuperTabPulseAsks {
  const SuperTabPulseAsks({
    required this.count,
    this.oldestAt,
    this.personId,
    this.list = const [],
  });

  final int count;

  /// When the oldest ask was sent, and who sent it; null with none.
  final DateTime? oldestAt;
  final String? personId;

  /// The asks, as many as the server lists.
  final List<SuperTabPulseAsk> list;
}

class SuperTabPulseWorking {
  const SuperTabPulseWorking({
    required this.count,
    required this.crew,
    this.agentIds = const [],
  });

  /// The agents working, of the project's [crew].
  final int count, crew;
  final List<String> agentIds;
}

/// A count of tasks and which they are: Next up and Lost.
class SuperTabPulseTasks {
  const SuperTabPulseTasks({
    required this.count,
    this.conversationIds = const [],
  });

  final int count;
  final List<String> conversationIds;
}

class SuperTabPulseHeld {
  const SuperTabPulseHeld({
    required this.count,
    this.withoutReason = 0,
    this.list = const [],
  });

  final int count;

  /// How many of them have no reason.
  final int withoutReason;
  final List<SuperTabPulseHold> list;
}

class SuperTabPulse {
  const SuperTabPulse({
    this.pmId,
    required this.asks,
    required this.working,
    required this.nextUp,
    required this.lost,
    required this.held,
    this.redAt = const {},
  });

  /// [value] read as the server sends it; null for anything that is not a
  /// pulse, so the board draws no strip rather than a wrong one.
  static SuperTabPulse? read(Object? value) {
    if (value is! Map) return null;
    final asks = value['asks'], working = value['working'];
    final nextUp = value['nextUp'], lost = value['lost'];
    final held = value['held'];
    if (asks is! Map ||
        working is! Map ||
        nextUp is! Map ||
        lost is! Map ||
        held is! Map) {
      return null;
    }
    final redAt = value['redAt'];
    return SuperTabPulse(
      pmId: _string(value['pmId']),
      asks: SuperTabPulseAsks(
        count: _count(asks['count']),
        oldestAt: _time(asks['oldestAt']),
        personId: _string(asks['personId']),
        list: List.unmodifiable([
          for (final ask in _list(asks['list']))
            if (ask case {
              'conversationId': final String conversationId,
              'messageId': final String messageId,
            })
              (
                conversationId: conversationId,
                messageId: messageId,
                personId: _string(ask['personId']),
                at: _time(ask['at']),
              ),
        ]),
      ),
      working: SuperTabPulseWorking(
        count: _count(working['count']),
        crew: _count(working['crew']),
        agentIds: _strings(working['agentIds']),
      ),
      nextUp: SuperTabPulseTasks(
        count: _count(nextUp['count']),
        conversationIds: _strings(nextUp['conversationIds']),
      ),
      lost: SuperTabPulseTasks(
        count: _count(lost['count']),
        conversationIds: _strings(lost['conversationIds']),
      ),
      held: SuperTabPulseHeld(
        count: _count(held['count']),
        withoutReason: _count(held['withoutReason']),
        list: List.unmodifiable([
          for (final hold in _list(held['list']))
            if (hold case {'conversationId': final String conversationId})
              (
                conversationId: conversationId,
                reason: switch (hold['reason']) {
                  final String reason when reason.trim().isNotEmpty => reason,
                  _ => null,
                },
              ),
        ]),
      ),
      redAt: Map.unmodifiable({
        if (redAt is Map)
          for (final rule in SuperTabPulseRule.values)
            rule: ?_time(redAt[rule.name]),
      }),
    );
  }

  /// The project's PM, by agent id; null when it has none.
  final String? pmId;
  final SuperTabPulseAsks asks;
  final SuperTabPulseWorking working;
  final SuperTabPulseTasks nextUp, lost;
  final SuperTabPulseHeld held;

  /// When each rule turns red, as the server worked it out; a rule it is not
  /// heading for is absent.
  final Map<SuperTabPulseRule, DateTime> redAt;

  /// Whether [rule] is red at [now]: its time has come.
  bool isRed(SuperTabPulseRule rule, DateTime now) => switch (redAt[rule]) {
    final at? => !at.isAfter(now),
    null => false,
  };

  /// The soonest a rule not yet red turns red, after [now]; null when none
  /// will.
  DateTime? nextRedAfter(DateTime now) {
    DateTime? next;
    for (final at in redAt.values) {
      if (at.isAfter(now) && (next == null || at.isBefore(next))) next = at;
    }
    return next;
  }
}

String? _string(Object? value) =>
    value is String && value.isNotEmpty ? value : null;

int _count(Object? value) => value is num && value > 0 ? value.toInt() : 0;

DateTime? _time(Object? value) => value is num
    ? DateTime.fromMillisecondsSinceEpoch(value.toInt(), isUtc: true)
    : null;

List<Object?> _list(Object? value) => value is List ? value : const [];

List<String> _strings(Object? value) => List.unmodifiable([
  for (final item in _list(value))
    if (item is String) item,
]);
