import 'dart:async';

import 'package:flutter/material.dart';

import '../models/model_search_catalog.dart';
import '../models/swarm_models_target.dart';
import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../shared/widgets/app_icon_button.dart';
import '../state/app_state.dart';
import '../state/swarm_navigation.dart';
import '../state/swarm_search.dart';
import '../widgets/desktop_chrome.dart';
import '../widgets/key_hints.dart';
import '../widgets/swarm_resource_preview.dart';
import '../widgets/swarm_switcher.dart';
import '../ws/ws_conn.dart';
import 'controller.dart';
import 'dialog_scope.dart';
import 'model.dart';

/// The Swarm's models (docs/plans/2026-10-23-swarm-local-models.md). Until the owner sets them up there is only a
/// Set up panel, since it is the only thing here that asks grid for anything; set up, it is the Models picker of ⌘I made
/// for the Swarm ([SwarmModelsTarget]): your models to run for it, models to get, and your APIs to share with it.
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

class _SwarmModelsWindow extends StatefulWidget {
  const _SwarmModelsWindow({
    required this.controller,
    required this.app,
    required this.now,
  });

  final SuperTabController controller;
  final AppNotifier? app;
  final DateTime Function() now;

  @override
  State<_SwarmModelsWindow> createState() => _SwarmModelsWindowState();
}

class _SwarmModelsWindowState extends State<_SwarmModelsWindow> {
  /// A Set up (or Try again) under way on this computer, and why the last one failed.
  bool _settingUp = false;
  String? _error;

