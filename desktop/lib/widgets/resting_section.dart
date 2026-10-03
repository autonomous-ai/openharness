/// What the pane picker and the Models panel both draw for a section whose computers rest to save
/// resources (grid-reads-without-waking, issue 03): the lines under its heading, the "Show models"
/// row and the wake it sends, the fade on a row that will not answer, and the question before an
/// agent is moved onto one. Written once so the two surfaces cannot drift apart; the words
/// themselves are `resting_model_words.dart`'s.
library;

import 'dart:async';

import 'package:harness/shared/theme/app_icons.dart';
import 'package:flutter/material.dart';

import '../core/models.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import 'desktop_chrome.dart';
import 'desktop_prompt_surface.dart';
import 'pane_menu.dart';
import 'resting_model_words.dart';

/// How far a row that will not answer is faded — every computer serving it seems offline. Listed
/// still, never removed.
const double kUnavailableOpacity = 0.45;

/// The "Show models" row's mark: the size the Models panel draws its row icons at, in a column as
/// wide as the smaller of the two surfaces' avatars.
const double _kWakeIconSize = 17;
const double _kWakeIconColumn = 28;

/// The sections a surface has asked to wake and not yet heard back about.
///
/// The daemon answers a wake at once with the section `waking`, so this covers only that round
/// trip: "Starting up…" at the click rather than a beat later — and an answer that does not say
/// `waking` (a daemon that predates the wake) puts "Show models" back rather than leaving a promise
/// nothing will keep. Lives in the surface's State, so it lasts exactly as long as the surface.
mixin SectionWakes<T extends StatefulWidget> on State<T> {
  final Set<String> _asking = {};

  /// What [section] says, counting a wake this surface has in flight — see [sectionWords].
  SectionWords wordsFor(GridSection section) =>
      sectionWords(section, asking: _asking.contains(section.name));

  /// Send [wake] for [section], once however often the row is clicked.
  Future<void> wakeSection(
    GridSection section,
    Future<void> Function(GridSection) wake,
  ) async {
    if (!_asking.add(section.name)) return;
    setState(() {});
    try {
      await wake(section);
    } finally {
      if (mounted) setState(() => _asking.remove(section.name));
    }
  }
}

/// The lines under a section's heading: the resting subtitle (why, on hover), one sentence above
/// the rows, and the "Show models" row. Draws nothing for [SectionWords.none] — which is every
/// section an older daemon sends.
class RestingSectionNotes extends StatelessWidget {
  const RestingSectionNotes({
    super.key,
    required this.words,
    required this.inset,
    required this.onWake,
  });

  final SectionWords words;

  /// The surface's content line, which the text starts on.
  final double inset;

  /// "Show models": wake this section. The surface stays open; the answer lands in it.
  final VoidCallback onWake;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (words.subtitle case final subtitle?)
          Padding(
            padding: EdgeInsets.fromLTRB(inset, 0, inset, 4),
            child: Tooltip(
              message: words.tooltip ?? '',
              child: Text(subtitle, style: DesktopChrome.metadata()),
            ),
          ),
        // Above the list it is about ("Not answering right now" over the last known models), or in
        // place of one.
        if (words.sentence case final sentence?)
          Padding(
            padding: EdgeInsets.fromLTRB(inset, 4, inset, 8),
            child: Text(
              sentence,
              style: DesktopChrome.text(size: 13, color: DesktopChrome.muted),
            ),
          ),
        if (words.offerWake) _WakeRow(inset: inset, onTap: onWake),
      ],
    );
  }
}

/// "Show models" for a resting section with no record: the one way to learn what it serves short
/// of sending it a message, and a person's act, so it is allowed to wake it.
class _WakeRow extends StatelessWidget {
  const _WakeRow({required this.inset, required this.onTap});

