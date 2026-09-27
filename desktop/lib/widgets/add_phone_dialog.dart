import 'dart:async';
import 'dart:io' show SocketException;
import 'dart:math' as math;

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:qr/qr.dart';
import 'package:xterm/xterm.dart' show TerminalTheme;

import '../api/api_client.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shortcuts/app_keymap.dart';
import '../state/app_state.dart';
import '../terminal/terminal_text.dart';
import '../terminal/terminal_theme.dart';
import '../terminal/terminal_theme_store.dart';
import 'box_chrome.dart';
import 'terminal_prompt.dart';

/// Harness ▸ Add Phone… — a QR the phone scans to sign in to this account AND
/// pair with this computer, end to end encrypted, with no password typed.
///
/// Three parts, and the QR is only one of them:
///
/// 1. **The QR** ([phonePairLink]) tells the phone who to sign in as, which
///    machine to pair with, and the one-time pairing code.
/// 2. **The sign-in code** ([PhoneSignInCodeCall]), which the QR also carries:
///    the phone redeems it for a session of its own, so the scan signs it in
///    with no emailed code. Renewed every minute while the dialog is open —
///    see [_AddPhoneDialogState._renewSignIn].
/// 3. **Arming the daemon.** The phone, once signed in, sends this machine an
///    `e2e_pair_intent`; the daemon runs the handshake only when somebody on
///    THIS computer hands it the same code (`POST /api/pair`, the call
///    `harness pair <code>` makes). So while this dialog is open it keeps
///    handing it over — see [_AddPhoneDialogState._loop] — and the code is
///    live exactly as long as the QR is on screen.
///
/// [pair] and [signInCode] are the transport, injectable so a test needs no
/// daemon; by default they are this app's own loopback client
/// ([phonePairOverDaemon], [ApiClient.phoneSignInCode]).
Future<void> showAddPhoneDialog(
  BuildContext context,
  AppNotifier app, {
  AppKeymap? keymap,
  PhonePairCall? pair,
  PhoneSignInCodeCall? signInCode,
}) => showTerminalPrompt<void>(
  context,
  keymap: keymap,
  builder: (_) => AddPhoneDialog(
    app: app,
    pair: pair ?? phonePairOverDaemon(app.api),
    signInCode: signInCode ?? app.api.phoneSignInCode,
  ),
);

/// Where the QR points. The phone's `ConnectCode` (mobile
/// `lib/phone/welcome/connect_code.dart`) parses exactly this.
const kPhonePairHost = 'harness.autonomous.ai';
const kPhonePairPath = '/pair';

/// The characters a pairing code is drawn from: no `0 O 1 I L`, which read
/// alike — and no `U` either.
///
/// ⚠️ `U` is left out on purpose, although it reads fine. The daemon feeds
/// the code through core.ts `normalizeCode`, which maps `U` to `V` (Crockford
/// base32); the phone's `normalizePairCode` only uppercases and strips
/// separators. A code with a `U` in it would therefore reach CPace as two
/// different secrets and fail as `CODE_MISMATCH` every time — for a 16-letter
/// code, about four scans in ten. Without it both sides agree whatever either
/// normaliser does, at 30 symbols: 78 bits over 16 characters, far past what
/// three guesses per five minutes (the daemon's rate limit) could dent.
const kPhonePairCodeAlphabet = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
const kPhonePairCodeLength = 16;

/// A fresh one-time pairing code, from a cryptographically secure source.
///
/// It is the whole secret the pairing rests on — the backend relays the
/// handshake and must learn nothing from it — so never `Random()`.
/// [random] exists for tests; `Random.secure().nextInt` is uniform, so no
/// symbol is likelier than another.
String newPhonePairCode({math.Random? random}) {
  final source = random ?? math.Random.secure();
  return String.fromCharCodes([
    for (var i = 0; i < kPhonePairCodeLength; i++)
      kPhonePairCodeAlphabet.codeUnitAt(
        source.nextInt(kPhonePairCodeAlphabet.length),
      ),
  ]);
}

