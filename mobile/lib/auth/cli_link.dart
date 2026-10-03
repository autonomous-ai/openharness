/// Result of `harness link connect <machineId> --stdin --json` — the password-authenticated
/// replacement for the old token-based `import`.
class CliLinkConnectResult {
  /// Null on success.
  final String? error;

  /// The machineId the CLI actually linked — echoed back from its own success line. Null if
  /// [error] is set, or if the CLI's output didn't match the expected shape.
  final String? linkedMachineId;

  /// The linked machine's fingerprint, for the user to verify.
  final String? fingerprint;

  const CliLinkConnectResult({
    this.error,
    this.linkedMachineId,
    this.fingerprint,
  });
}

/// One row of `harness link list`.
class LinkedMachine {
  final String machineId;
  final String fingerprint;

  /// As printed by the CLI: `YYYY-MM-DD HH:MM`.
  final String linkedAt;

  const LinkedMachine({
    required this.machineId,
    required this.fingerprint,
    required this.linkedAt,
  });
}

class CliLinkListResult {
  /// Null on success (an empty list is success with zero rows, not an error).
  final String? error;
  final List<LinkedMachine> machines;

  const CliLinkListResult({this.error, this.machines = const []});
}
