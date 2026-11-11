import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../autonomous_device/autonomous_device_cli.dart';
import '../core/test_run.dart';
import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../shared/widgets/app_icon_button.dart';
import '../shared/widgets/app_select_field.dart';
import '../shared/widgets/labeled_field.dart';
import '../shared/widgets/setting_row.dart';
import '../shared/widgets/skeleton.dart';
import '../widgets/desktop_chrome.dart';

bool get _onWindows => defaultTargetPlatform == TargetPlatform.windows;

/// The Autonomous robots paired with this computer over the network, through the CLI
/// (`harness autonomous-device`): what is paired, what the network shows, and the two acts on them —
/// pair with the six-character code a robot shows, and revoke.
///
/// The Devices tab owns one while it is open: its list of paired robots and the Wi-Fi code
/// dialog read the same state, so a pairing shows up in the list the moment the CLI confirms it.
/// The CLI keeps the trust and the connection; nothing here holds a code longer than one request.
class WifiRobotsController extends ChangeNotifier {
  WifiRobotsController({
    AutonomousDeviceCli? cli,
    this.onLocalNetworkBlocked,
    Duration? refreshEvery,
  }) : _injected = cli,
       // Tests may inject a fake; without one under test nothing may reach a real CLI.
       _inert = kUnderTest && cli == null,
       // Under test no background clock runs unless the test asks for one (with its fake).
       _every =
           refreshEvery ?? (kUnderTest ? null : const Duration(seconds: 60));

  final AutonomousDeviceCli? _injected;
  late final AutonomousDeviceCli _cli = _injected ?? AutonomousDeviceCli();
  final bool _inert;
  final Duration? _every;

  /// Discovery found the local network refused: the app restarts a daemon it did not launch so it
  /// gets the app's permission (AppNotifier.localNetworkBlocked).
  final Future<void> Function()? onLocalNetworkBlocked;

  Timer? _timer;
  bool _started = false, _refreshing = false, _disposed = false;
  bool _seen = true;

  /// Whether the robots can be seen, set by the screen that lists them (its `VisibleTick`).
  /// While they cannot, the CLI is not asked; when they can again, once at once, then every
  /// minute.
  bool get seen => _seen;
  set seen(bool seen) {
    if (seen == _seen) return;
    _seen = seen;
    _timer?.cancel();
    _timer = null;
    if (seen && _started && _every != null && !unsupported && !busy) {
      unawaited(refresh());
    }
  }

  int _generation = 0;

  bool loading = true;
  bool busy = false;
  bool unsupported = false;
  bool networkBlocked = false;

  /// The last status read failed: why.
  String? error;

  /// The last pairing failed: why. Shown in the Wi-Fi code dialog.
  String? pairError;

  /// The last revoke failed: why. Shown beside the paired list.
  String? revokeError;

  Map<String, dynamic> status = const {};
  List<Map<String, dynamic>> paired = const [];
  List<Map<String, dynamic>> discovered = const [];

  /// Nothing to press while a request is out, before the first answer, or with no CLI behind it.
  bool get controlsDisabled => busy || loading || _inert;

  /// Reads the CLI once and then every minute while somebody looks.
  void start() {
    if (_started) return;
    _started = true;
    if (_inert) {
      loading = false;
      notifyListeners();
      return;
    }
    unawaited(refresh());
  }

  void _changed() {
    if (!_disposed) notifyListeners();
  }

  void _scheduleRefresh() {
    _timer?.cancel();
    final every = _every;
    if (_disposed || every == null || !_seen || unsupported || busy) return;
    _timer = Timer(every, () => unawaited(refresh()));
  }

  String _message(Object error) => error is AutonomousDeviceCliException
      ? error.userMessage
      : 'Could not reach the Harness CLI.';

  /// A refused local network loses discovery only: paired robots still list, and the dialog says
  /// where to allow it instead of "no robots found".
  Future<Map<String, dynamic>> _discoverOrBlocked() async {
    try {
      return await _cli.discover();
    } on AutonomousDeviceCliException catch (error) {
      if (!error.localNetworkBlocked) rethrow;
      if (onLocalNetworkBlocked case final restart?) {
        await restart();
        try {
          return await _cli.discover();
        } on AutonomousDeviceCliException catch (again) {
          if (!again.localNetworkBlocked) rethrow;
        }
      }
      return {'devices': const [], 'localNetworkBlocked': true};
    }
  }

