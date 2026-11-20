import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/desktop_build.dart';

const _macSafari =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 '
    '(KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const _linuxChrome =
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) '
    'Chrome/130.0.0.0 Safari/537.36';

ClientHints _hints(
  String platform, {
  bool mobile = false,
  CpuHints? cpu,
  bool refuse = false,
}) => ClientHints(
  platform: platform,
  mobile: mobile,
  cpu: () async {
    if (refuse) throw StateError('refused');
    return cpu ?? (architecture: '', bitness: '');
  },
);

void main() {
  group('desktopDownloadUri', () {
    test('a build goes to its own download route', () {
      expect(
        desktopDownloadUri(DesktopBuild.macosArm64).toString(),
        'https://harness.autonomous.ai/desktop/download/macos-arm64',
      );
      expect(
        desktopDownloadUri(DesktopBuild.macos).toString(),
        'https://harness.autonomous.ai/desktop/download-macos',
      );
    });

    test('no build goes to the page that lists them all', () {
      expect(
        desktopDownloadUri(null).toString(),
        'https://harness.autonomous.ai/download',
      );
    });
  });

  group('buildFromUserAgent', () {
    DesktopBuild? of(String ua, {String platform = '', int touch = 0}) =>
        buildFromUserAgent(
          NavigatorSnapshot(
            userAgent: ua,
            platform: platform,
            maxTouchPoints: touch,
          ),
        );

    test('every Mac gets the build every Mac runs', () {
      expect(of(_macSafari, platform: 'MacIntel'), DesktopBuild.macos);
    });

    test('an iPad asking for the desktop site is not a Mac', () {
      expect(of(_macSafari, platform: 'MacIntel', touch: 5), isNull);
    });

    test('phones, Windows and ChromeOS have no build', () {
      expect(
        of('Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/130.0 Mobile'),
        isNull,
      );
      expect(
        of('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'),
        isNull,
      );
      expect(of('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), isNull);
      expect(of('Mozilla/5.0 (X11; CrOS x86_64 14541.0.0)'), isNull);
    });

    test('Chromium on Linux trusts navigator.platform, not its user agent', () {
      expect(
        of(_linuxChrome, platform: 'Linux aarch64'),
        DesktopBuild.linuxArm64,
      );
      expect(of(_linuxChrome, platform: 'Linux x86_64'), DesktopBuild.linuxX64);
      expect(of(_linuxChrome, platform: 'Linux'), isNull);
    });

    test('Firefox on Linux names its CPU in the user agent', () {
      expect(
        of('Mozilla/5.0 (X11; Linux aarch64; rv:131.0) Firefox/131.0'),
        DesktopBuild.linuxArm64,
      );
    });

    test('a 32-bit ARM userland gets no build', () {
      expect(
        of('Mozilla/5.0 (X11; Linux armv8l; rv:131.0) Firefox/131.0'),
        isNull,
      );
    });
  });

  group('detectDesktopBuild', () {
    Future<DesktopBuild?> detect(ClientHints hints, {String ua = ''}) =>
        detectDesktopBuild(NavigatorSnapshot(userAgent: ua, hints: hints));

    test('an ARM Mac gets the Apple silicon build', () async {
      expect(
        await detect(
          _hints('macOS', cpu: (architecture: 'arm', bitness: '64')),
        ),
        DesktopBuild.macosArm64,
      );
    });

    test('a Mac that will not say keeps the build every Mac runs', () async {
      expect(await detect(_hints('macOS', refuse: true)), DesktopBuild.macos);
      expect(
        await detect(
          _hints('macOS', cpu: (architecture: 'x86', bitness: '64')),
        ),
        DesktopBuild.macos,
      );
    });

    test('Linux takes its CPU from the hints', () async {
      expect(
        await detect(
          _hints('Linux', cpu: (architecture: 'arm', bitness: '64')),
        ),
        DesktopBuild.linuxArm64,
      );
      expect(
        await detect(
          _hints('Linux', cpu: (architecture: 'x86', bitness: '64')),
        ),
        DesktopBuild.linuxX64,
      );
      expect(
        await detect(
          _hints('Linux', cpu: (architecture: 'x86', bitness: '32')),
        ),
        isNull,
      );
    });

    test('Linux whose hints refuse falls back to the user agent', () async {
      expect(
        await detect(
          _hints('Linux', refuse: true),
          ua: 'Mozilla/5.0 (X11; Linux aarch64; rv:131.0) Firefox/131.0',
        ),
        DesktopBuild.linuxArm64,
      );
    });

    test('mobile and Windows hints have no build', () async {
      expect(await detect(_hints('Android', mobile: true)), isNull);
      expect(await detect(_hints('Windows')), isNull);
    });
  });
}
