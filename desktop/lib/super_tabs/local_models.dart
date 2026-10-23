import 'dart:async';

import 'package:flutter/material.dart';

import '../models/model_search_catalog.dart';
import '../models/swarm_models_target.dart';
import '../shared/theme/app_icons.dart';
import '../shared/widgets/app_dialog.dart';
import '../state/app_state.dart';
import '../state/swarm_navigation.dart';
import '../state/swarm_search.dart';
import '../widgets/desktop_chrome.dart';
import '../widgets/swarm_resource_preview.dart';
import '../widgets/swarm_switcher.dart';
import 'controller.dart';
import 'dialog_scope.dart';
import 'identity.dart';
import 'model.dart';

/// The Swarm's Local models (docs/plans/2026-10-23-swarm-local-models.md): the owner's switch for the add-on, off until
/// they turn it on since it is the only thing here that asks grid for anything, and, once it is ready, the Models picker
/// of ⌘I made for the Swarm ([SwarmModelsTarget]): your models to run for it, models to get, your APIs to share with it,
/// and the models shared with you that agents on your machines can use.
Future<void> showSwarmLocalModels(
  BuildContext context,
  SuperTabController c, {
  AppNotifier? app,
  DateTime Function() now = DateTime.now,
}) => showAppDialog<void>(
  context: context,
  builder: (context) => SuperTabDialogScope(
    controller: c,
    requireWrite: false,
    child: _SwarmModelsWindow(controller: c, app: app, now: now),
  ),
);

class _SwarmModelsWindow extends StatelessWidget {
  const _SwarmModelsWindow({
    required this.controller,
    required this.app,
    required this.now,
  });

  final SuperTabController controller;
  final AppNotifier? app;
  final DateTime Function() now;

  @override
  Widget build(BuildContext context) {
    final c = controller;
    final size = MediaQuery.sizeOf(context);
    return ListenableBuilder(
      listenable: c,
      builder: (context, _) {
        final local = c.snapshot?.localModels;
        final on = local?.enabled == true;
        final picker = on && local?.ready == true && app != null;
        final served = [
          if (local != null)
            for (final pool in c.snapshot?.machines ?? const [])
              for (final m in superTabServedModels(
                pool,
                local.grid,
                now: now(),
              ))
                '${m.name} on ${superTabMachineName(pool['name'] as String? ?? 'a machine')}',
        ];
        final header = Padding(
          padding: const EdgeInsets.fromLTRB(24, 20, 16, 12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text(
                      'Local models',
                      style: DesktopChrome.text(size: 15, medium: true),
                    ),
                  ),
                  Text('Use local models', style: DesktopChrome.control()),
                  const SizedBox(width: 8),
                  Switch(
                    key: const ValueKey('super-local-models-switch'),
                    value: on,
                    onChanged: !c.isOwner || !c.canWrite || c.saving
                        ? null
                        : (value) => unawaited(
                            c.command({
                              'type': 'localModels.set',
                              'enabled': value,
                            }),
                          ),
                  ),
                  const SizedBox(width: 4),
                  IconButton(
                    key: const ValueKey('super-local-models-close'),
                    tooltip: 'Close',
                    icon: const Icon(Icons.close, size: 18),
                    onPressed: () => Navigator.pop(context),
                  ),
                ],
              ),
              const SizedBox(height: 4),
              Text(
                'People in this Swarm can run AI models on their own machines and share their APIs. '
                'The product manager can give simple tasks to them, at no subscription cost.',
                style: DesktopChrome.text(),
              ),
              const SizedBox(height: 8),
              Text(
                key: const ValueKey('super-local-models-status'),
                _status(local, owner: c.isOwner),
                style: DesktopChrome.metadata(
                  color: on && local?.ready == false
                      ? Theme.of(context).colorScheme.error
                      : null,
                ),
              ),
              if (on && served.isNotEmpty) ...[
                const SizedBox(height: 4),
                Text(
                  key: const ValueKey('super-local-models-running'),
                  'Running now: ${served.join(', ')}',
                  style: DesktopChrome.metadata(),
                ),
              ],
            ],
          ),
        );
        // The ⌘I picker's look: its rows and preview read [DesktopChrome] to draw as the desktop app, not a terminal.
        return Dialog(
          clipBehavior: Clip.antiAlias,
          child: DesktopChrome(
            child: SizedBox(
              width: picker ? (size.width - 80).clamp(360, 1120) : 480,
              height: picker ? (size.height - 80).clamp(360, 720) : null,
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  header,
                  if (picker) ...[
                    Divider(height: 1, color: DesktopChrome.rim),
                    Expanded(
                      child: _SwarmModelsPicker(app: app!, grid: local!.grid),
                    ),
                  ] else
                    const SizedBox(height: 12),
                ],
              ),
            ),
          ),
        );
      },
    );
  }
}

/// ⌘I's Models list and preview, for the Swarm whose grid is [grid].
class _SwarmModelsPicker extends StatefulWidget {
  const _SwarmModelsPicker({required this.app, required this.grid});

  final AppNotifier app;
  final String grid;

  @override
  State<_SwarmModelsPicker> createState() => _SwarmModelsPickerState();
}

class _SwarmModelsPickerState extends State<_SwarmModelsPicker> {
  late final ModelSearchCatalog _catalog;
  late final SwarmModelsTarget _target;
  late final SwarmSearchController _search;
  final _editing = TextEditingController();
  final _focus = FocusNode();
  final _controls = SearchPreviewControls();

