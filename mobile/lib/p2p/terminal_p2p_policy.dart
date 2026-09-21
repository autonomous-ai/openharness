/// The backend's terminal-P2P policy for one machine, as it arrives on the relay's
/// `connected` ack — a port of `p2pPolicy()` in the harness CLI's `remoteRelay.ts`
/// and `readTurn()` in its `terminalP2p.ts`. Same clamps, same reasons: the list
/// caps match what the backend is configured to send, and a malformed TURN block
/// degrades to STUN-only rather than to no P2P at all.
library;

const terminalP2pProtocolVersion = 1;

const _maxStunUrls = 10;
const _maxTurnUrls = 8;
const _maxTurnSecretChars = 512;
const _defaultOpenWaitMs = 1500;
const _maxOpenWaitMs = 5000;

/// Cloudflare hands out one credential covering several urls. The CLI keeps only
/// one (werift's limit); libwebrtc takes the whole list, so the phone passes it all.
class TerminalP2pTurn {
  const TerminalP2pTurn({
    required this.urls,
    required this.username,
    required this.credential,
  });

  final List<String> urls;
  final String username;
  final String credential;

  /// Shared by both peers in the CLI: same validation, same reason.
  static TerminalP2pTurn? parse(Object? raw) {
    if (raw is! Map) return null;
    final username = raw['username'];
    final credential = raw['credential'];
    if (username is! String ||
        username.isEmpty ||
        username.length > _maxTurnSecretChars) {
      return null;
    }
    if (credential is! String ||
        credential.isEmpty ||
        credential.length > _maxTurnSecretChars) {
      return null;
    }
    final urlsRaw = raw['urls'];
    final urls = urlsRaw is List
        ? urlsRaw
              .whereType<String>()
              .where(
                (url) =>
                    RegExp(r'^turns?:', caseSensitive: false).hasMatch(url),
              )
              .take(_maxTurnUrls)
              .toList(growable: false)
        : const <String>[];
    if (urls.isEmpty) return null;
    return TerminalP2pTurn(
      urls: urls,
      username: username,
      credential: credential,
    );
  }

  /// As the offer carries it to the responder — the only way the credential can
  /// reach it, since the backend never sends the responder a policy of its own.
  Map<String, dynamic> toJson() => {
    'urls': urls,
    'username': username,
    'credential': credential,
  };
}

class TerminalP2pPolicy {
  const TerminalP2pPolicy({
    required this.stunUrls,
    required this.openWaitMs,
    this.turn,
  });

  /// `stun:`/`stuns:` urls, in the backend's order.
  final List<String> stunUrls;

  /// How long a `terminal_open` waits for the data channel before riding the relay.
  final int openWaitMs;
  final TerminalP2pTurn? turn;

  Duration get openWait => Duration(milliseconds: openWaitMs);

  /// Null unless the backend enabled P2P for this user+machine at the protocol this
  /// build speaks — either is the same "ws relay only" answer.
  static TerminalP2pPolicy? parse(Object? raw) {
    if (raw is! Map) return null;
    if (raw['enabled'] != true) return null;
    if (raw['protocolVersion'] != terminalP2pProtocolVersion) return null;
    final stunRaw = raw['stunUrls'];
    final stunUrls = stunRaw is List
        ? stunRaw
              .whereType<String>()
              .where(
                (url) =>
                    RegExp(r'^stuns?:', caseSensitive: false).hasMatch(url),
              )
              .take(_maxStunUrls)
              .toList(growable: false)
        : const <String>[];
    final waitRaw = raw['openWaitMs'];
    final openWaitMs = waitRaw is num && waitRaw.isFinite
        ? waitRaw.round().clamp(0, _maxOpenWaitMs)
        : _defaultOpenWaitMs;
    return TerminalP2pPolicy(
      stunUrls: stunUrls,
      openWaitMs: openWaitMs,
      turn: TerminalP2pTurn.parse(raw['turn']),
    );
  }
}
