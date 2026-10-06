/// cli.ts `humanizeLinkError`: a password-link failure code as the sentence to show. Every branch,
/// the fallback included, wraps the code in words — a bare code must never reach the screen.
///
/// Worded for a phone, not a terminal: the desktop app is named first, where most people set the
/// password and keep Harness running, and the CLI command after it, for a server.
String humanizeLinkError(String code, String machineId, {DateTime? retryAt}) {
  if (code == 'RATE_LIMITED') {
    if (retryAt == null) {
      return 'Too many wrong attempts on $machineId. Wait a few minutes and try again.';
    }
    final minutes = (retryAt.difference(DateTime.now()).inSeconds / 60).ceil();
    return minutes > 0
        ? 'Too many wrong attempts on $machineId. Try again in $minutes minute${minutes == 1 ? '' : 's'}.'
        : 'Too many wrong attempts on $machineId. Try again now.';
  }
  const closedPrefix = 'CONNECTION_CLOSED:';
  if (code.startsWith(closedPrefix)) {
    return 'The connection closed unexpectedly (code ${code.substring(closedPrefix.length)}) '
        'before linking finished. Try again.';
  }
  return switch (code) {
    'NO_REMOTE_PASSWORD' =>
      '$machineId has no phone password yet. Set one there (in Harness: Machines, then '
          'Password; on a server: `harness remote-password set`), then try again.',
    'BAD_INTENT' =>
      'The connection request was malformed — this usually means a version mismatch. '
          'Update Harness on the computer and on this phone, then try again.',
    'WRONG_PASSWORD' =>
      'That password is wrong. It is the one set on $machineId (in Harness: Machines, then '
          'Password; on a server: `harness remote-password set`).',
    'BUSY' =>
      'Machine $machineId is already handling another link attempt. Wait a moment and try again.',
    'TIMEOUT' =>
      "$machineId didn't respond in time. Make sure Harness is running there (the app, or "
          '`harness start` on a server) and it is online, then try again.',
    'SEND_FAILED' =>
      'Could not reach the relay to start linking. Check your network connection and try again.',
    'DERIVE_FAILED' =>
      'Could not process the password locally. Try again; if it persists, restart the app and retry.',
    'SELECT_FAILED' =>
      "Could not find $machineId, or it isn't reachable right now. Check that Harness is "
          'running there (the app, or `harness start` on a server).',
    'PAIR_FAILED' =>
      "Linking failed on $machineId's side. Try again; if it persists, check its status there "
          'with `harness status`.',
    'PROTOCOL_ERROR' =>
      'Something unexpected happened during the handshake. Try again; if it persists, update '
          'Harness on the computer.',
    'CONNECTION_ERROR' =>
      'Could not reach the relay. Check your network connection and try again.',
    _ =>
      'Linking failed ($code). Try again; if it persists, check that Harness on the computer is '
          'up to date.',
  };
}
