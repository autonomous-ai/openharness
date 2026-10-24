import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';

import '../core/viewer_mode.dart';
import '../state/app_state.dart';
import '../update/desktop_updater.dart' show semverGt;
import '../widgets/desktop_chrome.dart';
import '../ws/local_daemon_transport.dart';
import 'update_harness_native.dart'
    if (dart.library.js_interop) 'update_harness_web.dart';

/// The Harness version shared tabs need on a computer (Agent Messages, tab activity).
const kAgentMessagesMinimumCli = '0.4.15';

/// The local daemon's version from its `/api/health`; null when it does not answer.
typedef HarnessVersionReader = Future<String?> Function(Uri base);

/// Runs `harness <args>`; true when it succeeded.
typedef HarnessUpdateRunner = Future<bool> Function(List<String> args);

/// [HarnessVersionReader] that also takes the app's [LocalDaemonTransport].
typedef DaemonVersionReader = Future<String?> Function(
  Uri base,
  LocalDaemonTransport? transport,
);

/// Reads the version the way the app reaches its daemon: over the Unix socket
/// when [transport] uses one (so another user's process on the loopback port is
/// never asked), the loopback port otherwise.
Future<String?> readDaemonVersion(
  Uri base, [
  LocalDaemonTransport? transport,
]) async {
  final dio = Dio(
    BaseOptions(
      connectTimeout: const Duration(seconds: 3),
      receiveTimeout: const Duration(seconds: 3),
    ),
  );
  if (transport != null) {
    dio.httpClientAdapter = LocalDaemonHttpAdapter(transport, daemonBase: base);
  }
  try {
    final response = await dio.getUri<Map<String, dynamic>>(
      base.replace(path: '/api/health'),
    );
    final version = response.data?['version'];
    return version is String && version.isNotEmpty ? version : null;
  } catch (_) {
    return null;
  } finally {
    dio.close(force: true);
  }
}

/// What [UpdateHarnessLine] uses when it is not given its own. Tests replace them
/// (test/flutter_test_config.dart) so no test reads the developer's daemon or runs the real CLI.
@visibleForTesting
DaemonVersionReader daemonVersionReader = readDaemonVersion;
@visibleForTesting
HarnessUpdateRunner harnessUpdateRunner = runHarnessUpdate;

bool isDevelopmentBuild(String version) => version.contains('-dev');

/// Why shared tabs are off: the Harness that holds them, at [current] (null when it did not say),
/// is too old. On Desktop that is this computer's; a browser ([viewer]) runs none of its own and
/// asks one of the account's computers.
String harnessTooOldLine(String? current, {required bool viewer}) {
  final computer = viewer ? 'your computer' : 'this computer';
  final runs = viewer ? 'Your computer runs' : 'This computer runs';
  if (current == null) return 'Update Harness on $computer to share tabs.';
  if (isDevelopmentBuild(current)) {
    return "$runs a development build of Harness ($current), which doesn't update itself.";
  }
  return '$runs Harness $current; shared tabs need $kAgentMessagesMinimumCli or newer.';
}

Future<bool> _confirmReplace(BuildContext context) async =>
    await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        content: const Text(
          'This replaces the development build on this computer with the latest release.',
        ),
        actions: [
          TextButton(
            key: const ValueKey('update-harness-cancel'),
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel'),
          ),
          TextButton(
            key: const ValueKey('update-harness-confirm'),
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Replace'),
          ),
        ],
      ),
    ) ??
    false;

/// "This computer's Harness is too old for shared tabs", with Update now where this app can run
/// the CLI (ruling T7: no daemon request updates it, and `harness update` stops the daemon it asks).
class UpdateHarnessLine extends StatefulWidget {
  const UpdateHarnessLine(
    this.app, {
    super.key,
    this.readVersion,
    this.runUpdate,
    this.canUpdate = canRunHarnessUpdate,
    this.confirm = _confirmReplace,
    this.pollEvery = const Duration(seconds: 2),
    this.pollLimit = 60,
  });

  final AppNotifier app;
  final HarnessVersionReader? readVersion;
  final HarnessUpdateRunner? runUpdate;
  final bool canUpdate;
  final Future<bool> Function(BuildContext context) confirm;
  final Duration pollEvery;
  final int pollLimit;

  @override
  State<UpdateHarnessLine> createState() => _UpdateHarnessLineState();
}

class _UpdateHarnessLineState extends State<UpdateHarnessLine> {
  String? _version;
  bool _updating = false, _failed = false, _disposed = false;

  Uri get _base => Uri.parse(widget.app.config.localCliBaseUrl);

  @override
  void initState() {
    super.initState();
    unawaited(_read());
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }

  Future<String?> _readVersion() {
    final custom = widget.readVersion;
    return custom != null
        ? custom(_base)
        : daemonVersionReader(_base, widget.app.localDaemonTransport);
  }

  Future<void> _read() async {
    final version = await _readVersion();
    if (!_disposed && mounted) setState(() => _version = version);
  }

  Future<void> _update() async {
    final current = _version;
    if (current == null || _updating) return;
    final dev = isDevelopmentBuild(current);
    if (dev && !await widget.confirm(context)) return;
    if (_disposed || !mounted) return;
    setState(() {
      _updating = true;
      _failed = false;
    });
    var done = false;
    if (await (widget.runUpdate ?? harnessUpdateRunner)(
      dev ? const ['update', '--force'] : const ['update'],
    )) {
      for (var i = 0; i < widget.pollLimit && !_disposed; i++) {
        final next = await _readVersion();
        if (next != null &&
            next != current &&
            (semverGt(next, current) || (dev && !isDevelopmentBuild(next)))) {
          done = true;
          break;
        }
        await Future<void>.delayed(widget.pollEvery);
      }
    }
    if (_disposed || !mounted) return;
    setState(() {
      _updating = false;
      _failed = !done;
    });
    if (done) unawaited(widget.app.sharedTabs.refresh());
  }

  @override
  Widget build(BuildContext context) {
    final current = _version;
    final line = harnessTooOldLine(current, viewer: kViewerMode);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          line,
          key: const ValueKey('agent-messages-too-old'),
          maxLines: 3,
          overflow: TextOverflow.ellipsis,
          style: DesktopChrome.metadata(),
        ),
        if (current != null && widget.canUpdate)
          _updating
              ? const Text(
                  'Updating…',
                  key: ValueKey('update-harness-updating'),
                )
              : TextButton(
                  key: const ValueKey('update-harness-now'),
                  onPressed: () => unawaited(_update()),
                  child: const Text('Update now'),
                ),
        if (_failed)
          const Text(
            "The update didn't finish. Run harness update in a terminal.",
            key: ValueKey('update-harness-failed'),
          ),
      ],
    );
  }
}
