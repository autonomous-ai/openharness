import 'dart:async';
import 'dart:io' show SocketException;
import 'dart:math' as math;

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';

import '../shared/widgets/qr_code_view.dart';
import '../api/api_client.dart';
import '../auth/sign_in_provider.dart';
import '../core/phone_app_links.dart';
import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shortcuts/app_keymap.dart';
import '../state/account_devices.dart' show NewDeviceNotice;
import '../state/app_state.dart';
import '../measurement/product_measurement.dart' show AddPhoneOpening;
import '../ws/ws_conn.dart' show WsRequestFailure, WsRequestTimeout;
import 'desktop_chrome.dart';
import 'desktop_prompt_surface.dart';
import 'quiet_link.dart';
import 'sign_in_provider_button.dart';
import 'terminal_prompt.dart';

/// Harness ▸ Add Phone… — how a phone comes to manage this account's agents.
///
/// **The code first, and few words (owner, 2026-10-13).** Desktop asks for an
/// account before its workspace opens, so Add Phone opens on its QR: the code,
/// "Scan with the Harness mobile app.", and the stores for a phone without
/// the app.
/// The phone's welcome leads with Scan QR code (mobile `phone_welcome.dart`):
/// the scan signs it in to this account with nothing to type, so it cannot
/// land on another account. No steps, no picture, no "Looking for your phone"
/// while it waits — that read as this computer searching, and people waited
/// instead of scanning. A phone that signs in with this account by itself does
/// as well: the account's device key log makes every computer on it trust the
/// phone, and the dialog watches the account for it ([AppNotifier.deviceJoins]).
///
/// Then "`<phone>` is ready.", Done, and See your phones — Machines, at its
/// phones ([AddPhoneDialog.onManageDevices]).
///
/// With no account here — a session the server stopped renewing while this was
/// open — the required sign-in page's ways in stand where the code will be:
/// Continue with Google, Continue with Apple, Continue with email
/// ([AppNotifier.signInFromStep]). The code comes up once the account lands.
///
/// The code is armed only while it is on screen:
///
/// 1. **The QR** ([phonePairLink]) tells the phone who to sign in as, which
///    machine to pair with, and the one-time pairing code.
/// 2. **The sign-in code** ([PhoneSignInCodeCall]), which the QR also carries:
///    the phone redeems it for a session of its own, so the scan signs it in
///    with no emailed code. Renewed every minute while the code is up — see
///    [_AddPhoneDialogState._renewSignIn].
/// 3. **Arming the daemon.** The phone, once signed in, sends this machine an
///    `e2e_pair_intent`; the daemon runs the handshake only when somebody on
///    THIS computer hands it the same code (`POST /api/pair`, the call
///    `harness pair <code>` makes). So while the code is up the dialog keeps
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
  AddPhoneOpening? from,
  PhonePairCall? pair,
  PhoneSignInCodeCall? signInCode,
  bool Function()? signInUnavailable,
  VoidCallback? onConnectMachine,
  VoidCallback? onManageDevices,
}) async {
  // Read once before opening: a repeated join for an existing key is not a new phone.
  // If the snapshot is unavailable, leave attribution unknown and keep Add Phone usable.
  Set<String>? known;
  final account = app.currentUser?.id;
  if (from != null && account != null && !kIsWeb && app.viewer == null) {
    try {
      final devices = await app.loadDevices();
      if (devices != null) {
        known = {for (final device in devices.devices) device.pub};
      }
    } catch (_) {}
  }
  if (!context.mounted) return;
  return showTerminalPrompt<void>(
    context,
    keymap: keymap,
    builder: (_) => AddPhoneDialog(
      app: app,
      pair: pair,
      signInCode: signInCode ?? app.api.phoneSignInCode,
      signInUnavailable:
          signInUnavailable ?? () => app.api.phoneSignInUnavailable,
      onConnectMachine: onConnectMachine,
      onManageDevices: onManageDevices,
      onPhoneJoined: (device) {
        if (from == null ||
            known == null ||
            account != app.currentUser?.id ||
            !known.add(device.pub)) {
          return;
        }
        app.productMeasurement.addPhonePaired(from);
      },
    ),
  );
}

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

