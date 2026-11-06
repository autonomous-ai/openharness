// What the machine's owner sees of the Claude accounts a Product Manager may move between: the
// replies of `pm_accounts_list` and `pm_accounts_history` as typed values.

/// One usage window of an account: `'5-hour'` or `'weekly'`.
class PmWindow {
  const PmWindow({
    required this.name,
    required this.leftPercent,
    this.resetsAt,
  });
  final String name;
  final int leftPercent;
  final DateTime? resetsAt;

  static PmWindow? fromJson(Object? row) {
    if (row is! Map || row['name'] is! String || row['leftPercent'] is! num) {
      return null;
    }
    final resets = row['resetsAt'];
    return PmWindow(
      name: row['name'] as String,
      leftPercent: (row['leftPercent'] as num).round().clamp(0, 100),
      resetsAt: resets is String ? DateTime.tryParse(resets)?.toLocal() : null,
    );
  }
}

class PmAccount {
  const PmAccount({
    required this.id,
    required this.label,
    this.email,
    this.isDefault = false,
    required this.pmMayUse,
    this.pmHere = const [],
    required this.signedIn,
    this.windows = const [],
  });
  final String id;
  final String label;
  final String? email;
  final bool isDefault;
  final bool pmMayUse;
  final List<String> pmHere;
  final bool signedIn;
  final List<PmWindow> windows;

  PmWindow? window(String name) {
    for (final w in windows) {
      if (w.name == name) return w;
    }
    return null;
  }

  /// When the account is usable again, if a window is at or under 5% and says when it resets.
  /// With two such windows, the later reset.
  DateTime? get outUntil {
    DateTime? until;
    for (final w in windows) {
      final at = w.resetsAt;
      if (w.leftPercent <= 5 && at != null) {
        if (until == null || at.isAfter(until)) until = at;
      }
    }
    return until;
  }

  static PmAccount? fromJson(Object? row) {
    if (row is! Map ||
        row['id'] is! String ||
        row['pmMayUse'] is! bool ||
        row['signedIn'] is! bool) {
      return null;
    }
    final windows = row['windows'];
    final here = row['pmHere'];
    return PmAccount(
      id: row['id'] as String,
      label: row['label'] as String? ?? row['id'] as String,
      email: row['email'] as String?,
      isDefault: row['default'] == true,
      pmMayUse: row['pmMayUse'] as bool,
      pmHere: [if (here is List) ...here.whereType<String>()],
      signedIn: row['signedIn'] as bool,
      windows: [
        if (windows is List)
          for (final w in windows) ?PmWindow.fromJson(w),
      ],
    );
  }
}

/// One move of a PM from an account to another.
class PmMove {
  const PmMove({
    required this.at,
    required this.pm,
    required this.from,
    required this.to,
    required this.why,
    this.window,
    this.leftPercent,
    this.awayMs,
    required this.ok,
  });
  final DateTime at;
  final String pm;
  final String from;
  final String to;
  final String why;
  final String? window;
  final int? leftPercent;
  final int? awayMs;
  final bool ok;

  static PmMove? fromJson(Object? row) {
    if (row is! Map ||
        row['at'] is! num ||
        row['pm'] is! String ||
        row['from'] is! String ||
        row['to'] is! String) {
      return null;
    }
    return PmMove(
      at: DateTime.fromMillisecondsSinceEpoch((row['at'] as num).round()),
      pm: row['pm'] as String,
      from: row['from'] as String,
      to: row['to'] as String,
      why: row['why'] as String? ?? '',
      window: row['window'] as String?,
      leftPercent: (row['leftPercent'] as num?)?.round(),
      awayMs: (row['awayMs'] as num?)?.round(),
      ok: row['ok'] != false,
    );
  }
}
