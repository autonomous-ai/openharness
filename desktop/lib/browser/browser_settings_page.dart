import 'dart:convert';

import 'package:flutter/material.dart';

import '../logging/app_log.dart';
import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_select_field.dart';
import '../state/app_state.dart';
import '../widgets/desktop_chrome.dart';
import '../ws/ws_conn.dart';
import 'browser_settings.dart';

/// Browser settings, inside the agent's Browser panel (Mockup 5). They are read from and saved to the agent's machine;
/// a saved proxy password never comes back, so it shows as dots and is sent only when the person types a new one.
class BrowserSettingsPage extends StatefulWidget {
  const BrowserSettingsPage({
    super.key,
    required this.app,
    required this.machineId,
    required this.agentId,
    required this.onBack,
  });

  final AppNotifier app;
  final String machineId, agentId;
  final VoidCallback onBack;

  @override
  State<BrowserSettingsPage> createState() => _BrowserSettingsPageState();
}

class _BrowserSettingsPageState extends State<BrowserSettingsPage> {
  BrowserSettings? _saved;
  String? _failure;
  ProxyTestResult? _tested;
  bool _busy = false, _advanced = false;

  var _scheme = BrowserProxy.schemes.first;
  final _host = TextEditingController(), _port = TextEditingController();
  final _username = TextEditingController(),
      _password = TextEditingController();

  /// The person typed a password, or removed the proxy: the stored one no longer goes with what is in the fields.
  bool _passwordEdited = false;
  final _zone = TextEditingController(), _languages = TextEditingController();
  var _screen = BrowserSettings.screens.first, _speed = 'normal';
  bool _human = true, _device = false;
  final _gpuVendor = TextEditingController(),
      _gpuRenderer = TextEditingController();
  final _cpuCores = TextEditingController(), _memory = TextEditingController();

  late final _fields = [
    _host,
    _port,
    _username,
    _password,
    _zone,
    _languages,
    _gpuVendor,
    _gpuRenderer,
    _cpuCores,
    _memory,
  ];

  @override
  void initState() {
    super.initState();
    _run(() async {
      _show(
        await widget.app.agentBrowserSettings(widget.machineId, widget.agentId),
      );
    });
  }

  @override
  void dispose() {
    for (final field in _fields) {
      field.dispose();
    }
    super.dispose();
  }

  void _show(BrowserSettings saved) {
    _saved = saved;
    final proxy = saved.proxy;
    _scheme = proxy?.scheme ?? BrowserProxy.schemes.first;
    _host.text = proxy?.host ?? '';
    _port.text = proxy == null ? '' : '${proxy.port}';
    _username.text = proxy?.username ?? '';
    _password.clear();
    _passwordEdited = false;
    _zone.text = saved.timeZone ?? '';
    _languages.text = saved.languages;
    _screen = saved.screen;
    _human = saved.humanInput;
    _speed = saved.humanSpeed;
    final device = saved.device;
    _device = device != null;
    _gpuVendor.text = device?.gpuVendor ?? '';
    _gpuRenderer.text = device?.gpuRenderer ?? '';
    _cpuCores.text = device == null ? '' : '${device.cpuCores}';
    _memory.text = device == null ? '' : '${device.memoryGb}';
  }

  /// [work] against the machine, one at a time; a failure is shown where the person can act on it.
  Future<void> _run(Future<void> Function() work, {bool save = false}) async {
    setState(() {
      _busy = true;
      _failure = null;
    });
    try {
      await work();
    } catch (failure) {
      final code = failure is WsRequestFailure
          ? failure.code
          : '${failure.runtimeType}';
      appLog.warn('browser', 'settings request failed: $code');
      _failure = code == 'NOT_OWNER'
          ? 'Only its owner can open this browser'
          // A screen is one of this build's or the machine's own, so a refused one is newer than the machine (portrait).
          : save &&
                failure is WsRequestFailure &&
                failure.detail == 'invalid browser setting: screen'
          ? 'Update Harness on $_machineName for this screen'
          : save && failure is WsRequestFailure
          ? 'Browser settings weren\'t saved. Check them and save again.'
          : 'Reconnect this machine to open its browser';
    }
    if (mounted) setState(() => _busy = false);
  }

  String get _machineName =>
      widget.app.stateOf(widget.machineId)?.machine.displayName ??
      widget.machineId;

  static int? _number(String text, int max) {
    final n = int.tryParse(text.trim());
    return n != null && n >= 1 && n <= max ? n : null;
  }

  bool get _hasProxy => _host.text.trim().isNotEmpty || _port.text.isNotEmpty;

  /// The proxy in the fields, or null with none; invalid when [_hasProxy] and this is null.
  BrowserProxy? get _proxy {
    final host = _host.text.trim(), port = _number(_port.text, 65535);
    if (!RegExp(r'^[A-Za-z0-9.:[\]-]+$').hasMatch(host) || port == null) {
      return null;
    }
    return BrowserProxy(
      scheme: _scheme,
      host: host,
      port: port,
      username: _username.text,
    );
  }