/// The browser already holds the machine's trusted identity. Arm that machine over its encrypted
/// connection; the account service never receives the QR's pairing secret.
PhonePairCall phonePairOverRelay(AppNotifier app, String machineId) =>
    (code, cancel) async {
      if (cancel.isCancelled) return const PhonePairAnswer.failed('CANCELLED');
      try {
        final answer = await Future.any([
          app.pairPhone(machineId, code),
          cancel.whenCancel.then(
            (_) => <String, dynamic>{'error': 'CANCELLED'},
          ),
        ]);
        if (answer['ok'] == true) {
          final label = answer['label'];
          return PhonePairAnswer.paired(
            label is String && label.trim().isNotEmpty ? label.trim() : 'phone',
          );
        }
        final error = answer['error'];
        return PhonePairAnswer.failed(
          error == 'UNSUPPORTED' ? PhonePairAnswer.unavailable : '$error',
        );
      } on WsRequestTimeout {
        return const PhonePairAnswer.failed(PhonePairAnswer.unavailable);
      } on WsRequestFailure catch (failure) {
        return PhonePairAnswer.failed(
          failure.code == 'UNSUPPORTED'
              ? PhonePairAnswer.unavailable
              : failure.code,
        );
      } catch (_) {
        return const PhonePairAnswer.failed('BACKEND_DOWN');
      }
    };

/// A fresh one-time sign-in code for the QR and how long it stays good, or
/// null when there is none to be had (see [ApiClient.phoneSignInCode]).
typedef PhoneSignInCodeCall = Future<({String code, Duration ttl})?> Function();

class AddPhoneDialog extends StatefulWidget {
  const AddPhoneDialog({
    super.key,
    required this.app,
    this.pair,
    required this.signInCode,
    this.signInUnavailable,
    this.onConnectMachine,
    this.onManageDevices,
    this.onPhoneJoined,
  });

  final AppNotifier app;
  final PhonePairCall? pair;
  final PhoneSignInCodeCall signInCode;

  /// Whether a sign-in code cannot be had on this computer at all right now
  /// ([ApiClient.phoneSignInUnavailable]): on Windows, the Harness daemon's
  /// private pipe is missing. The QR then goes without one, as with an older
  /// CLI, and says how the phone signs in instead.
  final bool Function()? signInUnavailable;
  final VoidCallback? onConnectMachine;

  /// "See your phones", beside Done once the phone is in: Machines, at its
  /// phones, where it can be named, removed, or a second one added. Only
  /// then — while adding one it was a second way out nobody was looking for
  /// (owner, 2026-10-12). Not "devices": the tab row's Devices is the Harness
  /// hardware. The dialog closes; the caller opens Machines after.
  final VoidCallback? onManageDevices;
  final ValueChanged<NewDeviceNotice>? onPhoneJoined;

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

  /// How often the QR gets a new sign-in code. Shorter than the code's own
  /// life (90 s at the backend), so the one on screen always has at least
  /// half a minute left in it when a phone reads it.
  static const _signInRenew = Duration(seconds: 60);

  AppNotifier get app => widget.app;

  // Freeze the destination while a QR is visible, even if focus or inventory changes.
  late final String? _remoteMachineId = app.viewer == null
      ? null
      : app.ownedActionMachine?.machine.machineId;

  late final PhonePairCall _pair =
      widget.pair ??
      (_remoteMachineId != null
          ? phonePairOverRelay(app, _remoteMachineId)
          : phonePairOverDaemon(app.api));

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

  /// The last ask found no sign-in code to be had here ([AddPhoneDialog.signInUnavailable]).
  bool _signInUnavailable = false;
  Timer? _signInTimer;

  /// Bumped to start the renewal over (see [_restartSignIn]): an answer to an
  /// older ask is dropped, so only one chain of renewals ever runs.
  int _signInRound = 0;

  /// The QR's sign-in code has been asked for since the code last came up. A
  /// code put away lets its renewal lapse ([_renewSignIn]), and the next
  /// showing asks afresh.
  bool _signInStarted = false;

