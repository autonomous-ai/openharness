import 'package:flutter/material.dart';

import '../models/model_search_catalog.dart' show thisComputerName;
import '../shared/widgets/app_select_field.dart';
import '../state/app_state.dart';
import '../widgets/desktop_chrome.dart';
import 'controller.dart';
import 'identity.dart';
import 'machines.dart';

/// A machine a Buddy may be started on, as the pickers list it. [joins] marks
/// this Mac while it is not in the Swarm yet: starting there adds it first.
typedef BuddyMachine = ({String id, String name, bool joins});

/// What the pickers say about this Mac while [action] would add it to the
/// Swarm: `Start` in the Buddy chat's bar, `Add Buddy` in the dialog.
String buddyJoinsNote(String action) =>
    'Not in this Swarm yet: $action adds it';

/// The reader's own machines in the Swarm: a Buddy runs only there, like a
/// Lead, whatever its engine (Ken, 10-28). Not a machine the reader may use
/// but someone else owns, and not a Harness Team account. The backend refuses
/// any other. With [app], the Mac running Harness comes first: by name when it
/// is in the Swarm, else as `This Mac · NAME` when the Add machine flow would
/// take it now (Dee, 10-29).
List<BuddyMachine> buddyMachines(SuperTabController c, {AppNotifier? app}) {
  final own = [
    for (final m in c.snapshot?.machines ?? const <Map<String, dynamic>>[])
      if (m['hostMachineId'] == null &&
          m['contributorId'] == c.accountId &&
          m['machineId'] is String)
        (
          id: m['machineId'] as String,
          name: superTabMachineName(m['name'] as String? ?? ''),
          joins: false,
        ),
  ];
  final here = app?.machineStates.values
      .where((m) => m.isLocalMachine)
      .firstOrNull;
  if (app == null || here == null) return own;
  final hereId = here.machine.machineId;
  final inSwarm = own.where((m) => m.id == hereId).firstOrNull;
  if (inSwarm != null) {
    return [inSwarm, ...own.where((m) => m.id != hereId)];
  }
  // Only this account's own Mac, only while the Add machine flow takes it.
  if (thisComputerRefusal(app, c) != null) return own;
  final label = thisComputerName();
  return [
    (
      id: hereId,
      name:
          '${label[0].toUpperCase()}${label.substring(1)} · '
          '${superTabMachineName(here.machine.displayName)}',
      joins: true,
    ),
    ...own,
  ];
}

/// The machine of [machines] that [chosen] names, else the first.
BuddyMachine? pickedBuddyMachine(List<BuddyMachine> machines, String? chosen) =>
    machines.where((m) => m.id == chosen).firstOrNull ?? machines.firstOrNull;

/// The Machine field of the Buddy pickers. With [fitNames] it is as wide as
/// its longest name rather than the row. [action] is the button that adds
/// this Mac when it is picked, named in its note.
class BuddyMachineField extends StatelessWidget {
  const BuddyMachineField({
    super.key,
    required this.machines,
    required this.value,
    required this.action,
    required this.onChanged,
    this.fitNames = false,
  });
  final List<BuddyMachine> machines;
  final String value;
  final String action;
  final ValueChanged<String> onChanged;
  final bool fitNames;

  /// Wide enough for the note whole under a name, which a menu only as wide as
  /// a fitted field would cut off.
  static const _joinsMenuWidth = 320.0;

  @override
  Widget build(BuildContext context) {
    final style = DesktopChrome.control();
    return AppSelectField<String>(
      value: value,
      semanticLabel: 'Machine',
      textStyle: style,
      width: fitNames
          ? AppSelectField.fitWidth(
              context,
              labels: [for (final m in machines) m.name],
              textStyle: style,
            )
          : null,
      menuWidth: machines.any((m) => m.joins) ? _joinsMenuWidth : null,
      options: [
        for (final m in machines)
          SelectOption(
            value: m.id,
            label: m.name,
            detail: m.joins ? buddyJoinsNote(action) : null,
          ),
      ],
      onChanged: onChanged,
    );
  }
}

/// Why nothing was added when the reader's write access ended during the add.
const kBuddyAccessLost =
    'You can no longer change this Swarm, so this Mac was not added.';

/// Where a Buddy starts, once the person has clicked Start: the picked
/// machine, added to the Swarm first when it is this Mac and not in it yet.
/// Keeps the Add machine setup between tries, as that form does, so a setup
/// still running is joined rather than started again.
class BuddyMachineAdder {
  BuddyMachineAdder(this.controller, this.app);
  final SuperTabController controller;
  final AppNotifier? app;
  String? _setupId;

  /// The id of the machine to start on; null with no [error] when [alive] ended
  /// first, in which case nothing more is done for a gone dialog or bar.
  Future<({String? id, String? error})> resolve(
    BuddyMachine machine, {
    required bool Function() alive,
  }) async {
    final app = this.app;
    if (!machine.joins || app == null) return (id: machine.id, error: null);
    _setupId ??= superTabOperationId();
    try {
      final id = await contributeComputer(
        controller,
        app,
        machine.id,
        setupId: _setupId!,
        alive: alive,
      );
      _setupId = null;
      // Nothing was added though nobody gave up: write access is gone.
      if (id == null && alive()) return (id: null, error: kBuddyAccessLost);
      return (id: id, error: null);
    } catch (failure) {
      if (failure is! SuperTabFailure || failure.code != 'SETUP_PENDING') {
        _setupId = null;
      }
      return (id: null, error: failure.toString());
    }
  }
}

/// What the Buddy pickers show when none of the reader's machines can run a
/// Buddy: where to add one, and why this computer cannot be added from here.
class BuddyNoMachine extends StatelessWidget {
  const BuddyNoMachine({
    super.key,
    required this.controller,
    required this.app,
  });
  final SuperTabController controller;
  final AppNotifier? app;

  @override
  Widget build(BuildContext context) {
    final app = this.app;
    if (app == null) {
      return Text(
        'A Buddy runs on one of your own machines. Add one of yours to this '
        'Swarm first.',
        style: DesktopChrome.metadata(),
      );
    }
    return ListenableBuilder(
      listenable: app,
      builder: (context, _) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'None of your machines is in this Swarm yet.',
            style: DesktopChrome.metadata(),
          ),
          if (thisComputerRefusal(app, controller) case final refusal?)
            Text(refusal, style: DesktopChrome.metadata()),
        ],
      ),
    );
  }
}
