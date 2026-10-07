import '../auth/cli_link.dart';
import '../auth/link_errors.dart';
import '../auth/peer_link_client.dart';
import '../core/config.dart';
import '../e2ee/keys.dart';
import 'direct_auth.dart';
import 'direct_auth_api.dart';
import 'device_log_sync.dart';
import 'group_sync.dart';
import 'password_link.dart';
import 'viewer_key_store.dart';

/// `harness link connect/list/unlink` for a device with no harness CLI: the password exchange runs
/// here ([linkWithPassword]) and the pin lands in [ViewerKeyStore] rather than `machinePeers.json`.
class DirectLink implements PeerLinkClient {
  DirectLink({
    required this.keys,
    required this.auth,
    required this.config,
    this.socket = defaultRelaySocket,
  });

  final ViewerKeyStore keys;
  final DirectAuth auth;
  final AppConfig config;
  final RelaySocketFactory socket;

  /// The account's device key log, once the app has one: its head rides every roster swap, so a
  /// machine shown a different log than this app is found out (`device_log_sync.dart`).
  ViewerDeviceLog? deviceLog;

  @override
  Future<CliLinkConnectResult> connect(
    String machineId,
    String password, {
    void Function(String stage)? onProgress,
    String? displayName,
  }) async {
    final String token;
    try {
      token = await auth.accessToken();
    } on DirectAuthException catch (error) {
      return CliLinkConnectResult(error: error.message);
    }
    final result = await linkWithPassword(
      machineId: machineId,
      password: password,
      identity: await keys.identity(),
      accessToken: token,
      wsBaseUrl: config.wsBaseUrl,
      autonomousEnv: config.autonomousEnv,
      onProgress: (stage) => onProgress?.call(stage.wireName),
      socket: socket,
    );
    switch (result) {
      case PasswordLinked(:final peerPub, :final fingerprint):
        await keys.pin(machineId, peerPub);
        return CliLinkConnectResult(
          linkedMachineId: machineId,
          fingerprint: fingerprint,
        );
      case PasswordLinkFailed(:final code, :final retryAt):
        // Named the way the CLI's `--name` names it: the id is all a stranger to this rail sees.
        final name = displayName == null || displayName.isEmpty
            ? machineId
            : displayName;
        return CliLinkConnectResult(
          error: humanizeLinkError(code, name, retryAt: retryAt),
        );
    }
  }

  /// Swaps trust-group rosters with [machineId] ([syncTrustGroup]): the machines this device learns
  /// of are pinned — no password for them — and the machine learns this device and whatever it
  /// linked. [label] is this device's name for itself. Never throws.
  Future<GroupSyncOutcome> syncGroup(
    String machineId, {
    required String label,
  }) async {
    final log = deviceLog;
    // Until the log is this sign-in's, the pins and the roster may still be the account just left's:
    // none of it goes to this account's machines, and nothing they say is taken in beside it.
    if (log != null && !await log.ownsLog()) return GroupSyncOutcome.none;
    final String token;
    try {
      token = await auth.accessToken();
    } catch (_) {
      return GroupSyncOutcome.none;
    }
    return syncTrustGroup(
      machineId: machineId,
      keys: keys,
      accessToken: token,
      wsBaseUrl: config.wsBaseUrl,
      autonomousEnv: config.autonomousEnv,
      label: label,
      socket: socket,
      devlog: await log?.gossip(),
      suspended: log?.suspendedPubs,
      onDevlog: log?.heard,
    );
  }

  @override
  Future<CliLinkListResult> list() async => CliLinkListResult(
    machines: [
      for (final peer in await keys.peers())
        LinkedMachine(
          machineId: peer.machineId,
          fingerprint: fingerprint(peer.pub),
          linkedAt: _asCliPrints(peer.linkedAt),
        ),
    ],
  );

  @override
  Future<String?> unlink(String machineId) async =>
      await keys.unlink(machineId) ? null : '$machineId is not linked.';
}

/// `YYYY-MM-DD HH:MM`, the form `harness link list` prints and [LinkedMachine] carries.
String _asCliPrints(DateTime at) {
  String two(int n) => n.toString().padLeft(2, '0');
  return '${at.year}-${two(at.month)}-${two(at.day)} ${two(at.hour)}:${two(at.minute)}';
}