  /// This computer had no account while the dialog was open. When the account
  /// lands, a code that was up asks for its sign-in code again — see
  /// [_appChanged].
  bool _awaitingAccount = false;

  /// The phone is in: the name it gave, or '' when it gave none. Null while
  /// the code is up.
  String? _ready;

  /// The stores' code is up in the Harness code's place ([_stores]).
  bool _showingStores = false;

  StreamSubscription<NewDeviceNotice>? _joins;

  /// No pairing to be had from this daemon — asking stopped for good.
  bool _stopped = false;
  String? _message;

  /// A message that is an instruction to the person ("scan the new code"),
  /// which the next "no phone yet" must not wipe before they have read it.
  /// Everything else describes a condition, and goes when it does.
  bool _sticky = false;

  @override
  void initState() {
    super.initState();
    _awaitingAccount = _signedOut;
    app.addListener(_appChanged);
    _joins = app.deviceJoins.listen(_deviceJoined);
    // Signed in — as Desktop is before its workspace opens — the code is up
    // from the first frame: nothing to read or press before it.
    _codeChanged();
  }

  @override
  void dispose() {
    _closed = true;
    app.removeListener(_appChanged);
    unawaited(_joins?.cancel());
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

  /// No account here, or its sign-in is under way: the ways in, not the code.
  bool get _signedOut => app.isGuest || app.signingIn;

  void _appChanged() {
    if (_closed) return;
    if (_signedOut) {
      _awaitingAccount = true;
    } else if (_awaitingAccount) {
      // Signed in while the dialog was open. A sign-in code asked for without
      // an account was refused, and the next renewal is a minute off: without
      // asking now, the first QR the phone can scan has no sign-in in it, and
      // the phone falls back to an emailed code.
      _awaitingAccount = false;
      if (_signInStarted) _restartSignIn();
    }
    setState(() {});
    _codeChanged();
  }

  /// A device joined the account while this was open. A computer is not the
  /// phone; anything else signed in with this account is.
  void _deviceJoined(NewDeviceNotice device) {
    if (_closed || device.kind == 'machine' || _signedOut) return;
    widget.onPhoneJoined?.call(device);
    if (_ready != null) return;
    _phoneIn(device.label);
  }

  /// The phone is in — by the code, or by its own sign-in. The code goes, with
  /// its renewal and the loop that arms it ([_asking]).
  void _phoneIn(String label) {
    _signInTimer?.cancel();
    setState(() {
      _ready = label.trim();
      _message = null;
      _showingStores = false;
    });
  }

  /// The Harness code is what the dialog shows: an account here, no phone in
  /// yet, and not the stores' code in its place.
  bool get _codeUp => !_signedOut && _ready == null && !_showingStores;

  /// Only while the code is up: a code nobody can see is a code nobody can
  /// scan, and arming the daemon with it would be for nothing.
  bool get _asking => !_closed && !_stopped && _codeUp;

  /// The code came up, or went: up, it asks for its sign-in code — fresh
  /// unless one is still renewing — and starts arming the daemon; gone, the
  /// loop ends after its answer and the renewal lapses.
  void _codeChanged() {
    if (_codeUp && !_signInStarted) {
      _signInStarted = true;
      _restartSignIn();
    }
    _syncLoop();
  }

  /// "App Store · Google Play" and Back: the stores' code in the Harness
  /// code's place, or the Harness code again. One kind of code on screen at a
  /// time — Harness reads only its own, the Camera only the stores' — so
  /// nobody scans one with the other's.
  void _showStores(bool showing) {
    setState(() => _showingStores = showing);
    _codeChanged();
  }

  /// One of the sign-in's ways in. They stay live while the browser is open,
  /// as on the required sign-in page: the same one again reopens its page,
  /// another one switches. [provider] null is Continue with email.
  void _signInWith(SignInProvider? provider) =>
      unawaited(app.signInFromStep(provider));

  /// See your phones: Machines, at its phones, once this has closed — the
  /// caller opens it ([AddPhoneDialog.onManageDevices]).
  void _seePhones() {
    widget.onManageDevices?.call();
    _close();
  }

  /// Who and what the QR is for, or null while there is nothing to show yet.
  ///
  /// The machine is the one the phone will see in its own list: this
  /// computer's row, whose id is the backend's once someone is signed in (the
  /// daemon serves this computer under the account's `machineId` then — see
  /// `AppNotifier._followLocalMachineId`).
  ({String email, String machineId})? get _target {
    // Mid sign-in the daemon moves onto the account, and this computer's id
    // with it (`AppNotifier.login`): nothing to show or arm until it lands.
    if (_signedOut) return null;
    final email = app.currentUser?.email.trim();
    final machineId = app.viewer == null
        ? app.localMachineState?.machine.machineId
        : _remoteMachineId;
    // `CurrentUserProfile.local()` says "local terminal": not an address.
    if (email == null || !email.contains('@')) return null;
    if (machineId == null || machineId.isEmpty) return null;
    return (email: email, machineId: machineId);
  }

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
        answer = await _pair(code, _cancel);
      } catch (error) {
        answer = PhonePairAnswer.failed('$error');
      }
      // A long poll can come back long after the dialog went — a handshake
      // that finished (or failed) behind a closed window must not touch it.
      if (_closed) return;
      if (answer.label case final label?) {
        // The transports call a phone that gave no name "phone".
        _phoneIn(label == 'phone' ? '' : label);
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
          // A phone holding another code than this one, and the daemon has
          // spent this one: a new code — and a new QR — goes up, QUIETLY.
          //
          // ⚠️ That phone is almost always one already in. A scan signs the
          // phone in by its sign-in code, and the account takes it at once
          // (the dialog turns to "is ready." on [_deviceJoined]); the phone
          // then also pairs by the QR's code, which reaches the daemon after
          // that dialog stopped answering, and the daemon keeps it a minute.
          // The next Add Phone opened in that minute hands it a fresh code,
          // and the handshake fails. Its red "That code didn't work. Scan the
          // new one above." read as the phone just added having failed
          // (2026-10-13). A phone that truly scanned an old code is told so
          // on its own screen, and joins by signing in all the same.
          if (_message != null) setState(() => _message = null);
          setState(() => _code = newPhonePairCode());
          wait = _poll;
        case 'RATE_LIMITED':
          _say('Too many tries. Wait a minute.');
          wait = _rateLimited;
        case 'BACKEND_DOWN':
          _say(
            app.viewer == null
                ? "This ${_thisComputer()} can't reach Harness right now."
                : 'The computer is offline. Reconnect it to add your phone.',
          );
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
          _say(
            app.viewer == null
                ? 'Update Harness on this ${_thisComputer()} to add a phone.'
                : 'Update Harness on the computer to add a phone.',
          );
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
  /// The one exception is an account arriving — see [_restartSignIn].
  Future<void> _renewSignIn() async {
    final round = _signInRound;
    ({String code, Duration ttl})? next;
    try {
      next = await widget.signInCode();
    } catch (_) {
      next = null;
    }
    if (_closed || !mounted || round != _signInRound) return;
    setState(() {
      _signIn = next?.code;
      _signInAsked = true;
      _signInUnavailable =
          next == null && (widget.signInUnavailable?.call() ?? false);
    });
    if (_ready != null || _stopped) return;
    final ttl = next?.ttl;
    final wait = ttl != null && ttl - const Duration(seconds: 30) < _signInRenew
        ? ttl - const Duration(seconds: 30)
        : _signInRenew;
    _signInTimer = Timer(wait > Duration.zero ? wait : _signInRenew, () {
      // Put away, the code needs no fresher sign-in: the next showing asks.
      if (!_codeUp) {
        _signInStarted = false;
        return;
      }
      unawaited(_renewSignIn());
    });
  }

  /// The renewal from the top, now: the pending one is cancelled, an ask
  /// still in flight is dropped when it lands, and the QR waits on
  /// "Preparing your code…" for the new code. The caller rebuilds.
  void _restartSignIn() {
    _signInTimer?.cancel();
    _signInRound++;
    _signIn = null;
    _signInAsked = false;
    unawaited(_renewSignIn());
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

  /// Narrower than a form: one column, the code at its middle.
  static const double _width = 400;

  /// The code, the dialog's subject: big enough to scan from across a desk.
  static const double _qrSide = 200;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final ready = _ready != null;
    return TerminalPromptKeys(
      cancel: _close,
      child: DesktopPromptSurface(
        width: _width,
        body: LayoutBuilder(
          builder: (context, constraints) {
            final qrSide = math.min(_qrSide, constraints.maxWidth);
            return DesktopPromptScrollBody(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Semantics(
                    header: true,
                    child: Text(
                      'Add your phone',
                      textAlign: TextAlign.center,
                      style: DesktopChrome.heading(),
                    ),
                  ),
                  const SizedBox(height: 20),
                  if (ready)
                    _done()
                  else if (_signedOut)
                    _waysIn()
                  else if (_showingStores)
                    _stores(qrSide)
                  else
                    ..._codeArea(qrSide),
                ],
              ),
            );
          },
        ),
        actions: [
          if (ready)
            // One row across the foot: See your phones at its left, Done at
            // its right. ⚠️ Not two actions: the actions wrap to the right, and
            // the link, centred in a box of the button's height, took a whole
            // row of its own — centred over Done.
            Row(
              children: [
                if (widget.onManageDevices != null)
                  _InlineLink(
                    key: const ValueKey('add-phone-see-phones'),
                    label: 'See your phones',
                    onPressed: _seePhones,
                  ),
                const Spacer(),
                FilledButton(
                  key: const ValueKey('add-phone-done'),
                  autofocus: true,
                  onPressed: _close,
                  child: const Text('Done'),
                ),
              ],
            )
          else if (_signedOut)
            TextButton(
              key: const ValueKey('add-phone-cancel'),
              onPressed: _close,
              child: const Text('Cancel'),
            )
          else
            // Close, not Cancel: nothing is undone by it. The phone that
            // scanned is in all the same; only the code goes.
            TextButton(
              key: const ValueKey('add-phone-close'),
              onPressed: _close,
              child: const Text('Close'),
            ),
        ],
      ),
    );
  }

  /// The phone is in: a tick and its name, nothing else to read.
  Widget _done() {
    final ok = grid.AppPalette.online;
    final name = _ready!;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 12),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          ExcludeSemantics(
            child: Container(
              width: 56,
              height: 56,
              decoration: BoxDecoration(
                color: ok.withValues(alpha: .16),
                shape: BoxShape.circle,
              ),
              child: Icon(AppIcons.check, size: 24, color: ok),
            ),
          ),
          const SizedBox(height: 14),
          Semantics(
            liveRegion: true,
            child: Text(
              '${name.isEmpty ? 'Your phone' : name} is ready.',
              key: const ValueKey('add-phone-ready'),
              textAlign: TextAlign.center,
              style: DesktopChrome.heading(),
            ),
          ),
        ],
      ),
    );
  }

  /// No account here: the required sign-in page's ways in, and no words
  /// around them (owner, 2026-10-13). The pressed one says what it waits on.
  Widget _waysIn() {
    final waiting = app.pendingAuthorizeUrl == null
        ? 'Signing in…'
        : 'Waiting for your browser';
    final error = app.loginBrowserError;
    return Center(
      child: IntrinsicWidth(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          spacing: 10,
          children: [
            for (final provider in SignInProvider.values)
              SignInProviderButton(
                provider: provider,
                // Return signs in with the first.
                autofocus: provider == SignInProvider.values.first,
                onPressed: () => _signInWith(provider),
                busyLabel: app.signingIn && app.signInProvider == provider
                    ? waiting
                    : null,
              ),
            Center(
              child: QuietLink(
                key: const ValueKey('add-phone-sign-in-email'),
                label: 'Continue with email',
                onPressed: () => _signInWith(null),
              ),
            ),
            if (error != null)
              Semantics(
                liveRegion: true,
                child: Text(
                  error,
                  textAlign: TextAlign.center,
                  style: _note(Theme.of(context).colorScheme.error),
                ),
              ),
          ],
        ),
      ),
    );
  }

  /// The code, one line under it, and the stores for a phone without the app
  /// — or, before there is a code, why not yet, in a square of the code's own
  /// size so nothing moves when it comes. What went wrong, only when it did.
  List<Widget> _codeArea(double qrSide) {
    // The code's own size at the least, so nothing moves when it comes; taller
    // when what it says (and a button) needs more than the code does.
    Widget room(List<Widget> children) => Center(
      child: Container(
        width: qrSide,
        constraints: BoxConstraints(minHeight: qrSide),
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: DesktopChrome.field,
          borderRadius: BorderRadius.circular(14),
        ),
        child: Center(
          child: Column(mainAxisSize: MainAxisSize.min, children: children),
        ),
      ),
    );
    Widget say(String text) =>
        Text(text, textAlign: TextAlign.center, style: _note());

    final target = _target;
    if (target == null && _connectFirst) {
      return [
        room([
          say('Your phone pairs with a computer on your account.'),
          if (widget.onConnectMachine case final connect?) ...[
            const SizedBox(height: 8),
            TextButton(
              onPressed: () {
                Navigator.of(context).pop();
                connect();
              },
              child: const Text('Connect a machine'),
            ),
          ],
        ]),
      ];
    }
    final Widget code;
    if (target == null) {
      code = room([
        say(
          app.currentUser?.email.contains('@') == true
              ? 'Waiting for Harness on this ${_thisComputer()}…'
              : 'Waiting for your account…',
        ),
      ]);
    } else if (!_signInAsked) {
      // A moment's wait for the sign-in code, in the QR's own space: a QR that
      // changed right after it appeared would be one scanned without it.
      code = room([say('Preparing your code…')]);
    } else {
      final link = phonePairLink(
        email: target.email,
        machineId: target.machineId,
        code: _code,
        signIn: _signIn,
      ).toString();
      code = Center(
        // Dimmed once there is no pairing to be had, so nobody scans it.
        child: Opacity(
          opacity: _stopped ? .25 : 1,
          child: PhonePairQr(data: link, side: qrSide),
        ),
      );
    }
    final message = _message;
    return [
      code,
      if (_remoteMachineId case final machineId?) ...[
        const SizedBox(height: 8),
        Text(
          app.stateOf(machineId)?.machine.displayName ?? 'Computer',
          textAlign: TextAlign.center,
          style: _note(),
        ),
      ],
      const SizedBox(height: 14),
      // The phone's welcome leads with Scan QR code: the Harness mobile app is
      // where to scan, so nobody reaches for the Camera. "Mobile", because on
      // this computer "the Harness app" read as the one already open.
      Text(
        'Scan with the Harness mobile app.',
        textAlign: TextAlign.center,
        style: DesktopChrome.text(size: 15, medium: true),
      ),
      if (target != null && _signInUnavailable && _signIn == null) ...[
        const SizedBox(height: 4),
        Text(
          'Your phone will ask for a code from your email.',
          key: const ValueKey('add-phone-email-code'),
          textAlign: TextAlign.center,
          style: _note(),
        ),
      ],
      const SizedBox(height: 4),
      Wrap(
        alignment: WrapAlignment.center,
        crossAxisAlignment: WrapCrossAlignment.center,
        spacing: 4,
        children: [
          Text('No app yet?', style: _note()),
          _InlineLink(
            key: const ValueKey('add-phone-show-downloads'),
            // The stores, not "Get Harness": in the computer's own Harness
            // that read as this app's download.
            label: 'App Store · Google Play',
            onPressed: () => _showStores(true),
          ),
        ],
      ),
      if (message != null) ...[
        const SizedBox(height: 10),
        Semantics(
          liveRegion: true,
          child: Text(
            message,
            key: const ValueKey('add-phone-status'),
            textAlign: TextAlign.center,
            style: _note(Theme.of(context).colorScheme.error),
          ),
        ),
      ],
    ];
  }

  /// "App Store · Google Play": ONE code a phone's camera opens, which sends
  /// an iPhone to the App Store and an Android phone to Google Play
  /// ([kPhoneAppUrl]) — so nobody has to know which store is theirs — in the
  /// Harness code's place. A code, not a link: clicked here a link opens on
  /// this computer, which cannot install a phone's app. Back returns.
  Widget _stores(double qrSide) => Column(
    mainAxisSize: MainAxisSize.min,
    children: [
      QrCodeView(
        data: kPhoneAppUrl,
        side: qrSide,
        semanticLabel: 'QR code for Harness on the App Store or Google Play',
      ),
      const SizedBox(height: 12),
      const _StoreMarks(),
      const SizedBox(height: 10),
      _InlineLink(
        key: const ValueKey('add-phone-hide-downloads'),
        label: '‹ Back',
        onPressed: () => _showStores(false),
      ),
    ],
  );

  /// A browser with none of the account's computers to pair through.
  bool get _connectFirst =>
      app.viewer != null &&
      !app.signingIn &&
      app.currentUser?.email.contains('@') == true;

  /// A quiet line: smaller and fainter than what it is under.
  TextStyle _note([Color? color]) =>
      DesktopChrome.text(color: color ?? DesktopChrome.muted, size: 13);
}