  final double inset;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => PaneMenuAction(
    onPressed: onTap,
    builder: (context, active) => Padding(
      padding: EdgeInsets.symmetric(horizontal: inset, vertical: 10),
      child: Row(
        children: [
          SizedBox(
            width: _kWakeIconColumn,
            child: Icon(
              AppIcons.eye,
              size: _kWakeIconSize,
              color: active ? grid.AppDesktop.onSelection : DesktopChrome.muted,
            ),
          ),
          SizedBox(width: inset),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  kShowModels,
                  style: DesktopChrome.control(
                    medium: true,
                    color: active ? grid.AppDesktop.onSelection : null,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  kShowModelsWait,
                  style: DesktopChrome.metadata(
                    color: active ? grid.AppDesktop.onSelection : null,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    ),
  );
}

/// "Stop [model]?" before Use stops the local model other harnesses are on, to start another in its
/// place (one runs at a time). Only asked when [users] — those harnesses' names — is not empty: the
/// harness being switched is moving off it anyway. True only for the button that says so.
Future<bool> confirmStopInUse(
  BuildContext context, {
  required String model,
  required List<String> users,
}) async =>
    await showAppDialog<bool>(
      context: context,
      builder: (_) => _StopInUsePrompt(model: model, users: users),
    ) ??
    false;

class _StopInUsePrompt extends StatefulWidget {
  const _StopInUsePrompt({required this.model, required this.users});

  final String model;
  final List<String> users;

  @override
  State<_StopInUsePrompt> createState() => _StopInUsePromptState();
}

class _StopInUsePromptState extends State<_StopInUsePrompt> {
  final _cancel = FocusNode(debugLabel: 'Cancel stopping a model in use');

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && ModalRoute.of(context)?.isCurrent != false) {
        _cancel.requestFocus();
      }
    });
  }

  @override
  void dispose() {
    _cancel.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final users = widget.users;
    final who = users.length == 1
        ? users.single
        : '${users.first} and ${users.length - 1} more';
    return DesktopPromptSurface(
      body: DesktopPromptScrollBody(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('Stop ${widget.model}?', style: DesktopChrome.heading()),
            const SizedBox(height: DesktopChrome.groupGap),
            Text(
              '$who ${users.length == 1 ? 'uses' : 'use'} it, and will stop answering until '
              '${users.length == 1 ? 'it moves' : 'they move'} to another model. One local model '
              'runs at a time on this computer.',
              style: DesktopChrome.text(size: 13),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(
          focusNode: _cancel,
          onPressed: () => Navigator.pop(context, false),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: () => Navigator.pop(context, true),
          child: const Text('Stop and switch'),
        ),
      ],
    );
  }
}

/// "Switch anyway?" before moving an agent onto [model], every computer serving which seems
/// offline. True only for the button that says so; Cancel, Escape and a click outside all leave
/// the agent where it is. The move itself is never refused — the daemon can be wrong about a
/// computer — but an agent moved there will not answer until it is back.
Future<bool> confirmSwitchAnyway(
  BuildContext context, {
  required String model,
  required GridModelUnavailable offline,
}) async =>
    await showAppDialog<bool>(
      context: context,
      builder: (_) => _SwitchAnywayPrompt(model: model, offline: offline),
    ) ??
    false;

class _SwitchAnywayPrompt extends StatefulWidget {
  const _SwitchAnywayPrompt({required this.model, required this.offline});

  final String model;
  final GridModelUnavailable offline;

  @override
  State<_SwitchAnywayPrompt> createState() => _SwitchAnywayPromptState();
}

class _SwitchAnywayPromptState extends State<_SwitchAnywayPrompt> {
  final _cancel = FocusNode(debugLabel: 'Cancel model switch');

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && ModalRoute.of(context)?.isCurrent != false) {
        _cancel.requestFocus();
      }
    });
  }

  @override
  void dispose() {
    _cancel.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return DesktopPromptSurface(
      body: DesktopPromptScrollBody(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(kSwitchAnyway, style: DesktopChrome.heading()),
            const SizedBox(height: DesktopChrome.groupGap),
            Text(
              offlineNoteSentence(widget.offline.machine, widget.model),
              style: DesktopChrome.text(size: 13),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(
          focusNode: _cancel,
          onPressed: () => Navigator.pop(context, false),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: () => Navigator.pop(context, true),
          child: const Text(kSwitchAnywayAction),
        ),
      ],
    );
  }
}
