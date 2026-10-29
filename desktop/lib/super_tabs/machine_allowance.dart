// What a machine row's Subscriptions card says in place of a figure (docs: Machines view, every row shows the block).

/// An engine on an API key or a gateway: metered, with no subscription windows to read (cli superTabs/machines.ts
/// reports it known, with none).
const kAllowanceApiKey = 'API key · no limits';

/// A known allowance whose windows reset since it was read: the next reading has the figure.
const kAllowanceWaiting = 'Waiting for a new reading';

/// A host that sends no reason for an unknown allowance predates them (cli superTabs/capacity.ts quotaUnknownReason).
const kAllowanceUpdate = 'Update Harness on this machine to see it';

/// Why [quota], one engine's entry in a machine's reading (null when it reported none), shows no figure. [reason] is
/// the machine's own words for an unknown allowance (its reading's `quotaReasons`), which name no account or plan.
String superMachineAllowanceReason(
  Map<String, dynamic>? quota,
  Object? reason,
) {
  if (quota?['known'] == true) {
    final windows = quota!['windows'];
    return windows is List && windows.isNotEmpty
        ? kAllowanceWaiting
        : kAllowanceApiKey;
  }
  if (reason is String && reason.isNotEmpty) return reason;
  return kAllowanceUpdate;
}
