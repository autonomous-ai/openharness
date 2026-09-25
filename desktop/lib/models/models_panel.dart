import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../core/models.dart';
import '../shared/theme/app_theme.dart';
import '../theme/app_theme.dart';
import '../usage/models_menu_controller.dart';
import 'local_model.dart';
import 'model_manager_controller.dart';
import 'model_mark.dart';
import '../widgets/onboarding_card.dart';
import '../widgets/resting_model_words.dart';
import '../widgets/resting_section.dart';
import 'shared_model_row.dart';
import 'api_connections_panel.dart';

enum ModelsTab { all, subscriptions, local, shared, apis }

class ModelsPanel extends StatefulWidget {
  const ModelsPanel({
    super.key,
    required this.controller,
    required this.subscriptions,
    required this.onClose,
    required this.onManage,
    this.newModelIds = const {},
    this.showOnboarding = false,
    this.onDismissOnboarding,
    this.initialTab = ModelsTab.all,
  });
  final ModelManagerController controller;
  final ModelsMenuController subscriptions;
  final VoidCallback onClose, onManage;
  final Set<String> newModelIds;
  final bool showOnboarding;
  final VoidCallback? onDismissOnboarding;
  final ModelsTab initialTab;
  @override
  State<ModelsPanel> createState() => _ModelsPanelState();
}

class _ModelsPanelState extends State<ModelsPanel> with SectionWakes {
  final _search = TextEditingController();
  bool _exploring = false;
  final _searchFocus = FocusNode(debugLabel: 'Search models');
  late ModelsTab _selectedTab = widget.initialTab;
  bool _editingApi = false;
  ModelManagerController get controller => widget.controller;
  ModelsMenuController get subscriptions => widget.subscriptions;
  @override
  void initState() {
    super.initState();
    unawaited(controller.apis.refresh());
  }

