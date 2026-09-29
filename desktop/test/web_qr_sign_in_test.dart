import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/cli_login.dart' show SignInQr;
import 'package:harness/core/config.dart';
import 'package:harness/core/web_form_factor.dart';
import 'package:harness/viewer/connect_code.dart';
import 'package:harness/viewer/direct_auth_api.dart';
import 'package:harness/viewer/qr_sign_in.dart';

/// The backend's device-auth, scripted: each start mints the next request; polls answer in order.
class _Api extends DirectAuthApi {
  _Api(this.answers) : super(config: AppConfig.dev);
  final List<SignInRequestAnswer> answers;
  final started = <(String, String, String)>[];
  final polled = <String>[];

  @override
  Future<SignInRequest> startSignInRequest({
    required String label,
    required String fingerprint,
    required String pub,
  }) async {
    started.add((label, fingerprint, pub));
    return SignInRequest(
      userCode: 'USER${started.length}',
      deviceCode: 'dev${started.length}',
      expiresIn: const Duration(seconds: 16),
    );
  }

  @override
  Future<SignInRequestAnswer> pollSignInRequest(String deviceCode) async {
    polled.add(deviceCode);
    return answers.isEmpty
        ? const SignInRequestAnswer.pending()
        : answers.removeAt(0);
  }
}

WebQrSignIn _signIn(_Api api) {
  var n = 0;
  return WebQrSignIn(
    api: api,
    fingerprint: 'AB12·CD34·EF56·7890',
    pub: 'PUBKEY=',
    label: 'Chrome on macOS',
    linkBase: Uri.parse('http://127.0.0.1:8080'),
    mintCode: () => 'ABCDEFGHJKMNPQR${++n}',
    sleep: (_) async {},
  );
}

void main() {
  test('shows a browser QR, and hands back the session and the phone\'s group once approved', () async {
    final api = _Api([
      const SignInRequestAnswer.pending(),
      const SignInRequestAnswer.approved(
        IssuedTokens(token: 'hna_x', refreshToken: 'hnr_x'),
        sealedRoster: 'c2VhbGVk',
      ),
    ]);
    final qrs = <SignInQr>[];
    final result = await _signIn(api).run(onQr: qrs.add, current: () => true);

    expect(api.started, [('Chrome on macOS', 'AB12CD34EF567890', 'PUBKEY=')]);
    expect(qrs, hasLength(1));
    final code = ConnectCode.parse(qrs.single.url)!;
    expect(code.isViewerSignIn, isTrue);
    expect(code.signInRequest, 'USER1');
    expect(code.pairCode, 'ABCDEFGHJKMNPQR1');
    expect(code.fingerprint, 'AB12CD34EF567890');
    expect(code.hostname, 'Chrome on macOS');
    // Lands on this build, so a phone's camera opens a build that can approve it.
    expect(Uri.parse(qrs.single.url).origin, 'http://127.0.0.1:8080');

    expect(result.tokens.token, 'hna_x');
    expect(result.code, 'ABCDEFGHJKMNPQR1');
    expect(result.userCode, 'USER1');
    expect(result.sealedRoster, 'c2VhbGVk');
  });

  test(
    'an expired request is replaced with a fresh one, and a fresh QR',
    () async {
      final api = _Api([
        const SignInRequestAnswer.expired(),
        const SignInRequestAnswer.approved(IssuedTokens(token: 't')),
      ]);
      final qrs = <SignInQr>[];
      final result = await _signIn(api).run(onQr: qrs.add, current: () => true);
      expect(qrs.map((q) => ConnectCode.parse(q.url)!.signInRequest), [
        'USER1',
        'USER2',
      ]);
      expect(result.code, 'ABCDEFGHJKMNPQR2');
    },
  );

  test('a request left unanswered is redrawn before it expires', () async {
    final api = _Api([
      for (var i = 0; i < 3; i++) const SignInRequestAnswer.pending(),
      const SignInRequestAnswer.approved(IssuedTokens(token: 't')),
    ]);
    final qrs = <SignInQr>[];
    await _signIn(api).run(onQr: qrs.add, current: () => true);
    // 16 s requests, replaced 10 s early, polled every 2 s: three polls per QR.
    expect(qrs, hasLength(2));
    expect(api.polled, ['dev1', 'dev1', 'dev1', 'dev2']);
  });

  test('"Not me" on the phone ends it, and so does a cancel here', () async {
    await expectLater(
      _signIn(_Api([const SignInRequestAnswer.denied()]))
          .run(onQr: (_) {}, current: () => true),
      throwsA(
        isA<DirectAuthException>().having(
          (e) => e.message,
          'message',
          contains('Declined'),
        ),
      ),
    );
    var live = true;
    await expectLater(
      _signIn(_Api([])).run(onQr: (_) => live = false, current: () => live),
      throwsA(isA<DirectAuthException>()),
    );
  });

  group('web form factor', () {
    test('a phone browser is web mobile; a tablet or a laptop is not', () {
      expect(
        mobileUserAgent(
          'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148 Safari/604.1',
        ),
        isTrue,
      );
      expect(
        mobileUserAgent(
          'Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/130.0 Mobile Safari/537.36',
        ),
        isTrue,
      );
      expect(
        mobileUserAgent(
          'Mozilla/5.0 (Linux; Android 14; SM-X910) Chrome/130.0 Safari/537.36',
        ),
        isFalse,
      );
      expect(
        mobileUserAgent(
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/130.0 Safari/537.36',
        ),
        isFalse,
      );
    });

    test('names the browser and its OS', () {
      expect(
        browserLabelFrom(
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0 Safari/537.36',
        ),
        'Chrome on macOS',
      );
      expect(
        browserLabelFrom(
          'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/130.0 Safari/537.36 Edg/130.0',
        ),
        'Edge on Windows',
      );
      expect(
        browserLabelFrom(
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15',
        ),
        'Safari on macOS',
      );
      expect(
        browserLabelFrom(
          'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0',
        ),
        'Firefox on Linux',
      );
      expect(browserLabelFrom(''), 'Web browser');
    });

    test('native builds are never web mobile, and tests can pick one', () {
      expect(isMobileWeb, isFalse);
      debugMobileWebOverride = true;
      addTearDown(() => debugMobileWebOverride = null);
      expect(isMobileWeb, isTrue);
    });
  });
}
