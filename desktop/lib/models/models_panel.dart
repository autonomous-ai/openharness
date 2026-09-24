import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../shared/theme/app_theme.dart';
import '../theme/app_theme.dart';
import '../usage/models_menu_controller.dart';
import 'local_model.dart';
import 'model_manager_controller.dart';
import 'model_mark.dart';

class ModelsPanel extends StatefulWidget {
  const ModelsPanel({
    super.key,
    required this.controller,
    required this.subscriptions,
    required this.onClose,
    required this.onManage,
    this.newModelIds = const {},
  });
  final ModelManagerController controller;
  final ModelsMenuController subscriptions;
  final VoidCallback onClose, onManage;
  final Set<String> newModelIds;
  @override
  State<ModelsPanel> createState() => _ModelsPanelState();
}

enum _Filter { all, running }

class _ModelsPanelState extends State<ModelsPanel> {
  final _search = TextEditingController();
  final _searchFocus = FocusNode(debugLabel: 'Search models');
  _Filter _filter = _Filter.all;
  ModelManagerController get controller => widget.controller;
  ModelsMenuController get subscriptions => widget.subscriptions;
  @override
  void dispose() {
    _search.dispose();
    _searchFocus.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: Listenable.merge([controller, subscriptions]),
    builder: (context, _) {
      final query = _search.text.trim().toLowerCase();
      final models = controller.localModels
          .where(
            (m) =>
                (m.name.toLowerCase().contains(query) ||
                    m.id.toLowerCase().contains(query)) &&
                switch (_filter) {
                  _Filter.all => true,
                  _Filter.running => m.running,
                },
          )
          .toList();
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
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 16),
                  child: TextField(
                    key: const ValueKey('models-search'),
                    controller: _search,
                    focusNode: _searchFocus,
                    autofocus: true,
                    style: AppType.monoLabel(),
                    decoration: InputDecoration(
                      hintText: 'Search models…',
                      hintStyle: AppType.monoLabel(color: AppPalette.textFaint),
                      prefixIcon: Icon(
                        LucideIcons.search,
                        size: 15,
                        color: AppPalette.textFaint,
                      ),
                      prefixIconConstraints: const BoxConstraints(minWidth: 36),
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
                            _Filter.all,
                            'All',
                            controller.localModels.length,
                          ),
                          _tab(
                            _Filter.running,
                            'Running',
                            controller.localModels
                                .where((m) => m.running)
                                .length,
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
                    padding: const EdgeInsets.symmetric(
                      horizontal: 8,
                      vertical: 6,
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
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
                        if (controller.error case final error?)
                          Padding(
                            padding: const EdgeInsets.symmetric(
                              horizontal: 12,
                              vertical: 12,
                            ),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  error,
                                  style: AppType.body(color: AppColors.warning),
                                ),
                                TextButton(
                                  onPressed: controller.scanning
                                      ? null
                                      : () => unawaited(
                                          controller.refresh(force: true),
                                        ),
                                  child: const Text('Try again'),
                                ),
                              ],
                            ),
                          ),
                        if (!controller.loaded && controller.error == null)
                          Padding(
                            padding: const EdgeInsets.symmetric(
                              horizontal: 12,
                              vertical: 28,
                            ),
                            child: Text(
                              'Finding models that fit…',
                              style: AppType.body(color: AppColors.textSoft),
                            ),
                          )
                        else if (models.isEmpty && controller.error == null)
                          Padding(
                            padding: const EdgeInsets.symmetric(
                              horizontal: 12,
                              vertical: 28,
                            ),
                            child: Text(
                              query.isNotEmpty
                                  ? 'No matching models'
                                  : switch (_filter) {
                                      _Filter.running => 'No models running',
                                      _Filter.all =>
                                        'No compatible models found',
                                    },
                              style: AppType.body(color: AppColors.textSoft),
                            ),
                          ),
                        for (final model in models) _model(model),
                        if (_filter == _Filter.all &&
                            query.isEmpty &&
                            subscriptions.rows.isNotEmpty) ...[
                          _heading('Subscriptions'),
                          for (final row in subscriptions.rows)
                            _subscription(row),
                        ],
                        if (_filter == _Filter.all)
                          for (final section in controller.sections.where(
                            (s) => !s.own && s.models.isNotEmpty,
                          )) ...[
                            if (section.models.any(
                              (m) => m.id.toLowerCase().contains(query),
                            ))
                              _heading('Shared · ${section.name}'),
                            for (final model in section.models.where(
                              (m) => m.id.toLowerCase().contains(query),
                            ))
                              Padding(
                                padding: const EdgeInsets.fromLTRB(
                                  12,
                                  14,
                                  6,
                                  14,
                                ),
                                child: Row(
                                  children: [
                                    ModelMark(model: model.id),
                                    const SizedBox(width: 12),
                                    Expanded(
                                      child: Column(
                                        crossAxisAlignment:
                                            CrossAxisAlignment.start,
                                        children: [
                                          Text(
                                            model.id,
                                            style: AppType.label(
                                              color: AppPalette.textPrimary,
                                              height: 1.3,
                                            ),
                                            maxLines: 1,
                                            overflow: TextOverflow.ellipsis,
                                          ),
                                          const SizedBox(height: 6),
                                          Text(
                                            model.node,
                                            style: AppType.monoMeta(
                                              color: AppPalette.textSecondary,
                                              height: 1.3,
                                            ),
                                            maxLines: 1,
                                            overflow: TextOverflow.ellipsis,
                                          ),
                                        ],
                                      ),
                                    ),
                                  ],
                                ),
                              ),
                          ],
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
                              'Select models in a session’s model picker.',
                              style: AppType.monoMeta(
                                color: AppPalette.textSecondary,
                              ),
                            ),
                          )
                        else
                          const Spacer(),
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

  Widget _tab(_Filter filter, String title, int count) => Padding(
    padding: const EdgeInsets.only(right: 4),
    child: Semantics(
      selected: _filter == filter,
      child: TextButton(
        onPressed: () => setState(() => _filter = filter),
        style: TextButton.styleFrom(
          backgroundColor: _filter == filter
              ? AppPalette.textPrimary.withValues(alpha: .08)
              : Colors.transparent,
          foregroundColor: _filter == filter
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
            if (model.tokensPerSecond case final speed? when model.running)
              '${speed.toStringAsFixed(1)} tok/s',
            if (model.requests case final requests?
                when model.running && model.windowSeconds != null)
              '${requests.toInt()} ${requests == 1 ? 'request' : 'requests'} / ${_window(model.windowSeconds!)}',
          ].join(' · ');
    final action = model.canStop ? 'Pause' : 'Start';
    final tooltip = active
        ? status
        : model.canStop
        ? 'Pause ${model.name} and free memory. The download is kept.'
        : 'Start ${model.name}';
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
                        model.canStop ? LucideIcons.pause : LucideIcons.play,
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
                    'Account ···$account',
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

/// Discovery appears once. Completion explains where model selection lives;
/// the overview never creates a session or changes its model implicitly.
class LocalModelInvitation extends StatelessWidget {
  const LocalModelInvitation({
    super.key,
    required this.controller,
    required this.onOpen,
  });
  final ModelManagerController controller;
  final VoidCallback onOpen;
  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: controller,
    builder: (context, _) {
      final ready = controller.readyModel;
      if (ready == null && !controller.showIntroduction) {
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
                    if (ready == null)
                      const ModelMark()
                    else
                      Icon(
                        LucideIcons.circleCheckBig,
                        color: AppColors.success,
                        size: 22,
                      ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            ready == null
                                ? 'Run AI on this computer'
                                : '${ready.name} is running',
                            style: AppType.label(color: AppColors.text),
                          ),
                          if (ready == null)
                            TextButton(
                              onPressed: onOpen,
                              style: TextButton.styleFrom(
                                padding: EdgeInsets.zero,
                                alignment: Alignment.centerLeft,
                              ),
                              child: const Text('Explore models'),
                            )
                          else
                            Padding(
                              padding: const EdgeInsets.only(top: 5),
                              child: Text(
                                'Select it from the model picker in a session.',
                                style: AppType.body(color: AppColors.textSoft),
                              ),
                            ),
                        ],
                      ),
                    ),
                    IconButton(
                      tooltip: 'Dismiss',
                      onPressed: () => ready == null
                          ? unawaited(controller.dismissIntroduction())
                          : controller.dismissReady(),
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
