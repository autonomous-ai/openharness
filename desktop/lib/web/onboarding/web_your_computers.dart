import 'package:flutter/material.dart';

import '../../shared/theme/app_icons.dart';
import '../../shared/theme/app_theme.dart' as grid;
import '../../state/app_state.dart';
import '../../widgets/desktop_chrome.dart';
import '../../widgets/machine_picker_form.dart';

/// The account's computers this browser is not connected to, each with what
/// it takes: one waiting on this browser is connected right here (the same
/// form the machine picker opens), one that is offline says what to do on it.
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

  String? _connecting;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (final state in WebYourComputers.listed(widget.app)) ...[
          _ComputerRow(
            state: state,
            onConnect: () =>
                setState(() => _connecting = state.machine.machineId),
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

class _ComputerRow extends StatelessWidget {
  const _ComputerRow({required this.state, required this.onConnect});

  final MachineState state;
  final VoidCallback onConnect;

  bool get _offline => state.nodeOnline == false;

  String get _status => _offline
      ? 'Offline. Open Harness on it, or run harness start there.'
      : state.needsLink
      ? 'Ready to connect to this browser.'
      : 'Not connected yet.';

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
    decoration: BoxDecoration(
      color: DesktopChrome.field,
      border: Border.all(color: DesktopChrome.rim),
      borderRadius: BorderRadius.circular(DesktopChrome.dialogRadius),
    ),
    child: Row(
      children: [
        Icon(
          _offline ? AppIcons.monitorOff : AppIcons.laptop,
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
              Text(_status, style: DesktopChrome.metadata()),
            ],
          ),
        ),
        if (state.needsLink && !_offline)
          FilledButton(onPressed: onConnect, child: const Text('Connect')),
      ],
    ),
  );
}
