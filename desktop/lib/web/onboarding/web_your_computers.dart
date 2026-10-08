import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/models.dart';
import '../../shared/theme/app_icons.dart';
import '../../shared/theme/app_theme.dart' as grid;
import '../../state/app_state.dart';
import '../../widgets/desktop_chrome.dart';
import '../../widgets/machine_picker_form.dart';

/// The account's computers this browser is not connected to. One waiting on
/// this browser connects with a click — a computer trusts the account's other
/// devices through its device key log, so there is no password to type — and
/// one that does not answer says so and offers another try; one that is
/// offline says what to do on it.
///
/// What used to open was the machine picker itself — a search box with `@` in
/// it and tabs for harnesses and agents a browser with no computer cannot use.
class WebYourComputers extends StatefulWidget {
  const WebYourComputers({super.key, required this.app});

  final AppNotifier app;

  /// The ones to list: the account's own, not those shared with it, one per name
  /// ([newestOfEachName]).
  static List<MachineState> listed(AppNotifier app) => newestOfEachName([
    for (final state in app.machineStates.values)
      if (!state.machine.isShared) state,
  ], app.removedMachines);

  /// A computer set up again (its Harness data wiped, a reinstall) comes back
  /// under a new id and leaves the old record behind, offline for good, under
  /// the same name — and once its key is removed from the account it can never
  /// come back. So of the machines sharing a name, the removed ones are left
  /// out while any other is there, and otherwise only the latest removed is
  /// kept: the one to sign in on again. [removed] is
  /// [AppNotifier.removedMachines].
  static List<MachineState> newestOfEachName(
    List<MachineState> states,
    Map<String, int> removed,
  ) {
    int? removedAt(MachineState s) => removed[s.machine.machineId];
    final byName = <String, List<MachineState>>{};
    for (final s in states) {
      (byName[s.machine.displayName] ??= []).add(s);
    }
    bool kept(MachineState s) {
      final at = removedAt(s);
      if (at == null) return true;
      final peers = byName[s.machine.displayName]!;
      if (peers.any((p) => removedAt(p) == null)) return false;
      return peers.every((p) => p == s || removedAt(p)! < at);
    }

    return [
      for (final s in states)
        if (kept(s)) s,
    ];
  }

  @override
  State<WebYourComputers> createState() => _WebYourComputersState();
}

class _WebYourComputersState extends State<WebYourComputers> {
  /// The computer being dialed, and the ones the last try did not reach.
  String? _trying;
  final _failed = <String>{};

  Future<void> _connect(String machineId) async {
    setState(() {
      _trying = machineId;
      _failed.remove(machineId);
    });
    final connected = await widget.app.connectTrusted(machineId);
    if (!mounted) return;
    setState(() {
      _trying = null;
      if (!connected) _failed.add(machineId);
    });
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (final state in WebYourComputers.listed(widget.app)) ...[
          _ComputerRow(
            app: widget.app,
            state: state,
            failed: _failed.contains(state.machine.machineId),
            trying: _trying == state.machine.machineId,
            onConnect: () => unawaited(_connect(state.machine.machineId)),
          ),
          const SizedBox(height: 10),
        ],
      ],
    );
  }
}

/// Where a computer stands with this browser.
enum ComputerLinkState {
  removed,
  offline,
  linking,
  connecting,
  failed,
  ready,
  idle,
}

ComputerLinkState computerLinkState(
  AppNotifier app,
  MachineState state, {
  bool failed = false,
  bool trying = false,
}) {
  final id = state.machine.machineId;
  // Taken out of the account: it was signed out, and opening Harness on it
  // will not bring it back — only signing in there again will.
  if (app.removedMachines.containsKey(id) &&
      state.connectionStatus != ConnectionStatus.connected) {
    return ComputerLinkState.removed;
  }
  if (state.nodeOnline == false) return ComputerLinkState.offline;
  if (app.pendingMachineLink(id) != null) return ComputerLinkState.linking;
  if (trying ||
      state.connectionStatus == ConnectionStatus.connecting ||
      state.connectionStatus == ConnectionStatus.reconnecting) {
    return ComputerLinkState.connecting;
  }
  if (failed) return ComputerLinkState.failed;
  return state.needsLink ? ComputerLinkState.ready : ComputerLinkState.idle;
}

class _ComputerRow extends StatelessWidget {
  const _ComputerRow({
    required this.app,
    required this.state,
    required this.failed,
    required this.trying,
    required this.onConnect,
  });

  final AppNotifier app;
  final MachineState state;
  final bool failed;
  final bool trying;
  final VoidCallback onConnect;

  @override
  Widget build(BuildContext context) {
    final link = computerLinkState(app, state, failed: failed, trying: trying);
    final status = switch (link) {
      ComputerLinkState.removed =>
        'Removed from your account. Sign in to Harness on it to add it back.',
      ComputerLinkState.offline =>
        'Offline. Open Harness on it, or run harness start there.',
      ComputerLinkState.linking => machineLinkProgress(
        app.machineLinkStage(state.machine.machineId),
      ),
      ComputerLinkState.connecting => 'Connecting…',
      ComputerLinkState.failed =>
        "Couldn't connect. Check Harness is running on it, then try again.",
      ComputerLinkState.ready => 'Ready to connect to this browser.',
      ComputerLinkState.idle => 'Not connected yet.',
    };
    final busy =
        link == ComputerLinkState.linking ||
        link == ComputerLinkState.connecting;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      decoration: BoxDecoration(
        color: DesktopChrome.field,
        border: Border.all(color: DesktopChrome.rim),
        borderRadius: BorderRadius.circular(DesktopChrome.dialogRadius),
      ),
      child: Row(
        children: [
          Icon(
            link == ComputerLinkState.offline ||
                    link == ComputerLinkState.removed
                ? AppIcons.monitorOff
                : AppIcons.laptop,
            size: 18,
            color: DesktopChrome.foreground,
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  state.machine.displayName,
                  style: DesktopChrome.text(medium: true),
                ),
                Semantics(
                  liveRegion: true,
                  child: Text(status, style: DesktopChrome.metadata()),
                ),
              ],
            ),
          ),
          if (busy)
            SizedBox.square(
              dimension: 14,
              child: CircularProgressIndicator(
                strokeWidth: 1.5,
                color: DesktopChrome.muted,
              ),
            )
          else if (link == ComputerLinkState.ready)
            FilledButton(onPressed: onConnect, child: const Text('Connect'))
          else if (link == ComputerLinkState.failed)
            FilledButton(onPressed: onConnect, child: const Text('Try again')),
        ],
      ),
    );
  }
}
