import 'dart:async';

import 'package:flutter/material.dart';

import '../core/models.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_select_field.dart';
import '../state/account_devices.dart';
import '../state/app_state.dart';
import '../state/machine_devices.dart';
import '../state/swarm_search.dart';
import 'desktop_chrome.dart';
import 'finger_target.dart';

/// What the Machines picker needs from the screen around it for the parts that are not rows: a
/// dialog has to be shown with the picker stepped aside, and Add Phone belongs to the workspace.
class MachinePickerHooks {
  const MachinePickerHooks({
    required this.confirm,
    required this.onHistory,
    this.onAddPhone,
    this.onApproveDevice,
  });

  /// Asks a yes/no question over the workspace (the picker steps aside while it is up).
  final DeviceConfirm confirm;

  /// Opens the account's device history.
  final VoidCallback onHistory;

  /// Opens Add Phone. Null where a phone cannot be added from here.
  final VoidCallback? onAddPhone;

  /// Approves a device that says its code aloud (a lamp, `harness login --code`). Null hides it.
  final VoidCallback? onApproveDevice;
}

/// The top of the Machines picker: which computer's tabs this window shows, and what the account's
/// device list needs looked at (a list that froze, a device refused, the devices already on the
/// account when this one joined, apps nobody has used in months).
class MachinePickerHeader extends StatelessWidget {
  const MachinePickerHeader({
    super.key,
    required this.search,
    required this.hooks,
  });

  final SwarmSearchController search;
  final MachinePickerHooks hooks;

  @override
  Widget build(BuildContext context) {
    final devices = search.machineDevices;
    return ListenableBuilder(
      listenable: Listenable.merge([search.app, ?devices]),
      builder: (context, _) {
        grid.AppTheme.watch(context);
        return Padding(
          padding: const EdgeInsets.fromLTRB(24, 0, 20, 10),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              MachineWindowChoice(app: search.app),
              if (devices != null)
                _DeviceNotices(devices: devices, hooks: hooks),
            ],
          ),
        );
      },
    );
  }
}

/// Show in this window: every tab on the account, or only the tabs of one computer. One sign-in,
/// several computers — the account's desk still holds every tab; this window draws all of them, or
/// those whose agents all run on the computer chosen here.
class MachineWindowChoice extends StatelessWidget {
  const MachineWindowChoice({super.key, required this.app});

  final AppNotifier app;

  /// Why [machine] cannot be chosen right now, or null when it can: this window has no live
  /// connection to it, it has to be linked again, or it reports itself offline.
  String? _unavailable(Machine machine) {
    final state = app.stateOf(machine.machineId);
    if (state == null || state.needsLink) return 'Not connected';
    if (state.nodeOnline == false) return 'Offline';
    if (state.connectionStatus != ConnectionStatus.connected) {
      return 'Not connected';
    }
    return null;
  }

  @override
  Widget build(BuildContext context) {
    final selected = app.machineProfileId;
    final localId = app.localMachineState?.machine.machineId;
    final machines = app.machines;
    final names = <String, int>{};
    for (final machine in machines) {
      names[machine.displayName] = (names[machine.displayName] ?? 0) + 1;
    }
    String short(String id) => id.length > 8 ? id.substring(0, 8) : id;
    final options = <SelectOption<String?>>[
      const SelectOption<String?>(
        value: null,
        label: 'All machines',
        detail: 'Every tab on this account, whichever computer it runs on.',
      ),
      for (final machine in machines)
        // A computer this window cannot reach has no live tabs to narrow down to, so it cannot be
        // chosen until it is back. One already chosen stays shown.
        if (_unavailable(machine) == null || selected == machine.machineId)
          SelectOption<String?>(
            value: machine.machineId,
            label: machine.displayName,
            note: [
              if (machine.machineId == localId) 'This computer',
              if ((names[machine.displayName] ?? 0) > 1)
                short(machine.machineId),
              ?_unavailable(machine),
            ].join(' · '),
            detail: machine.machineId == localId
                ? 'Tabs whose agents are all here.'
                : 'Tabs whose agents are all there.',
          ),
    ];
    return Wrap(
      key: const Key('machine-window-choice'),
      crossAxisAlignment: WrapCrossAlignment.center,
      spacing: 10,
      runSpacing: 6,
      children: [
        Text('Show in this window', style: DesktopChrome.metadata()),
        SizedBox(
          width: 240,
          child: fingerTarget(
            enabled: workspaceIsCompact(context),
            AppSelectField<String?>(
              key: const Key('machine-window-choice-field'),
              semanticLabel: 'Show in this window',
              value: selected,
              options: options,
              onChanged: (id) {
                if (id != null &&
                    id != selected &&
                    machines
                        .where((m) => m.machineId == id)
                        .any((m) => _unavailable(m) != null)) {
                  return;
                }
                app.setMachineProfile(id);
              },
            ),
          ),
        ),
      ],
    );
  }
}

/// A line the device list asks to be read, tinted like the device bands above the workspace, with
/// the one button that answers it.
class _Notice extends StatelessWidget {
  const _Notice({
    required this.text,
    this.textKey,
    this.children = const [],
    this.action,
  });