  @override
  void dispose() {
    _search.dispose();
    _searchFocus.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: Listenable.merge([controller, subscriptions, controller.apis]),
    builder: (context, _) {
      final query = _search.text.trim().toLowerCase();
      final all = _selectedTab == ModelsTab.all;
      final subscriptionRows = subscriptions.rows;
      final matchingSubscriptions = subscriptionRows.where(
        (row) => [
          'title',
          'account',
          'engine',
        ].any((key) => '${row[key] ?? ''}'.toLowerCase().contains(query)),
      );
      final sharedSections = controller.sections.where((s) => !s.own).toList();
      final sharedCount = sharedSections.fold(
        0,
        (count, section) => count + section.models.length,
      );
      final matchingShared = [
        for (final section in sharedSections)
          (
            section: section,
            models: section.models
                .where(
                  (model) => [
                    section.name,
                    model.id,
                    model.node,
                  ].any((text) => text.toLowerCase().contains(query)),
                )
                .toList(),
            // Resting, starting, not answering.
            words: wordsFor(section),
          ),
      ];
      // Drawn while it lists something or, with no search, has something to say (only ever from a
      // newer daemon). A search is for models: a section it emptied says nothing.
      bool drawn(
        ({GridSection section, List<GridModel> models, SectionWords words}) s,
      ) => s.models.isNotEmpty || (query.isEmpty && s.words.speaks);
      final models = controller.localModels
          .where(
            (m) =>
                m.name.toLowerCase().contains(query) ||
                m.id.toLowerCase().contains(query),
          )
          .toList();
      final hasShared = matchingShared.any(drawn);
      final hasApis = controller.apis.connections.any(
        (row) => row.matches(query),
      );
      final noMatches =
          matchingSubscriptions.isEmpty &&
          models.isEmpty &&
          !hasShared &&
          !hasApis;
      int rank(LocalModel m) => controller.operationFor(m)?.active == true
          ? 0
          : m.running
          ? 1
          : m.downloaded
          ? 2
          : 3;
      models.sort((a, b) {
        final byState = rank(a).compareTo(rank(b));
        return byState != 0
            ? byState
            : controller.localModels
                  .indexOf(a)
                  .compareTo(controller.localModels.indexOf(b));
      });
      return CallbackShortcuts(
        bindings: {
          const SingleActivator(LogicalKeyboardKey.escape): widget.onClose,
        },
        child: FocusScope(
          child: Material(
            color: AppPalette.panelBg,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(14),
              side: BorderSide(
                color: AppPalette.textPrimary.withValues(alpha: .12),
              ),
            ),
            clipBehavior: Clip.antiAlias,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(20, 10, 12, 8),
                  child: Row(
                    children: [
                      Expanded(child: Text('Models', style: AppType.heading())),
                      IconButton(
                        onPressed: widget.onClose,
                        tooltip: 'Close Models',
                        icon: const Icon(LucideIcons.x, size: 16),
                      ),
                    ],
                  ),
                ),
                if (widget.showOnboarding && !_exploring && !_editingApi)
                  OnboardingCard(
                    title: 'Power a harness with local AI',
                    description: 'Choose a model that runs on your computer. Then select it in a harness’s model picker.',
                    action: 'Explore local models',
                    onAction: () => setState(() {
                      _exploring = true;
                      _selectedTab = ModelsTab.local;
                      _search.clear();
                    }),
                    onDismiss: widget.onDismissOnboarding ?? () {},
                  ),
                if (!_editingApi)
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 16),
                    child: TextField(
                      key: const ValueKey('models-search'),
                      controller: _search,
                      focusNode: _searchFocus,
                      autofocus: true,
                      style: AppType.monoLabel(),
                      decoration: InputDecoration(
                        hintText: _selectedTab == ModelsTab.subscriptions
                            ? 'Search subscriptions'
                            : _selectedTab == ModelsTab.apis
                            ? 'Search APIs'
                            : 'Search models',
                        hintStyle: AppType.monoLabel(
                          color: AppPalette.textFaint,
                        ),
                        prefixIcon: Icon(
                          LucideIcons.search,
                          size: 15,
                          color: AppPalette.textFaint,
                        ),
                        prefixIconConstraints: const BoxConstraints(
                          minWidth: 36,
                        ),
                        suffixIcon: _search.text.isEmpty
                            ? null
                            : IconButton(
                                tooltip: 'Clear search',
                                icon: const Icon(LucideIcons.x, size: 14),
                                onPressed: () {
                                  setState(_search.clear);
                                  _searchFocus.requestFocus();
                                },
                              ),
                        isDense: true,
                        filled: true,
                        fillColor: AppPalette.windowBg,
                        contentPadding: const EdgeInsets.symmetric(
                          vertical: 12,
                          horizontal: 12,
                        ),
                        border: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(8),
                          borderSide: BorderSide.none,
                        ),
                        focusedBorder: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(8),
                          borderSide: BorderSide(
                            color: AppPalette.accent.withValues(alpha: .8),
                          ),
                        ),
                      ),
                      onChanged: (_) => setState(() {}),
                    ),
                  ),
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 10, 12, 8),
                  child: Align(
                    alignment: Alignment.centerLeft,
                    child: SingleChildScrollView(
                      scrollDirection: Axis.horizontal,
                      child: Row(
                        children: [
                          _tab(
                            ModelsTab.all,
                            'All',
                            subscriptionRows.length +
                                controller.localModels.length +
                                sharedCount +
                                controller.apis.connections.length,
                          ),
                          _tab(
                            ModelsTab.subscriptions,
                            'Subscriptions',
                            subscriptionRows.length,
                          ),
                          _tab(
                            ModelsTab.local,
                            'Local',
                            controller.localModels.length,
                          ),
                          _tab(ModelsTab.shared, 'Shared', sharedCount),
                          _tab(
                            ModelsTab.apis,
                            'APIs',
                            controller.apis.connections.length,
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
                Divider(
                  height: 1,
                  color: AppPalette.textPrimary.withValues(alpha: .08),
                ),
                Flexible(
                  child: SingleChildScrollView(
                    key: ValueKey(_selectedTab),
                    padding: const EdgeInsets.symmetric(
                      horizontal: 8,
                      vertical: 6,
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        if (all &&
                            !_editingApi &&
                            query.isNotEmpty &&
                            noMatches)
                          _empty('No matches'),
                        if (_selectedTab == ModelsTab.subscriptions ||
                            (all &&
                                !_editingApi &&
                                matchingSubscriptions.isNotEmpty)) ...[
                          if (all) _heading('Subscriptions'),
                          if (matchingSubscriptions.isEmpty)
                            _empty(
                              query.isEmpty
                                  ? 'No subscriptions'
                                  : 'No matching subscriptions',
                            ),
                          for (final row in matchingSubscriptions)
                            _subscription(row),
                        ],
                        if (_selectedTab == ModelsTab.local ||
                            (all &&
                                !_editingApi &&
                                (query.isEmpty || models.isNotEmpty))) ...[
                          Padding(
                            padding: const EdgeInsets.fromLTRB(12, 10, 12, 4),
                            child: Text(
                              [
                                'This computer',
                                if (controller.memoryBytes case final memory?)
                                  '${_size(memory)} memory',
                              ].join(' · '),
                              style: AppType.monoMeta(
                                color: AppPalette.textSecondary,
                              ),
                            ),
                          ),
                          const SizedBox(height: 4),
                          if (controller.error case final error?) _retry(error),
                          if (!controller.loaded && controller.error == null)
                            _empty('Finding models that fit…')
                          else if (models.isEmpty && controller.error == null)
                            _empty(
                              query.isNotEmpty
                                  ? 'No matching models'
                                  : 'No compatible models found',
                            ),
                          for (final model in models) _model(model),
                        ],
                        if (_selectedTab == ModelsTab.shared ||
                            (all && !_editingApi && hasShared)) ...[
                          if (controller.models?.reachable == false)
                            _retry('Shared models are unavailable.')
                          else if (controller.models == null &&
                              controller.error != null)
                            _retry(controller.error!)
                          else if (controller.models == null)
                            _empty('Finding shared models…')
                          else if (!matchingShared.any(drawn))
                            _empty(
                              query.isEmpty
                                  ? 'No shared models'
                                  : 'No matching models',
                            ),
                          for (final shared in matchingShared)
                            if (drawn(shared)) ...[
                              _heading(
                                all
                                    ? 'Shared · ${shared.section.name}'
                                    : shared.section.name,
                              ),
                              if (shared.words.speaks)
                                RestingSectionNotes(
                                  words: shared.words,
                                  inset: 12,
                                  onWake: () => unawaited(
                                    wakeSection(
                                      shared.section,
                                      (section) =>
                                          controller.wake(section.name),
                                    ),
                                  ),
                                ),
                              for (final model in shared.models)
                                SharedModelRow(model: model),
                            ],
                        ],
                        if (_selectedTab == ModelsTab.apis ||
                            (all && (hasApis || _editingApi)))
                          ApiConnectionsPanel(
                            key: const ValueKey('models-api-connections'),
                            controller: controller.apis,
                            query: query,
                            showPresets: !all,
                            onEditingChanged: (editing) =>
                                setState(() => _editingApi = editing),
                          ),
                      ],
                    ),
                  ),
                ),
                Divider(
                  height: 1,
                  color: AppPalette.textPrimary.withValues(alpha: .08),
                ),
                Padding(
                  padding: const EdgeInsets.fromLTRB(20, 8, 12, 8),
                  child: LayoutBuilder(
                    builder: (context, constraints) => Row(
                      children: [
                        if (constraints.maxWidth >= 440)
                          Expanded(
                            child: Text(
                              _selectedTab == ModelsTab.apis || _editingApi
                                  ? 'Available to harness tools on this computer.'
                                  : 'Select models in a session’s model picker.',
                              style: AppType.monoMeta(
                                color: AppPalette.textSecondary,
                              ),
                            ),
                          )
                        else
                          const Spacer(),
                        if (_selectedTab != ModelsTab.apis && !_editingApi)
                          TextButton(
                            onPressed: controller.opening
                                ? null
                                : widget.onManage,
                            style: TextButton.styleFrom(
                              foregroundColor: AppPalette.textSecondary,
                              textStyle: AppType.monoMeta(),
                            ),
                            child: const Text('Manage models'),
                          ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      );
    },
  );

  Widget _tab(ModelsTab tab, String title, int count) => Padding(
    padding: const EdgeInsets.only(right: 4),
    child: Semantics(
      selected: _selectedTab == tab,
      child: TextButton(
        key: ValueKey('models-tab-${tab.name}'),
        onPressed: () {
          if (_selectedTab == tab) return;
          setState(() {
            _selectedTab = tab;
            _editingApi = false;
          });
        },
        style: TextButton.styleFrom(
          backgroundColor: _selectedTab == tab
              ? AppPalette.textPrimary.withValues(alpha: .08)
              : Colors.transparent,
          foregroundColor: _selectedTab == tab
              ? AppPalette.textPrimary
              : AppPalette.textSecondary,
          textStyle: AppType.monoMeta(),
          minimumSize: const Size(0, 30),
          padding: const EdgeInsets.symmetric(horizontal: 10),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(6)),
        ),
        child: Text('$title $count'),
      ),
    ),
  );

  Widget _empty(String message) => Padding(
    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 28),
    child: Text(message, style: AppType.body(color: AppColors.textSoft)),
  );

  Widget _retry(String message) => Padding(
    padding: const EdgeInsets.all(12),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(message, style: AppType.body(color: AppColors.warning)),
        TextButton(
          onPressed: controller.scanning
              ? null
              : () => unawaited(controller.refresh(force: true)),
          child: const Text('Try again'),
        ),
      ],
    ),
  );

  Widget _model(LocalModel model) {
    final pending = controller.pendingId == model.id;
    final reported = controller.operationFor(model);
    // A previous completed receipt must not label a new pause click "Testing".
    final operation = pending && reported?.active != true ? null : reported;
    final active = operation?.active == true || pending;
    final failed = operation?.failed == true;
    final status = active
        ? [
            operation?.label ??
                (controller.pendingStart ? 'Starting' : 'Stopping'),
            if (operation?.progress case final progress?)
              '${(progress * 100).floor()}%',
          ].join(' · ')
        : failed
        ? operation?.error ?? 'Could not finish. Try again.'
        : [
            if (model.sizeBytes case final size?) _size(size),
            // Parked while this computer's models rest: running, and answering again by itself on
            // the next message — not a plain "running" with its telemetry gone blank.
            if (model.resting) kRestingUntilNextMessage,
            if (model.tokensPerSecond case final speed? when model.running)
              '${speed.toStringAsFixed(1)} tok/s',
            if (model.requests case final requests?
                when model.running && model.windowSeconds != null)
              '${requests.toInt()} ${requests == 1 ? 'request' : 'requests'} / ${_window(model.windowSeconds!)}',
          ].join(' · ');
    final action = model.canStop
        ? 'Pause'
        : model.downloaded
        ? 'Start'
        : 'Download and start';
    final icon = model.canStop
        ? LucideIcons.pause
        : model.downloaded
        ? LucideIcons.play
        : LucideIcons.download;
    final tooltip = active
        ? status
        : model.canStop
        ? 'Pause ${model.name} and free memory. The download is kept.'
        : '$action ${model.name}';
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 14, 6, 14),
      child: Row(
        children: [
          ModelMark(model: model.name),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Flexible(
                      child: Tooltip(
                        message: model.name,
                        child: Text(
                          model.name,
                          style: AppType.label(
                            color: AppPalette.textPrimary,
                            height: 1.3,
                          ),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                    ),
                    if (widget.newModelIds.contains(model.id)) ...[
                      const SizedBox(width: 8),
                      Text(
                        'New',
                        style: AppType.monoMeta(
                          color: AppPalette.textSecondary,
                        ),
                      ),
                    ],
                  ],
                ),
                const SizedBox(height: 6),
                Text(
                  status,
                  style: AppType.monoMeta(
                    color: failed
                        ? AppColors.warning
                        : AppPalette.textSecondary,
                    height: 1.3,
                  ),
                  maxLines: failed ? 3 : 2,
                  overflow: TextOverflow.ellipsis,
                ),
                if (active)
                  Padding(
                    padding: const EdgeInsets.only(top: 8, right: 12),
                    child: LinearProgressIndicator(
                      value: operation?.stage == 'downloading'
                          ? operation?.progress
                          : null,
                      color: AppColors.textSoft,
                      backgroundColor: AppColors.border,
                      minHeight: 2,
                    ),
                  ),
              ],
            ),
          ),
          const SizedBox(width: 8),
          Tooltip(
            message: tooltip,
            child: SizedBox(
              width: 40,
              height: 40,
              child: active
                  ? Semantics(
                      liveRegion: true,
                      label: '$status ${model.name}',
                      child: Center(
                        child: SizedBox(
                          width: 15,
                          height: 15,
                          child: CircularProgressIndicator(
                            strokeWidth: 1.5,
                            color: AppPalette.textSecondary,
                          ),
                        ),
                      ),
                    )
                  : IconButton(
                      key: ValueKey('model-action-${model.id}'),
                      onPressed:
                          controller.busy ||
                              !controller.inventoryAvailable ||
                              (!model.canStart && !model.canStop)
                          ? null
                          : () => unawaited(controller.toggle(model)),
                      icon: Icon(
                        icon,
                        size: 17,
                        semanticLabel: '$action ${model.name}',
                      ),
                      style: IconButton.styleFrom(
                        foregroundColor: AppPalette.textPrimary,
                        disabledForegroundColor: AppPalette.textFaint
                            .withValues(alpha: .4),
                      ),
                    ),
            ),
          ),
        ],
      ),
    );
  }

  String _size(double bytes) {
    final gb = bytes / (1024 * 1024 * 1024);
    return '${gb.toStringAsFixed(gb == gb.roundToDouble() ? 0 : 1)} GB';
  }

  String _window(double seconds) => seconds > 0 && seconds % 3600 == 0
      ? '${(seconds / 3600).toInt()}h'
      : seconds > 0 && seconds % 60 == 0
      ? '${(seconds / 60).toInt()}m'
      : '${seconds.toInt()}s';
  Widget _heading(String title) => Padding(
    padding: const EdgeInsets.fromLTRB(12, 20, 12, 6),
    child: Text(
      title,
      style: AppType.monoMeta(color: AppPalette.textSecondary),
    ),
  );

  Widget _subscription(Map<String, Object?> row) {
    final account =
        subscriptions.rows.where((r) => r['title'] == row['title']).length > 1
        ? row['account'] as String? ?? ''
        : '';
    final percent = row['remainingPercent'] as double?;
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 14, 12, 14),
      child: Row(
        children: [
          ModelMark(model: row['title'] as String?),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  '${row['title'] ?? ''}',
                  style: AppType.label(
                    color: AppPalette.textPrimary,
                    height: 1.3,
                  ),
                ),
                if (account.isNotEmpty) ...[
                  const SizedBox(height: 6),
                  Text(
                    'Account $account',
                    style: AppType.monoMeta(
                      color: AppPalette.textSecondary,
                      height: 1.3,
                    ),
                  ),
                ],
              ],
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Text(
                  '${row['status'] ?? ''}'.replaceAll('remaining', 'left'),
                  textAlign: TextAlign.right,
                  style: AppType.monoMeta(
                    color: percent == 0
                        ? AppColors.warning
                        : AppPalette.textSecondary,
                  ),
                ),
                if (percent != null) ...[
                  const SizedBox(height: 6),
                  SizedBox(
                    width: 80,
                    child: LinearProgressIndicator(
                      value: percent / 100,
                      minHeight: 3,
                      color: AppColors.textSoft,
                      backgroundColor: AppColors.border,
                    ),
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// Discovery appears once; the overview never creates a session or changes its
/// model implicitly.
///
/// No "`<model>` is running" toast: a started model is shown by its own row in the
/// Models overview, and a toast in the corner of the workspace repeated it.
class LocalModelInvitation extends StatelessWidget {
  const LocalModelInvitation({
    super.key,
    required this.controller,
    required this.onOpen,
    this.showIntroduction = true,
  });
  final bool showIntroduction;
  final ModelManagerController controller;
  final VoidCallback onOpen;
  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: controller,
    builder: (context, _) {
      if (!showIntroduction || !controller.showIntroduction) {
        return const SizedBox.shrink();
      }
      return Align(
        alignment: Alignment.bottomRight,
        child: Padding(
          padding: const EdgeInsets.all(18),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 400),
            child: Material(
              elevation: 8,
              color: AppColors.surface,
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(12),
                side: BorderSide(color: AppColors.borderStrong),
              ),
              child: Padding(
                padding: const EdgeInsets.fromLTRB(16, 10, 8, 10),
                child: Row(
                  children: [
                    const ModelMark(),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            'Run AI on this computer',
                            style: AppType.label(color: AppColors.text),
                          ),
                          TextButton(
                            onPressed: onOpen,
                            style: TextButton.styleFrom(
                              padding: EdgeInsets.zero,
                              alignment: Alignment.centerLeft,
                            ),
                            child: const Text('Explore models'),
                          ),
                        ],
                      ),
                    ),
                    IconButton(
                      tooltip: 'Dismiss',
                      onPressed: () =>
                          unawaited(controller.dismissIntroduction()),
                      icon: const Icon(Icons.close, size: 17),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      );
    },
  );
}
