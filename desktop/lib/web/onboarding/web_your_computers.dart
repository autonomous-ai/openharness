import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/models.dart';
import '../../shared/theme/app_icons.dart';
import '../../shared/theme/app_theme.dart' as grid;
import '../../state/app_state.dart';
import '../../widgets/desktop_chrome.dart';
import '../../widgets/machine_picker_form.dart';

/// The account's computers this browser is not connected to, each with what
/// it takes: one waiting on this browser connects with a click — a computer
/// that trusts this browser through the account's device key log needs no
/// password — and only one that still refuses opens the password form (the
/// one the machine picker uses); one that is offline says what to do on it.
///
/// What used to open was the machine picker itself — a search box with `@` in
/// it and tabs for harnesses and agents a browser with no computer cannot use.
class WebYourComputers extends StatefulWidget {
  const WebYourComputers({super.key, required this.app});

  final AppNotifier app;

  /// The ones to list: the account's own, not those shared with it.
  static List<MachineState> listed(AppNotifier app) => [
    for (final state in app.machineStates.values)
      if (!state.machine.isShared) state,
  ];

  @override
  State<WebYourComputers> createState() => _WebYourComputersState();
}

class _WebYourComputersState extends State<WebYourComputers> {
  static const _formHeight = 300.0;

  /// The computer being dialed with no password, and the one whose password
  /// form is open — set only once dialing it was refused.
  String? _trying, _connecting;

  Future<void> _connect(String machineId) async {
    setState(() => _trying = machineId);
    final connected = await widget.app.connectTrusted(machineId);
    if (!mounted) return;
    setState(() {
      _trying = null;
      if (!connected) _connecting = machineId;
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
            formOpen: _connecting == state.machine.machineId,
            trying: _trying == state.machine.machineId,
            onConnect: () => unawaited(_connect(state.machine.machineId)),
          ),
          if (_connecting == state.machine.machineId)
            // The picker's preview pane is a fixed height the form fills; on
            // a scrolling page it gets one of its own.
            Container(
              height: _formHeight,
              margin: const EdgeInsets.only(top: 8),
              decoration: BoxDecoration(
                color: DesktopChrome.field,
                border: Border.all(color: DesktopChrome.rim),
                borderRadius: BorderRadius.circular(DesktopChrome.dialogRadius),
              ),
              child: MachinePickerForm(
                app: widget.app,
                kind: MachinePickerFormKind.connect,
                machineId: state.machine.machineId,
                onClose: (_) => setState(() => _connecting = null),
                onFocusChanged: (_) {},
              ),
            ),
          const SizedBox(height: 10),
        ],
      ],
    );
  }
}

/// Where a computer stands with this browser, read from the same link state the
/// connect form shows — so the row and the form never say different things.
enum ComputerLinkState { offline, linking, connecting, entering, ready, idle }

ComputerLinkState computerLinkState(
  AppNotifier app,
  MachineState state, {
  required bool formOpen,
  bool trying = false,
}) {
  final id = state.machine.machineId;
  if (state.nodeOnline == false) return ComputerLinkState.offline;
  if (app.pendingMachineLink(id) != null) return ComputerLinkState.linking;
  if (trying ||
      state.connectionStatus == ConnectionStatus.connecting ||
      state.connectionStatus == ConnectionStatus.reconnecting) {
    return ComputerLinkState.connecting;
  }
  if (formOpen) return ComputerLinkState.entering;
  return state.needsLink ? ComputerLinkState.ready : ComputerLinkState.idle;
}

class _ComputerRow extends StatelessWidget {
  const _ComputerRow({
    required this.app,
    required this.state,
    required this.formOpen,
    required this.trying,
    required this.onConnect,
  });

  final AppNotifier app;
  final MachineState state;
  final bool formOpen;
  final bool trying;
  final VoidCallback onConnect;

  @override
  Widget build(BuildContext context) {
    final link = computerLinkState(
      app,
      state,
      formOpen: formOpen,
      trying: trying,
    );
    final status = switch (link) {
      ComputerLinkState.offline =>
        'Offline. Open Harness on it, or run harness start there.',
      ComputerLinkState.linking => machineLinkProgress(
        app.machineLinkStage(state.machine.machineId),
      ),
      ComputerLinkState.connecting => 'Connecting…',
      ComputerLinkState.entering =>
        "It hasn't trusted this browser yet. Enter its password below.",
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
            link == ComputerLinkState.offline
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
            FilledButton(onPressed: onConnect, child: const Text('Connect')),
        ],
      ),
    );
  }
}
