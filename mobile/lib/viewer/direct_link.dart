import '../auth/cli_link.dart';
import '../auth/link_errors.dart';
import '../auth/peer_link_client.dart';
import '../core/config.dart';
import '../e2ee/keys.dart';
import 'direct_auth.dart';
import 'direct_auth_api.dart';
import 'code_link.dart';
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
  /// machine shown a different log than this phone is found out (`device_log_sync.dart`).
  ViewerDeviceLog? deviceLog;

  @override
  Future<CliLinkConnectResult> connect(
    String machineId,
    String password, {
    void Function(String stage)? onProgress,
    String? displayName,
    String? label,
  }) async {
    final start = await _start();
    if (start.failed != null) return start.failed!;
    final result = await linkWithPassword(
      machineId: machineId,
      password: password,
      identity: start.identity!,
      accessToken: start.token!,
      wsBaseUrl: config.wsBaseUrl,
      autonomousEnv: config.autonomousEnv,
      onProgress: (stage) => onProgress?.call(stage.wireName),
      label: label,
      socket: socket,
    );
    switch (result) {
      case PasswordLinked(:final peerPub, :final fingerprint):
        return _pin(machineId, peerPub, fingerprint);
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

  /// The QR's one-time code in place of the password: the same pin, from [linkWithCode].
  @override
  Future<CliLinkConnectResult> connectWithCode(
    String machineId,
    String code, {
    required String label,
    String? displayName,
  }) async {
    final start = await _start();
    if (start.failed != null) return start.failed!;
    final result = await linkWithCode(
      machineId: machineId,
      code: code,
      label: label,
      identity: start.identity!,
      accessToken: start.token!,
      wsBaseUrl: config.wsBaseUrl,
      autonomousEnv: config.autonomousEnv,
      socket: socket,
    );
    switch (result) {
      case PasswordLinked(:final peerPub, :final fingerprint):
        return _pin(machineId, peerPub, fingerprint);
      case PasswordLinkFailed(:final code):
        final name = displayName == null || displayName.isEmpty
            ? 'the computer'
            : displayName;
        return CliLinkConnectResult(
          error: switch (code) {
            'CODE_MISMATCH' =>
              'That code didn’t match. Scan the new one on $name.',
            'TIMEOUT' => 'Keep “Add phone” open on $name, then scan again.',
            'PAIRING_BUSY' =>
              '$name is pairing with something else. Try again.',
            _ => 'Couldn’t connect to $name ($code).',
          },
        );
    }
  }

  // ⚠️ **Both links answer with a result, never an exception** — the same contract the desktop's
  // CLI-backed link keeps. Their callers await them with nothing around them: the password form with its button
  // disabled until an answer comes, the QR's pairing screen under "Pairing…". A state file that
  // was locked or full threw straight through here, and left each of them waiting for good.

  /// The session's token and this device's identity — what either link needs before it dials.
  Future<
    ({String? token, E2eeIdentity? identity, CliLinkConnectResult? failed})
  >
  _start() async {
    try {
      return (
        token: await auth.accessToken(),
        identity: await keys.identity(),
        failed: null,
      );
    } on DirectAuthException catch (error) {
      return (
        token: null,
        identity: null,
        failed: CliLinkConnectResult(error: error.message),
      );
    } catch (_) {
      return (
        token: null,
        identity: null,
        failed: const CliLinkConnectResult(
          error: 'This phone couldn’t read its own keys. Try again.',
        ),
      );
    }
  }

  /// The machine proved itself; remembering it is the one thing left that can fail.
  Future<CliLinkConnectResult> _pin(
    String machineId,
    List<int> peerPub,
    String fingerprint,
  ) async {
    try {
      await keys.pin(machineId, peerPub);
    } catch (_) {
      return const CliLinkConnectResult(
        error: 'Linked, but this phone couldn’t save it. Try again.',
      );
    }
    return CliLinkConnectResult(
      linkedMachineId: machineId,
      fingerprint: fingerprint,
    );
  }

  /// Swaps trust-group rosters with [machineId] ([syncTrustGroup]): the machines this phone learns of
  /// are pinned — no password for them — and the machine learns this phone and whatever it linked.
  /// [label] is this phone's name for itself. Never throws.
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
    final log = deviceLog;
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