  static List<Map<String, dynamic>> _rows(Object? raw) => [
    for (final row in raw is List ? raw : const [])
      if (row is Map<String, dynamic>) row,
  ];

  Future<void> refresh() async {
    if (_refreshing || _inert || _disposed) return;
    _refreshing = true;
    final generation = _generation;
    try {
      final next = await _cli.status();
      final results = await Future.wait([_cli.list(), _discoverOrBlocked()]);
      if (_disposed || generation != _generation) return;
      final devices = _rows(results[0]['devices']);
      final found = [
        for (final row in _rows(results[1]['devices']))
          if (row['id'] is String && (row['id'] as String).isNotEmpty) row,
      ];
      final blocked = results[1]['localNetworkBlocked'] == true;
      if (loading ||
          unsupported ||
          error != null ||
          blocked != networkBlocked ||
          jsonEncode([next, devices, found]) !=
              jsonEncode([status, paired, discovered])) {
        status = next;
        paired = devices;
        discovered = found;
        networkBlocked = blocked;
        loading = false;
        unsupported = false;
        error = null;
        _changed();
      }
    } catch (failure) {
      if (!_disposed && generation == _generation) {
        error = _message(failure);
        if (failure is AutonomousDeviceCliException && failure.unsupported) {
          unsupported = true;
        }
        loading = false;
        _changed();
      }
    } finally {
      _refreshing = false;
      _scheduleRefresh();
    }
  }

  /// Runs one mutation: no poll begun before it may overwrite its newer answer.
  Future<bool> _act(
    Future<void> Function() action,
    void Function(String message) failed,
  ) async {
    if (busy || _inert || _disposed) return false;
    _timer?.cancel();
    _generation++;
    busy = true;
    error = null;
    pairError = null;
    revokeError = null;
    _changed();
    var ok = false;
    try {
      await action();
      ok = true;
    } catch (failure) {
      failed(_message(failure));
    } finally {
      busy = false;
      _changed();
      _scheduleRefresh();
    }
    return ok;
  }

  /// Why [deviceId] and [code] cannot be paired as typed, or null when they can.
  String? pairProblem(String? deviceId, String code) {
    if (deviceId == null || !discovered.any((d) => d['id'] == deviceId)) {
      return 'Select your discovered Autonomous robot first.';
    }
    if (!RegExp(r'^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{6}$')
        .hasMatch(normalizeAutonomousDeviceCode(code))) {
      return 'Enter the six-character code shown on your Autonomous robot.';
    }
    return null;
  }

  /// Pairs the discovered robot [deviceId] with the [code] it shows. True once the CLI holds it.
  Future<bool> pair({required String? deviceId, required String code}) async {
    if (busy) return false;
    if (pairProblem(deviceId, code) case final problem?) {
      pairError = problem;
      _changed();
      return false;
    }
    return _act(() async {
      // The daemon resolves this selected discovery identity, never a UI address.
      await _cli.pair(
        code: normalizeAutonomousDeviceCode(code),
        deviceId: deviceId!,
      );
      // The pair response and the list row carry the same identity; reading the list keeps one
      // source for what is paired.
      final devices = await _cli.list();
      if (!_disposed) paired = _rows(devices['devices']);
    }, (message) => pairError = message);
  }

  Future<bool> revoke(String id) => _act(() async {
    await _cli.revoke(id);
    if (!_disposed) {
      paired = [
        for (final d in paired)
          if (d['id'] != id) d,
      ];
    }
    await refresh();
  }, (message) => revokeError = message);

  /// Clears a pairing message once the person changes what they typed or chose.
  void clearPairError() {
    if (pairError == null) return;
    pairError = null;
    _changed();
  }

