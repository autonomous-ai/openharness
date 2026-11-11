/// A reading this old is late: the machine reports every 15 seconds
/// (`MACHINE_HEARTBEAT_MS`, `cli/src/superTabs/machines.ts`), so a reading past a beat and a quarter has missed one.
const kSuperTabMachineLateAfter = Duration(seconds: 20);

/// How long a machine's reading may stand before the Swarm calls it offline: two missed beats, plus a margin for the
/// Swarm to be read in turn. A machine reports at once when something changes, so a quiet one is still under this.
const kSuperTabMachineOfflineAfter = Duration(seconds: 35);

/// What the Machines list says of one machine, and draws as its dot.
enum SuperTabMachineStatus {
  /// Reported within [kSuperTabMachineLateAfter].
  live,

  /// Past that, not yet [kSuperTabMachineOfflineAfter].
  late,

  /// Silent for [kSuperTabMachineOfflineAfter] or more (or, for a computer read directly, not connected).
  offline,

  /// The Swarm cannot be read, so what a machine reports through it cannot be told from silence. Not offline.
  unknown,

  /// Back from the background: what is shown was read before, and the new reading has not arrived.
  refreshing,
}

/// The status of a machine from how old its reading is.
///
/// [age]: null when it has no reading. [unreachable]: the Swarm cannot be read and the reading comes through it.
/// [refreshing]: a new reading is awaited. [connected]: for a computer this Desktop reads itself, whether its
/// connection is up; null for one whose reports come through the Swarm. A computer that is connected is never
/// called offline for an old reading, only late: its connection says it is there.
SuperTabMachineStatus superTabMachineStatus({
  required Duration? age,
  bool unreachable = false,
  bool refreshing = false,
  bool? connected,
}) {
  if (unreachable) return SuperTabMachineStatus.unknown;
  if (refreshing) return SuperTabMachineStatus.refreshing;
  if (connected == false || age == null) return SuperTabMachineStatus.offline;
  if (age >= kSuperTabMachineOfflineAfter) {
    return connected == true
        ? SuperTabMachineStatus.late
        : SuperTabMachineStatus.offline;
  }
  return age >= kSuperTabMachineLateAfter
      ? SuperTabMachineStatus.late
      : SuperTabMachineStatus.live;
}

/// How long ago: "just now", "4s ago", "3 min ago", "2 h ago".
String superTabAgo(Duration age) {
  final seconds = age.inSeconds;
  if (seconds < 1) return 'just now';
  if (seconds < 60) return '${seconds}s ago';
  if (age.inMinutes < 60) return '${age.inMinutes} min ago';
  if (age.inHours < 24) return '${age.inHours} h ago';
  return '${age.inDays} d ago';
}

/// What hovering or focusing a machine's row says of its state, before its owner and hardware: nothing while
/// it is online (the dot says so), and never how old the reading is.
String? superTabMachineTip(SuperTabMachineStatus status) => switch (status) {
  SuperTabMachineStatus.refreshing => 'Refreshing…',
  SuperTabMachineStatus.unknown => "Can't reach Harness",
  SuperTabMachineStatus.offline => 'Offline',
  SuperTabMachineStatus.live || SuperTabMachineStatus.late => null,
};

/// The state in words, so that colour is never the only signal.
String superTabMachineStateLabel(SuperTabMachineStatus status) =>
    switch (status) {
      SuperTabMachineStatus.live => 'Live',
      SuperTabMachineStatus.late => 'Late',
      SuperTabMachineStatus.offline => 'Offline',
      SuperTabMachineStatus.unknown => 'Status unknown',
      SuperTabMachineStatus.refreshing => 'Refreshing',
    };