/// A link in a line of words: the words in the accent and nothing around them
/// — a box read as one more button beside the dialog's own. Hover and the
/// keyboard underline them. They wrap, rather than run out of room, at a large
/// text size.
class _InlineLink extends StatefulWidget {
  const _InlineLink({super.key, required this.label, required this.onPressed});

  final String label;
  final VoidCallback onPressed;

  @override
  State<_InlineLink> createState() => _InlineLinkState();
}

class _InlineLinkState extends State<_InlineLink> {
  var _hovered = false;
  var _focused = false;

  @override
  Widget build(BuildContext context) {
    final active = _hovered || _focused;
    return Semantics(
      button: true,
      child: InkWell(
        onTap: widget.onPressed,
        onHover: (hovered) => setState(() => _hovered = hovered),
        onFocusChange: (focused) => setState(() => _focused = focused),
        mouseCursor: SystemMouseCursors.click,
        borderRadius: BorderRadius.circular(4),
        hoverColor: Colors.transparent,
        focusColor: Colors.transparent,
        highlightColor: Colors.transparent,
        splashFactory: NoSplash.splashFactory,
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 2),
          child: Text(
            widget.label,
            style:
                DesktopChrome.text(
                  size: 13,
                  medium: true,
                  color: DesktopChrome.accent,
                ).copyWith(
                  decoration: active ? TextDecoration.underline : null,
                  decorationColor: DesktopChrome.accent,
                ),
          ),
        ),
      ),
    );
  }
}

