import '../auth/cli_link.dart';
import '../auth/link_errors.dart';
import '../auth/peer_link_client.dart';
import '../core/config.dart';
import '../e2ee/keys.dart';
import '../logging/app_log.dart';
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
        return CliLinkConnectResult(error: _codePairingError(code, name));
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

/// A failed pairing by an Add Phone code ([linkWithCode]) as the sentence the pairing screen shows,
/// [name] the computer's.
///
/// ⚠️ **Never the bare code.** The fallback used to be "Couldn’t connect to $name ($code)." — and
/// most failures took it: every socket error (CONNECTION_ERROR), a socket closed mid-pairing, a
/// computer the relay could not reach, the computer's own refusal, and whatever string a computer
/// sends back. Each now says what to do instead, and the code goes to the log.
String _codePairingError(String code, String name) {
  appLog.warn('pair', 'pairing by code failed: $code');
  // Where the name starts the sentence: "the computer", for one with no name, would not.
  final subject = name.isEmpty
      ? name
      : '${name[0].toUpperCase()}${name.substring(1)}';
  if (code.startsWith('CONNECTION_CLOSED')) {
    return 'The connection to $name dropped before pairing finished. Scan again.';
  }
  return switch (code) {
    'CODE_MISMATCH' => 'That code didn’t match. Scan the new one on $name.',
    'TIMEOUT' => 'Keep “Add Phone” open on $name, then scan again.',
    'PAIRING_BUSY' => '$subject is pairing with something else. Try again.',
    'CONNECTION_ERROR' =>
      'Couldn’t reach $name. Check your connection, then scan again.',
    'SELECT_FAILED' =>
      'Couldn’t find $name, or it’s offline. Make sure Harness is open there, then scan again.',
    'PAIR_REFUSED' || 'PAIR_FAILED' =>
      '$subject didn’t finish pairing. Open Add Phone… on it again and scan the new code.',
    'PROTOCOL_ERROR' =>
      'Pairing with $name went wrong. Make sure Harness is up to date there, then scan again.',
    _ =>
      'Couldn’t pair with $name. Open Add Phone… on it again and scan the new code.',
  };
}
