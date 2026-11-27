/// One agent's Browser settings as its machine keeps them (cli services/agentBrowser/settings.ts `publicSettings`).
/// They live only on that machine: this app reads them, changes them and sends them back whole.
class BrowserSettings {
  const BrowserSettings({
    this.proxy,
    this.timeZone,
    required this.languages,
    this.screen = '1080x1920',
    this.humanInput = true,
    this.humanSpeed = 'normal',
    this.device,
  });

  /// Portrait first, the first the default (the machine's too): the Browser panel sits beside the chat, taller than
  /// wide, and a landscape screen left black bands above and below the page.
  static const screens = [
    '1080x1920',
    '1200x1920',
    '1050x1680',
    '1920x1080',
    '1680x1050',
    '1536x864',
    '1440x900',
    '1366x768',
  ];
  static const speeds = ['slow', 'normal', 'fast'];
  static final _size = RegExp(r'^[1-9][0-9]{2,4}x[1-9][0-9]{2,4}$');

  final BrowserProxy? proxy;

  /// An IANA zone, or null for Auto: the proxy's exit zone with a proxy, the machine's without.
  final String? timeZone;

  /// Language tags, most wanted first, as `vi-VN, en-US`.
  final String languages;
  final String screen;
  final bool humanInput;
  final String humanSpeed;
  final BrowserDevice? device;

  factory BrowserSettings.fromJson(Map<String, dynamic> j) {
    final zone = j['timeZone'], languages = j['languages'];
    return BrowserSettings(
      proxy: BrowserProxy.fromJson(j['proxy']),
      timeZone: zone is String && zone.isNotEmpty ? zone : null,
      languages: languages is String ? languages : '',
      // A size from a newer machine stays as it is: falling back would change the screen at the next save.
      screen: j['screen'] is String && _size.hasMatch(j['screen'] as String)
          ? j['screen'] as String
          : screens.first,
      humanInput: j['humanInput'] is bool ? j['humanInput'] as bool : true,
      humanSpeed: speeds.contains(j['humanSpeed'])
          ? j['humanSpeed'] as String
          : 'normal',
      device: BrowserDevice.fromJson(j['device']),
    );
  }

  /// What `agent_browser_settings_save` takes. The password is write-only: sent only when the person typed one, so a
  /// save without it keeps the stored one.
  Map<String, Object?> toSave({String? password}) => {
    'proxy': proxy == null
        ? null
        : {
            'scheme': proxy!.scheme,
            'host': proxy!.host,
            'port': proxy!.port,
            'username': proxy!.username,
            'password': ?password,
          },
    'timeZone': timeZone,
    'languages': languages,
    'screen': screen,
    'humanInput': humanInput,
    'humanSpeed': humanSpeed,
    'device': device?.toJson(),
  };
}

class BrowserProxy {
  const BrowserProxy({
    required this.scheme,
    required this.host,
    required this.port,
    this.username = '',
    this.passwordSet = false,
  });

  static const schemes = ['http', 'https', 'socks5'];

  final String scheme, host, username;
  final int port;

  /// The machine holds a password for it; the password itself never comes back.
  final bool passwordSet;

  static BrowserProxy? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final scheme = raw['scheme'], host = raw['host'], port = raw['port'];
    if (!schemes.contains(scheme) || host is! String || port is! int) {
      return null;
    }
    final username = raw['username'];
    return BrowserProxy(
      scheme: scheme as String,
      host: host,
      port: port,
      username: username is String ? username : '',
      passwordSet: raw['passwordSet'] == true,
    );
  }
}

/// The GPU, CPU cores and memory the browser reports to pages, instead of the container's own.
class BrowserDevice {
  const BrowserDevice({
    required this.gpuVendor,
    required this.gpuRenderer,
    required this.cpuCores,
    required this.memoryGb,
  });

  final String gpuVendor, gpuRenderer;
  final int cpuCores, memoryGb;

  static BrowserDevice? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final vendor = raw['gpuVendor'], renderer = raw['gpuRenderer'];
    final cores = raw['cpuCores'], memory = raw['memoryGb'];
    if (vendor is! String ||
        renderer is! String ||
        cores is! int ||
        memory is! int) {
      return null;
    }
    return BrowserDevice(
      gpuVendor: vendor,
      gpuRenderer: renderer,
      cpuCores: cores,
      memoryGb: memory,
    );
  }

  Map<String, Object> toJson() => {
    'gpuVendor': gpuVendor,
    'gpuRenderer': gpuRenderer,
    'cpuCores': cpuCores,
    'memoryGb': memoryGb,
  };
}

/// What a proxy test found from the agent's machine: the exit address and its zone, or that the proxy did not answer.
class ProxyTestResult {
  const ProxyTestResult({required this.ok, this.address, this.timeZone});

  final bool ok;
  final String? address, timeZone;

  factory ProxyTestResult.fromJson(Map<String, dynamic> j) {
    final address = j['address'], zone = j['timeZone'];
    return j['ok'] == true
        ? ProxyTestResult(
            ok: true,
            address: address is String ? address : null,
            timeZone: zone is String ? zone : null,
          )
        : const ProxyTestResult(ok: false);
  }
}
