import 'dart:convert';

import 'ledger_types.dart';
import 'usage_ledger_store.dart';
import 'usage_overview.dart';

/// A bounded, local-transcript estimate for the cable device. No account quota,
/// transcript content, paths, or fleet totals cross this boundary. "Complete"
/// describes the enabled sources, never the user's entire bill.
Map<String, dynamic> projectDeviceUsage({
  required String machineId,
  required String machineName,
  required DateTime now,
  required List<ProviderLedger> ledgers,
  required List<LedgerScanState> states,
}) {
  final local = now.toLocal();
  final start = DateTime(local.year, local.month, local.day);
  // Calendar construction, rather than +24h, preserves local DST boundaries.
  final end = DateTime(local.year, local.month, local.day + 1);
  final providers = <Map<String, dynamic>>[];
  double? cost;
  DateTime? asOf;
  var complete = true;
  // v1 names exactly these sources. Adding a ledger provider must not silently
  // expand a fixed-capacity device response or redefine its coverage.
  for (final provider in const [
    LedgerProvider.claude,
    LedgerProvider.codex,
    LedgerProvider.opencode,
  ]) {
    final state =
        states.where((s) => s.provider == provider).firstOrNull ??
        LedgerScanState(provider: provider);
    final ledger = ledgers.where((l) => l.provider == provider).firstOrNull;
    final scan = state.lastScanAt;
    final usable =
        state.enabled &&
        ledger != null &&
        scan != null &&
        !scan.isBefore(start) &&
        !scan.isAfter(now) &&
        const [
          LedgerStatus.ok,
          LedgerStatus.partial,
          LedgerStatus.scanning,
        ].contains(state.status);
    final clipped = usable
        ? ledgerFromEntries(
            provider,
            ledger.entries
                .where(
                  (entry) =>
                      !entry.timestamp.isBefore(start) &&
                      entry.timestamp.isBefore(end) &&
                      !entry.timestamp.isAfter(scan),
                )
                .toList(),
          )
        : null;
    // An empty complete scan establishes zero. An empty failed/partial scan
    // cannot. Known zero (including free inference) remains distinguishable
    // from an unpriced model or a provider that was never enabled.
    final reading =
        clipped?.costUsd ??
        (clipped != null && !clipped.hasData && state.status == LedgerStatus.ok
            ? 0.0
            : null);
    final priced =
        clipped != null &&
        !clipped.hasUnpricedModel &&
        reading != null &&
        reading.isFinite &&
        reading >= 0;
    if (state.enabled) {
      complete = complete && state.status == LedgerStatus.ok && priced;
      if (reading != null && reading.isFinite && reading >= 0) {
        cost = (cost ?? 0) + reading;
        if (asOf == null || scan!.isBefore(asOf)) asOf = scan;
      } else {
        complete = false;
      }
    }
    providers.add({
      'id': provider.name,
      'enabled': state.enabled,
      'state': state.enabled ? state.status.name : 'disabled',
      'priced': priced,
      if (state.enabled && scan != null && !scan.isAfter(now))
        'asOfMs': scan.millisecondsSinceEpoch,
    });
  }
  return {
    'scope': 'local-transcripts',
    'machineId': machineId,
    'machineName': _utf8Prefix(machineName, 39),
    'day':
        '${local.year.toString().padLeft(4, '0')}-'
        '${local.month.toString().padLeft(2, '0')}-'
        '${local.day.toString().padLeft(2, '0')}',
    'windowStartMs': start.millisecondsSinceEpoch,
    'windowEndMs': end.millisecondsSinceEpoch,
    'generatedAtMs': now.millisecondsSinceEpoch,
    if (asOf != null) 'asOfMs': asOf.millisecondsSinceEpoch,
    'currency': 'USD',
    'costKind': 'estimated',
    'coverage': cost == null
        ? 'unavailable'
        : (complete ? 'complete' : 'partial'),
    'costUsd': ?cost,
    'stale':
        asOf == null ||
        now.millisecondsSinceEpoch - asOf.millisecondsSinceEpoch >
            kLedgerStaleAfter.inMilliseconds,
    'providers': providers,
  };
}

String _utf8Prefix(String text, int maxBytes) {
  final out = StringBuffer();
  var size = 0;
  for (final rune in text.runes) {
    final char = String.fromCharCode(rune);
    size += utf8.encode(char).length;
    if (size > maxBytes) break;
    out.write(char);
  }
  return out.toString();
}
