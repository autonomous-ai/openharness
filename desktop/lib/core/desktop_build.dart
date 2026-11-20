/// Which desktop build suits the browser asking — the Dart side of the website's
/// `website/src/lib/desktopPlatform.ts`, kept to the same rules so the app's Download app and the
/// website's `/desktop` offer the same build.
///
/// macOS ships one universal app in two builds: every Mac runs the Intel one, and a Mac whose browser
/// says its CPU is ARM gets the Apple silicon one. Only Chromium can say; Safari and Firefox report
/// "Intel" on every Mac. On Linux the CPU decides whether the app runs at all, so an unknown CPU gets
/// no build: the `/desktop` page offers both instead of guessing.
library;

enum DesktopBuild {
  macos('/desktop/download-macos'),
  macosArm64('/desktop/download/macos-arm64'),
  linuxX64('/desktop/download/linux-x64'),
  linuxArm64('/desktop/download/linux-arm64');

  const DesktopBuild(this.path);

  /// The website route that redirects to this build's latest download.
  final String path;
}

/// The website the download routes live on.
final kHarnessSite = Uri.parse('https://harness.autonomous.ai');

/// Where Download app goes: the build's own download, or `/download` — which lists every build —
/// when nothing suits this browser or it could not be told.
Uri desktopDownloadUri(DesktopBuild? build) =>
    kHarnessSite.replace(path: build?.path ?? '/download');

/// User-Agent Client Hints' high-entropy CPU answer.
typedef CpuHints = ({String architecture, String bitness});

/// User-Agent Client Hints (Chromium only, secure contexts only).
class ClientHints {
  const ClientHints({
    required this.platform,
    required this.mobile,
    required this.cpu,
  });

  final String platform;
  final bool mobile;

  /// `getHighEntropyValues(['architecture', 'bitness'])`; may throw when refused.
  final Future<CpuHints> Function() cpu;
}

/// The few `navigator` fields detection reads.
class NavigatorSnapshot {
  const NavigatorSnapshot({
    this.userAgent = '',
    this.platform = '',
    this.maxTouchPoints = 0,
    this.hints,
  });

  final String userAgent;
  final String platform;
  final int maxTouchPoints;
  final ClientHints? hints;
}

final _arm64 = RegExp(r'\b(aarch64|arm64)\b');
final _x64 = RegExp(r'\b(x86_64|x86-64|amd64)\b');

/// `armv8l` is deliberately absent: a 32-bit userland the ARM64 AppImage cannot serve.
DesktopBuild? _linuxBuild(String text) {
  if (_arm64.hasMatch(text)) return DesktopBuild.linuxArm64;
  if (_x64.hasMatch(text)) return DesktopBuild.linuxX64;
  return null;
}

/// From the user agent and `navigator.platform` alone: the path every browser has.
DesktopBuild? buildFromUserAgent(NavigatorSnapshot snapshot) {
  final agent = snapshot.userAgent.toLowerCase();
  final os = snapshot.platform.toLowerCase();
  // Android's user agent also says "Linux", and iOS browsers' say "like Mac OS X": phones go first.
  if (RegExp('android|iphone|ipad|ipod').hasMatch(agent) ||
      RegExp('^(iphone|ipad|ipod)').hasMatch(os)) {
    return null;
  }
  // iPadOS Safari reports itself as a Mac; only the touchscreen tells it apart.
  if (agent.contains('macintosh') ||
      agent.contains('mac os x') ||
      os.startsWith('mac')) {
    return snapshot.maxTouchPoints > 1 ? null : DesktopBuild.macos;
  }
  if (agent.contains('windows') || os.startsWith('win')) return null;
  if (agent.contains('cros')) return null;
  if (!agent.contains('linux') && !os.startsWith('linux')) return null;
  // Chromium's user agent says x86_64 on every Linux machine; only `navigator.platform` is real there.
  final chromium = RegExp(r'\b(chrome|chromium)/').hasMatch(agent);
  return _linuxBuild(chromium ? os : '$os $agent');
}

enum _Cpu { x64, arm64, other }

/// Null when the browser would not say; [_Cpu.other] for a CPU nothing is published for.
Future<_Cpu?> _cpuOf(ClientHints hints) async {
  try {
    final (:architecture, :bitness) = await hints.cpu();
    if (bitness == '64' && architecture == 'x86') return _Cpu.x64;
    if (bitness == '64' && architecture == 'arm') return _Cpu.arm64;
    if (architecture.isNotEmpty && bitness.isNotEmpty) return _Cpu.other;
  } catch (_) {
    // Refused by a permissions policy or privacy setting: "would not say".
  }
  return null;
}

/// The build for this browser, from Client Hints where offered and the user agent otherwise. Never
/// throws; null means no build suits it or it could not be told.
Future<DesktopBuild?> detectDesktopBuild(NavigatorSnapshot snapshot) async {
  final hints = snapshot.hints;
  if (hints == null || hints.platform.isEmpty) {
    return buildFromUserAgent(snapshot);
  }
  if (hints.mobile) return null;
  switch (hints.platform) {
    case 'macOS':
      // Anything short of a definite ARM answer keeps the build every Mac runs.
      return await _cpuOf(hints) == _Cpu.arm64
          ? DesktopBuild.macosArm64
          : DesktopBuild.macos;
    case 'Windows' || 'Android' || 'iOS':
      return null;
    case 'Linux':
      return switch (await _cpuOf(hints)) {
        _Cpu.x64 => DesktopBuild.linuxX64,
        _Cpu.arm64 => DesktopBuild.linuxArm64,
        _Cpu.other => null,
        null => buildFromUserAgent(snapshot),
      };
    default:
      // "Chrome OS", "Unknown" and the like: let the user agent have its say.
      return buildFromUserAgent(snapshot);
  }
}
