/// Runtime configuration for the phone app.
class AppConfig {
  /// Base URL of the central backend (control plane + ws hub).
  final String apiBaseUrl;
  final String autonomousEnv;

  const AppConfig({required this.apiBaseUrl, this.autonomousEnv = 'prod'});

  static const AppConfig dev = AppConfig(
    apiBaseUrl: 'https://harness-api.autonomous.ai',
    autonomousEnv: 'prod',
  );

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