  @override
  void dispose() {
    _disposed = true;
    _timer?.cancel();
    // Leaving the tab does not revoke trust or stop the daemon.
    super.dispose();
  }
}

/// Status of one paired robot, as its row says it.
String wifiRobotDetail(Map<String, dynamic> device) => [
  device['pendingFirstSession'] == true
      ? 'Waiting for first connection'
      : device['online'] == true
      ? 'Connected'
      : 'Paired · Offline',
  ?device['fingerprint']?.toString(),
].join(' · ');

Future<bool> _confirmRevoke(
  BuildContext context,
  Map<String, dynamic> device,
) async =>
    await showAppDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Revoke Autonomous robot?'),
        content: SizedBox(
          width: 360,
          child: Text(
            'Disconnect ${device['label'] ?? 'this Autonomous robot'} and remove its access to this computer. '
            'It will need to pair again.',
            style: grid.AppType.body(height: 1.4),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            style: TextButton.styleFrom(
              foregroundColor: grid.AppPalette.textSecondary,
              overlayColor: grid.AppSurface.hoverFill,
            ),
            child: const Text('Cancel'),
          ),
          FilledButton(
            key: const Key('device-confirm'),
            style: FilledButton.styleFrom(
              backgroundColor: grid.AppPalette.dangerFill,
              overlayColor: const Color(0x1FFFFFFF),
            ),
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Revoke Autonomous robot'),
          ),
        ],
      ),
    ) ??
    false;

/// The Devices tab's robots paired over Wi-Fi: one row each, and Revoke… on it. Nothing at all while
/// none is paired — Add device ▸ Wi-Fi code is where one is added.
class WifiRobotsList extends StatelessWidget {
  const WifiRobotsList({super.key, required this.controller, this.topGap = 0});

  final WifiRobotsController controller;

  /// Space above the list, taken only when there is a list.
  final double topGap;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: controller,
    builder: (context, _) {
      grid.AppTheme.watch(context);
      final paired = controller.paired;
      final problem = controller.revokeError;
      if (paired.isEmpty && problem == null) return const SizedBox.shrink();
      return Column(
        key: const Key('wifi-robots'),
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SizedBox(height: topGap),
          Text('Paired over Wi-Fi', style: grid.AppType.title()),
          const SizedBox(height: 5),
          Text(
            'Harness CLI keeps the connection running when you close Desktop.',
            style: DesktopChrome.metadata(),
          ),
          const SizedBox(height: 14),
          for (final device in paired) ...[
            SettingRow(
              key: ValueKey('wifi-robot-${device['id']}'),
              title: device['label']?.toString() ?? 'Autonomous robot',
              // The fingerprint belongs to the device it identifies, not to a row of its own.
              detail: wifiRobotDetail(device),
              control: SizedBox(
                width: SettingRow.controlWidth,
                child: OutlinedButton(
                  key: ValueKey('wifi-robot-revoke-${device['id']}'),
                  onPressed:
                      controller.controlsDisabled || device['id'] is! String
                      ? null
                      : () async {
                          if (!await _confirmRevoke(context, device)) return;
                          await controller.revoke(device['id'] as String);
                        },
                  child: const Text('Revoke…'),
                ),
              ),
            ),
            const SizedBox(height: 10),
          ],
          if (problem != null)
            Semantics(
              liveRegion: true,
              child: Text(
                problem,
                key: const Key('wifi-robots-error'),
                style: DesktopChrome.metadata(
                  color: Theme.of(context).colorScheme.error,
                ),
              ),
            ),
        ],
      );
    },
  );
}

/// Add device ▸ Wi-Fi code: choose a robot the network shows and enter the six-character code it
/// displays. True when it paired.
Future<bool> showWifiPairDialog(
  BuildContext context,
  WifiRobotsController controller, {
  void Function()? openLocalNetworkSettings,
}) async =>
    await showAppDialog<bool>(
      context: context,
      builder: (_) => WifiPairDialog(
        controller: controller,
        openLocalNetworkSettings: openLocalNetworkSettings,
      ),
    ) ??
    false;

class WifiPairDialog extends StatefulWidget {
  const WifiPairDialog({
    super.key,
    required this.controller,
    this.openLocalNetworkSettings,
  });