/// `https://harness.autonomous.ai/pair#e=<email>&m=<machineId>&c=<code>&h=<sign-in code>`.
///
/// ⚠️ EVERYTHING rides in the FRAGMENT, never the query. The code is the
/// out-of-band secret end-to-end encryption rests on, and a browser never
/// sends a fragment to the server — so a link opened in Safari (no app
/// installed yet, a desktop camera, a curious person) still keeps the code
/// off our servers and out of every access log between here and there. The
/// email and machine id go with it: nothing in this link is the server's
/// business.
///
/// Encoded as a query string inside the fragment, with
/// [Uri.encodeQueryComponent], because the phone reads it back with
/// [Uri.splitQueryString] — a `+` in an address has to arrive as a `+`.
///
/// [signIn] (`h`) is the one-time code that signs the phone in; without it —
/// or on a phone app that predates it — the phone signs in with an emailed
/// code, as before. It is the account's credential for its minute, which is
/// one more reason all of this rides in the fragment.
Uri phonePairLink({
  required String email,
  required String machineId,
  required String code,
  String? signIn,
}) => Uri(
  scheme: 'https',
  host: kPhonePairHost,
  path: kPhonePairPath,
  fragment:
      'e=${Uri.encodeQueryComponent(email)}'
      '&m=${Uri.encodeQueryComponent(machineId)}'
      '&c=$code'
      '${signIn != null ? '&h=${Uri.encodeQueryComponent(signIn)}' : ''}',
);

/// What one `POST /api/pair` came to, as far as this dialog cares.
@immutable
class PhonePairAnswer {
  /// The phone is paired; [label] is its own name for itself.
  const PhonePairAnswer.paired(String this.label) : error = null;

  /// The daemon's error code (`NO_INTENT`, `CODE_MISMATCH`, …), or
  /// [unavailable] for a daemon that cannot pair at all.
  const PhonePairAnswer.failed(String this.error) : label = null;

  final String? label;
  final String? error;

  /// The daemon has no pairing to offer: it said so (a build without E2EE),
  /// it predates `/api/pair` (404), or nobody is listening. Asking again will
  /// not change that.
  static const unavailable = 'PAIRING_UNAVAILABLE';

  @override
  String toString() =>
      label != null ? 'PhonePairAnswer.paired($label)' : 'failed($error)';
}

/// Hand the daemon [code] once. [cancel] is cancelled when the dialog closes:
/// the transport should give up waiting on its long poll then.
typedef PhonePairCall = Future<PhonePairAnswer> Function(
  String code,
  CancelToken cancel,
);

/// [PhonePairCall] over this app's own loopback client — the daemon's Unix
/// socket, or its port (see [ApiClient]).
PhonePairCall phonePairOverDaemon(ApiClient api) => (code, cancel) async {
  try {
    final (:status, :body) = await api.pair(code, cancelToken: cancel);
    final error = body['error'];
    if (status >= 200 && status < 300 && error == null) {
      final label = body['label'];
      return PhonePairAnswer.paired(
        label is String && label.trim().isNotEmpty ? label.trim() : 'phone',
      );
    }
    // A daemon from before `/api/pair` answers its catch-all 404, which is
    // `{error: 'not found'}` — a code, but not one of the pairing's.
    if (status == 404) {
      return const PhonePairAnswer.failed(PhonePairAnswer.unavailable);
    }
    return PhonePairAnswer.failed(
      error is String && error.isNotEmpty ? error : 'HTTP_$status',
    );
  } on DioException catch (error) {
    return PhonePairAnswer.failed(switch (error.type) {
      // Nobody on the port or the socket.
      DioExceptionType.connectionError => PhonePairAnswer.unavailable,
      DioExceptionType.unknown when error.error is SocketException =>
        PhonePairAnswer.unavailable,
      // Our own 60 s ran out on a handshake: the phone went quiet.
      DioExceptionType.receiveTimeout ||
      DioExceptionType.sendTimeout ||
      DioExceptionType.connectionTimeout => 'TIMEOUT',
      _ => 'UNREACHABLE',
    });
  }
};

/// A fresh one-time sign-in code for the QR and how long it stays good, or
/// null when there is none to be had (see [ApiClient.phoneSignInCode]).
typedef PhoneSignInCodeCall = Future<({String code, Duration ttl})?> Function();

class AddPhoneDialog extends StatefulWidget {
  const AddPhoneDialog({
    super.key,
    required this.app,
    required this.pair,
    required this.signInCode,
  });

  final AppNotifier app;
  final PhonePairCall pair;
  final PhoneSignInCodeCall signInCode;

  @override
  State<AddPhoneDialog> createState() => _AddPhoneDialogState();
}

class _AddPhoneDialogState extends State<AddPhoneDialog> {
  /// With no phone waiting the daemon answers at once, so this is the whole
  /// cadence of the loop: how soon after the phone's intent lands the
  /// handshake starts. ⚠️ `NO_INTENT`, `EXPIRED` and `BUSY` are answered
  /// BEFORE any handshake runs, and only a handshake that ran and failed
  /// counts against the daemon's three-per-five-minutes limit (manager.ts
  /// `failPair`) — so asking this often costs the person nothing.
  static const _poll = Duration(milliseconds: 1500);
  static const _rateLimited = Duration(seconds: 60);
  static const _unexpected = Duration(seconds: 5);

