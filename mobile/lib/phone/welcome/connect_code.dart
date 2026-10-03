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

/// What a computer signing in by QR shows — the desktop app's "Scan with your phone", or
/// `harness login` choosing it (backend `routes/qrSignIn.ts`):
///
/// ```
/// https://harness.autonomous.ai/signin#k=<code>
/// ```
///
/// The code is in the fragment, like [ConnectCode]'s, so a Camera app that opens the link sends it
/// nowhere. It is only an address: approving it takes this phone's own sign-in, and the computer
/// still asks its person whose account it is joining before anything is created.
class SignInCode {
  const SignInCode(this.code);

  final String code;

  static const path = '/signin';
  static final _shape = RegExp(r'^hnq_[A-Za-z0-9_-]{43}$');

  static SignInCode? parse(String raw) {
    final uri = Uri.tryParse(raw.trim());
    if (uri == null ||
        uri.scheme != 'https' ||
        uri.host != ConnectCode.host ||
        uri.path != path) {
      return null;
    }
    final code = Uri.splitQueryString(uri.fragment)['k']?.trim() ?? '';
    return _shape.hasMatch(code) ? SignInCode(code) : null;
  }

  static String link(String code) => Uri(
    scheme: 'https',
    host: ConnectCode.host,
    path: path,
    fragment: 'k=${Uri.encodeQueryComponent(code)}',
  ).toString();
}