  String? get _newPassword => _passwordEdited ? _password.text : null;

  /// What Save would send, or null while a field is not valid.
  Map<String, Object?>? get _toSave {
    final proxy = _proxy, zone = _zone.text.trim();
    if (_hasProxy && proxy == null) return null;
    if (zone.isNotEmpty &&
        !RegExp(r'^[A-Za-z][A-Za-z0-9_+/-]*$').hasMatch(zone)) {
      return null;
    }
    if (_languages.text.trim().isEmpty) return null;
    BrowserDevice? device;
    if (_device) {
      final cores = _number(_cpuCores.text, 256),
          memory = _number(_memory.text, 1024);
      if (_gpuVendor.text.trim().isEmpty ||
          _gpuRenderer.text.trim().isEmpty ||
          cores == null ||
          memory == null) {
        return null;
      }
      device = BrowserDevice(
        gpuVendor: _gpuVendor.text.trim(),
        gpuRenderer: _gpuRenderer.text.trim(),
        cpuCores: cores,
        memoryGb: memory,
      );
    }
    return BrowserSettings(
      proxy: proxy,
      timeZone: zone.isEmpty ? null : zone,
      languages: _languages.text.trim(),
      screen: _screen,
      humanInput: _human,
      humanSpeed: _speed,
      device: device,
    ).toSave(password: _newPassword);
  }

  bool get _changed {
    final next = _toSave;
    return next != null && jsonEncode(next) != jsonEncode(_saved!.toSave());
  }

  void _save() => _run(() async {
    _show(
      await widget.app.agentBrowserSettingsSave(
        widget.machineId,
        widget.agentId,
        _toSave!,
      ),
    );
  }, save: true);

  void _test() => _run(() async {
    final proxy = _proxy!;
    final tested = await widget.app.agentBrowserProxyTest(
      widget.machineId,
      widget.agentId,
      {
        'scheme': proxy.scheme,
        'host': proxy.host,
        'port': proxy.port,
        'username': proxy.username,
        'password': ?_newPassword,
      },
    );
    _tested = tested;
  });

  void _remove() => setState(() {
    for (final field in [_host, _port, _username, _password]) {
      field.clear();
    }
    _passwordEdited = true;
    _tested = null;
  });

  /// Any edit can change what Save and Test may do; a proxy edit also makes the last test stale.
  void _edited({bool proxy = false}) => setState(() {
    if (proxy) _tested = null;
  });

  Widget _field(
    String key,
    TextEditingController controller,
    String hint, {
    bool proxy = false,
    bool obscure = false,
    ValueChanged<String>? onChanged,
  }) => TextField(
    key: ValueKey('browser-settings-$key'),
    controller: controller,
    enabled: !_busy,
    obscureText: obscure,
    style: DesktopChrome.control(),
    decoration: InputDecoration(hintText: hint),
    onChanged: onChanged ?? (_) => _edited(proxy: proxy),
  );

  Widget _select(
    String key,
    String value,
    Map<String, String> labels,
    ValueChanged<String> onChanged,
  ) => AppSelectField<String>(
    key: ValueKey('browser-settings-$key'),
    value: value,
    textStyle: DesktopChrome.control(),
    options: [
      for (final MapEntry(key: value, value: label) in labels.entries)
        SelectOption(value: value, label: label),
    ],
    onChanged: (value) => setState(() => onChanged(value)),
  );

  /// On or off, drawn as New agent's Worktree and Browser are: a ticked square, never a blue switch (blue is Save's).
  Widget _toggle(String key, bool on, ValueChanged<bool> onChanged) =>
      Semantics(
        checked: on,
        child: DesktopPill(
          key: ValueKey('browser-settings-$key'),
          label: on ? 'On' : 'Off',
          icon: on ? AppIcons.squareCheck : AppIcons.square,
          quiet: true,
          compact: true,
          textSize: 12,
          foregroundColor: DesktopChrome.muted,
          onPressed: _busy ? null : () => setState(() => onChanged(!on)),
        ),
      );

