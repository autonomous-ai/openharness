/// A project's board pulse (task #3384): what waits for its PM and who works,
/// as the server works it out per read (backend superTabs/pulse.ts) and sends
/// it in `derived.pulse`. The server decides when each count turns red
/// (`redAt`); the app holds no threshold of its own.
library;

/// A rule that turns a segment of the pulse red.
enum SuperTabPulseRule {
  /// An ask has waited too long for the PM.
  asks,

  /// Nobody has worked while work waited.
  idle,

  /// A lost task has had no agent too long.
  lost,

  /// A hold has no reason.
  held,
}

/// A person's message to the PM not yet settled.
typedef SuperTabPulseAsk = ({
  String conversationId,
  String messageId,
  String? personId,
  DateTime at,
});

/// A held task and why, null when nobody said.
typedef SuperTabPulseHold = ({String conversationId, String? reason});

class SuperTabPulse {
  SuperTabPulse._(Map<String, dynamic> row)
    : pmId = _optional<String>(row['pmId']),
      asks = _asks(_map(row['asks'])),
      working = _working(_map(row['working'])),
      nextUp = _tasks(_map(row['nextUp'])),
      lost = _tasks(_map(row['lost'])),
      held = _held(_map(row['held'])),
      limits = switch (row['limits']) {
        final Map limits => (
          askMinutes: _optional<num>(limits['askMinutes'])?.toInt(),
          idleMinutes: _optional<num>(limits['idleMinutes'])?.toInt(),
          lostMinutes: _optional<num>(limits['lostMinutes'])?.toInt(),
        ),
        _ => (askMinutes: null, idleMinutes: null, lostMinutes: null),
      },
      redAt = Map.unmodifiable({
        for (final rule in SuperTabPulseRule.values)
          rule: ?_time(_map(row['redAt'])[rule.name]),
      });

  /// [value]'s pulse; null for one this build cannot read, so the board draws
  /// no strip rather than a wrong one.
  static SuperTabPulse? read(Object? value) {
    if (value is! Map) return null;
    try {
      return SuperTabPulse._(Map<String, dynamic>.from(value));
    } on FormatException {
      return null;
    }
  }

  /// Every project's pulse in `derived.pulse`, by project id; empty from a
  /// server before it.
  static Map<String, SuperTabPulse> readAll(Object? value) => Map.unmodifiable({
    if (value is Map)
      for (final MapEntry(:key, :value) in value.entries)
        if (key is String) key: ?read(value),
  });

  /// The project's PM, while it has one.
  final String? pmId;
  final ({
    int count,
    DateTime? oldestAt,
    String? personId,
    List<SuperTabPulseAsk> list,
  })
  asks;
  final ({int count, int crew, List<String> agentIds}) working;
  final ({int count, List<String> conversationIds}) nextUp, lost;
  final ({int count, int withoutReason, List<SuperTabPulseHold> list}) held;

  /// The limits behind `redAt`, only to say why a count is red.
  final ({int? askMinutes, int? idleMinutes, int? lostMinutes}) limits;

  /// When each rule turns red; a rule left out is not red.
  final Map<SuperTabPulseRule, DateTime> redAt;

  /// Whether [rule] is red at [now]: at its `redAt` or after it.
  bool isRed(SuperTabPulseRule rule, DateTime now) {
    final at = redAt[rule];
    return at != null && !at.isAfter(now);
  }

  /// Whether any rule is red at [now].
  bool anyRed(DateTime now) =>
      SuperTabPulseRule.values.any((rule) => isRed(rule, now));

  /// The next time after [now] a rule turns red, null when none will.
  DateTime? nextRedAfter(DateTime now) {
    DateTime? next;
    for (final at in redAt.values) {
      if (at.isAfter(now) && (next == null || at.isBefore(next))) next = at;
    }
    return next;
  }

  static ({
    int count,
    DateTime? oldestAt,
    String? personId,
    List<SuperTabPulseAsk> list,
  })
  _asks(Map<String, dynamic> row) => (
    count: _count(row['count']),
    oldestAt: _time(row['oldestAt']),
    personId: _optional<String>(row['personId']),
    list: List.unmodifiable([
      for (final ask in _list(row['list']))
        (
          conversationId: _text(_map(ask)['conversationId']),
          messageId: _text(_map(ask)['messageId']),
          personId: _optional<String>(_map(ask)['personId']),
          at: _time(_map(ask)['at']) ?? (throw const FormatException('at')),
        ),
    ]),
  );

  static ({int count, int crew, List<String> agentIds}) _working(
    Map<String, dynamic> row,
  ) => (
    count: _count(row['count']),
    crew: _count(row['crew']),
    agentIds: _ids(row['agentIds']),
  );

  static ({int count, List<String> conversationIds}) _tasks(
    Map<String, dynamic> row,
  ) => (
    count: _count(row['count']),
    conversationIds: _ids(row['conversationIds']),
  );

  static ({int count, int withoutReason, List<SuperTabPulseHold> list}) _held(
    Map<String, dynamic> row,
  ) => (
    count: _count(row['count']),
    withoutReason: _count(row['withoutReason'] ?? 0),
    list: List.unmodifiable([
      for (final hold in _list(row['list']))
        (
          conversationId: _text(_map(hold)['conversationId']),
          reason: switch (_map(hold)['reason']) {
            final String reason when reason.trim().isNotEmpty => reason,
            _ => null,
          },
        ),
    ]),
  );

  static Map<String, dynamic> _map(Object? value) => value is Map
      ? Map<String, dynamic>.from(value)
      : throw const FormatException('Not a pulse object.');

  static List<Object?> _list(Object? value) => switch (value) {
    null => const [],
    final List list => list,
    _ => throw const FormatException('Not a pulse list.'),
  };

  static List<String> _ids(Object? value) =>
      List.unmodifiable([for (final id in _list(value)) _text(id)]);

  static String _text(Object? value) =>
      value is String ? value : throw const FormatException('Not an id.');

  static int _count(Object? value) => value is num
      ? value.toInt()
      : throw const FormatException('Not a count.');

  static T? _optional<T>(Object? value) => value is T ? value : null;

  static DateTime? _time(Object? value) =>
      value is num ? DateTime.fromMillisecondsSinceEpoch(value.toInt()) : null;
}