  /// How long "Connected" stays up before the dialog closes itself.
  static const _connectedHold = Duration(milliseconds: 1500);

  /// How often the QR gets a new sign-in code. Shorter than the code's own
  /// life (90 s at the backend), so the one on screen always has at least
  /// half a minute left in it when a phone reads it.
  static const _signInRenew = Duration(seconds: 60);

  AppNotifier get app => widget.app;

  /// A fresh code each time the dialog opens, and a fresh one again after a
  /// scan that did not match — see [_loop].
  late String _code = newPhonePairCode();

  /// ONE token for the dialog's whole life: cancelling it is closing.
  final _cancel = CancelToken();
  bool _closed = false;
  bool _running = false;
  Timer? _timer;
  Completer<bool>? _sleeping;

  /// The sign-in code in the QR, once asked for. Null after asking is a QR
  /// without one: the phone then asks for an emailed code.
  String? _signIn;
  bool _signInAsked = false;
  Timer? _signInTimer;

  /// No pairing to be had from this daemon — asking stopped for good.
  bool _stopped = false;
  String? _connected;
  String? _message;

  /// A message that is an instruction to the person ("scan the new code"),
  /// which the next "no phone yet" must not wipe before they have read it.
  /// Everything else describes a condition, and goes when it does.
  bool _sticky = false;

  @override
  void initState() {
    super.initState();
    app.addListener(_appChanged);
    _syncLoop();
    unawaited(_renewSignIn());
  }

  @override
  void dispose() {
    _closed = true;
    app.removeListener(_appChanged);
    _timer?.cancel();
    _signInTimer?.cancel();
    if (_sleeping case final sleeping? when !sleeping.isCompleted) {
      sleeping.complete(false);
    }
    // ⚠️ This only stops WAITING. A handshake the daemon has already started
    // runs to its end whatever happens here, and a phone that finishes it is
    // paired: the person scanned the code, which is the consent. What closing
    // does guarantee is that nothing arms the daemon again — the code dies
    // with the QR.
    _cancel.cancel('Add Phone closed');
    super.dispose();
  }

  void _appChanged() {
    if (_closed) return;
    setState(() {});
    _syncLoop();
  }

  /// Who and what the QR is for, or null while there is nothing to show yet.
  ///
  /// The machine is the one the phone will see in its own list: this
  /// computer's row, whose id is the backend's once someone is signed in (the
  /// daemon serves this computer under the account's `machineId` then — see
  /// `AppNotifier._followLocalMachineId`).
  ({String email, String machineId})? get _target {
    if (app.isGuest) return null;
    final email = app.currentUser?.email.trim();
    final machineId = app.localMachineState?.machine.machineId;
    // `CurrentUserProfile.local()` says "local terminal": not an address.
    if (email == null || !email.contains('@')) return null;
    if (machineId == null || machineId.isEmpty) return null;
    return (email: email, machineId: machineId);
  }

  bool get _asking => !_closed && !_stopped && _connected == null;

  /// Starts the loop when there is a QR worth arming and nothing is asking
  /// yet. Called again whenever the app changes, so a profile that loads
  /// after the dialog opened arms it then.
  void _syncLoop() {
    if (_running || !_asking || _target == null) return;
    _running = true;
    unawaited(_loop().whenComplete(() => _running = false));
  }

  Future<void> _loop() async {
    while (_asking && _target != null) {
      final code = _code;
      PhonePairAnswer answer;
      try {
        answer = await widget.pair(code, _cancel);
      } catch (error) {
        answer = PhonePairAnswer.failed('$error');
      }
      // A long poll can come back long after the dialog went — a handshake
      // that finished (or failed) behind a closed window must not touch it.
      if (_closed) return;
      if (answer.label case final label?) {
        setState(() {
          _connected = label;
          _message = null;
        });
        if (await _sleep(_connectedHold) && mounted) {
          Navigator.of(context).pop();
        }
        return;
      }
      final Duration wait;
      switch (answer.error) {
        // No phone yet, one whose minute ran out, or one mid-handshake with
        // somebody else. Ask again.
        case 'NO_INTENT' || 'EXPIRED' || 'BUSY':
          if (!_sticky && _message != null) setState(() => _message = null);
          wait = _poll;
        case 'CODE_MISMATCH':
          // The phone holds the old code and the daemon has spent it. A new
          // one — and a new QR — is the only way forward.
          _say("That didn't match. Scan the new code.", sticky: true);
          setState(() => _code = newPhonePairCode());
          wait = _poll;
        case 'RATE_LIMITED':
          _say('Too many tries. Wait a minute.');
          wait = _rateLimited;
        case 'BACKEND_DOWN':
          _say("This ${_thisComputer()} can't reach Harness right now.");
          wait = _poll;
        // The phone started and went quiet, or said no. The QR is still
        // good: scanning it again starts over.
        case 'TIMEOUT':
          _say('Your phone stopped answering. Scan again.', sticky: true);
          wait = _poll;
        case 'CANCELLED':
          _say('Cancelled on your phone. Scan again.', sticky: true);
          wait = _poll;
        case PhonePairAnswer.unavailable:
          _say('Update Harness on this ${_thisComputer()} to add a phone.');
          setState(() => _stopped = true);
          return;
        case final other:
          _say('Could not pair ($other). Trying again.');
          wait = _unexpected;
      }
      if (!await _sleep(wait)) return;
    }
  }