  final WifiRobotsController controller;

  /// Replaces opening System Settings ▸ Privacy & Security ▸ Local Network (tests).
  final void Function()? openLocalNetworkSettings;

  @override
  State<WifiPairDialog> createState() => _WifiPairDialogState();
}

class _WifiPairDialogState extends State<WifiPairDialog> {
  final _code = TextEditingController();
  String? _selected;

  WifiRobotsController get _robots => widget.controller;

  @override
  void initState() {
    super.initState();
    _robots.addListener(_changed);
    // A message from an earlier attempt belongs to that attempt.
    _robots.pairError = null;
    unawaited(_robots.refresh());
  }

  @override
  void dispose() {
    _robots.removeListener(_changed);
    _code.dispose();
    super.dispose();
  }

  void _changed() {
    // A robot that left the network takes its selection with it, and the code typed for it: a
    // code is never retargeted at another robot.
    if (_selected != null &&
        !_robots.discovered.any((device) => device['id'] == _selected)) {
      _selected = null;
      _code.clear();
    }
    if (mounted) setState(() {});
  }

  void _openLocalNetworkSettings() =>
      (widget.openLocalNetworkSettings ??
      () => unawaited(
        launchUrl(
          Uri.parse(
            _onWindows ? 'windowsdefender://network/' : 'x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork',
          ),
        ),
      ))();

