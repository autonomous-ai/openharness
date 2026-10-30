import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/core/models.dart' show Agent;
import 'package:harness_mobile/core/project_folder.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/widgets/empty_state.dart';
import 'package:harness_mobile/state/app_state.dart';

import 'add_device/add_device_page.dart';
import 'welcome/connect_computer.dart';
import 'welcome/set_up_computer.dart' show ComputerSteps;
import 'welcome/your_computer.dart';
import 'tty_controls.dart';
import 'tty.dart';
import 'find_row.dart';
import 'machine_actions.dart';
import 'machine_index.dart';
import 'phone_card.dart';
import 'phone_navigation.dart';
import 'phone_status.dart';
import 'settings_page.dart' show PhoneSettingsButton;

/// The machines on the account, grouped by what they need.
///
/// The desktop lists machines in account order, because its rail shows every one at once and the
/// order is the only stable thing about it. A phone screen holds five or six rows, so the order
/// has to carry meaning instead: the machines that are linked and working go first, because those
/// are the ones somebody opens day to day. The machines that want something — a password, a
/// Harness that is not running — collect underneath, where they read as a to-do list rather than
/// as the thing standing between you and the machine you actually came for.
class MachinesTab extends StatelessWidget {
  const MachinesTab({
    super.key,
    required this.notifier,
    this.large = true,
    this.fromTerminal = false,
    this.fromSettings = false,
  });

  final AppNotifier notifier;

  /// The tab's big title. Off when this is PUSHED — from Settings or a swipe left on the terminal —
  /// where it draws the back chevron above its title instead, as Settings itself does.
  final bool large;

  /// Pushed by a swipe left on the terminal: a swipe right ANYWHERE goes back — the way home is the
  /// same swipe the other way, as on the New Harness form.
  final bool fromTerminal;

  /// Pushed from Settings ▸ Computers: no Settings at the top right — back is the way there, and
  /// Settings again over this list would stack Settings on Settings.
  final bool fromSettings;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: notifier,
    builder: (context, _) {
      AppTheme.watch(context);
      final tty = Tty.of(context);
      // The ↻ at the top right, where Settings was (owner, 2026-10-13). Settings stays beside it
      // only on the home screen — while no computer is ready, nothing else there leads to Settings
      // or Sign out. Pushed, back leads to a screen that has it.
      final showSettings = large && !fromSettings;
      final page = Scaffold(
        backgroundColor: tty.ground,
        body: SafeArea(
          bottom: false,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (!large)
                Align(
                  alignment: Alignment.centerLeft,
                  child: TtyBackButton(
                    onPressed: () => Navigator.of(context).maybePop(),
                  ),
                ),
              Row(
                children: [
                  Expanded(
                    child: Padding(
                      padding: EdgeInsets.fromLTRB(
                        Tty.origin,
                        large ? 12 : 8,
                        Tty.origin,
                        4,
                      ),
                      child: TtyText(
                        'Computers',
                        size: large ? 24 : TtySize.title,
                        weight: FontWeight.w600,
                      ),
                    ),
                  ),
                  // What a pull on the list does, for whoever does not know to pull — or has
                  // nothing to pull: the empty and failed states draw no list.
                  _RefreshButton(
                    busy:
                        notifier.machinesRefreshing || notifier.machinesLoading,
                    trailing: !showSettings,
                    onPressed: () => unawaited(notifier.retryMachines()),
                  ),
                  if (showSettings) PhoneSettingsButton(notifier: notifier),
                ],
              ),
              Expanded(
                child: _Body(notifier: notifier, home: large),
              ),
            ],
          ),
        ),
      );
      return fromTerminal ? _SwipeBack(child: page) : page;
    },
  );
}

/// A swipe right anywhere on [child] pops it — not only the system's sliver of left edge, which a
/// thumb in the middle of the screen never finds. The New Harness form's reach and flick.
class _SwipeBack extends StatefulWidget {
  const _SwipeBack({required this.child});

  final Widget child;

  @override
  State<_SwipeBack> createState() => _SwipeBackState();
}

class _SwipeBackState extends State<_SwipeBack> {
  /// How far right the drag under way has gone.
  double _swiped = 0;

