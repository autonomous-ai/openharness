import 'dart:async';

import 'package:flutter/material.dart';

import '../../shared/widgets/section_scaffold.dart';
import '../../shared/widgets/setting_row.dart';
import '../experimental_features.dart';
import '../../teams/swarm_settings_controller.dart';
import '../../companions/coding_memory_connection.dart';
import '../../companions/coding_memory_settings.dart';

class ExperimentalSection extends StatefulWidget {
  const ExperimentalSection({
    super.key,
    this.store,
    this.controller,
    this.openCodingMemory,
  });

  final ExperimentalFeaturesStore? store;
  final SwarmSettingsController? controller;
  final CodingMemoryConnection? Function()? openCodingMemory;

  @override
  State<ExperimentalSection> createState() => _ExperimentalSectionState();
}

class _ExperimentalSectionState extends State<ExperimentalSection> {
  @override
  void initState() {
    super.initState();
    unawaited((widget.store ?? _fallbackStore).refresh());
    final controller = widget.controller;
    if (controller != null) unawaited(controller.refresh());
  }

  final _fallbackStore = ExperimentalFeaturesStore();

  @override
  void dispose() {
    _fallbackStore.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final preferences = widget.store ?? _fallbackStore;
    final features = ExperimentalFeature.values.where((f) => f.available);
    return SectionScaffold(
      title: 'Experimental',
      subtitle: 'Try features that are still taking shape. Account experiments sync across your devices; coding memory is local to this computer.',
      child: SingleChildScrollView(
        child: ListenableBuilder(
          listenable: Listenable.merge([preferences, widget.controller]),
          builder: (context, _) => Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            spacing: 10,
            children: [
              if (!preferences.loaded ||
                  (preferences.error != null &&
                      preferences.errorFeature == null))
                Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      preferences.error ??
                          (preferences.signedIn
                              ? 'Loading your account settings…'
                              : 'Sign in to choose experiments for your account.'),
                    ),
                    if (preferences.error != null)
                      TextButton(
                        onPressed: () => unawaited(preferences.refresh()),
                        child: const Text('Refresh settings'),
                      ),
                  ],
                ),
              for (final feature in features)
                SettingRow(
                  title: feature.label,
                  detail: feature.description,
                  control: Semantics(
                    label: feature.label,
                    child: Align(
                      alignment: Alignment.centerLeft,
                      child: Switch(
                        key: ValueKey('experimental-${feature.id}'),
                        value: preferences.enabled(feature),
                        onChanged:
                            preferences.loaded &&
                                !preferences.saving &&
                                (preferences.isAvailable(feature) ||
                                    preferences.enabled(feature))
                            ? (on) => unawaited(preferences.set(feature, on))
                            : null,
                      ),
                    ),
                  ),
                  footer: preferences.savingFeature == feature
                      ? Semantics(liveRegion: true, child: Text('Saving…'))
                      : preferences.errorFeature == feature
                      ? Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Semantics(
                              liveRegion: true,
                              child: Text(preferences.error!),
                            ),
                            TextButton(
                              onPressed: () => unawaited(preferences.refresh()),
                              child: const Text('Refresh setting'),
                            ),
                          ],
                        )
                      : preferences.loaded && !preferences.isAvailable(feature)
                      ? const Text(
                          'This experiment is unavailable on this server.',
                        )
                      : null,
                ),
              if (widget.controller case final controller?)
                _SwarmCollaborationSetting(controller: controller),
              if (widget.openCodingMemory case final open?)
                _CodingMemorySetting(
                  open: open,
                  companionEnabled: preferences.enabled(
                    ExperimentalFeature.focusBarCreature,
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _CodingMemorySetting extends StatefulWidget {
  const _CodingMemorySetting({
    required this.open,
    required this.companionEnabled,
  });
  final CodingMemoryConnection? Function() open;
  final bool companionEnabled;
  @override
  State<_CodingMemorySetting> createState() => _CodingMemorySettingState();
}

class _CodingMemorySettingState extends State<_CodingMemorySetting> {
  late final settings = CodingMemorySettings(() => widget.open());
  @override
  void initState() {
    super.initState();
    unawaited(settings.refresh());
  }

  @override
  void didUpdateWidget(_CodingMemorySetting oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.companionEnabled != widget.companionEnabled) {
      unawaited(settings.refresh());
    }
  }

  @override
  void dispose() {
    settings.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: settings,
    builder: (context, _) => SettingRow(
      title: 'Coding memory',
      detail: 'Let your companion learn coding preferences and project knowledge across supported agents on this computer. Uses the model selected in Companions.',
      control: Semantics(
        label: 'Coding memory',
        child: Align(
          alignment: Alignment.centerLeft,
          child: Switch(
            key: const Key('experimental-coding-memory'),
            value: settings.enabled,
            onChanged: settings.loaded && !settings.saving
                ? (value) => unawaited(settings.setEnabled(value))
                : null,
          ),
        ),
      ),
      footer: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            'For your account on this computer. Review memories and control learning and recall in Companions → Memories. Turning this off keeps saved memories.',
          ),
          if (!widget.companionEnabled)
            const Text(
              'Learning and recall are paused while Focus-bar creature is off.',
            ),
          if (settings.saving)
            const Text('Saving…')
          else if (!settings.loaded && settings.error == null)
            const Text('Loading…'),
          if (settings.error case final error?) ...[
            const SizedBox(height: 8),
            Semantics(liveRegion: true, child: Text(error)),
            TextButton(
              onPressed: settings.saving ? null : settings.refresh,
              child: const Text('Refresh setting'),
            ),
          ],
        ],
      ),
    ),
  );
}

class _SwarmCollaborationSetting extends StatelessWidget {
  const _SwarmCollaborationSetting({required this.controller});
  final SwarmSettingsController controller;

  @override
  Widget build(BuildContext context) {
    final state = controller;
    final status = state.saving
        ? 'Saving…'
        : !state.loaded && state.error == null
        ? 'Loading…'
        : null;
    return SettingRow(
      title: 'Tab collaboration',
      detail:
          'Let agents automatically consult only peers in the same tab. '
          'Off by default.',
      control: Semantics(
        label: 'Tab collaboration',
        child: Align(
          alignment: Alignment.centerLeft,
          child: Switch(
            key: const Key('experimental-swarm-collaboration'),
            value: state.enabled,
            onChanged: state.loaded && !state.saving
                ? (on) => unawaited(state.setEnabled(on))
                : null,
          ),
        ),
      ),
      footer: DefaultTextStyle.merge(
        style: Theme.of(context).textTheme.bodySmall,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'Use “Tab conversation” in the command palette to inspect '
              'their questions and replies.',
            ),
            if (status != null) ...[
              const SizedBox(height: 8),
              Semantics(liveRegion: true, child: Text(status)),
            ],
            if (state.error case final error?) ...[
              const SizedBox(height: 8),
              Semantics(liveRegion: true, child: Text(error)),
              TextButton(
                onPressed: state.saving
                    ? null
                    : () => unawaited(state.refresh()),
                child: const Text('Refresh setting'),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
