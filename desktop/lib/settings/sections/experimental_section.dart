import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart' show kIsWeb;

import '../../shared/widgets/section_scaffold.dart';
import '../../shared/widgets/setting_row.dart';
import '../experimental_features.dart';
import '../../state/app_state.dart';
import 'privacy_section.dart' show ProductUsageSetting;

class ExperimentalSection extends StatefulWidget {
  const ExperimentalSection({super.key, this.store, this.notifier});

  final ExperimentalFeaturesStore? store;
  final AppNotifier? notifier;

  @override
  State<ExperimentalSection> createState() => _ExperimentalSectionState();
}

class _ExperimentalSectionState extends State<ExperimentalSection> {
  @override
  void initState() {
    super.initState();
    unawaited((widget.store ?? _fallbackStore).refresh());
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
    final features = ExperimentalFeature.values.where(
      (f) => f.available && f.visibleInSettings,
    );
    return SectionScaffold(
      title: 'Experimental',
      subtitle: 'Try features that are still taking shape. Account experiments sync across your devices.',
      child: SingleChildScrollView(
        child: ListenableBuilder(
          listenable: preferences,
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
              for (final feature in features) ...[
                SettingRow(
                  title: feature.label,
                  detail: feature.description,
                  control: Semantics(
                    label: feature.label,
                    child: Align(
                      alignment: Alignment.centerLeft,
                      child: Switch(
                        key: ValueKey('experimental-${feature.id}'),
                        value: preferences.enabled(feature) != feature.inverted,
                        onChanged:
                            preferences.loaded &&
                                !preferences.saving &&
                                (preferences.isAvailable(feature) ||
                                    preferences.enabled(feature))
                            ? (on) => unawaited(
                                preferences.set(
                                  feature,
                                  on != feature.inverted,
                                ),
                              )
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
              ],
              if (!kIsWeb && widget.notifier != null)
                ProductUsageSetting(notifier: widget.notifier!, compact: true),
            ],
          ),
        ),
      ),
    );
  }
}