  /// Sets the Swarm's models up from this computer, at once: turns them on (the backend names the Swarm's grid),
  /// then has this computer's Harness set grid up — installed and signed in with the Harness account if it is not —
  /// create the grid and add the Swarm's people, and tells the Swarm how that went. The owner's computers keep the
  /// members in step afterwards (CLI `superTabs/swarmGrids.ts`).
  /// Answers the Swarm's grid once it is ready, else null ([_error] says why).
  Future<String?> _setUp() async {
    final c = widget.controller, app = widget.app;
    setState(() {
      _settingUp = true;
      _error = null;
    });
    try {
      final snapshot = c.snapshot;
      var grid = snapshot?.localModels?.enabled == true
          ? snapshot!.localModels!.grid
          : null;
      if (grid == null) {
        final result = await c.command({
          'type': 'localModels.set',
          'enabled': true,
        });
        grid = result?['grid'] as String? ?? c.snapshot?.localModels?.grid;
      }
      if (grid == null) {
        _error =
            c.operationError ?? 'The Swarm could not be reached. Try again.';
        return null;
      }
      final machineId = app?.modelManager.machine?.machine.machineId;
      if (app == null || machineId == null) {
        // Nothing here can run grid: the owner's other computers finish it in the background.
        return null;
      }
      final members = [
        for (final person in c.snapshot?.people ?? const <SuperTabPerson>[])
          if (person.role != 'viewer' && person.id != c.snapshot?.ownerId)
            person.email,
      ];
      Map<String, dynamic> answer;
      try {
        answer = await app.swarmGridSync(machineId, grid, members);
      } on WsRequestFailure catch (failure) {
        // Grid's own answer, refused: its words, not "unreachable" (2026-10-24: a plan's network limit read as this
        // computer could not be reached).
        answer = failure.payload.isNotEmpty
            ? {...failure.payload, 'ready': false}
            : {'ready': false, 'error': failure.detail ?? failure.code};
      } catch (_) {
        answer = {
          'ready': false,
          'error': 'This computer could not be reached. Try again.',
        };
      }
      final ready = answer['ready'] == true;
      final error = answer['error'] is String
          ? answer['error'] as String
          : null;
      await c.command({
        'type': 'localModels.status',
        'grid': grid,
        'ready': ready,
        if (error != null)
          'error': error.length > 500 ? error.substring(0, 500) : error,
      });
      if (!ready) {
        _error =
            error ?? 'Models could not be set up for this Swarm. Try again.';
        return null;
      }
      return grid;
    } finally {
      if (mounted) setState(() => _settingUp = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.controller, app = widget.app;
    final size = MediaQuery.sizeOf(context);
    return ListenableBuilder(
      listenable: c,
      builder: (context, _) {
        final local = c.snapshot?.localModels;
        final on = local?.enabled == true;
        // The models list whenever this computer can run models, as ⌘I's is; before the Swarm's are set up it offers
        // Set up in it, as ⌘I offers setting Grid up (owner, 2026-10-24). The panel below is for a window with no models.
        final ready = on && local?.ready == true;
        final picker = app != null;
        final String? failed = _settingUp
            ? null
            : _error ??
                  (on && local?.ready == false
                      ? local?.error ?? 'the request was refused'
                      : null);
        final header = Padding(
          padding: EdgeInsets.fromLTRB(24, 18, 16, picker ? 14 : 4),
          child: Row(
            children: [
              Expanded(
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.baseline,
                  textBaseline: TextBaseline.alphabetic,
                  children: [
                    Text(
                      'Your models',
                      style: DesktopChrome.text(
                        size: 15,
                        medium: true,
                        height: 1.35,
                      ).copyWith(fontWeight: FontWeight.w600),
                    ),
                    // The computer whose models and APIs these are, beside the title.
                    if (picker) ...[
                      const SizedBox(width: 10),
                      Flexible(
                        child: Text(
                          _capitalized(thisComputerName()),
                          key: const ValueKey('super-local-models-machine'),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: DesktopChrome.metadata(),
                        ),
                      ),
                    ],
                  ],
                ),
              ),
              AppIconButton(
                key: const ValueKey('super-local-models-close'),
                tooltip: 'Close',
                icon: AppIcons.close,
                onPressed: () => Navigator.pop(context),
              ),
            ],
          ),
        );
        // Before it is set up, and while it is being set up or has failed: one panel, as ⌘I's Set up is.
        final setup = Padding(
          padding: const EdgeInsets.fromLTRB(24, 4, 24, 20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                'Run models on your own machines for this Swarm, and share your APIs with it. '
                'Agents in this Swarm can then run on them, at no subscription cost.',
                style: DesktopChrome.text(),
              ),
              const SizedBox(height: 12),
              Text(
                key: const ValueKey('super-local-models-status'),
                _settingUp || (on && local?.ready == null)
                    ? (c.isOwner
                          ? 'Setting up… The first time can take a few minutes.'
                          : 'Being set up on the owner\'s computer.')
                    : failed != null
                    ? 'Could not set up: ${_sentence(failed)}'
                    : c.isOwner
                    ? 'Set up connects this computer to the Swarm with your Harness account. Everyone in the Swarm can then use the models you run and the APIs you share, now and as they join.'
                    : 'The Swarm owner has not set up models yet.',
                style: DesktopChrome.metadata(
                  color: failed != null
                      ? Theme.of(context).colorScheme.error
                      : null,
                ),
              ),
              if (c.isOwner) ...[
                const SizedBox(height: 16),
                Row(
                  children: [
                    FilledButton(
                      key: const ValueKey('super-local-models-setup'),
                      onPressed: _settingUp || !c.canWrite || c.saving
                          ? null
                          : () => unawaited(_setUp()),
                      child: Text(
                        _settingUp
                            ? 'Setting up…'
                            : failed != null
                            ? 'Try again'
                            : 'Set up',
                      ),
                    ),
                    if (_settingUp) ...[
                      const SizedBox(width: 12),
                      const SizedBox.square(
                        dimension: 14,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      ),
                    ],
                  ],
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
                    Expanded(
                      child: _SwarmModelsPicker(
                        app: app,
                        grid: local?.grid ?? '',
                        ready: ready,
                        canSetUp: c.isOwner,
                        onSetUp: () async {
                          final grid = await _setUp();
                          return (
                            grid: grid,
                            error: grid == null ? _error : null,
                          );
                        },
                        setupNote: on && local?.ready == null
                            ? 'The Swarm owner is setting up its models.'
                            : 'The Swarm owner has not set up models yet.',
                        setupError: _settingUp ? null : failed,
                        setupPending: on && local?.ready == null,
                      ),
                    ),
                  ] else
                    setup,
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
  const _SwarmModelsPicker({
    required this.app,
    required this.grid,
    this.ready = true,
    this.canSetUp = false,
    this.onSetUp,
    this.setupNote,
    this.setupError,
    this.setupPending = false,
  });

  final AppNotifier app;
  final String grid;
  final bool ready;
  final bool canSetUp;
  final Future<({String? grid, String? error})> Function()? onSetUp;
  final String? setupNote;
  final String? setupError;
  final bool setupPending;

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
      ready: widget.ready,
      canSetUp: widget.canSetUp,
      onSetUp: widget.onSetUp,
      setupNote: widget.setupNote,
      setupError: widget.setupError,
      setupPending: widget.setupPending,
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
  void didUpdateWidget(covariant _SwarmModelsPicker oldWidget) {
    super.didUpdateWidget(oldWidget);
    // Set up meanwhile, here or on the owner's other computer: the same list goes on, on the Swarm's grid.
    if (widget.ready && !_target.ready && widget.grid.isNotEmpty) {
      _target.markReady(widget.grid);
      unawaited(_target.refresh());
    }
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
          padding: const EdgeInsets.fromLTRB(24, 0, 24, 14),
          child: Row(
            children: [
              Expanded(child: _searchField()),
              const SizedBox(width: 12),
              ListenableBuilder(
                listenable: _search,
                builder: (context, _) => _SwarmModelScopes(search: _search),
              ),
            ],
          ),
        ),
        Divider(height: 1, color: DesktopChrome.rim),
        Expanded(
          // The rows are the preview's to act on; the hints for both are this window's footer.
          child: KeyHints(
            visible: false,
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
        ),
      ],
    );
  }

  /// The app's own search field, as Settings' is: the theme frames it and centres the magnifier on its line.
  Widget _searchField() => TextField(
    key: const ValueKey('super-local-models-search'),
    controller: _editing,
    focusNode: _focus,
    autofocus: true,
    onChanged: _query,
    onSubmitted: (_) {
      _choose(_search.submit());
      _focus.requestFocus();
    },
    textInputAction: TextInputAction.search,
    style: grid.kFieldTextStyle,
    decoration: InputDecoration(
      hintText: 'Search models and APIs',
      prefixIcon: Icon(
        AppIcons.search,
        size: grid.kFieldIconSize,
        color: grid.AppPalette.textFaint,
      ),
    ),
  );
}

/// All, or one section: APIs, your models, the models to get.
class _SwarmModelScopes extends StatelessWidget {
  const _SwarmModelScopes({required this.search});

  final SwarmSearchController search;

  @override
  Widget build(BuildContext context) {
    Widget scope(String label, ModelSearchSection? section) {
      final on = search.modelScope == section;
      return Semantics(
        button: true,
        selected: on,
        child: Material(
          color: on
              ? DesktopChrome.foreground.withValues(alpha: .10)
              : Colors.transparent,
          borderRadius: BorderRadius.circular(6),
          child: InkWell(
            key: ValueKey('super-local-models-scope:${section?.name ?? 'all'}'),
            borderRadius: BorderRadius.circular(6),
            onTap: () => search.setModelScope(section),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
              child: Text(
                label,
                style: DesktopChrome.text(
                  size: 12,
                  medium: true,
                  height: 1.3,
                  color: on ? DesktopChrome.foreground : DesktopChrome.muted,
                ),
              ),
            ),
          ),
        ),
      );
    }

    return Container(
      height: 36,
      padding: const EdgeInsets.all(3),
      decoration: BoxDecoration(
        color: DesktopChrome.field,
        borderRadius: BorderRadius.circular(9),
        border: Border.all(color: DesktopChrome.rim),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          scope('All', null),
          scope('APIs', ModelSearchSection.apis),
          scope('Yours', ModelSearchSection.local),
          scope('Get', ModelSearchSection.catalog),
        ],
      ),
    );
  }
}

String _capitalized(String text) =>
    text.isEmpty ? text : '${text[0].toUpperCase()}${text.substring(1)}';

/// [text] as a sentence: grid's own words often end without a full stop.
String _sentence(String text) {
  final t = text.trim();
  return RegExp(r'[.!?]$').hasMatch(t) ? t : '$t.';
}

/// The Local models part of a machine's details: what it runs for the Swarm. Running, sharing and offering are in the
/// sidebar's Local models.
class SuperTabMachineLocalModels extends StatelessWidget {
  const SuperTabMachineLocalModels({
    super.key,
    required this.controller,
    required this.machineId,
    this.now = DateTime.now,
  });

  final SuperTabController controller;
  final String machineId;

  final DateTime Function() now;

  @override
  Widget build(BuildContext context) {
    final local = controller.snapshot?.localModels;
    if (local == null || !local.enabled) return const SizedBox.shrink();
    final pool = controller.snapshot?.machines
        .where((m) => m['machineId'] == machineId)
        .firstOrNull;
    // A fresh reading only, as the route reads it; then each model by what it is: an API this machine's person
    // shares, or a model of theirs running for the Swarm.
    final fresh = superTabServedModels(pool, local.grid, now: now());
    final apis = <String>[], models = <String>[];
    final observed = pool?['observation'];
    for (final m
        in observed is Map && observed['localModels'] is List
            ? observed['localModels'] as List
            : const []) {
      if (m is! Map || m['grid'] != local.grid || m['model'] is! String) {
        continue;
      }
      if (!fresh.any((f) => f.model == m['model'])) continue;
      final model = m['model'] as String;
      if (m['kind'] == 'api') {
        apis.add(
          model.contains('/')
              ? model.substring(model.lastIndexOf('/') + 1)
              : model,
        );
      } else {
        models.add(m['name'] is String ? m['name'] as String : model);
      }
    }
    Widget line(String label, List<String> names) => Padding(
      padding: const EdgeInsets.symmetric(vertical: 5),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 104,
            child: Text(label, style: DesktopChrome.metadata()),
          ),
          const SizedBox(width: 16),
          Expanded(
            child: Text(
              names.isEmpty ? 'None' : names.join(', '),
              style: names.isEmpty
                  ? DesktopChrome.control(color: DesktopChrome.muted)
                  : DesktopChrome.control(),
            ),
          ),
        ],
      ),
    );
    return Padding(
      key: ValueKey('super-machine-local-models-$machineId'),
      padding: const EdgeInsets.only(top: 24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            'Models for this Swarm',
            style: DesktopChrome.control(medium: true),
          ),
          const SizedBox(height: 8),
          line('API models', apis),
          line('Local models', models),
        ],
      ),
    );
  }
}
