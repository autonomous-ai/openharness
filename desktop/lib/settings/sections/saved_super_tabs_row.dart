import 'dart:async';

import 'package:flutter/material.dart';

import '../../shared/widgets/setting_row.dart';
import '../../super_tabs/client.dart';

/// Where views of Super Tabs are kept on this device (the web's reading,
/// `SuperTabReading.drawsSaved`), Account says so in plain words, says when
/// they go, and clears them now.
class SavedSuperTabsRow extends StatefulWidget {
  const SavedSuperTabsRow({super.key, required this.superTabs});

  final SuperTabClient superTabs;

  @override
  State<SavedSuperTabsRow> createState() => _SavedSuperTabsRowState();
}

class _SavedSuperTabsRowState extends State<SavedSuperTabsRow> {
  bool _clearing = false, _cleared = false;

  Future<void> _clear() async {
    setState(() => _clearing = true);
    try {
      await widget.superTabs.clearSavedViews();
    } catch (_) {
      // A browser that refuses storage keeps nothing to clear.
    }
    if (mounted) {
      setState(() {
        _clearing = false;
        _cleared = true;
      });
    }
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
      onPressed: _clearing || _cleared ? null : () => unawaited(_clear()),
      child: Text(_cleared ? 'Cleared' : 'Clear now'),
    ),
  );
}