  /// Ask for a sign-in code, put it in the QR, and ask again before it runs
  /// out — for as long as the QR is on screen. A failure is not retried
  /// sooner: the QR works without one, and the next renewal tries again.
  Future<void> _renewSignIn() async {
    ({String code, Duration ttl})? next;
    try {
      next = await widget.signInCode();
    } catch (_) {
      next = null;
    }
    if (_closed || !mounted) return;
    setState(() {
      _signIn = next?.code;
      _signInAsked = true;
    });
    if (_connected != null || _stopped) return;
    final ttl = next?.ttl;
    final wait = ttl != null && ttl - const Duration(seconds: 30) < _signInRenew
        ? ttl - const Duration(seconds: 30)
        : _signInRenew;
    _signInTimer = Timer(
      wait > Duration.zero ? wait : _signInRenew,
      () => unawaited(_renewSignIn()),
    );
  }

  void _say(String message, {bool sticky = false}) => setState(() {
    _message = message;
    _sticky = sticky;
  });

  /// A wait the dialog can cut short: true when it ran out, false when the
  /// dialog closed. `Future.delayed` cannot be cancelled, and a timer left
  /// behind by a closed dialog is one more wake-up for nothing.
  Future<bool> _sleep(Duration duration) {
    final done = Completer<bool>();
    _sleeping = done;
    _timer = Timer(duration, () {
      if (!done.isCompleted) done.complete(!_closed);
    });
    return done.future;
  }

  void _close() => Navigator.of(context).maybePop();

  TerminalTheme get _theme =>
      terminalThemeFor(grid.AppTheme.palette.value, terminalThemeStore.value);
  Color get _faint => _theme.foreground.withValues(alpha: .54);
  TextStyle _ink([Color? color]) =>
      terminalContentStyle(color: color ?? _theme.foreground);

  @override
  Widget build(BuildContext context) {
    TerminalFontScope.watch(context);
    // Live font and colour changes reach an open dialog too — see the dialog
    // guide, design/terminal-dialogs.md.
    return ListenableBuilder(
      listenable: Listenable.merge([
        terminalFontStore,
        terminalThemeStore,
        grid.AppTheme.palette,
      ]),
      builder: (context, _) => _dialog(context),
    );
  }

