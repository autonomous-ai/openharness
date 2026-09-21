import 'dart:math' as math;

import 'package:file_selector/file_selector.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../core/codex_profiles.dart';
import '../state/app_state.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_select_field.dart';
import 'remote_folder_picker.dart';

/// Every profile comes from the harness CLI running on [machineId]
/// (`AppNotifier.listCodexProfiles`/`linkCodexProfile`), never from reading this computer's own
/// filesystem — which is what lets this field work for a remote machine too.
class CodexProfileField extends StatefulWidget {
  const CodexProfileField({
    super.key,
    required this.notifier,
    required this.machineId,
    required this.machineIsThisComputer,
    required this.value,
    required this.onChanged,
    this.onBusyChanged,
    this.observedPaths = const {},
    this.textStyle,
    this.valueChosen = false,
  });

  final AppNotifier notifier;
  final String machineId;
  final bool machineIsThisComputer;
  final LocalCodexProfile? value;
  final ValueChanged<LocalCodexProfile?> onChanged;
  final ValueChanged<bool>? onBusyChanged;
  final Set<String> observedPaths;
  final TextStyle? textStyle;
  final bool valueChosen;

  @override
  State<CodexProfileField> createState() => _CodexProfileFieldState();
}

class _CodexProfileFieldState extends State<CodexProfileField> {
  List<LocalCodexProfile> _profiles = const [];
  bool _loading = true;
  bool _linking = false;
  late bool _hasChosenProfile = widget.valueChosen;
  String? _error;
  int _loadGeneration = 0;
  int _machineRevision = 0;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void didUpdateWidget(CodexProfileField oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.machineId != widget.machineId ||
        oldWidget.machineIsThisComputer != widget.machineIsThisComputer ||
        oldWidget.notifier != widget.notifier) {
      _machineRevision++;
      _profiles = [];
      _hasChosenProfile = widget.valueChosen;
      _linking = false;
      _load();
    } else if (!setEquals(oldWidget.observedPaths, widget.observedPaths)) {
      _load();
    }
  }

  Future<void> _load() async {
    final generation = ++_loadGeneration;
    setState(() {
      _loading = true;
      _error = null;
    });
    // initState/didUpdateWidget can run during the parent's build. Report busy
    // after that build, before any user input can submit the default account.
    await Future<void>.value();
    if (!mounted || generation != _loadGeneration) return;
    _reportBusy();
    final result = await widget.notifier.listCodexProfiles(
      widget.machineId,
      observedPaths: widget.observedPaths,
    );
    if (!mounted || generation != _loadGeneration) return;
    final error = result['error'];
    if (error is String) {
      setState(() {
        _loading = false;
        _error = 'Could not refresh profiles. Try again or link a folder.';
      });
      _reportBusy();
      return;
    }
    final loaded = (result['profiles'] as List<dynamic>? ?? const [])
        .map(
          (raw) =>
              LocalCodexProfile.fromJson(Map<String, dynamic>.from(raw as Map)),
        )
        .toList();
    final profiles = {for (final profile in loaded) profile.path: profile}
        .values
        .toList();
    setState(() {
      _profiles = profiles;
      _loading = false;
    });
    if (profiles.length == 1 &&
        widget.value == null &&
        !_hasChosenProfile &&
        !_linking) {
      widget.onChanged(profiles.single);
    }
    _reportBusy();
  }

  void _reportBusy() => widget.onBusyChanged?.call(_loading || _linking);

  void _select(LocalCodexProfile? profile) {
    _hasChosenProfile = true;
    widget.onChanged(profile);
  }

  Future<void> _link() async {
    if (_linking) return;
    final machineId = widget.machineId;
    final revision = _machineRevision;
    bool current() => mounted && revision == _machineRevision;
    setState(() {
      _linking = true;
      _error = null;
    });
    _reportBusy();
    try {
      // Same local-vs-remote split as the New Agent folder browser
      // (`_FolderControl`/`_browse` in new_agent_dialog.dart): a native panel on this computer
      // reaches sidebar favourites and network mounts `fs_list_dir` never enumerates; on any other
      // machine a native panel would browse THIS Mac and hand back a path that does not exist there.
      final path = widget.machineIsThisComputer
          ? await getDirectoryPath(
              initialDirectory: widget.value?.path,
              confirmButtonText: 'Link profile',
            )
          : await showRemoteFolderPicker(
              context,
              notifier: widget.notifier,
              machineId: machineId,
              initialPath: widget.value?.path,
            );
      if (path == null || !current()) return;
      final result = await widget.notifier.linkCodexProfile(machineId, path);
      if (!current()) return;
      final error = result['error'];
      if (error is String) {
        setState(
          () => _error = 'Could not link this profile folder. Check that it is accessible.',
        );
        return;
      }
      final profile = LocalCodexProfile.fromJson(
        Map<String, dynamic>.from(result['profile'] as Map),
      );
      await _load();
      if (current()) _select(profile);
    } catch (_) {
      if (current()) {
        setState(
          () => _error = 'Could not link this profile folder. Check that it is accessible.',
        );
      }
    } finally {
      if (current()) {
        setState(() => _linking = false);
        _reportBusy();
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    // Default is launch behavior, not another discovered account folder.
    final choices = {
      for (final profile in _profiles) profile.path: profile,
      if (widget.value != null) widget.value!.path: widget.value!,
    };
    const refreshValue = '__refresh_profiles__';
    final height = math.max(
      34.0,
      MediaQuery.textScalerOf(context).scale(13) * 1.35 + 14,
    );
    return Wrap(
      spacing: 8,
      runSpacing: 6,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: [
        SizedBox(
          width:
              252 *
              math.min(1.4, MediaQuery.textScalerOf(context).scale(13) / 13),
          height: height,
          child: AppSelectField<String>(
            key: const Key('new-agent-codex-profile-field'),
            height: height,
            textStyle: widget.textStyle,
            radius: widget.textStyle == null ? null : 2,
            value: widget.value?.path ?? '',
            options: [
              const SelectOption(value: '', label: 'Default profile'),
              for (final profile in choices.values)
                SelectOption(
                  value: profile.path,
                  label: profile.label,
                  detail: profile.path,
                ),
              SelectOption(
                value: refreshValue,
                label: 'Refresh profiles',
                leading: () => const Icon(LucideIcons.refreshCw, size: 14),
              ),
            ],
            onChanged: (value) {
              if (value == refreshValue) {
                _load();
              } else {
                _select(choices[value]);
              }
            },
            trigger: Row(
              children: [
                Expanded(
                  child: Text(
                    'Codex profile: ${widget.value?.label ?? (_loading ? 'Loading…' : 'Default')}',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style:
                        widget.textStyle ??
                        TextStyle(
                          fontSize: 13,
                          color: grid.AppPalette.textPrimary,
                        ),
                  ),
                ),
                const SizedBox(width: 8),
                Icon(
                  Icons.keyboard_arrow_down,
                  size: 16,
                  color: grid.AppPalette.textSecondary,
                ),
              ],
            ),
          ),
        ),
        TextButton(
          onPressed: _linking ? null : _link,
          style: TextButton.styleFrom(
            foregroundColor: grid.AppPalette.textSecondary,
            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 6),
            minimumSize: const Size(0, 32),
            textStyle:
                widget.textStyle ??
                TextStyle(
                  fontFamily: grid.AppFont.sans,
                  fontFamilyFallback: grid.AppFont.sansFallback,
                  fontSize: 13,
                ),
          ),
          child: Text(_linking ? 'Adding…' : 'Add'),
        ),
        if (_error != null)
          Text(
            _error!,
            style: TextStyle(
              color: Theme.of(context).colorScheme.error,
              fontSize: 12,
            ),
          ),
      ],
    );
  }
}
