import 'package:flutter/material.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/state/app_state.dart';

import '../../demo/sample_mode.dart' show SampleMode;
import '../agent_index.dart';
import '../agents_page.dart' show openNewAgent;
import '../phone_status.dart';
import '../phone_search_controller.dart';
import '../phone_search_results.dart';
import '../tty.dart';
import '../tty_controls.dart';

/// The first screen once a computer is there: **Pick up where you left off**, every session on
/// your computers with the ones that moved last on top, each a tap from its terminal.
///
/// What the phone opens on when it has nothing to remember (a new phone, or a computer just linked)
/// in place of guessing one session and dropping you into it cold. The owner: "the welcome screen
/// should display a list of sessions so users can just click and start right away, rather than a
/// blank cold screen."
///
/// ⚠️ **The list is Find's own** ([PhoneSearchResults]): the same rows, state words, resume for a
/// paused session, and `+ New Harness` at the end. The first screen teaches the one a swipe right
/// brings back, and a tap opens through the same path Find uses (`openAgent` → the home screen).
class PickUpPage extends StatefulWidget {
  const PickUpPage({super.key, required this.notifier});

  final AppNotifier notifier;

  @override
  State<PickUpPage> createState() => _PickUpPageState();
}

class _PickUpPageState extends State<PickUpPage> {
  late final _search = PhoneSearchController(
    notifier: widget.notifier,
    history: widget.notifier.searchHistory,
    modes: false,
  );

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  /// `12 harnesses on MacBook Pro`, or `on 2 computers` — the app's word for one, not "session".
  String _where() {
    final entries = visibleAgents(agentIndex(widget.notifier));
    final computers = {for (final entry in entries) entry.machineName};
    final sessions =
        '${entries.length} ${entries.length == 1 ? 'harness' : 'harnesses'}';
    return computers.length == 1
        ? '$sessions on ${computers.single}'
        : '$sessions on ${computers.length} computers';
  }

  /// `+ New Harness`: in the project a row names, else on the first computer that can take one.
  void _newHarness(({String machineId, String folder, String label})? place) {
    if (place != null) {
      openNewAgent(
        context,
        widget.notifier,
        place.machineId,
        folder: place.folder,
      );
      return;
    }
    final ready = filterableMachines(widget.notifier)
        .where(
          (machine) =>
              phoneMachineStatusOf(machine) == PhoneMachineStatus.ready,
        )
        .firstOrNull;
    if (ready != null) {
      openNewAgent(context, widget.notifier, ready.machine.machineId);
    }
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.notifier,
    builder: (context, _) {
      AppTheme.watch(context);
      final tty = Tty.of(context);
      return Scaffold(
        backgroundColor: tty.ground,
        body: SafeArea(
          bottom: false,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(
                  Tty.origin,
                  20,
                  Tty.origin,
                  0,
                ),
                child: Text(
                  // Broken by hand: at 28pt it wraps with "off" alone on the second line.
                  SampleMode.maybeOf(context) != null
                      ? 'Try a sample\nharness'
                      : 'Pick up where\nyou left off',
                  key: const ValueKey('pick-up-title'),
                  style: tty
                      .style(size: TtySize.display, weight: FontWeight.w600)
                      .copyWith(height: 34 / 28, letterSpacing: -0.6),
                ),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(
                  Tty.origin,
                  6,
                  Tty.origin,
                  8,
                ),
                child: TtyText(_where(), color: tty.faint, size: TtySize.meta),
              ),
              Expanded(
                child: PhoneSearchResults(
                  notifier: widget.notifier,
                  controller: _search,
                  onNewHarness: _newHarness,
                ),
              ),
            ],
          ),
        ),
      );
    },
  );
}
