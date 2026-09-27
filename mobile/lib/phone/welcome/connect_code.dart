/// What the desktop app's **Add phone** QR says — the contract between the two apps:
///
/// ```
/// https://harness.autonomous.ai/pair#e=<email>&m=<machineId>&c=<one-time pairing code>&h=<sign-in code>
/// ```
///
/// A link, so the Camera app lands somewhere sensible: `/pair` on the website says to scan it from
/// the Harness app (`/connect` there is an older, unrelated page). **Everything is in the
/// fragment**, which a browser never sends to the server: the pairing code is the out-of-band
/// secret end-to-end encryption rests on, and it must not reach our backend even when the link is
/// opened in Safari. `m`, `c` and `h` are optional: a QR with only `e`
/// still signs the phone in to the right account, by an emailed code.
class ConnectCode {
  const ConnectCode({
    required this.email,
    this.machineId,
    this.pairCode,
    this.signIn,
  });

  final String email;
  final String? machineId;

  /// The one-time code the computer's daemon pairs with (its live-code CPace pairing), so no remote
  /// password is typed. Held until the phone is signed in.
  final String? pairCode;

  /// The one-time code that signs the phone in with no emailed code — minted
  /// for this QR by the computer's own sign-in, good for about a minute, and
  /// spent by the first phone to redeem it (`AppNotifier.signInWithScan`).
  final String? signIn;

  static const host = 'harness.autonomous.ai';
  static const path = '/pair';

  /// The code a scanned string holds, or null when it is not one of ours.
  static ConnectCode? parse(String raw) {
    final uri = Uri.tryParse(raw.trim());
    if (uri == null ||
        uri.scheme != 'https' ||
        uri.host != host ||
        uri.path != path) {
      return null;
    }
    final fields = Uri.splitQueryString(uri.fragment);
    final email = fields['e']?.trim() ?? '';
    if (!email.contains('@')) return null;
    String? present(String key) {
      final value = fields[key]?.trim();
      return value == null || value.isEmpty ? null : value;
    }

    return ConnectCode(
      email: email,
      machineId: present('m'),
      pairCode: present('c'),
      signIn: present('h'),
    );
  }

  /// The link for [email] — what the desktop app encodes, and what tests scan.
  static String link(
    String email, {
    String? machineId,
    String? pairCode,
    String? signIn,
  }) => Uri(
    scheme: 'https',
    host: host,
    path: path,
    fragment: [
      'e=${Uri.encodeQueryComponent(email)}',
      if (machineId != null) 'm=${Uri.encodeQueryComponent(machineId)}',
      if (pairCode != null) 'c=${Uri.encodeQueryComponent(pairCode)}',
      if (signIn != null) 'h=${Uri.encodeQueryComponent(signIn)}',
    ].join('&'),
  ).toString();
}
