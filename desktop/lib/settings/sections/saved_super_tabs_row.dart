import 'dart:async';

import 'package:flutter/material.dart';

import '../../shared/theme/app_theme.dart' as grid;
import '../../shared/widgets/setting_row.dart';
import '../../super_tabs/client.dart';

/// Where views of Super Tabs are kept on this device (the web's reading,
/// `SuperTabReading.drawsSaved`), Account says so in plain words, says when
/// they go, and clears them now. It says Cleared only when they went, and
/// only until a Super Tab is kept again.
class SavedSuperTabsRow extends StatefulWidget {
  const SavedSuperTabsRow({super.key, required this.superTabs});

  final SuperTabClient superTabs;

  @override
  State<SavedSuperTabsRow> createState() => _SavedSuperTabsRowState();
}

enum _Clearing { idle, busy, cleared, refused }

class _SavedSuperTabsRowState extends State<SavedSuperTabsRow> {
  var _state = _Clearing.idle;

  @override
  void initState() {
    super.initState();
    widget.superTabs.viewsKept.addListener(_keptAgain);
  }

  @override
  void dispose() {
    widget.superTabs.viewsKept.removeListener(_keptAgain);
    super.dispose();
  }

  void _keptAgain() {
    if (_state == _Clearing.cleared) setState(() => _state = _Clearing.idle);
  }

  Future<void> _clear() async {
    setState(() => _state = _Clearing.busy);
    var cleared = true;
    try {
      await widget.superTabs.clearSavedViews();
    } catch (_) {
      // A browser that refuses its storage (full, private mode).
      cleared = false;
    }
    if (!mounted) return;
    setState(() => _state = cleared ? _Clearing.cleared : _Clearing.refused);
  }

  @override
  Widget build(BuildContext context) => SettingRow(
    title: 'Super Tabs in this browser',
    detail:
        'This browser keeps a copy of the Super Tabs you open, so they show '
        'at once. Signing out removes it.',
    control: OutlinedButton(
      key: const Key('settings-clear-saved-super-tabs'),
      // A thumb's target on a phone.
      style: const ButtonStyle(tapTargetSize: MaterialTapTargetSize.padded),
      onPressed: switch (_state) {
        _Clearing.busy || _Clearing.cleared => null,
        _ => () => unawaited(_clear()),
      },
      child: Text(_state == _Clearing.cleared ? 'Cleared' : 'Clear now'),
    ),
    footer: _state == _Clearing.refused
        ? Text(
            'This browser did not let Harness clear it. Try again.',
            style: grid.AppType.body(
              color: Theme.of(context).colorScheme.error,
            ),
          )
        : null,
  );
}
