import 'package:flutter/material.dart';

import '../models/model_search_catalog.dart' show thisComputerName;
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_select_field.dart';
import '../state/app_state.dart';
import '../widgets/desktop_chrome.dart';
import 'controller.dart';
import 'identity.dart';
import 'machines.dart';

/// A machine a Buddy may be started on, as the pickers list it. [joins] marks
/// this Mac while it is not in the Swarm yet: starting there adds it first.
typedef BuddyMachine = ({String id, String name, bool joins});

/// What the picker says under this Mac while Start would add it.
const kBuddyJoinsNote = 'Not in this Swarm yet: Start adds it';

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
/// its longest name rather than the row.
class BuddyMachineField extends StatelessWidget {
  const BuddyMachineField({
    super.key,
    required this.machines,
    required this.value,
    required this.onChanged,
    this.fitNames = false,
  });
  final List<BuddyMachine> machines;
  final String value;
  final ValueChanged<String> onChanged;
  final bool fitNames;

  /// Padding, gap, chevron and border around the name in the closed field.
  static const _chrome = 18.0 + 6.0 + grid.AppControl.iconSize + 3.0;

  /// Wide enough for [kBuddyJoinsNote] whole under a name, which a menu only as
  /// wide as a fitted field would cut off.
  static const _joinsMenuWidth = 320.0;

  double _fieldWidth(BuildContext context, TextStyle style) {
    final scaler = MediaQuery.textScalerOf(context);
    var widest = 0.0;
    for (final m in machines) {
      final painter = TextPainter(
        text: TextSpan(text: m.name, style: style),
        textDirection: TextDirection.ltr,
        textScaler: scaler,
        maxLines: 1,
      )..layout();
      widest = widest > painter.width ? widest : painter.width;
      painter.dispose();
    }
    return widest.ceilToDouble() + _chrome;
  }

  @override
  Widget build(BuildContext context) {
    final style = DesktopChrome.control();
    return AppSelectField<String>(
      value: value,
      semanticLabel: 'Machine',
      textStyle: style,
      width: fitNames ? _fieldWidth(context, style) : null,
      menuWidth: machines.any((m) => m.joins) ? _joinsMenuWidth : null,
      options: [
        for (final m in machines)
          SelectOption(
            value: m.id,
            label: m.name,
            detail: m.joins ? kBuddyJoinsNote : null,
          ),
      ],
      onChanged: onChanged,
    );
  }
}

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
