import 'ledger_scanner.dart';
import 'ledger_types.dart';

/// Local transcript/database scans require the desktop app. Remote account
/// usage continues through the shared daemon RPC client.
class OpenCodeLedgerScanner implements LedgerScanner {
  OpenCodeLedgerScanner({String? dataDirectory, Map<String, String>? environment});

  @override
  LedgerProvider get provider => LedgerProvider.opencode;

  @override
  Future<LedgerScanResult> scan(Map<String, ScannedSource> previous) async =>
      const LedgerScanResult.unavailable('Local usage is available in the desktop app.');
}
