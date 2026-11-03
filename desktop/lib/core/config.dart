/// The port of the daemon this app talks to: the default below for the installed app; the test flavor
/// (`tool/test_flavor.py`) builds with `--dart-define=HARNESS_DAEMON_PORT=<port>` for a daemon of its own.
/// A build-time define, never the environment: a `PORT` in a person's shell must not move the installed app.
const int localDaemonPort = int.fromEnvironment('HARNESS_DAEMON_PORT', defaultValue: 18473);

/// Runtime configuration for the desktop app.
class AppConfig {
  /// Base URL of the central backend (control plane + ws hub).
  final String apiBaseUrl;
  final String autonomousEnv;
  final String localCliBaseUrl;

  const AppConfig({
    required this.apiBaseUrl,
    this.autonomousEnv = 'prod',
    this.localCliBaseUrl = _localCliBaseUrl,
  });

  /// The daemon's loopback URL; its Unix socket is named for the same port.
  static const _localCliBaseUrl = 'http://127.0.0.1:$localDaemonPort';

  static const defaultApiUrl = String.fromEnvironment(
    'HARNESS_API_URL',
    defaultValue: 'https://harness-api.autonomous.ai',
  );
  static const AppConfig dev = AppConfig(apiBaseUrl: defaultApiUrl);

  /// HTTPS->wss, HTTP->ws for the hub endpoint.
  String get wsBaseUrl {
    final uri = Uri.parse(apiBaseUrl);
    final scheme = uri.scheme == 'https' ? 'wss' : 'ws';
    return Uri(
      scheme: scheme,
      host: uri.host,
      port: uri.hasPort ? uri.port : null,
    ).toString().replaceFirst(RegExp(r'/$'), '');
  }
}
