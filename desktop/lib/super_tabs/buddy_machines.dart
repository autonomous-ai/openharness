import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_menu.dart';
import '../shared/widgets/app_select_field.dart';
import '../state/app_state.dart';
import '../widgets/desktop_chrome.dart';
import 'controller.dart';
import 'identity.dart';
import 'machines.dart';

/// A machine a Buddy may run on, as the pickers list it: one of the reader's
/// own. One outside the Swarm ([inSwarm] false) stays theirs: the server
/// records it for their Buddies alone and never adds it to the Swarm (Dee,
/// 10-29). An [offline] one, or one [paused] in the Swarm, is listed but cannot
/// be picked: the server refuses new work there (backend machines.ts).
typedef BuddyMachine = ({
  String id,
  String name,
  bool inSwarm,
  bool offline,
  bool paused,
});

/// The menu's group of the reader's own machines. The picker has only its
/// headings, machine names and 'offline': no notes (Dee, 10-29).
const kBuddyOwnMachines = 'Your machines';

/// Why a row cannot be picked, as the sidebar says a Buddy is 'not started'.
const kBuddyMachineOffline = 'offline';
const kBuddyMachinePaused = 'paused';

/// Why [m] cannot be picked in words, or null when it can.
String? buddyMachineBlock(BuddyMachine m) => m.offline
    ? kBuddyMachineOffline
    : m.paused
    ? kBuddyMachinePaused
    : null;

/// The reader's own machines a Buddy may run on, like a Lead, whatever its
/// engine (Ken, 10-28): those signed in to their account, in the Swarm or not,
/// and those of theirs the Swarm lists. Never a machine someone shared with
/// them, nor a Harness Team account; the backend refuses any other. Each by
/// the name its person gave it. With [app], the Mac running Harness comes
/// first, then the online machines, then the offline ones.
List<BuddyMachine> buddyMachines(SuperTabController c, {AppNotifier? app}) {
  final byId = <String, BuddyMachine>{};
  for (final m in c.snapshot?.machines ?? const <Map<String, dynamic>>[]) {
    if (m['hostMachineId'] != null ||
        m['contributorId'] != c.accountId ||
        m['machineId'] is! String) {
      continue;
    }
    final id = m['machineId'] as String;
    byId[id] = (
      id: id,
      name: superTabMachineName(m['name'] as String? ?? ''),
      inSwarm: true,
      // Not in the account's list (yet): only a fresh Swarm reading says it
      // is there, else it is offline until one does (review of #2240).
      offline: app?.stateOf(id)?.isOffline ?? _silent(m),
      paused: m['paused'] == true,
    );
  }
  String? here;
  for (final s in app?.machineStates.values ?? const <MachineState>[]) {
    if (s.belongsToOtherAccount || s.machine.isTeamAccount || s.needsLink) {
      continue;
    }
    final id = s.machine.machineId;
    final listed = byId[id];
    if (s.isLocalMachine) here = id;
    // The name its person gave it, as every machine row reads (Dee, 10-29;
    // docs/naming-system.md): no "This Mac" prefix, no owner suffix.
    final given = superTabMachineName(s.machine.displayName);
    final name = given.isNotEmpty ? given : listed?.name ?? id;
    byId[id] = (
      id: id,
      name: name,
      inSwarm: listed != null,
      offline: s.isOffline,
      paused: listed?.paused ?? false,
    );
  }
  final all = byId.values.toList();
  int rank(BuddyMachine m) =>
      m.id == here ? 0 : (buddyMachineBlock(m) == null ? 1 : 2);
  // A stable sort: within a rank, the Swarm's order, then the account's.
  return [
    for (final r in [0, 1, 2]) ...all.where((m) => rank(m) == r),
  ];
}

/// The machine of [machines] that [chosen] names while it can be picked, else
/// the first that can; null when none can.
BuddyMachine? pickedBuddyMachine(List<BuddyMachine> machines, String? chosen) {
  final open = machines.where((m) => buddyMachineBlock(m) == null);
  return open.where((m) => m.id == chosen).firstOrNull ?? open.firstOrNull;
}

