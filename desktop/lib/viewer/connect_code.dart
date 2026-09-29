/// What the desktop app's **Add phone** QR says — the contract between the two apps:
///
/// ```
/// https://harness.autonomous.ai/pair#e=<email>&m=<machineId>&c=<one-time pairing code>&h=<sign-in code>
///                                     &f=<machine fingerprint>&n=<hostname>
/// ```
///
/// `f` and `n` come from `harness link qr` (and newer desktops): the machine's identity fingerprint,
/// checked against the key the pairing pins, and its name for the confirm screen.
///
/// A machine that is not signed in yet (`harness login`, the desktop's sign-in) shows the same link
/// with `s` in place of `m` and `e`: its sign-in request, which a signed-in phone approves — that
/// signs the machine in — before the pairing code links the two.
///
/// A BROWSER asking to be signed in (the web sign-in page) adds `k=v`: approving it signs that
/// browser in, and the phone then links it through one of its machines — it is a viewer, like the
/// phone, not a machine to add.
///
/// Any host serving the app is taken (a local build is `http://<ip>:<port>/pair`): the fields are
/// what matter, and the host is only where a phone's camera sends the link.
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
    this.fingerprint,
    this.hostname,
    this.signInRequest,
    this.viewer = false,
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

  /// The machine's identity fingerprint as the QR spells it (separators dropped), or null from an
  /// older desktop. When present, the pairing refuses a machine that proves a different key.
  final String? fingerprint;

  /// The machine's hostname, for display only — the account's machine list is what names it.
  final String? hostname;

  /// `s`: the sign-in request of a machine that is not signed in yet (`/api/device-auth`). Approving
  /// it signs that machine in to this phone's account; its machine id comes back from the approval.
  final String? signInRequest;

  /// A machine asking to be signed in, rather than one already on the account.
  bool get isSignIn => signInRequest != null;

  /// `k=v`: the sign-in request is a browser's, not a machine's — see the class comment.
  final bool viewer;

  /// A browser asking to be signed in.
  bool get isViewerSignIn => isSignIn && viewer;

  static const host = 'harness.autonomous.ai';
  static const path = '/pair';

  /// The code a scanned string holds, or null when it is not one of ours.
  static ConnectCode? parse(String raw) {
    final uri = Uri.tryParse(raw.trim());
    if (uri == null ||
        (uri.scheme != 'https' && uri.scheme != 'http') ||
        uri.host.isEmpty ||
        uri.path != path) {
      return null;
    }
    final Map<String, String> fields;
    try {
      fields = Uri.splitQueryString(uri.fragment);
    } on FormatException {
      return null;
    }
    String? present(String key) {
      final value = fields[key]?.trim();
      return value == null || value.isEmpty ? null : value;
    }

    final email = fields['e']?.trim() ?? '';
    // An account to sign in to, a machine to pair with, or a machine asking to be signed in.
    final pairs = present('m') != null && present('c') != null;
    if (!email.contains('@') && !pairs && present('s') == null) return null;

    return ConnectCode(
      email: email,
      machineId: present('m'),
      pairCode: present('c'),
      signIn: present('h'),
      fingerprint: present('f'),
      hostname: present('n'),
      signInRequest: present('s'),
      viewer: present('k') == 'v',
    );
  }

  /// The link for [email] — what the desktop app encodes, and what tests scan.
  /// The sign-in QR's link (`harness login`) — what tests scan.
  ///
  /// [viewer] marks a browser's (`k=v`); [base] is where the link lands — a local or LAN build
  /// passes its own origin, so a phone's camera opens the build that can approve it.
  static String signInLink(
    String signInRequest, {
    required String pairCode,
    String? fingerprint,
    String? hostname,
    bool viewer = false,
    Uri? base,
  }) => Uri(
    scheme: base?.scheme ?? 'https',
    host: base?.host ?? host,
    port: base != null && base.hasPort ? base.port : null,
    path: path,
    fragment: [
      's=${Uri.encodeQueryComponent(signInRequest)}',
      'c=${Uri.encodeQueryComponent(pairCode)}',
      if (fingerprint != null) 'f=${Uri.encodeQueryComponent(fingerprint)}',
      if (hostname != null) 'n=${Uri.encodeQueryComponent(hostname)}',
      if (viewer) 'k=v',
    ].join('&'),
  ).toString();

  static String link(
    String email, {
    String? machineId,
    String? pairCode,
    String? signIn,
    String? fingerprint,
    String? hostname,
  }) => Uri(
    scheme: 'https',
    host: host,
    path: path,
    fragment: [
      'e=${Uri.encodeQueryComponent(email)}',
      if (machineId != null) 'm=${Uri.encodeQueryComponent(machineId)}',
      if (pairCode != null) 'c=${Uri.encodeQueryComponent(pairCode)}',
      if (signIn != null) 'h=${Uri.encodeQueryComponent(signIn)}',
      if (fingerprint != null) 'f=${Uri.encodeQueryComponent(fingerprint)}',
      if (hostname != null) 'n=${Uri.encodeQueryComponent(hostname)}',
    ].join('&'),
  ).toString();
}
