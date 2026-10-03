import 'cli_link.dart';

/// Linking to another machine by its remote password: the exchange `harness link
/// connect/list/unlink` runs on a desktop, run by the app itself (`viewer/direct_link.dart`).
abstract interface class PeerLinkClient {
  /// [onProgress] gets the CLI's stage names (`connecting`, `deriving_key`, `exchanging`,
  /// `verifying`) — best-effort feedback, never needed for correctness. [displayName] is how an
  /// error names the machine; without it, all an error has to go on is the raw [machineId].
  Future<CliLinkConnectResult> connect(
    String machineId,
    String password, {
    void Function(String stage)? onProgress,
    String? displayName,
    // What this device calls itself, for the computer's list of paired devices ("Dee's iPhone").
    String? label,
  });

  /// Pairing by the one-time code a desktop app's "Add phone" QR carries (`viewer/code_link.dart`)
  /// — no remote password. [label] is how the machine lists this device. A build that cannot says
  /// so in the error.
  Future<CliLinkConnectResult> connectWithCode(
    String machineId,
    String code, {
    required String label,
    String? displayName,
  });

  Future<CliLinkListResult> list();

  /// Null on success.
  Future<String?> unlink(String machineId);
}