  Widget _row(String label, Widget control) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 4),
    child: Row(
      children: [
        SizedBox(
          width: 96,
          child: Text(label, style: DesktopChrome.metadata()),
        ),
        Expanded(child: control),
      ],
    ),
  );

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    const gap = SizedBox.square(dimension: DesktopChrome.controlGap);
    final saved = _saved;
    final tested = _tested;
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Align(
            alignment: Alignment.centerLeft,
            child: DesktopPill(
              key: const ValueKey('browser-settings-back'),
              label: 'Browser settings',
              icon: AppIcons.chevronLeft,
              compact: true,
              quiet: true,
              tooltip: 'Back',
              onPressed: widget.onBack,
            ),
          ),
          if (_failure case final failure?) ...[
            gap,
            Text(failure, style: DesktopChrome.metadata()),
          ],
          if (saved != null) ...[
            const SizedBox(height: DesktopChrome.groupGap),
            Text('Proxy', style: DesktopChrome.metadata()),
            gap,
            Row(
              children: [
                SizedBox(
                  width: 112,
                  child: _select(
                    'scheme',
                    _scheme,
                    const {
                      'http': 'HTTP',
                      'https': 'HTTPS',
                      'socks5': 'SOCKS5',
                    },
                    (scheme) {
                      _scheme = scheme;
                      _tested = null;
                    },
                  ),
                ),
                gap,
                Expanded(child: _field('host', _host, 'Host', proxy: true)),
                gap,
                SizedBox(
                  width: 80,
                  child: _field('port', _port, 'Port', proxy: true),
                ),
              ],
            ),
            gap,
            Row(
              children: [
                Expanded(
                  child: _field('username', _username, 'Username', proxy: true),
                ),
                gap,
                Expanded(
                  child: _field(
                    'password',
                    _password,
                    // The stored password never comes back: its dots stand for it until a new one is typed.
                    saved.proxy?.passwordSet == true && !_passwordEdited
                        ? '••••••••'
                        : 'Password',
                    obscure: true,
                    onChanged: (_) => setState(() {
                      _passwordEdited = true;
                      _tested = null;
                    }),
                  ),
                ),
              ],
            ),
            gap,
            Wrap(
              alignment: WrapAlignment.end,
              spacing: DesktopChrome.controlGap,
              children: [
                TextButton(
                  key: const ValueKey('browser-settings-remove'),
                  onPressed: !_busy && _hasProxy ? _remove : null,
                  child: const Text('Remove'),
                ),
                TextButton(
                  key: const ValueKey('browser-settings-test'),
                  onPressed: !_busy && _proxy != null ? _test : null,
                  child: const Text('Test'),
                ),
                FilledButton(
                  key: const ValueKey('browser-settings-save'),
                  onPressed: !_busy && _changed ? _save : null,
                  child: const Text('Save'),
                ),
              ],
            ),
            if (tested != null) ...[
              gap,
              Text(
                tested.ok
                    ? [
                        'Proxy works',
                        ?tested.address,
                        ?tested.timeZone,
                      ].join(' · ')
                    : 'Proxy is not reachable',
                style: DesktopChrome.metadata(),
              ),
            ],
            const SizedBox(height: DesktopChrome.groupGap),
            _row('Time zone', _field('zone', _zone, 'Auto')),
            _row('Language', _field('languages', _languages, 'vi-VN, en-US')),
            _row(
              'Screen',
              _select('screen', _screen, {
                for (final size in {...BrowserSettings.screens, _screen})
                  size: size.replaceFirst('x', ' × '),
              }, (screen) => _screen = screen),
            ),
            _row(
              'Human input',
              Row(
                children: [
                  _toggle('human', _human, (on) => _human = on),
                  gap,
                  // Off, no speed applies.
                  Expanded(
                    child: ExcludeFocus(
                      excluding: !_human,
                      child: IgnorePointer(
                        ignoring: !_human,
                        child: Opacity(
                          opacity: _human ? 1 : .38,
                          child: _select('speed', _speed, const {
                            'slow': 'Slow',
                            'normal': 'Normal',
                            'fast': 'Fast',
                          }, (speed) => _speed = speed),
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ),
            gap,
            Align(
              alignment: Alignment.centerLeft,
              child: DesktopPill(
                key: const ValueKey('browser-settings-advanced'),
                label: 'Advanced',
                icon: _advanced ? AppIcons.chevronDown : AppIcons.chevronRight,
                compact: true,
                quiet: true,
                onPressed: () => setState(() => _advanced = !_advanced),
              ),
            ),
            if (_advanced) ...[
              _row(
                'Device',
                Row(
                  children: [
                    _toggle('device', _device, (on) => _device = on),
                    gap,
                    Text(
                      'GPU, CPU, memory',
                      style: DesktopChrome.metadata(color: DesktopChrome.hint),
                    ),
                  ],
                ),
              ),
              if (_device) ...[
                gap,
                Row(
                  children: [
                    Expanded(
                      child: _field('gpu-vendor', _gpuVendor, 'GPU vendor'),
                    ),
                    gap,
                    Expanded(
                      child: _field(
                        'gpu-renderer',
                        _gpuRenderer,
                        'GPU renderer',
                      ),
                    ),
                  ],
                ),
                gap,
                Row(
                  children: [
                    Expanded(
                      child: _field('cpu-cores', _cpuCores, 'CPU cores'),
                    ),
                    gap,
                    Expanded(child: _field('memory', _memory, 'Memory GB')),
                  ],
                ),
              ],
            ],
          ],
        ],
      ),
    );
  }
}