/// Under the phone app's one code, the two stores it opens — each its own mark
/// and name — so nobody wonders whether theirs is one of them.
class _StoreMarks extends StatelessWidget {
  const _StoreMarks();

  /// Each store's mark, in its own colours whatever the theme — it is the
  /// store's brand, the way the sign-in buttons' marks are.
  static const _stores = [
    ('App Store', 'assets/stores/app-store.svg'),
    ('Google Play', 'assets/stores/google-play.svg'),
  ];

  @override
  Widget build(BuildContext context) => Wrap(
    alignment: WrapAlignment.center,
    spacing: 20,
    runSpacing: 6,
    children: [
      for (final (name, mark) in _stores)
        Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            ExcludeSemantics(
              child: SvgPicture.asset(mark, width: 18, height: 18),
            ),
            const SizedBox(width: 7),
            Text(
              name,
              style: DesktopChrome.control().copyWith(
                fontWeight: FontWeight.w600,
              ),
            ),
          ],
        ),
    ],
  );
}

/// "Mac" where the menu says Harness ▸ Add Phone…; the command palette also
/// reaches this dialog on Linux, where "this Mac" would be wrong.
String _thisComputer() =>
    defaultTargetPlatform == TargetPlatform.macOS ? 'Mac' : 'computer';

/// The Add Phone QR — [QrCodeView], named for the one thing it is here.
class PhonePairQr extends StatelessWidget {
  const PhonePairQr({super.key, required this.data, required this.side});

  /// What the code says — the whole link, secret included.
  final String data;
  final double side;

  @override
  Widget build(BuildContext context) => QrCodeView(
    data: data,
    side: side,
    semanticLabel: 'QR code to add your phone',
  );
}