  @override
  Widget build(BuildContext context) => GestureDetector(
    // Translucent: the rows under the finger still take their taps; the list scrolls on the other
    // axis.
    behavior: HitTestBehavior.translucent,
    onHorizontalDragStart: (_) => _swiped = 0,
    onHorizontalDragUpdate: (details) => _swiped += details.primaryDelta ?? 0,
    onHorizontalDragEnd: (details) {
      if (_swiped >= 64 || (details.primaryVelocity ?? 0) >= 300) {
        unawaited(Navigator.of(context).maybePop());
      }
    },
    child: widget.child,
  );
}

class _Body extends StatelessWidget {
  const _Body({required this.notifier, required this.home});

  final AppNotifier notifier;

  /// This list is the home screen ([MachinesTab.large]), not pushed over it.
  final bool home;

  @override
  Widget build(BuildContext context) {
    // The order a swipe on the machine page walks, split back into the runs this list draws.
    // Taken from [visibleMachines] rather than partitioned here so the page and the list cannot
    // drift apart — the split below ([_rows]) is presentation, the order is not.
    final ordered = visibleMachines(notifier);
    if (ordered.isEmpty &&
        (notifier.machinesLoading || notifier.machinesRefreshing)) {
      return const PhoneListSkeleton();
    }
    // ⚠️ A list that could not be fetched is not an empty one. Drawn as "No machines yet", it told
    // somebody with three machines to go and set one up — and with nothing in the list there was no
    // pull-to-refresh either, so no way to try again short of restarting the app.
    final failure = notifier.lastError;
    if (ordered.isEmpty && failure != null) {
      return EmptyState(
        icon: LucideIcons.circleAlert300,
        title: "Couldn't reach your computers",
        message: failure,
        action: FilledButton(
          onPressed: () => unawaited(notifier.retryMachines()),
          child: const Text('Try again'),
        ),
      );
    }
    if (ordered.isEmpty) {
      // ⚠️ With the way to set one up, as the list's own last row offers it: reached from Settings
      // on a phone with no computer yet, this was a sentence and nothing to press.
      return EmptyState(
        icon: LucideIcons.laptopMinimal300,
        title: 'No computers yet',
        message:
            'Set up Harness on your computer, signed in to this account, and it '
            'appears here.',
        action: FilledButton(
          key: const ValueKey('machines-set-up'),
          onPressed: () => _setUpComputer(context),
          child: const Text('Add computer'),
        ),
      );
    }

    final tty = Tty.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Expanded(
          child: RefreshIndicator(
            onRefresh: notifier.retryMachines,
            child: ListView(
              physics: const AlwaysScrollableScrollPhysics(),
              // The bar under the list keeps clear of the home indicator; the list only of the bar.
              padding: const EdgeInsets.only(bottom: 16),
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(
                    Tty.origin,
                    0,
                    Tty.origin,
                    8,
                  ),
                  child: Text(
                    'Your harnesses run on these.',
                    style: tty.style(size: TtySize.meta, color: tty.faint),
                  ),
                ),
                ..._rows(context, ordered, tty),
              ],
            ),
          ),
        ),
        _ConnectBar(
          key: const ValueKey('machines-connect-bar'),
          notifier: notifier,
          home: home,
          onSetUp: () => _setUpComputer(context),
        ),
      ],
    );
  }

  /// [ordered]'s rows — each run of computers that want the same thing under one line that says it
  /// once, `offline · turn them on, or run harness start there`, rather than the same words under
  /// every row: six offline computers said it six times, half the screen of one sentence.
  ///
  /// A run of one keeps its own second line: a header over a single row is two lines saying what
  /// one did, and in the singular. The working ones each say their own thing — how many harnesses —
  /// and are never gathered. Runs, not sorting: [visibleMachines] already puts each kind together.
  List<Widget> _rows(
    BuildContext context,
    List<MachineState> ordered,
    Tty tty,
  ) {
    final rows = <Widget>[];
    var start = 0;
    while (start < ordered.length) {
      final status = phoneMachineStatusOf(ordered[start]);
      var end = start + 1;
      while (end < ordered.length &&
          phoneMachineStatusOf(ordered[end]) == status) {
        end++;
      }
      final group = _groupOf(status);
      final gathered = group != null && end - start > 1;
      if (group != null && gathered) {
        rows.add(_GroupLine(word: group.word, hint: group.hint));
      }
      for (final state in ordered.sublist(start, end)) {
        rows.add(_row(context, state, tty, ownLine: !gathered));
      }
      start = end;
    }
    return rows;
  }

  /// What a run of computers in [status] is called over it ([phoneMachineWord]), and what to do
  /// about them, said once — null for the ones that need nothing.
  static ({String word, String hint})? _groupOf(PhoneMachineStatus status) =>
      switch (status) {
        PhoneMachineStatus.needsPassword => (
          word: phoneMachineWord(status),
          hint: 'tap one to unlock: scan its code',
        ),
        PhoneMachineStatus.offline => (
          word: phoneMachineWord(status),
          hint: 'turn them on, or run harness start there',
        ),
        PhoneMachineStatus.ready || PhoneMachineStatus.connecting => null,
      };

  /// A row whose second line its group's own line says instead — one line, a thumb's height.
  static const double _gatheredRowHeight = 48;

  /// Add computer: the onboarding's "On your computer, go to" over this list — the address that
  /// sends the download, and the account watched for the computer that opens it. A second computer
  /// is set up the way the first was (`welcome/your_computer.dart`).
  void _setUpComputer(BuildContext context) => unawaited(
    Navigator.of(context)
        .push(phoneRoute((_) => YourComputerPage(notifier: notifier))),
  );

  /// [ownLine] false: its run's [_GroupLine] says what the second line would have, so it has none.
  Widget _row(
    BuildContext context,
    MachineState state,
    Tty tty, {
    bool ownLine = true,
  }) {
    final status = phoneMachineStatusOf(state);
    final count = state.agents.length;
    final machineId = state.machine.machineId;
    var word = phoneMachineWord(status);
    var (Color color, String detail) = switch (status) {
      PhoneMachineStatus.ready => (
        tty.green,
        count == 0
            ? 'nothing running'
            : '$count harness${count == 1 ? '' : 'es'}',
      ),
      PhoneMachineStatus.connecting => (tty.faint, 'one moment…'),
      PhoneMachineStatus.needsPassword => (
        tty.yellow,
        'tap to unlock: scan its code',
      ),
      PhoneMachineStatus.offline => (
        tty.faint,
        'turn it on, or run harness start there',
      ),
    };
    // Something asked of it by hand is still on its way: the row says so, rather than the state it
    // is about to leave.
    if (notifier.machineRemoving(machineId)) {
      (word, color) = ('removing…', tty.faint);
    } else if (notifier.machineRetrying(machineId)) {
      (word, color) = ('trying…', tty.faint);
    } else if (notifier.isNewMachine(machineId) &&
        status == PhoneMachineStatus.ready) {
      // Just set up from this phone (Set up Intern 3): which one it is, among the rest. Not green:
      // beside the green Start it read as a second button. Gone once Start is pressed: its spinner
      // says enough.
      (word, color) = (
        notifier.machineStarting(machineId) ? '' : 'new',
        tty.text,
      );
    }
    // Whether it runs Harness OS and has an update, for its sheet's Update and Change Wi-Fi; asked
    // at most every few minutes, the answer redrawing the list.
    if (status == PhoneMachineStatus.ready) {
      unawaited(notifier.refreshOsStatus(machineId));
    }
    // Just set up from this phone: Start, to its harness, or to a new OpenCode there when it has none.
    final start =
        notifier.isNewMachine(machineId) && status == PhoneMachineStatus.ready;
    return FindRow(
      title: state.machine.displayName,
      detail: ownLine ? detail : null,
      minHeight: ownLine ? FindRow.height : _gatheredRowHeight,
      state: word,
      stateColor: color,
      accessory: start
          ? _StartButton(notifier: notifier, machineId: machineId)
          : null,
      accessoryRoom: start ? _StartButton.room : 0,
      // ⚠️ An offline computer is tappable now. It used to be drawn inert, with nothing a tap could do
      // for it — and it is exactly the one somebody wants to try again, rename, or take off the
      // account.
      onTap: () => _open(context, state),
    );
  }

  /// One sheet for every computer, whatever it reads — see [openMachineActions]. A locked one has
  /// "Unlock…" at its head, the act its row offers; one place decides what a computer offers, so no
  /// state can lose the rename or the removal.
  void _open(BuildContext context, MachineState state) {
    notifier.sawMachine(state.machine.machineId);
    openMachineActions(context, notifier, state.machine.machineId);
  }
}

