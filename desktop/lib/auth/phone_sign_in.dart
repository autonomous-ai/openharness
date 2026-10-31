/// Signing in by a QR that a signed-in phone scans and approves (backend `routes/qrSignIn.ts`) —
/// beside SSO, for the sign-in clients that can: the CLI's (`harness login --qr`) and a viewer's.
///
/// A client that cannot is simply not one of these, and the login screen offers SSO alone.
abstract interface class PhoneSignInClient {
  /// Shows [onQr] the link to encode (again, whenever its life is extended), waits for a phone to
  /// approve it, then asks [onConfirm] whether to sign in as the account that approved — someone
  /// else's phone may have. Resolves once signed in; throws [PhoneSignInException] otherwise.
  Future<void> loginWithPhone({
    required void Function(String link, int expiresIn) onQr,
    required Future<bool> Function(String email) onConfirm,
  });
}

/// Signing in by a short code another signed-in device approves: a phone (Settings ▸ Sign in a
/// computer ▸ Type a code instead) or a computer (Machines ▸ Approve a device). The same approval as
/// the QR (backend `routes/qrSignIn.ts`), for a computer whose screen a phone cannot reach — a remote
/// one — or a person with no phone at hand. The CLI's (`harness login --code`).
abstract interface class CodeSignInClient {
  /// Shows [onCode] the code to type (again, whenever its life is extended), waits for a device to
  /// approve it, then asks [onConfirm] whose account it is, as [PhoneSignInClient.loginWithPhone].
  Future<void> loginWithCode({
    required void Function(String code, int expiresIn) onCode,
    required Future<bool> Function(String email) onConfirm,
  });
}

/// The two ways in another device approves: a phone scanning the QR, or a code typed elsewhere.
enum ApprovalSignIn { phone, code }

/// Why a phone sign-in did not finish. [code]: `DENIED` (on the phone), `EXPIRED`, `CANCELLED`
/// (the person here said no, or went back), `BACKEND_ERROR`, `UNAVAILABLE` (a backend without it).
class PhoneSignInException implements Exception {
  const PhoneSignInException(this.code, this.message);

  final String code;
  final String message;

  @override
  String toString() => message;
}

/// Where a sign-in QR points; the phone's scanner reads exactly this (mobile `SignInCode`).
String phoneSignInLink(String code) => Uri(
  scheme: 'https',
  host: 'harness.autonomous.ai',
  path: '/signin',
  fragment: 'k=${Uri.encodeQueryComponent(code)}',
).toString();
