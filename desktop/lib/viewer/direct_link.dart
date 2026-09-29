import '../auth/cli_link.dart';
import '../auth/link_errors.dart';
import '../auth/peer_link_client.dart';
import '../core/config.dart';
import '../e2ee/keys.dart';
import 'direct_auth.dart';
import 'direct_auth_api.dart';
import 'code_link.dart';
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

  /// The QR's one-time code in place of the password (`harness link qr`, or Add Phone): the
  /// same pin, from [linkWithCode], refused when the machine's key is not the fingerprint the QR
  /// named. Answers with a result, never an exception.
  @override
  Future<CliLinkConnectResult> connectWithCode(
    String machineId,
    String code, {
    required String label,
    String? displayName,
    String? expectedFingerprint,
  }) async {
    final String token;
    try {
      token = await auth.accessToken();
    } on DirectAuthException catch (error) {
      return CliLinkConnectResult(error: error.message);
    } catch (_) {
      return const CliLinkConnectResult(error: 'Not signed in.');
    }
    final PasswordLinkResult result;
    try {
      result = await linkWithCode(
        machineId: machineId,
        code: code,
        label: label,
        identity: await keys.identity(),
        accessToken: token,
        wsBaseUrl: config.wsBaseUrl,
        autonomousEnv: config.autonomousEnv,
        socket: socket,
      );
    } catch (_) {
      return const CliLinkConnectResult(
        error: 'This browser couldn’t read its own keys. Try again.',
      );
    }
    final name = displayName == null || displayName.isEmpty
        ? 'the machine'
        : displayName;
    switch (result) {
      case PasswordLinked(:final peerPub, :final fingerprint):
        if (expectedFingerprint != null &&
            !sameFingerprint(fingerprint, expectedFingerprint)) {
          return const CliLinkConnectResult(
            error: 'That machine’s fingerprint doesn’t match its code. Nothing was linked.',
          );
        }
        try {
          await keys.pin(machineId, peerPub);
        } catch (_) {
          return const CliLinkConnectResult(
            error: 'Linked, but this browser couldn’t save it. Try again.',
          );
        }
        return CliLinkConnectResult(
          linkedMachineId: machineId,
          fingerprint: fingerprint,
        );
      case PasswordLinkFailed(:final code):
        return CliLinkConnectResult(
          error: switch (code) {
            'CODE_MISMATCH' =>
              'That code didn’t match. Scan the new one on $name.',
            'TIMEOUT' => 'Keep the QR open on $name, then scan again.',
            'PAIRING_BUSY' =>
              '$name is pairing with something else. Try again.',
            _ => 'Couldn’t connect to $name ($code).',
          },
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

/// Two fingerprints as the same key, however they are written (`5F80·61C4…`, `5f8061c4…`).
bool sameFingerprint(String a, String b) {
  String norm(String v) => v.toUpperCase().replaceAll(RegExp('[^0-9A-Z]'), '');
  final x = norm(a), y = norm(b);
  return x.isNotEmpty && x == y;
}
