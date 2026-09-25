import 'dart:convert';
import 'dart:typed_data';

import 'bytes.dart';
import 'primitives.dart';

/// core.ts's frame-payload envelope: `{__e2e: {v, k, n, ct, epoch?}}` stands in for a frame's
/// payload while its `type` stays readable, so the relay can route what it cannot read.

const int e2eVersion = 1;

/// Frames this client must send as ciphertext — core.ts `ENCRYPTED_DOWN_TYPES`.
/// `test/encrypted_down_types_test.dart` holds it to the CLI's own list, because a type missing here
/// fails nowhere on the phone: the frame simply leaves in the clear, and the machine refuses it with
/// E2EE_REQUIRED (for terminal_* the relay drops it as TERMINAL_FRAME_REJECTED).
const Set<String> encryptedDownTypes = {
  'message',
  'question_response',
  'agents_list',
  'sessions_list',
  'session_get',
  'models_list',
  'agent_create',
  'agent_create_status',
  'agent_delete',
  'agent_restart',
  // Reopens stopped work (`AppNotifier.resumeAgent`). Missing here, every tap on a Stopped row came
  // back "Could not open this harness: E2EE_REQUIRED".
  'agent_resume',
  // Carries the fork's name and first task — what the person typed — like agent_create's prompt.
  'agent_fork',
  'agent_recent',
  'agent_update',
  'agent_files',
  'agent_read_file',
  'fs_list_dir',
  'project_preview',
  // The branches of a folder on that machine, for the New Harness form
  // (`AppNotifier.readGitProject`).
  //
  // ⚠️ **Not in the CLI's `ENCRYPTED_DOWN_TYPES`, and still required.** The
  // machine's real rule is `encryptDownFrame` in `cli/src/lib/e2ee/
  // applicationFrames.ts`, which is that set OR a handful of types named
  // outright beside it — this one among them. Sent in the clear it came back
  // `E2EE_REQUIRED`, which on this screen read as a folder with no branches.
  'git_project_info',
  'codex_profiles_list',
  'codex_profile_link',
  // Asks the machine to read its OWN agent accounts' usage (cli/src/lib/accountUsage.ts). Missing
  // here it went out in the clear and the machine's CLI refused it outright with E2EE_REQUIRED —
  // which surfaced as an empty Usage page on a phone that was linked and connected.
  'usage_read',
  // The pane colours this client paints with, for the machine's tmux sessions (cli/src/lib/hostTheme.ts).
  'theme_set',
  'device_e2ee_pair',
  'e2ee_pairings_list',
  'e2ee_pairing_unpair',
  'e2ee_pairings_unpair_all',
  'e2ee_browser_link_create',
  'terminal_capabilities',
  'terminal_open',
  'terminal_alive',
  'terminal_ack',
  'terminal_input',
  'terminal_resize',
  'terminal_resync',
  'terminal_close',
  'terminal_scroll',
  'terminal_chunked_upload_begin',
  'terminal_chunked_upload_cancel',
  'p2p_offer',
  'p2p_answer',
  'p2p_ice_candidate',
  'p2p_abort',
  'p2p_promote',
};

/// Requests an older CLI took in the clear and a current one refuses unsealed — applicationFrames.ts
/// `STRICT_DOWN_TYPES`. Sealed only for a machine whose welcome says `strictDown`: an older one would
/// never open the envelope and would read the request as empty.
const Set<String> strictDownTypes = {
  'dsh_install',
  'dsh_update',
  'dsh_remove',
  'dsh_list',
  'agent_retarget',
  'engines_probe',
  'grid_models_list',
  'cancel',
  'claude_login_status',
  'speaking',
};

/// Whether [type] goes sealed to a machine — applicationFrames.ts `encryptDownFrameFor`.
bool sealsDown(String type, {required bool strictDown}) =>
    encryptedDownTypes.contains(type) ||
    (strictDown && strictDownTypes.contains(type));

Uint8List _aad(int v, String type, String dbSessionId, String k, String epoch) =>
    utf8Bytes('$v|$type|$dbSessionId|$k|$epoch');

/// Seals [payload] under [key]: [k] is 'p' (pairwise session) or 'g' (the machine's group key,
/// which also carries an [epoch]).
Map<String, Object?> wrapPayload(
  List<int> key,
  String k,
  int counter,
  String frameType,
  String? dbSessionId,
  Object? payload, {
  String? epoch,
}) {
  final aad = _aad(e2eVersion, frameType, dbSessionId ?? '', k, epoch ?? '');
  final sealed = aeadSeal(key, counter, aad, utf8Bytes(jsonEncode(payload)));
  return {
    '__e2e': {
      'v': e2eVersion,
      'k': k,
      'n': counter,
      'ct': b64e(sealed),
      'epoch': ?epoch,
    },
  };
}

/// The payload object [wrapPayload] sealed; null when it does not open — a wrong key or counter, or
/// an AAD (type, session, epoch) other than the one it was sealed under.
Map<String, dynamic>? unwrapPayload(
  List<int> key,
  Map<String, dynamic> env,
  String frameType,
  String? dbSessionId,
) {
  final v = env['v'], k = env['k'], n = env['n'], ct = env['ct'];
  final epoch = env['epoch'] ?? '';
  if (v is! int || k is! String || n is! int || ct is! String || epoch is! String) {
    return null;
  }
  final Uint8List sealed;
  try {
    sealed = b64d(ct);
  } on FormatException {
    return null;
  }
  final clear = aeadOpen(key, n, _aad(v, frameType, dbSessionId ?? '', k, epoch), sealed);
  return clear == null ? null : jsonObjectOf(clear);
}

bool isWrapped(Object? payload) => payload is Map && payload.containsKey('__e2e');

/// UTF-8 JSON that must be an object; null for anything else.
Map<String, dynamic>? jsonObjectOf(List<int> utf8Json) {
  try {
    final value = jsonDecode(utf8.decode(utf8Json));
    return value is Map<String, dynamic> ? value : null;
  } on FormatException {
    return null;
  }
}
