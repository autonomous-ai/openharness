import 'dart:async';

import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../shared/widgets/app_icon_button.dart';
import '../shared/widgets/app_menu.dart';
import '../shared/widgets/app_select_field.dart';
import '../state/app_state.dart';
import '../widgets/desktop_chrome.dart';
import 'buddies.dart';
import 'buddy_restart.dart';
import 'buddy_machines.dart';
import 'controller.dart';
import 'dialog_scope.dart';
import 'model.dart';

/// Actions for the Buddy selected in the conversation row.
class SuperTabBuddyMenu extends StatelessWidget {
  const SuperTabBuddyMenu({
    super.key,
    required this.controller,
    this.app,
    this.onOpenTerminal,
  });
  final SuperTabController controller;
  final AppNotifier? app;
  final ValueChanged<SuperTabAgent>? onOpenTerminal;

  @override
  Widget build(BuildContext context) {
    final buddies = controller.buddies(
      controller.oneBuddy ? '' : (controller.selected?.projectId ?? ''),
    );
    final shown = buddies
        .where((b) => b.id == controller.selectedId)
        .firstOrNull;
    final agent = shown == null
        ? null
        : controller.snapshot?.agents
              .where((a) => shown.agentIds.contains(a.id) && a.isMainBuddy)
              .firstOrNull;
    final openTerminal =
        agent != null && agent.harnessId.isNotEmpty && onOpenTerminal != null
        ? () => onOpenTerminal!(agent)
        : null;
    return shown == null
        ? const SizedBox.shrink()
        : Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    _name(controller, shown),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: DesktopChrome.control(),
                  ),
                ),
                TextButton.icon(
                  key: const ValueKey('super-buddy-open-terminal'),
                  onPressed: openTerminal,
                  icon: const Icon(AppIcons.terminal, size: 16),
                  label: const Text('Open terminal'),
                ),
                _menu(
                  context,
                  shown,
                  isDefault: shown.id == buddies.first.id,
                  openTerminal: openTerminal,
                ),
              ],
            ),
          );
  }

  static String _name(SuperTabController c, SuperTabConversation buddy) =>
      buddy.buddyName ?? buddy.title;

  Widget _menu(
    BuildContext context,
    SuperTabConversation buddy, {
    required bool isDefault,
    VoidCallback? openTerminal,
  }) {
    final c = controller;
    const key = SuperTabController.kSwarmBuddyKey;
    return AppDropdown(
      width: 220,
      consumeOutsideTap: false,
      alignmentOffset: Offset.zero,
      children: [
        AppMenuItem(
          key: const ValueKey('super-buddy-menu-terminal'),
          label: 'Open terminal',
          onPressed: openTerminal,
        ),
        if (!isDefault)
          AppMenuItem(
            key: const ValueKey('super-buddy-make-default'),
            label: 'Make default',
            onPressed: () => unawaited(c.setDefaultBuddy(buddy.id)),
          ),
        AppMenuItem(
          key: const ValueKey('super-buddy-rename'),
          label: 'Rename…',
          onPressed: () => unawaited(
            showRenameBuddy(context, c, key, conversationId: buddy.id),
          ),
        ),
        AppMenuItem(
          key: const ValueKey('super-buddy-restart'),
          label: 'Restart…',
          onPressed: () => unawaited(
            showRestartBuddy(
              context,
              c,
              key,
              conversationId: buddy.id,
              app: app,
            ),
          ),
        ),
        AppMenuItem(
          key: const ValueKey('super-buddy-remove'),
          label: 'Remove…',
          onPressed: () => unawaited(
            confirmRemoveBuddy(context, c, key, conversationId: buddy.id),
          ),
        ),
      ],
      builder: (context, menu, _) => AppIconButton(
        key: const ValueKey('super-buddy-menu'),
        tooltip: '${_name(c, buddy)} options',
        icon: AppIcons.ellipsis,
        onPressed: () => menu.isOpen ? menu.close() : menu.open(),
      ),
    );
  }
}

