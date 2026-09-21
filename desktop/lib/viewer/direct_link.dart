import '../auth/cli_link.dart';
import '../auth/link_errors.dart';
import '../auth/peer_link_client.dart';
import '../core/config.dart';
import '../e2ee/keys.dart';
import 'direct_auth.dart';
import 'direct_auth_api.dart';
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