/// The Machine field of the Buddy pickers: the reader's machines under a
/// heading that says who can read the chat, offline and paused ones listed
/// with why they cannot be picked. Built as the Add machine form's picker is, since a
/// shared select field has no unavailable row. With [fitNames] it is as wide
/// as its longest name rather than the row.
class BuddyMachineField extends StatefulWidget {
  const BuddyMachineField({
    super.key,
    required this.machines,
    required this.value,
    required this.onChanged,
    this.busy = false,
    this.fitNames = false,
  });
  final List<BuddyMachine> machines;
  final String? value;
  final ValueChanged<String> onChanged;
  final bool busy;
  final bool fitNames;

  /// Wide enough for a long machine name and its state on one line.
  static const menuMinWidth = 260.0;

  @override
  State<BuddyMachineField> createState() => _BuddyMachineFieldState();
}

class _BuddyMachineFieldState extends State<BuddyMachineField> {
  final _menu = MenuController();
  final _focus = FocusNode(debugLabel: 'Machine');

  @override
  void dispose() {
    _focus.dispose();
    super.dispose();
  }

  void _open() {
    if (!widget.busy) _menu.open();
  }

  Widget _heading() => Padding(
    padding: EdgeInsets.fromLTRB(
      AppMenuRowMetrics.compact.padding.left + grid.AppDesktop.menuInset,
      grid.AppDesktop.menuInset,
      AppMenuRowMetrics.compact.padding.right + grid.AppDesktop.menuInset,
      grid.AppDesktop.listRowGap,
    ),
    child: Semantics(
      header: true,
      child: Text(
        kBuddyOwnMachines,
        style: DesktopChrome.control(medium: true),
      ),
    ),
  );

