/// cli.ts `humanizeLinkError`: a password-link failure code as the sentence to show. Every branch,
/// the fallback included, wraps the code in words — a bare code must never reach the screen.
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
      'Machine $machineId has no remote password set. Ask its operator to run '
          '`harness remote-password set` there first.',
    'BAD_INTENT' =>
      'The connection request was malformed — this usually means a version mismatch. '
          'Update harness on both machines and try again.',
    'WRONG_PASSWORD' =>
      'That password is wrong. Check it against the other machine and try again.',
    'TIMEOUT' =>
      "Machine $machineId didn't respond in time. Make sure it's running `harness start` "
          'and reachable, then try again.',
    'SEND_FAILED' =>
      'Could not reach the relay to start linking. Check your network connection and try again.',
    'DERIVE_FAILED' =>
      'Could not process the password locally. Try again; if it persists, restart the app and retry.',
    'SELECT_FAILED' =>
      "Could not find machine $machineId, or it isn't reachable right now. Check that it has "
          'run `harness start`.',
    'PAIR_FAILED' =>
      "Linking failed on $machineId's side. Try again; if it persists, check its status there "
          'with `harness status`.',
    'PROTOCOL_ERROR' =>
      'Something unexpected happened during the handshake. Try again; if it persists, update '
          'harness on the other machine.',
    'CONNECTION_ERROR' =>
      'Could not reach the relay. Check your network connection and try again.',
    _ =>
      'Linking failed ($code). Try again; if it persists, check the other machine is on the '
          'latest harness version.',
  };
}