  Future<void> _submit() async {
    if (_robots.busy) return;
    final code = _code.text;
    // A code that is sent is spent: the field empties. One refused before sending stays, to be
    // corrected.
    if (_robots.pairProblem(_selected, code) == null) _code.clear();
    final paired = await _robots.pair(deviceId: _selected, code: code);
    if (mounted && paired) Navigator.of(context).pop(true);
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final robots = _robots;
    final disabled = robots.controlsDisabled;
    final message = robots.pairError ?? robots.error;
    final refresh = AppIconButton(
      icon: AppIcons.refreshCw,
      tooltip: 'Refresh Autonomous robot status',
      onPressed: disabled ? null : () => unawaited(robots.refresh()),
    );
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 500),
          child: DesktopDialogSurface(
            child: SingleChildScrollView(
              child: Padding(
                padding: const EdgeInsets.all(28),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    DesktopDialogHeader(
                      title: 'Pair with a code',
                      padding: EdgeInsets.zero,
                      onClose: () => Navigator.of(context).pop(false),
                    ),
                    const SizedBox(height: 8),
                    Text(
                      'Keep your Autonomous robot on the same network as this computer.',
                      style: DesktopChrome.text(color: DesktopChrome.muted),
                    ),
                    const SizedBox(height: 20),
                    if (robots.loading)
                      const SkeletonBlock(child: SkeletonListTile(leading: 0))
                    else if (robots.unsupported) ...[
                      Text(
                        'Update Harness CLI to use Autonomous robots.',
                        style: DesktopChrome.control(medium: true),
                      ),
                      const SizedBox(height: 6),
                      Text(
                        'Run this command in Terminal, then refresh.',
                        style: DesktopChrome.text(color: DesktopChrome.muted),
                      ),
                      const SizedBox(height: 8),
                      Row(
                        children: [
                          const Expanded(
                            child: SelectableText('harness update'),
                          ),
                          refresh,
                        ],
                      ),
                    ] else ...[
                      if (robots.networkBlocked) ...[
                        Column(
                          key: const Key('autonomous-device-network-blocked'),
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              'Allow Harness on your local network',
                              style: DesktopChrome.control(medium: true),
                            ),
                            const SizedBox(height: 6),
                            Text(
                              _onWindows
                                  ? 'Windows Firewall is blocking Harness, so it can’t find Autonomous robots. '
                                        'Allow Harness through the firewall, then refresh.'
                                  : 'macOS is blocking Harness from your local network, so it can’t find Autonomous robots. '
                                        'Turn on Harness in Privacy & Security › Local Network, then refresh.',
                              style: DesktopChrome.text(
                                color: DesktopChrome.muted,
                              ),
                            ),
                            if (Platform.isMacOS ||
                                _onWindows ||
                                widget.openLocalNetworkSettings != null) ...[
                              const SizedBox(height: 8),
                              OutlinedButton(
                                onPressed: disabled
                                    ? null
                                    : _openLocalNetworkSettings,
                                child: Text(
                                  _onWindows
                                      ? 'Open firewall settings'
                                      : 'Open Settings',
                                ),
                              ),
                            ],
                          ],
                        ),
                        const SizedBox(height: 18),
                      ],
                      Text(
                        'Device',
                        style: DesktopChrome.control(medium: true),
                      ),
                      const SizedBox(height: 6),
                      Row(
                        children: [
                          Expanded(
                            child: ExcludeFocus(
                              excluding: disabled,
                              child: IgnorePointer(
                                ignoring: disabled,
                                child: AppSelectField<String?>(
                                  key: const Key('autonomous-device-selection'),
                                  semanticLabel: 'Autonomous robot',
                                  value: _selected,
                                  options: [
                                    const SelectOption<String?>(
                                      value: null,
                                      label: 'Select a device',
                                    ),
                                    for (final device in robots.discovered)
                                      SelectOption<String?>(
                                        value: device['id'] as String,
                                        label:
                                            device['name']?.toString() ??
                                            'Autonomous robot',
                                      ),
                                  ],
                                  onChanged: (value) {
                                    if (robots.controlsDisabled) return;
                                    setState(() {
                                      _selected = value;
                                      _code.clear();
                                    });
                                    robots.clearPairError();
                                  },
                                ),
                              ),
                            ),
                          ),
                          const SizedBox(width: 8),
                          refresh,
                        ],
                      ),
                      const SizedBox(height: 6),
                      Text(
                        robots.networkBlocked
                            ? 'Allow local network access above to find your robot.'
                            : robots.discovered.isEmpty
                            // Windows Firewall drops the answers without an error, so a
                            // blocked network looks like an empty one there.
                            ? _onWindows
                                  ? 'No Autonomous robots found. Keep your device on the same network, then refresh. If it still isn’t found, Windows Firewall may be blocking Harness.'
                                  : 'No Autonomous robots found. Keep your device on the same network, then refresh.'
                            : 'Select your device and enter its six-character code. Separators are allowed, for example ABC-123.',
                        style: DesktopChrome.metadata(),
                      ),
                      const SizedBox(height: 14),
                      TextField(
                        key: const Key('autonomous-device-code'),
                        controller: _code,
                        enabled: !disabled,
                        maxLength: 32,
                        obscureText: true,
                        autocorrect: false,
                        enableSuggestions: false,
                        style: grid.AppType.mono(
                          color: grid.AppPalette.textPrimary,
                        ),
                        decoration: labeledFieldDecoration(
                          'Six-character code',
                          fill: grid.AppCard.inset,
                        ).copyWith(counterText: ''),
                        onSubmitted: (_) => unawaited(_submit()),
                      ),
                    ],
                    if (message != null && !robots.unsupported) ...[
                      const SizedBox(height: 12),
                      Semantics(
                        liveRegion: true,
                        child: Text(
                          message,
                          key: const Key('autonomous-device-error'),
                          style: DesktopChrome.text(
                            color: Theme.of(context).colorScheme.error,
                          ),
                        ),
                      ),
                    ],
                    const SizedBox(height: 12),
                    Text(
                      'Harness CLI keeps the connection running when you close Desktop.',
                      style: DesktopChrome.metadata(),
                    ),
                    const SizedBox(height: 24),
                    Wrap(
                      alignment: WrapAlignment.end,
                      spacing: 10,
                      runSpacing: 8,
                      children: [
                        TextButton(
                          onPressed: () => Navigator.of(context).pop(false),
                          child: const Text('Cancel'),
                        ),
                        FilledButton(
                          key: const Key('autonomous-device-pair'),
                          onPressed: disabled || robots.unsupported
                              ? null
                              : () => unawaited(_submit()),
                          child: Text(robots.busy ? 'Pairing…' : 'Pair'),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