/// Over a run of computers that want the same thing: what they are, then what to do about them —
/// `offline · turn them on, or run harness start there` — said once for the run.
class _GroupLine extends StatelessWidget {
  const _GroupLine({required this.word, required this.hint});

  final String word;
  final String hint;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    return Semantics(
      header: true,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(Tty.origin, 16, Tty.origin, 4),
        // Wraps rather than clips: at a large text size the hint is two lines, and the half cut off
        // was the half that said what to do.
        child: Text.rich(
          TextSpan(
            children: [
              TextSpan(
                text: word,
                style: tty.style(
                  color: tty.text,
                  size: TtySize.meta,
                  weight: FontWeight.w600,
                ),
              ),
              TextSpan(text: ' · $hint'),
            ],
          ),
          style: tty.style(color: tty.faint, size: TtySize.meta),
        ),
      ),
    );
  }
}

/// The foot of Computers, under the list and kept there however long it grows: **Add computer** —
/// the onboarding's own step ② ("On your computer, go to"), the way every computer is added now —
/// and under it, quietly, the camera, for a desktop from before that still pairs by its Add Phone
/// QR code.
///
/// Pinned, not the list's last rows: at the end of a list they sat after every computer, read as
/// two more of them, and went below the fold at nine. Down here they are where a thumb already is.
///
/// How a scan goes is said on a line over the button — under the list, where the computer it pairs
/// turns up; once paired, the computer is in the list.
class _ConnectBar extends StatefulWidget {
  const _ConnectBar({
    super.key,
    required this.notifier,
    required this.home,
    required this.onSetUp,
  });