  final String text;
  final Key? textKey;
  final List<String> children;
  final Widget? action;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(top: 8),
    child: DecoratedBox(
      decoration: BoxDecoration(
        color: grid.AppPalette.warn.withValues(alpha: 0.10),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: grid.AppPalette.warn.withValues(alpha: 0.28)),
      ),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(12, 8, 8, 8),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    text,
                    key: textKey,
                    style: DesktopChrome.metadata(
                      color: DesktopChrome.foreground,
                    ),
                  ),
                  for (final line in children)
                    Text(line, style: DesktopChrome.metadata()),
                ],
              ),
            ),
            if (action case final action?) ...[
              const SizedBox(width: 10),
              action,
            ],
          ],
        ),
      ),
    ),
  );
}

class _DeviceNotices extends StatelessWidget {
  const _DeviceNotices({required this.devices, required this.hooks});

  final MachineDevices devices;
  final MachinePickerHooks hooks;

  @override
  Widget build(BuildContext context) {
    final list = devices.devices;
    final unused = devices.unused();
    final notices = <Widget>[
      if (list != null && list.frozen)
        _Notice(
          textKey: const Key('account-devices-frozen'),
          text:
              'The device list froze on ${list.frozenReason != null ? 'this device' : list.frozenPeers.join(', ')}: '
              'Harness served a list that does not match what was verified before. No device is added '
              'until you review it.',
          action: list.frozenReason == null
              ? null
              : DesktopPill(
                  key: const Key('account-devices-review'),
                  label: 'Review…',
                  compact: true,
                  onPressed: () => unawaited(devices.trustAgain(hooks.confirm)),
                ),
        ),
      if (list?.registerError case final code?)
        _Notice(
          textKey: const Key('account-devices-refused'),
          text: registerRefusalSentence(code),
        ),
      if (devices.baselineShowing)
        _Notice(
          textKey: const Key('account-devices-baseline'),
          text: 'Already on your account: these were on it before this device joined. If one isn’t yours, remove it.',
          children: [
            for (final d in list!.baseline)
              '${d.label.trim().isEmpty ? 'A device' : d.label.trim()} · ${d.isMachine ? 'Computer' : 'App'} · ${d.fingerprint}',
          ],
          action: DesktopPill(
            key: const Key('account-devices-baseline-gotit'),
            label: 'Got it',
            compact: true,
            onPressed: () => unawaited(devices.gotIt()),
          ),
        ),
      if (unused.isNotEmpty)
        _Notice(
          textKey: const Key('account-devices-unused'),
          text:
              '${unused.length} app${unused.length == 1 ? '' : 's'} not used in 90 days. Most likely a '
              'browser whose data was cleared; removing them changes nothing you use.',
          action: DesktopPill(
            key: const Key('account-devices-remove-unused'),
            label: devices.removingUnused ? 'Removing…' : 'Remove them',
            compact: true,
            onPressed: devices.removingUnused
                ? null
                : () => unawaited(devices.removeUnused(hooks.confirm)),
          ),
        ),
      if (devices.error case final error?)
        Padding(
          padding: const EdgeInsets.only(top: 8),
          child: Semantics(
            liveRegion: true,
            child: Text(
              error,
              key: const Key('account-devices-error'),
              style: DesktopChrome.metadata(
                color: devices.errorIsNotice
                    ? grid.AppPalette.warn
                    : Theme.of(context).colorScheme.error,
              ),
            ),
          ),
        ),
    ];
    if (notices.isEmpty) return const SizedBox.shrink();
    // A long baseline must not take the list's room: the notices scroll on their own.
    return ConstrainedBox(
      constraints: const BoxConstraints(maxHeight: 180),
      child: SingleChildScrollView(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: notices,
        ),
      ),
    );
  }
}

/// The bottom of the Machines picker: the ways to add to the list, and its history.
class MachinePickerFooter extends StatelessWidget {
  const MachinePickerFooter({
    super.key,
    required this.search,
    required this.hooks,
    required this.onAddMachine,
  });

  final SwarmSearchController search;
  final MachinePickerHooks hooks;
  final VoidCallback onAddMachine;

  @override
  Widget build(BuildContext context) {
    final devices = search.machineDevices;
    return ListenableBuilder(
      listenable: Listenable.merge([?devices]),
      builder: (context, _) {
        grid.AppTheme.watch(context);
        final history = devices?.devices?.historyAvailable ?? false;
        final finger = workspaceIsCompact(context);
        return Padding(
          padding: const EdgeInsets.fromLTRB(20, 10, 20, 10),
          child: Wrap(
            key: const Key('machine-picker-footer'),
            spacing: 8,
            runSpacing: 8,
            children: [
              fingerTarget(
                enabled: finger,
                DesktopPill(
                  key: const Key('machine-picker-add-machine'),
                  label: 'Add machine',
                  compact: true,
                  onPressed: onAddMachine,
                ),
              ),
              if (hooks.onAddPhone case final addPhone?)
                fingerTarget(
                  enabled: finger,
                  DesktopPill(
                    key: const Key('machine-picker-add-phone'),
                    label: 'Add phone',
                    compact: true,
                    onPressed: addPhone,
                  ),
                ),
              if (hooks.onApproveDevice case final approve?)
                fingerTarget(
                  enabled: finger,
                  DesktopPill(
                    key: const Key('machine-picker-approve-device'),
                    label: 'Approve a device',
                    compact: true,
                    tooltip:
                        'Type the code a device with no screen says aloud.',
                    onPressed: approve,
                  ),
                ),
              fingerTarget(
                enabled: finger,
                DesktopPill(
                  key: const Key('account-devices-history'),
                  label: 'History…',
                  compact: true,
                  tooltip: history || devices?.devices == null
                      ? null
                      : 'Update Harness on this computer to see history.',
                  onPressed: history ? hooks.onHistory : null,
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}