  @override
  void initState() {
    super.initState();
    final app = widget.app;
    app.modelManager.start();
    app.modelManager.setPanelVisible(true);
    _catalog = ModelSearchCatalog(app.modelManager, app.modelsMenu)
      ..setVisible(true);
    _target = SwarmModelsTarget(
      app: app,
      grid: widget.grid,
      machineId: app.modelManager.machine?.machine.machineId ?? '',
    );
    unawaited(_target.refresh());
    // `adding`/`offersCreate`: the APIs section ends in Add API connection, as ⌘I's does.
    _search = SwarmSearchController(
      app,
      const [],
      models: _catalog,
      swarmModels: _target,
      adding: true,
      offersCreate: true,
    )..setQuery(':');
  }

  @override
  void dispose() {
    widget.app.modelManager.setPanelVisible(false);
    _search.dispose();
    _catalog.dispose();
    _target.dispose();
    _controls.dispose();
    _editing.dispose();
    _focus.dispose();
    super.dispose();
  }

  /// What ⌘I does with a chosen row here: Add API connection opens the add form in the preview, beside it. Every
  /// other row acts from its preview's button ([SwarmSearchController.swarmModelAction]).
  void _choose(SwarmSearchSelection? choice) {
    final row = choice?.destination;
    if (row == null || !row.isCreate) return;
    final index = _search.rows.indexWhere((r) => r.id == row.id);
    if (index >= 0) _search.move(index - _search.cursor);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _controls.invoke('picker.resource_add_api');
    });
  }

  void _query(String words) =>
      _search.setQuery(words.trim().isEmpty ? ':' : ': ${words.trim()}');

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(24, 12, 16, 8),
          child: Row(
            children: [
              Icon(AppIcons.search, size: 18, color: DesktopChrome.muted),
              const SizedBox(width: 12),
              Expanded(
                child: TextField(
                  key: const ValueKey('super-local-models-search'),
                  controller: _editing,
                  focusNode: _focus,
                  autofocus: true,
                  onChanged: _query,
                  onSubmitted: (_) {
                    _choose(_search.submit());
                    _focus.requestFocus();
                  },
                  decoration: const InputDecoration.collapsed(
                    hintText: 'Search models',
                  ),
                  style: DesktopChrome.text(),
                ),
              ),
            ],
          ),
        ),
        Expanded(
          child: ListenableBuilder(
            listenable: Listenable.merge([_search, _target]),
            builder: (context, _) => SwarmSearchResults(
              search: _search,
              onChoose: _choose,
              onRefocus: _focus.requestFocus,
              sideBySideMinWidth: 700,
              previewBuilder: () => SwarmResourcePreview(
                search: _search,
                controls: _controls,
                onChoose: _choose,
                onRefocus: _focus.requestFocus,
                onModalChanged: (_) {},
                onCommands: () {},
              ),
            ),
          ),
        ),
      ],
    );
  }
}

String _status(SuperTabLocalModels? local, {required bool owner}) {
  if (local == null || !local.enabled) {
    return owner
        ? 'Off. Only you can turn it on.'
        : 'Off. The Swarm owner can turn it on.';
  }
  return switch (local.ready) {
    true =>
      'On. Run your models for the Swarm, or share an API with it, below.',
    false =>
      'Could not finish setting up: ${_sentence(local.error ?? 'try again later')}',
    null =>
      owner
          ? 'Setting up. Keep Harness open on one of your computers for a minute.'
          : 'Setting up on the owner\'s computer.',
  };
}

/// [text] as a sentence: grid's own words often end without a full stop.
String _sentence(String text) {
  final t = text.trim();
  return RegExp(r'[.!?]$').hasMatch(t) ? t : '$t.';
}

/// The Local models part of a machine's details: what it runs for the Swarm, and on the viewer's own machine, a way to
/// run or stop one.
class SuperTabMachineLocalModels extends StatelessWidget {
  const SuperTabMachineLocalModels({
    super.key,
    required this.controller,
    required this.machineId,
    required this.mine,
    this.app,
    this.now = DateTime.now,
  });

  final SuperTabController controller;
  final String machineId;

  /// The viewer's own machine, which their window can reach: only they start a model on it.
  final bool mine;
  final AppNotifier? app;
  final DateTime Function() now;

  @override
  Widget build(BuildContext context) {
    final local = controller.snapshot?.localModels;
    if (local == null || !local.enabled) return const SizedBox.shrink();
    final pool = controller.snapshot?.machines
        .where((m) => m['machineId'] == machineId)
        .firstOrNull;
    final served = superTabServedModels(pool, local.grid, now: now());
    return Padding(
      key: ValueKey('super-machine-local-models-$machineId'),
      padding: const EdgeInsets.only(top: 24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text('Local models', style: DesktopChrome.control(medium: true)),
          const SizedBox(height: 8),
          Text(
            served.isEmpty
                ? 'Not running a model for this Swarm.'
                : 'Running ${served.map((m) => m.name).join(', ')} for this Swarm.',
            style: DesktopChrome.control(),
          ),
          if (mine && app != null) ...[
            const SizedBox(height: 8),
            Align(
              alignment: Alignment.centerLeft,
              child: OutlinedButton(
                key: const ValueKey('super-machine-local-models-run'),
                onPressed: () => unawaited(
                  showSwarmLocalModels(context, controller, app: app, now: now),
                ),
                child: const Text('Run a local model…'),
              ),
            ),
          ],
        ],
      ),
    );
  }
}