  Widget _dialog(BuildContext context) {
    // The grid: margins in whole character columns, spacing in whole rows.
    final cell = terminalCellSizeOf(context);
    final margin = cell.width * 2;
    final row = cell.height;
    // The window is the QR and one line: 240 points — a phone camera reads that
    // from across a desk — in a whole number of rows, so the line under it stays
    // on the grid, and the window just wider than the code.
    final qrSide = (240 / row).ceil() * row;
    final width = math.min(
      qrSide + margin * 4,
      MediaQuery.sizeOf(context).width - 32,
    );
    return TerminalPromptKeys(
      cancel: _close,
      child: Dialog(
        insetPadding: const EdgeInsets.all(16),
        elevation: 0,
        backgroundColor: Colors.transparent,
        child: SizedBox(
          width: width,
          child: Material(
            elevation: 0,
            color: _theme.background,
            surfaceTintColor: Colors.transparent,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(kTerminalCornerRadius),
              side: terminalPaneBorder(focused: true),
            ),
            clipBehavior: Clip.antiAlias,
            child: DefaultTextStyle.merge(
              style: _ink(),
              child: SingleChildScrollView(
                padding: EdgeInsets.fromLTRB(margin, row, margin, row),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      'Add your phone',
                      textAlign: TextAlign.center,
                      style: _ink(),
                    ),
                    SizedBox(height: row),
                    ..._body(qrSide, row),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  List<Widget> _body(double qrSide, double row) {
    if (app.isGuest) {
      return [Text('Sign in to add your phone.', style: _ink())];
    }
    final target = _target;
    if (target == null) {
      return [
        Text(
          app.currentUser?.email.contains('@') == true
              ? 'Waiting for Harness on this ${_thisComputer()}…'
              : 'Waiting for your account…',
          style: _ink(_faint),
        ),
      ];
    }
    // A moment's wait for the sign-in code, in the QR's own space: a QR that
    // changed right after it appeared would be one scanned without it.
    if (!_signInAsked) return [SizedBox(height: qrSide + row * 2)];
    final link = phonePairLink(
      email: target.email,
      machineId: target.machineId,
      code: _code,
      signIn: _signIn,
    ).toString();
    return [
      Center(
        // Dimmed once it has done its job, so nobody scans a spent code.
        child: Opacity(
          opacity: _connected == null && !_stopped ? 1 : .25,
          child: PhonePairQr(data: link, side: qrSide),
        ),
      ),
      SizedBox(height: row),
      // One line, and it is the status too: what to do, then that it worked.
      // The phone's own screen says the rest (Yes — scan to connect).
      _status(),
    ];
  }

  Widget _status() {
    final connected = _connected;
    final (text, color) = connected != null
        ? ('✓ Connected $connected', _theme.green)
        : _message != null
        ? (_message!, _theme.red)
        : ('Scan with Harness on your iPhone', _faint);
    return Semantics(
      liveRegion: true,
      child: Text(
        text,
        key: const ValueKey('add-phone-status'),
        textAlign: TextAlign.center,
        style: _ink(color),
      ),
    );
  }
}

/// "Mac" where the menu says Harness ▸ Add Phone…; the command palette also
/// reaches this dialog on Linux, where "this Mac" would be wrong.
String _thisComputer() =>
    defaultTargetPlatform == TargetPlatform.macOS ? 'Mac' : 'computer';

/// [data] as a QR code: dark modules on a white square with its quiet zone.
///
/// ⚠️ White and black whatever the theme. A dark-mode QR — light modules on a
/// dark field — is one many phone cameras will not read, and the four-module
/// white margin (the "quiet zone") is part of the code, not decoration: it is
/// how a scanner finds the edges. So the white square stays, on every palette.
class PhonePairQr extends StatelessWidget {
  const PhonePairQr({super.key, required this.data, required this.side});

  /// What the code says — the whole link, secret included.
  final String data;
  final double side;

  static const _quietModules = 4;

  // One entry: the dialog rebuilds on every font or palette change, and
  // choosing the best of eight mask patterns is not free.
  static (String, QrImage)? _cached;

  static QrImage _imageOf(String data) {
    if (_cached case (final cachedData, final image) when cachedData == data) {
      return image;
    }
    final image = QrImage(
      QrCode.fromData(data: data, errorCorrectLevel: QrErrorCorrectLevel.M),
    );
    _cached = (data, image);
    return image;
  }

  @override
  Widget build(BuildContext context) {
    final image = _imageOf(data);
    final module = side / (image.moduleCount + _quietModules * 2);
    return Semantics(
      image: true,
      label: 'QR code to add your phone',
      child: Container(
        width: side,
        height: side,
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(module * 2),
        ),
        child: CustomPaint(painter: _QrPainter(image, data)),
      ),
    );
  }
}

class _QrPainter extends CustomPainter {
  _QrPainter(this.image, this.data);

  final QrImage image;
  final String data;

  @override
  void paint(Canvas canvas, Size size) {
    final count = image.moduleCount;
    final total = count + PhonePairQr._quietModules * 2;
    // Snapped to half a point — a whole device pixel on a Retina screen — so
    // neighbouring modules meet exactly instead of leaving hairline seams.
    final module = (size.shortestSide / total * 2).floorToDouble() / 2;
    final origin = Offset(
      (size.width - module * count) / 2,
      (size.height - module * count) / 2,
    );
    final path = Path();
    for (var y = 0; y < count; y++) {
      for (var x = 0; x < count; x++) {
        if (!image.isDark(y, x)) continue;
        path.addRect(
          Rect.fromLTWH(
            origin.dx + x * module,
            origin.dy + y * module,
            module,
            module,
          ),
        );
      }
    }
    canvas.drawPath(
      path,
      Paint()
        ..color = Colors.black
        ..isAntiAlias = false,
    );
  }

  @override
  bool shouldRepaint(_QrPainter oldDelegate) => oldDelegate.data != data;
}