  Widget _row(BuddyMachine m, String? focusId) {
    final block = buddyMachineBlock(m);
    final choose = widget.busy || block != null
        ? null
        : () => widget.onChanged(m.id);
    return Semantics(
      button: true,
      enabled: choose != null,
      selected: m.id == widget.value,
      onTap: choose,
      label: [m.name, ?block].join(', '),
      excludeSemantics: true,
      child: AppMenuItem(
        key: ValueKey('super-buddy-machine-option-${m.id}'),
        autofocus: m.id == focusId,
        leadingSlot: false,
        label: m.name,
        selected: block == null && m.id == widget.value,
        // In words, never by its grey alone (design system, Color and state).
        trailing: block == null
            ? null
            : Text(
                block,
                style: DesktopChrome.metadata(color: DesktopChrome.muted),
              ),
        onPressed: choose,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final current = widget.machines
        .where((m) => m.id == widget.value)
        .firstOrNull;
    final focusId =
        current?.id ??
        widget.machines
            .where((m) => buddyMachineBlock(m) == null)
            .firstOrNull
            ?.id;
    final label = current?.name ?? 'Choose a machine';
    final style = DesktopChrome.control();
    final fitted = widget.fitNames
        ? AppSelectField.fitWidth(
                context,
                labels: [for (final m in widget.machines) m.name],
                textStyle: style,
              ) +
              grid.AppControl.iconSize
        : null;
    final field = LayoutBuilder(
      builder: (context, constraints) {
        final width = fitted ?? constraints.maxWidth;
        final menuWidth = width < BuddyMachineField.menuMinWidth
            ? BuddyMachineField.menuMinWidth
            : width;
        return AppDropdown(
          controller: _menu,
          childFocusNode: _focus,
          width: menuWidth,
          onOpen: () => setState(() {}),
          onClose: () => setState(() {}),
          children: [
            _heading(),
            for (final m in widget.machines) _row(m, focusId),
          ],
          builder: (context, menu, _) => CallbackShortcuts(
            bindings: {
              const SingleActivator(LogicalKeyboardKey.arrowDown): _open,
              const SingleActivator(LogicalKeyboardKey.arrowUp): _open,
            },
            child: Semantics(
              label: 'Machine',
              value: label,
              expanded: menu.isOpen,
              child: SizedBox(
                width: width,
                child: TextButton(
                  focusNode: _focus,
                  style: TextButton.styleFrom(
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(
                        grid.AppControl.radius,
                      ),
                    ),
                  ),
                  onPressed: widget.busy
                      ? null
                      : () => menu.isOpen ? menu.close() : _open(),
                  child: ExcludeSemantics(
                    child: Row(
                      children: [
                        Expanded(
                          child: Tooltip(
                            message: label,
                            excludeFromSemantics: true,
                            child: Text(
                              label,
                              style: style,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                            ),
                          ),
                        ),
                        const SizedBox(width: 8),
                        const Icon(
                          AppIcons.chevronDown,
                          size: grid.AppControl.iconSize,
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
        );
      },
    );
    return fitted == null ? field : SizedBox(width: fitted, child: field);
  }
}

/// Why nothing started when the reader's write access ended while their
/// machine was being prepared.
const kBuddyAccessLost = 'Your access changed, so no Buddy was added.';

/// What a Buddy's start sends, once the person has clicked Start: the picked
/// machine and, for one of theirs outside the Swarm, its setup, prepared there
/// as Add machine prepares one. Nothing is added to the Swarm. Keeps the setup
/// between tries, as that form does, so a setup still running is joined
/// rather than started again.
class BuddyMachineAdder {
  BuddyMachineAdder(this.controller, this.app);
  final SuperTabController controller;
  final AppNotifier? app;
  String? _setupId;

  /// The id to start on and its [setup]; a null id with no [error] when
  /// [alive] ended first, in which case nothing more is done for a gone dialog
  /// or bar.
  Future<({String? id, Map<String, dynamic>? setup, String? error})> resolve(
    BuddyMachine machine, {
    required bool Function() alive,
  }) async {
    final app = this.app;
    if (machine.inSwarm || app == null) {
      return (id: machine.id, setup: null, error: null);
    }
    _setupId ??= superTabOperationId();
    try {
      final setup = await prepareBuddyMachine(
        controller,
        app,
        machine.id,
        setupId: _setupId!,
        alive: alive,
      );
      _setupId = null;
      if (setup == null) {
        // Nothing was prepared though nobody gave up: write access is gone.
        return (
          id: null,
          setup: null,
          error: alive() ? kBuddyAccessLost : null,
        );
      }
      return (id: machine.id, setup: setup, error: null);
    } catch (failure) {
      if (failure is! SuperTabFailure || failure.code != 'SETUP_PENDING') {
        _setupId = null;
      }
      return (id: null, setup: null, error: failure.toString());
    }
  }
}

/// What the Buddy pickers say when none of the reader's machines can take a
/// Buddy now: none is signed in to their account, all are offline, or new work
/// is paused on those that are not.
const kBuddyNoMachine =
    'Your Buddy runs on one of your own computers. Open Harness on one, '
    'signed in to your account.';
const kBuddyAllOffline =
    'Your machines are offline. Open Harness on one of them to start your '
    'Buddy there.';
const kBuddyAllPaused =
    'New work is paused on your machines. Choose Resume new work in Machines '
    'to start your Buddy.';

/// [kBuddyNoMachine], or with machines listed [kBuddyAllPaused] when resuming
/// one would be enough, else [kBuddyAllOffline].
class BuddyNoMachine extends StatelessWidget {
  const BuddyNoMachine({super.key, required this.machines});
  final List<BuddyMachine> machines;

  @override
  Widget build(BuildContext context) => Text(
    machines.isEmpty
        ? kBuddyNoMachine
        : machines.any((m) => m.paused && !m.offline)
        ? kBuddyAllPaused
        : kBuddyAllOffline,
    key: const ValueKey('super-buddy-no-machine'),
    style: DesktopChrome.metadata(),
  );
}

/// Whether [pool]'s last reading is too old to take a Buddy now, as the
/// Machines list calls a machine offline; no reading is offline.
bool _silent(Map<String, dynamic> pool) {
  final observation = pool['observation'];
  final at = observation is Map ? observation['receivedAt'] : null;
  if (at is! num) return true;
  final age = DateTime.now().difference(
    DateTime.fromMillisecondsSinceEpoch(at.toInt()),
  );
  return superTabMachineStatus(age: age) == SuperTabMachineStatus.offline;
}