/// + New Buddy (#3818): its name and the reader's machine it runs on; Claude, as every Buddy. The server refuses one
/// past the Swarm's cap (BUDDY_CAP), said in the form.
Future<void> showNewBuddy(
  BuildContext context,
  SuperTabController c, {
  AppNotifier? app,
}) => showAppDialog<void>(
  context: context,
  builder: (context) => SuperTabDialogScope(
    controller: c,
    child: _NewBuddyDialog(controller: c, app: app),
  ),
);

class _NewBuddyDialog extends StatefulWidget {
  const _NewBuddyDialog({required this.controller, this.app});
  final SuperTabController controller;
  final AppNotifier? app;

  @override
  State<_NewBuddyDialog> createState() => _NewBuddyDialogState();
}

class _NewBuddyDialogState extends State<_NewBuddyDialog> {
  SuperTabController get c => widget.controller;

  /// The backend's limit on a Buddy's name.
  static const _maxLength = 32;
  final _name = TextEditingController();
  String? _machine;
  bool _busy = false;
  String? _error;
  late final _adder = BuddyMachineAdder(widget.controller, widget.app);

  List<BuddyMachine> get _machines => buddyMachines(c, app: widget.app);
  BuddyMachine? get _picked => pickedBuddyMachine(_machines, _machine);

  @override
  void initState() {
    super.initState();
    _machine = _machines.firstOrNull?.id;
    _name.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final machine = _picked, name = _name.text.trim();
    if (_busy || machine == null || name.isEmpty) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    final (:id, :setup, error: addError) = await _adder.resolve(
      machine,
      alive: () => mounted,
    );
    if (!mounted) return;
    if (id == null) {
      setState(() {
        _busy = false;
        _error = addError;
      });
      return;
    }
    final added = await c.addBuddy(
      projectId: SuperTabController.kSwarmBuddyKey,
      machineId: id,
      engine: 'claude',
      setup: setup,
      name: name,
    );
    if (added && setup != null) unawaited(widget.app?.wakeSuperTabHost(id));
    if (!mounted) return;
    if (added) {
      Navigator.pop(context);
      return;
    }
    setState(() {
      _busy = false;
      _error = c.operationError ?? 'Could not add the Buddy. Try again.';
    });
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final machines = _machines;
    final ready = !_busy && _picked != null && _name.text.trim().isNotEmpty;
    return AlertDialog(
      title: const Text('New Buddy'),
      content: SizedBox(
        width: 440,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'One Buddy per purpose, each with its own chat and memory: '
                'Code, Research, Planning.',
                style: DesktopChrome.text(),
              ),
              const SizedBox(height: grid.AppDesktop.controlGap),
              TextField(
                key: const ValueKey('super-buddy-new-name'),
                controller: _name,
                autofocus: true,
                enabled: !_busy,
                maxLength: _maxLength,
                decoration: const InputDecoration(
                  labelText: 'Name',
                  counterText: '',
                ),
                onSubmitted: (_) => unawaited(_submit()),
              ),
              const SizedBox(height: grid.AppDesktop.controlGap),
              if (machines.isEmpty)
                Text(kBuddyNoMachine, style: DesktopChrome.metadata())
              else
                AppSelectField<String>(
                  key: const ValueKey('super-buddy-new-machine'),
                  value: _picked?.id ?? '',
                  semanticLabel: 'Machine',
                  textStyle: DesktopChrome.control(),
                  options: [
                    for (final m in machines)
                      SelectOption(value: m.id, label: m.name),
                  ],
                  onChanged: (value) {
                    if (!_busy) setState(() => _machine = value);
                  },
                ),
              if (_error case final error?) ...[
                const SizedBox(height: grid.AppDesktop.controlGap),
                Text(
                  error,
                  key: const ValueKey('super-buddy-new-error'),
                  style: DesktopChrome.control(),
                ),
              ],
            ],
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: _busy ? null : () => Navigator.pop(context),
          child: const Text('Cancel'),
        ),
        FilledButton(
          key: const ValueKey('super-buddy-new-add'),
          onPressed: ready ? () => unawaited(_submit()) : null,
          child: Text(_busy ? 'Adding…' : 'Add Buddy'),
        ),
      ],
    );
  }
}
