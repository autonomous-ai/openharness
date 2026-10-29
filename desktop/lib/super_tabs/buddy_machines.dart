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
/// 10-29). An [offline] one is listed but cannot be picked.
typedef BuddyMachine = ({String id, String name, bool inSwarm, bool offline});

/// The menu's group of the reader's own machines. The picker has only its
/// headings, machine names and 'offline': no notes (Dee, 10-29).
const kBuddyOwnMachines = 'Your machines';

/// Why a row cannot be picked, as the sidebar says a Buddy is 'not started'.
const kBuddyMachineOffline = 'offline';

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
      offline: app?.stateOf(id)?.isOffline ?? false,
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
    );
  }
  final all = byId.values.toList();
  int rank(BuddyMachine m) => m.id == here ? 0 : (m.offline ? 2 : 1);
  // A stable sort: within a rank, the Swarm's order, then the account's.
  return [
    for (final r in [0, 1, 2]) ...all.where((m) => rank(m) == r),
  ];
}

/// The machine of [machines] that [chosen] names while it is online, else the
/// first online one; null when none is.
BuddyMachine? pickedBuddyMachine(List<BuddyMachine> machines, String? chosen) =>
    machines.where((m) => m.id == chosen && !m.offline).firstOrNull ??
    machines.where((m) => !m.offline).firstOrNull;

/// The Machine field of the Buddy pickers: the reader's machines under a
/// heading that says who can read the chat, offline ones listed with why
/// they cannot be picked. Built as the Add machine form's picker is, since a
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

  Widget _heading(double width) => SizedBox(
    width: width,
    child: Padding(
      padding: EdgeInsets.fromLTRB(
        AppMenuRowMetrics.roomy.padding.left + 6,
        6,
        AppMenuRowMetrics.roomy.padding.right + 6,
        2,
      ),
      child: Semantics(
        header: true,
        child: Text(
          kBuddyOwnMachines,
          style: DesktopChrome.control(medium: true),
        ),
      ),
    ),
  );

  Widget _row(BuddyMachine m, double width, String? focusId) => Padding(
    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
    child: SizedBox(
      width: width - 12,
      child: MenuItemButton(
        key: ValueKey('super-buddy-machine-option-${m.id}'),
        autofocus: m.id == focusId,
        overflowAxis: Axis.vertical,
        semanticsLabel: [
          m.name,
          if (m.offline) kBuddyMachineOffline,
        ].join(', '),
        style: ButtonStyle(
          side: const WidgetStatePropertyAll(BorderSide.none),
          padding: WidgetStatePropertyAll(AppMenuRowMetrics.roomy.padding),
        ),
        onPressed: widget.busy || m.offline
            ? null
            : () => widget.onChanged(m.id),
        // In words, never by its grey alone (design system, Color and state).
        trailingIcon: m.offline
            ? Text(
                kBuddyMachineOffline,
                style: DesktopChrome.metadata(color: DesktopChrome.muted),
              )
            : m.id == widget.value
            ? const Icon(AppIcons.check, size: grid.AppControl.iconSize)
            : null,
        child: Text(m.name, maxLines: 1, overflow: TextOverflow.ellipsis),
      ),
    ),
  );

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final current = widget.machines
        .where((m) => m.id == widget.value)
        .firstOrNull;
    final focusId =
        current?.id ?? widget.machines.where((m) => !m.offline).firstOrNull?.id;
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
        return MenuAnchor(
          controller: _menu,
          childFocusNode: _focus,
          consumeOutsideTap: true,
          alignmentOffset: const Offset(0, grid.AppControl.menuGap),
          style: grid.AppMenu.style(minWidth: menuWidth, maxWidth: menuWidth),
          onOpen: () => setState(() {}),
          onClose: () => setState(() {}),
          menuChildren: [
            _heading(menuWidth),
            for (final m in widget.machines) _row(m, menuWidth, focusId),
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

/// Harness cannot yet tell a Buddy's window from another agent's on Windows
/// (security review of #2093): the server says the same (backend machines.ts).
const kBuddyWindows =
    'A Buddy cannot run on a Windows machine yet. Pick one of your Macs or '
    'Linux machines.';

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
      // The server checks again once the machine reports; asked here first so
      // nothing is prepared there for nothing. An unreadable answer refuses
      // nothing.
      final os = await app
          .readMachineResources(machine.id)
          .then((r) => r?.os, onError: (_) => null);
      if (os != null && os.toLowerCase().contains('windows')) {
        return (id: null, setup: null, error: kBuddyWindows);
      }
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
/// Buddy now: none is signed in to their account, or all are offline.
const kBuddyNoMachine =
    'Your Buddy runs on one of your own computers. Open Harness on one, '
    'signed in to your account.';
const kBuddyAllOffline =
    'Your machines are offline. Open Harness on one of them to start your '
    'Buddy there.';

/// [kBuddyNoMachine] or, with machines listed, [kBuddyAllOffline].
class BuddyNoMachine extends StatelessWidget {
  const BuddyNoMachine({super.key, required this.machines});
  final List<BuddyMachine> machines;

  @override
  Widget build(BuildContext context) => Text(
    machines.isEmpty ? kBuddyNoMachine : kBuddyAllOffline,
    key: const ValueKey('super-buddy-no-machine'),
    style: DesktopChrome.metadata(),
  );
}