  final AppNotifier notifier;

  /// This list is the home screen, which a computer turning up takes away: the code goes to the
  /// home screen to pair by — [scanAndPairComputer]'s `handOff`.
  final bool home;

  /// Add computer: "On your computer, go to", pushed over this list.
  final VoidCallback onSetUp;

  /// "Or scan the QR code on your computer" under Add computer — hidden, its code kept (owner,
  /// 2026-10-13). Signed in here, a computer on the same account turns up and is trusted by itself
  /// (the device key log), and one that still wants a code reads "locked" in the list, whose
  /// Unlock page leads with "Scan its code": the line only repeated that, and under Add computer it
  /// read as a second way to add one.
  static const offerScan = false;

  @override
  State<_ConnectBar> createState() => _ConnectBarState();
}

class _ConnectBarState extends State<_ConnectBar> {
  /// What the last scan came to, while it is worth saying: pairing, or why it did not.
  String? _said;
  bool _failed = false;

  /// A scan under way, from the camera to its answer: one at a time, so a one-time code is never
  /// spent on two pairings.
  bool _scanning = false;

  void _say(String? message, {bool failed = false}) => setState(() {
    _said = message;
    _failed = failed;
  });

  Future<void> _scan() async {
    if (_scanning) return;
    setState(() => _scanning = true);
    try {
      await scanAndPairComputer(
        context,
        widget.notifier,
        say: _say,
        handOff: widget.home,
        // ⚠️ Said on the camera, because nothing here says it. The camera only scans (owner,
        // 2026-10-08) and leaves the steps on the computer to the page it is opened from — Set up
        // another computer has them under its own Connect computer. Opened from here, somebody who
        // came to the phone first faced a camera and "Scan the code on your computer" with no code
        // on the computer and no word of how to bring one up. That page's steps, word for word.
        steps: ComputerSteps(account: widget.notifier.currentUser?.email),
      );
    } finally {
      if (mounted) setState(() => _scanning = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    final said = _said;
    return DecoratedBox(
      decoration: BoxDecoration(
        color: tty.ground,
        // The new-device banner's rule: the list scrolls under this edge, and without it the last
        // row ran into the button.
        border: Border(top: BorderSide(color: tty.dim.withValues(alpha: 0.25))),
      ),
      child: Padding(
        // SafeArea leaves the foot to this page: the bar keeps clear of the home indicator itself.
        // Without the scan's line under the button, the gap under it is the one over it.
        padding: EdgeInsets.only(
          top: 12,
          bottom:
              MediaQuery.paddingOf(context).bottom +
              (_ConnectBar.offerScan ? 0 : 12),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: Tty.origin),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (said != null)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 8),
                      child: Text(
                        _failed ? '✗ $said' : said,
                        key: const ValueKey('machines-connect-status'),
                        style: tty.style(
                          size: TtySize.meta,
                          color: _failed ? tty.red : tty.faint,
                        ),
                      ),
                    ),
                  TtyPrimaryButton(
                    key: const ValueKey('machines-add-computer'),
                    icon: LucideIcons.laptopMinimal300,
                    label: 'Add computer',
                    onPressed: widget.onSetUp,
                  ),
                  // A Harness with no screen, or one locked as it starts: Settings' Set up Intern 3,
                  // here too, where the computers are.
                  const SizedBox(height: 4),
                  Center(
                    child: TtyTextButton(
                      key: const ValueKey('machines-set-up-device'),
                      label: 'Set up Intern 3',
                      onPressed: () => Navigator.of(context).push(
                        phoneRoute(
                          (_) => AddDevicePage(notifier: widget.notifier),
                        ),
                      ),
                    ),
                  ),
                  // A desktop from before shows its Add Phone QR code rather than an address: the
                  // camera pairs with it. "QR code", not "Add Phone code" — a desktop menu's name
                  // read as a noun stack under a button named for the other side.
                  if (_ConnectBar.offerScan)
                    Center(
                      child: TtyTextButton(
                        key: const ValueKey('machines-connect-computer'),
                        label: _scanning
                            ? 'Scanning…'
                            : 'Or scan the QR code on your computer',
                        size: TtySize.meta,
                        color: tty.faint,
                        onPressed: _scanning ? null : () => unawaited(_scan()),
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
}

/// The list read again — what a pull does ([AppNotifier.retryMachines]) — as a glyph at the top
/// right, beside Settings on the home screen.
///
/// While a read the person asked for is running ([busy]) the glyph turns and a press does nothing;
/// it keeps its ink rather than greying out, because it is working, not unavailable — the rail's
/// reload says the same (`AppIconButton.spinning`). The deaf poll's own reads do not turn it: every
/// few seconds, that would be a glyph that never stops.
class _RefreshButton extends StatefulWidget {
  const _RefreshButton({
    required this.busy,
    required this.trailing,
    required this.onPressed,
  });

  final bool busy;

  /// Last in its row, with no Settings after it (the list pushed): the glyph sits on the right
  /// gutter, in Settings' own box. Otherwise it stands left of Settings, which keeps its place on
  /// the gutter.
  final bool trailing;

  final VoidCallback onPressed;

  @override
  State<_RefreshButton> createState() => _RefreshButtonState();
}

class _RefreshButtonState extends State<_RefreshButton>
    with SingleTickerProviderStateMixin {
  /// One turn — the rail's reload's (`AppIconButton`).
  static const Duration _spinPeriod = Duration(milliseconds: 900);

  late final AnimationController _spin = AnimationController(
    vsync: this,
    duration: _spinPeriod,
  );

  @override
  void initState() {
    super.initState();
    if (widget.busy) _spin.repeat();
  }

  @override
  void didUpdateWidget(_RefreshButton oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.busy == oldWidget.busy) return;
    if (widget.busy) {
      _spin.repeat();
    } else {
      // The turn under way lands upright instead of freezing at whatever angle the reply arrived:
      // a glyph stopped askew reads as stuck.
      _spin
          .animateTo(1, duration: _spinPeriod * (1 - _spin.value))
          .whenComplete(() {
            if (mounted && !widget.busy) _spin.value = 0;
          });
    }
  }

  @override
  void dispose() {
    _spin.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    return Semantics(
      button: true,
      enabled: !widget.busy,
      label: 'Refresh',
      excludeSemantics: true,
      child: GestureDetector(
        key: const ValueKey('machines-refresh'),
        behavior: HitTestBehavior.opaque,
        onTap: () {
          if (widget.busy) return;
          HapticFeedback.selectionClick();
          widget.onPressed();
        },
        // A thumb's 44. Beside Settings the glyph keeps to the box's right edge: Settings' box
        // already leaves room left of its own glyph, and centred here the two sat a button apart.
        child: SizedBox(
          width: widget.trailing ? 52 : 44,
          height: 44,
          child: Padding(
            padding: EdgeInsets.only(
              right: widget.trailing ? Tty.origin - 2 : 2,
            ),
            child: Align(
              alignment: Alignment.centerRight,
              child: RotationTransition(
                turns: _spin,
                child: Icon(
                  LucideIcons.refreshCw300,
                  size: 20,
                  color: tty.faint,
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Start, on a computer just set up from this phone: its harness — OpenCode first — or, with none
/// there yet, a new OpenCode in a fresh project of its own, opened as soon as it is up.
class _StartButton extends StatefulWidget {
  const _StartButton({required this.notifier, required this.machineId});

  final AppNotifier notifier;
  final String machineId;

  /// Kept at the end of the row's first line for it.
  static const double room = 76;

  @override
  State<_StartButton> createState() => _StartButtonState();
}

class _StartButtonState extends State<_StartButton> {
  bool get _busy => _app.machineStarting(widget.machineId);

  AppNotifier get _app => widget.notifier;

  Agent? _harness() {
    final agents = _app.machineStates[widget.machineId]?.agents ?? const [];
    bool opencode(Agent agent) =>
        '${agent.name} ${agent.title ?? ''}'.toLowerCase().contains('opencode');
    return agents.where(opencode).firstOrNull ?? agents.firstOrNull;
  }

  Future<void> _start() async {
    final messenger = ScaffoldMessenger.maybeOf(context);
    var harness = _harness();
    _app.setMachineStarting(widget.machineId, true);
    // As the desktop's first run: the harness in a tab of its own, "code", on the account's desk —
    // the tab this computer's screen opens on when someone signs in there, rather than a second
    // OpenCode of its own. Read first, so the tab has a desk to be written to.
    await _app.readDesk();
    if (harness == null) {
      _app.openNextAgentInNewDeskTab(name: 'code');
      final failed = await _app.createAgent(
        widget.machineId,
        engine: 'opencode',
        folder: '',
        projectFolder: const ProjectFolderRequest.newProject(),
      );
      if (failed != null) {
        _app.forgetNewDeskTabIntent();
        _app.setMachineStarting(widget.machineId, false);
        messenger?.showSnackBar(SnackBar(content: Text(failed)));
        return;
      }
      // Up when the computer lists it.
      final deadline = DateTime.now().add(const Duration(seconds: 30));
      while ((harness = _harness()) == null &&
          DateTime.now().isBefore(deadline)) {
        await Future<void>.delayed(const Duration(seconds: 1));
      }
      _app.setMachineStarting(widget.machineId, false);
      if (!mounted) return;
      if (harness == null) {
        messenger?.showSnackBar(
          const SnackBar(
            content: Text(
              'OpenCode is still starting there. Try again in a moment.',
            ),
          ),
        );
        return;
      }
    } else {
      _app.setMachineStarting(widget.machineId, false);
      // There already, in a tab (the screen's own) or in none: one of none gets its "code" tab.
      final ref = (machineId: widget.machineId, agentId: harness.id);
      final tab = _app.deskTabs
          .where(
            (t) => t.panes.any(
              (p) => p.machineId == ref.machineId && p.agentId == ref.agentId,
            ),
          )
          .firstOrNull;
      if (tab != null) {
        _app.selectDeskTab(tab.id);
      } else {
        _app.createDeskTabFor(ref, name: 'code');
      }
    }
    _app.sawMachine(widget.machineId);
    if (mounted) openAgent(context, _app, widget.machineId, harness.id);
  }

  /// While it starts, a spinner where "Start" was: the word "Starting…" is wider than [room] and
  /// ran over the row's "new". The hidden "Start" keeps the place, so nothing beside it moves.
  @override
  Widget build(BuildContext context) {
    final green = Tty.of(context).green;
    final button = TtyTextButton(
      key: ValueKey('machines-start-${widget.machineId}'),
      label: 'Start',
      color: green,
      weight: FontWeight.w600,
      onPressed: _busy ? null : () => unawaited(_start()),
    );
    if (!_busy) return button;
    return Semantics(
      label: 'Starting',
      child: Stack(
        alignment: Alignment.center,
        children: [
          ExcludeSemantics(child: Opacity(opacity: 0, child: button)),
          SizedBox.square(
            dimension: 16,
            child: CircularProgressIndicator(strokeWidth: 1.8, color: green),
          ),
        ],
      ),
    );
  }
}
