import 'dart:async';

import '../auth/phone_sign_in.dart';
import 'direct_auth_api.dart';

/// A viewer build signing itself in by a QR a signed-in phone approves — cli `lib/qrSignIn.ts`,
/// for an app with no CLI: start, show, poll (keeping the same code alive), ask the person whose
/// account approved, and only then claim the session. An app asks as `viewer`: it may reach the
/// account's machines, never connect as one.
Future<IssuedTokens> viewerQrSignIn({
  required DirectAuthApi api,
  required String label,
  required void Function(String link, int expiresIn) onQr,
  required Future<bool> Function(String email) onConfirm,
  required bool Function() stillCurrent,
  Future<void> Function(Duration)? sleep,
  DateTime Function()? now,
  Duration pollEvery = const Duration(seconds: 2),
}) async {
  final wait = sleep ?? Future<void>.delayed;
  final clock = now ?? DateTime.now;
  final ({String code, String pollToken, int expiresIn}) started;
  try {
    started = await api.qrStart(label: label);
  } catch (error) {
    throw PhoneSignInException('UNAVAILABLE', '$error');
  }
  final link = phoneSignInLink(started.code);
  var expiresAt = clock().add(Duration(seconds: started.expiresIn));
  onQr(link, started.expiresIn);
  Never gone(String code, String message) => throw PhoneSignInException(code, message);
  for (;;) {
    await wait(pollEvery);
    if (!stillCurrent()) {
      unawaited(api.qrCancel(started.pollToken));
      gone('CANCELLED', 'Sign-in was cancelled.');
    }
    if (expiresAt.difference(clock()) < const Duration(seconds: 30)) {
      int? more;
      try {
        more = await api.qrExtend(started.pollToken);
      } catch (_) {
        // As the CLI does: a code that cannot be kept alive is an expired one, said as such.
      }
      if (more == null) gone('EXPIRED', 'The code expired. Try again.');
      expiresAt = clock().add(Duration(seconds: more));
      onQr(link, more);
    }
    final ({String status, String? email}) state;
    try {
      state = await api.qrPoll(started.pollToken);
    } catch (_) {
      continue;
    }
    switch (state.status) {
      case 'pending':
        continue;
      case 'denied':
        gone('DENIED', 'Sign-in was denied on the phone.');
      case 'approved' when state.email != null:
        if (!await onConfirm(state.email!) || !stillCurrent()) {
          unawaited(api.qrCancel(started.pollToken));
          gone('CANCELLED', 'Not signed in as ${state.email}.');
        }
        try {
          return await api.qrClaim(started.pollToken);
        } catch (error) {
          gone('BACKEND_ERROR', '$error');
        }
      default:
        gone('EXPIRED', 'The code expired. Try again.');
    }
  }
}
