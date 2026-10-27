import '../measurement/product_measurement.dart';
import '../measurement/task_feedback.dart';

import 'dart:async';
import 'dart:ui' as ui;

// `defaultTargetPlatform` — the navigation bar this page keeps clear of is
// Android's alone; see [_TerminalPageState._navigationBar].
import 'package:flutter/foundation.dart'
    show ValueListenable, defaultTargetPlatform;
import 'package:flutter/material.dart';
// `PlatformException` — a refused camera permission arrives as one, and it is
// the one picker failure with something the person can do about it.
import 'package:flutter/services.dart';
import 'package:image_picker/image_picker.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter/semantics.dart'
    show CustomSemanticsAction, SemanticsService;
import 'package:xterm/xterm.dart' show Terminal, TerminalKey, TerminalStyle;

import 'package:harness_mobile/logging/app_log.dart';
import 'package:harness_mobile/logging/typing_trace.dart';
import 'package:harness_mobile/core/models.dart'
    show Agent, AgentProject, ConnectionStatus;
import 'package:harness_mobile/core/first_task.dart';
import 'package:harness_mobile/terminal/terminal_prompt_zone.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/widgets/skeleton.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/terminal/image_transcode.dart';
import 'package:harness_mobile/terminal/terminal_font_store.dart';
import 'package:harness_mobile/terminal/terminal_theme.dart';
import 'package:harness_mobile/terminal/terminal_theme_store.dart';
import 'package:harness_mobile/terminal/elicitation_press.dart';
import 'package:harness_mobile/terminal/key_hints.dart';
import 'package:harness_mobile/terminal/question_pane.dart';
import 'package:harness_mobile/terminal/question_pane_watcher.dart';
import 'package:harness_mobile/terminal/terminal_find.dart';
import 'package:harness_mobile/terminal/terminal_session.dart';
import 'package:harness_mobile/core/agent_handoff.dart'
    show supportsAgentHandoff;
import 'package:harness_mobile/widgets/engine_identity.dart'
    show engineIdentity;
import 'package:harness_mobile/widgets/fork_agent_dialog.dart';
import 'package:harness_mobile/widgets/rename_agent_dialog.dart';
import 'package:harness_mobile/widgets/terminal_panel.dart';

import 'agent_model_sections.dart';
import 'first_task_suggestion.dart';
import 'welcome/onboarding_copy.dart';
import 'agent_model_sheet.dart';
import 'daemon_chip.dart';
import 'daemon_scope.dart';
import 'delete_agent.dart';
import 'held_height.dart';
import 'machines_tab.dart';
import 'new_agent_chooser.dart';
import 'out_of_sight.dart';
import 'phone_sheet.dart';
import 'phone_status.dart';
import 'settings_page.dart';
import 'session_work_page.dart';
import 'terminal_action_column.dart';
import 'terminal_chrome_scroll.dart';
import 'terminal_input_dock.dart';
import 'terminal_copy.dart';
import 'terminal_file_send.dart';
import 'terminal_find_bar.dart';
import 'terminal_paste.dart';
import 'terminal_search.dart';
import 'tty.dart';
import 'tty_controls.dart';
import 'question_keys.dart';
import 'voice_bar_line.dart';
import 'voice_mic_button.dart';
import 'phone_navigation.dart';
import 'phone_shell_scope.dart';
import 'phone_search_catalog.dart' show phoneAgentId;
import 'agent_index.dart';
import 'terminal_title.dart';
import 'welcome/focus_hints.dart';

import 'package:harness_mobile/demo/sample_mode.dart';
import 'package:harness_mobile/notify/notifications_ask.dart';
import 'package:harness_mobile/swarm/swarm_mark.dart';

import 'voice_input_controller.dart';

/// One agent's terminal, filling the phone. The header says whose it is and whether it is live;
/// everything below it is the same [TerminalPanel] a desktop tile draws, minus that tile's own
/// header.
///
/// A pushed page, so the tab bar is covered: the bottom of this screen belongs to the composer, and
/// a nav bar under it would put two rows of chrome in the thumb's way.
class TerminalPage extends StatefulWidget {
  const TerminalPage({
    super.key,
    required this.notifier,
    required this.machineId,
    required this.agentId,
    required this.voice,
    this.isActive = true,
    this.sideSwipes = true,
  });

  final AppNotifier notifier;
  final String machineId;
  final String agentId;

  /// Voice input, shared by every page of the pager this page is in — see
  /// [VoiceInputController] for why it is not this page's own.
  final VoiceInputController voice;

  /// Whether this is the page being LOOKED AT, rather than one parked beside it in the pager.
  ///
  /// ⚠️ **Load-bearing for correctness, not just for tidiness.** [TerminalPanel] claims the keyboard
  /// whenever it is built focused — `requestKeyboard()` reopens the input connection on purpose — so
  /// two mounted pages both passing `focused: true` race for the software keyboard, and the winner
  /// can be the page off-screen. What gets typed then reaches an agent nobody is looking at.
  ///
  /// It also drives the panel's `visible`, which is what releases focus and stops the auto-resize for
  /// a page that has slid away — three terminals all resizing themselves to the layout would send
  /// SIGWINCH to three remote shells at once.
  final bool isActive;

  /// Whether a sideways swipe on the terminal opens Find (right) or Computers (left).
  ///
  /// Off for a page inside a pager of agents (`AgentSwipeHost` with neighbours), where the sideways
  /// axis is the pager's: the terminal's own detector sits deeper and would win every drag.
  final bool sideSwipes;

  @override
  State<TerminalPage> createState() => _TerminalPageState();
}

/// Whether the software keyboard is up, as one fact rather than as a flag each
/// page keeps for itself.
///
/// ⚠️ Per-page state cannot answer the question the pager asks. Swiping to the
/// next agent while typing must HOLD the keyboard — the outgoing page releases
/// focus, and unless the incoming one takes it in the same frame the platform
/// closes the keyboard — and a page built while the keyboard was down, then
/// swiped to after it rose, never watched it rise. Whether the keyboard is up is
/// a property of the SCREEN, not of any one page, so it is kept once here.
///
/// Written by every mounted page's `didChangeMetrics` — they all see the same
/// inset, so they all write the same value.
bool _keyboardIsUp = false;

/// Set while a swipe has asked the keyboard to go and the platform has not
/// finished taking it away.
///
/// ⚠️ **Without this, dismissing on a swipe silently does nothing.** The
/// keyboard leaves over an animation, so for the ~250ms after `unfocus()` the
/// inset is still above zero — and every mounted page's [didChangeMetrics] is
/// firing on every frame of that animation, each one writing `_keyboardIsUp =
/// true` again. The page being swiped to then reads the flag it was supposed to
/// have lost, passes `focused: true` to [TerminalPanel], and the panel's
/// `didUpdateWidget` claims the input connection back. The keyboard never goes,
/// and nothing in the code looks wrong.
///
/// So the writes are held off until the inset actually reaches zero, which is
/// the platform confirming the keyboard is gone. From that tick on, the flag
/// tracks the truth again as it always did.
bool _keyboardDismissing = false;

/// The onboarding hand-over whose first session has had its keyboard raised — once, across every page
/// a wrapping pager mounts for that agent: each would otherwise raise it again when swiped to.
({String machineId, String agentId, String text})? _firstSessionRaisedFor;

/// Desktop's starter as the first session's OpenCode box was first read, and the hand-over it was
/// read under — see `_TerminalPageState._firstTask`.
({String machineId, String agentId, String text})? _starterFor;
String? _starter;

/// A keyboard asked for again: whatever was putting one away is over, and the inset's ticks are the
/// truth again. Asked for while the last one still slid down, the inset turns back before reaching
/// zero, the hold-off of [dismissKeyboardForSwipe] never ended, and [_keyboardIsUp] read false
/// under a keyboard that was up.
void _keyboardWanted() => _keyboardDismissing = false;

/// Forgets what the keyboard did during the last run of terminal pages.
///
/// Called when a pager opens. A pager popped with the keyboard up is disposed
/// before the inset falls, so no page is left to see it fall — and the next
/// pager would otherwise open believing the keyboard is up, and summon it.
///
/// ⚠️ **A keyboard still on its way DOWN stays held off.** Search opening an
/// agent puts its own keyboard away and opens a pager in the same breath; the
/// inset is still falling as the new pages mount, and clearing the hold-off here
/// let those ticks write [_keyboardIsUp] back to true — the new agent's page
/// then claimed a keyboard nobody had asked for. Kept only while an inset is
/// actually showing, so a hold-off with no keyboard left to fall cannot swallow
/// the next one raised (see [dismissKeyboardForSwipe]).
void resetKeyboardSession() {
  _keyboardIsUp = false;
  _keyboardDismissing =
      _keyboardDismissing &&
      WidgetsBinding.instance.platformDispatcher.views.any(
        (view) => view.viewInsets.bottom > 0,
      );
}

/// Puts the keyboard away for a swipe between agents, and keeps it away.
///
/// ⚠️ **Dropping focus alone does nothing here, and neither does clearing the
/// flag.** [_keyboardIsUp] exists to HOLD the keyboard across a swipe — that is
/// what it was written for — so the incoming page reads it and claims the
/// keyboard straight back. Clearing it is therefore necessary, but not enough on
/// its own: the inset is still falling, and the metrics ticks of that fall put
/// it back. [_keyboardDismissing] is what makes the clear stick until the
/// platform agrees.
///
/// ⚠️ Held off only when a keyboard is actually up. With none, no inset ever
/// falls to zero to end the hold-off, and it would swallow the rise of the next
/// keyboard summoned — which the page would then not know it owns.
void dismissKeyboardForSwipe() {
  _keyboardDismissing = _keyboardDismissing || _keyboardIsUp;
  _keyboardIsUp = false;
  FocusManager.instance.primaryFocus?.unfocus();
}

/// What this page's build reads from [AppNotifier], as one value that can be
/// compared — see [_TerminalPageState._onNotifier]. A record, so two readings
/// are equal when every field is: the session by identity, the project by value.
typedef _PageFacts = ({
  int? paneId,
  TerminalSession? session,
  TerminalSessionStatus? status,
  bool rendered,
  bool hasScreen,
  Terminal? terminal,
  bool watching,
  bool acceptsInput,
  String? tabId,
  String? branch,
  String? agentName,
  String? agentEngine,
  AgentProject? agentProject,
  bool agentPresent,
  bool agentsFromCache,
  AgentLoadStatus? agentLoadStatus,
  bool machinePresent,
  PhoneMachineStatus? machineStatus,
  bool machineAway,
  bool imagePaste,
  String? machineName,
  String? asking,
});

class _TerminalPageState extends State<TerminalPage>
    with WidgetsBindingObserver, TickerProviderStateMixin {
  /// Whether this page's pane ever existed.
  ///
  /// ⚠️ Load-bearing, and the reason this page is stateful at all. The page is pushed BEFORE the
  /// attach — that is what lets it say "Attaching…" — so a null pane means two opposite things
  /// depending on when it is seen: not yet (wait) or no longer (leave).
  ///
  /// Without the distinction, the second case renders as a spinner that never resolves. It is
  /// reachable in normal use now that two tabs can each open a terminal: `openAgent` keeps exactly
  /// one pane, so opening an agent from the Machines tab closes the pane belonging to a
  /// TerminalPage still sitting in the Agents tab's stack.
  bool _hadPane = false;

  /// The agent's name as the last list to carry it knew it.
  ///
  /// Held because the sentence [_AgentGone] shows is about an agent that is, by
  /// then, in no list at all — the name has to be captured while it is still
  /// there or the screen can only say "that agent".
  String? _cachedAgentName;

  /// Whether a tap on the terminal has asked for the keyboard, and it has not
  /// risen yet.
  ///
  /// What makes [TerminalPanel] claim focus at all: arriving on a page raises
  /// nothing, and the panel takes the terminal's tap for [_raiseKeyboard], so
  /// this is the one way the keyboard is SUMMONED. Spent the moment the
  /// keyboard is up — from then on [_keyboardIsUp] holds it — so Back or `⌄`
  /// can put it away without a claim fetching it straight back.
  ///
  /// It stays set when no inset ever arrives, which is what a hardware keyboard
  /// looks like: the terminal keeps its focus, and the key bar stays for `esc`.
  bool _keyboardRequested = false;

  /// Whether the software keyboard is up, and with it [TerminalKeyBar].
  ///
  /// Read from [View] for the reason [didChangeMetrics] gives: MediaQuery's
  /// bottom inset is pinned at zero inside this page.
  bool _keyboardUp = false;

  /// Whether the keyboard is mid-animation, and so the pane's height is still
  /// changing frame by frame. Handed to [TerminalPanel.settling], which holds
  /// the remote resize until this clears.
  bool _keyboardSettling = false;

  /// Whether the keyboard was this page's when the app went into the
  /// background, and so has to come back with it.
  ///
  /// ⚠️ **Android takes the keyboard away on the way out and does not bring it
  /// back.** Switching to another app hides the IME, the inset falls to zero,
  /// and the metrics tick that follows spends [_keyboardRequested] and clears
  /// [_keyboardIsUp] — so the page returned to holds no record that it was
  /// being typed into, and shows a bare terminal over a half-written prompt.
  /// What was on screen on the way out is what belongs on screen on the way
  /// back.
  bool _keyboardHeldForBackground = false;

  /// The lifecycle state as of the last callback, so LEAVING the foreground can
  /// be told apart from arriving back in it.
  ///
  /// ⚠️ **Both directions pass through `inactive`**: resumed → inactive →
  /// paused going away, and paused → inactive → resumed coming back. Recording
  /// the keyboard on every non-resumed state therefore recorded it a second
  /// time on the way home, by which point the keyboard was long gone — wiping
  /// the answer one callback before it was due to be read.
  ///
  /// ⚠️ Read eagerly in `initState`, deliberately NOT as a `late` initializer.
  /// Flutter sets `lifecycleState` BEFORE it notifies observers, so a field
  /// first touched inside the callback would initialise itself to the state
  /// being announced — and the very first announcement a page hears is the app
  /// going away. `was` would then read `inactive`, the branch below would
  /// decide this was not the step out of the foreground, and the one keyboard
  /// worth remembering would be the one never recorded.
  AppLifecycleState _lifecycle = AppLifecycleState.resumed;

  /// Bumped to ask [TerminalPanel] for the input connection again when nothing
  /// else about it has changed — see [didChangeAppLifecycleState].
  int _focusRequest = 0;

  /// Drives the search sheet up from the bottom edge and back down — see
  /// [TerminalSearchOverlay].
  ///
  /// ⚠️ **One controller for the sheet and the dimming behind it, read by
  /// both.** Two, or an implicit animation on either side, would let them drift
  /// apart on a dropped frame: a sheet arriving over a page not yet dimmed, or
  /// the dimming still there after the sheet had gone.
  ///
  /// The timings are [BottomSheet]'s own, as is the curve below, so this sheet
  /// comes and goes like every sheet the app opens as a route — the way down a
  /// little quicker than the way up, the way dismissals usually are.
  late final AnimationController _searchOpen = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 250),
    reverseDuration: const Duration(milliseconds: 200),
  );

  /// The curve everything on the open/close reads: [BottomSheet]'s, which
  /// arrives quickly and settles, and leaves the same way run backwards.
  late final Animation<double> _searchCurve = CurvedAnimation(
    parent: _searchOpen,
    curve: Easing.legacyDecelerate,
  );

  /// Whether the search sheet is BUILT — true from the first frame of the
  /// opening animation to the last frame of the closing one.
  ///
  /// ⚠️ Not the same question as "is the animation at 1". The sheet holds a
  /// [TextField] that may have the keyboard, so it must come down the moment
  /// the sheet is gone and not a frame later — a field left mounted behind the
  /// terminal keeps the keyboard and swallows what the terminal is owed.
  bool _searching = false;

  /// Whether the terminal had the keyboard up when search opened — what closing
  /// it goes back to. See [_closeSearch].
  bool _keyboardBeforeSearch = false;

  /// What this page's own chrome showed for the keyboard when search opened —
  /// [_keyboardUp] then — held for as long as [_heldForSearch]. See
  /// [_terminalKeyboardUp].
  bool _keyboardUpAtSearch = false;

  /// Whether the terminal is still ignoring the search's keyboard: from search
  /// opening until that keyboard is gone — which is AFTER search has closed.
  ///
  /// ⚠️ **Not [_searching], and the difference is the whole bug.** iOS takes
  /// the keyboard's view away at once, but the inset it reports falls over
  /// ~0.5s — longer than the sheet takes to go. Released with [_searching], the
  /// terminal took the still-falling inset as its own keyboard: its key bar came
  /// up, its floating column went, and it shrank and grew back over a few
  /// frames right after the search had gone. Held until the inset reaches zero
  /// — or [_searchHoldLimit], so a keyboard that never reports zero cannot hold
  /// the terminal still for good.
  bool _heldForSearch = false;

  /// The keyboard up belongs to a field OUTSIDE this page — the rename dialog
  /// over the `⋯` sheet, any dialog with a text field — so the terminal must
  /// not read it as its own. Held from the tick the keyboard rises until the
  /// inset reaches zero again.
  ///
  /// ⚠️ **Without it, what was typed into the dialog went to the shell.** The
  /// dialog focused its field and raised the keyboard; [_keyboardIsUp] went
  /// true from that inset; [_shouldFocus] followed it and the panel took focus
  /// — and the input connection — back from the dialog ~300ms after it opened.
  /// The same fault [_heldForSearch] fixes for search, which is inside this
  /// page; a dialog is not, so this one is decided by where the focus that
  /// raised the keyboard lives.
  ///
  /// ⚠️ Not [ModalRoute.isCurrent]: this page is a tab's root in `PhoneShell`'s
  /// nested Navigator, and sheets and dialogs are pushed on the ROOT one, so
  /// the page stays "current" under them.
  bool _heldForCover = false;
  Timer? _searchHoldTimer;
  static const _searchHoldLimit = Duration(milliseconds: 800);

  /// Find in terminal while its bar is up — see [_openFind]. Null while it is not.
  TerminalFindController? _find;

  /// Whether the terminal had the keyboard when Find opened: closing gives it back, or puts away
  /// the one Find's field raised — as [_keyboardBeforeSearch] does for search.
  bool _keyboardBeforeFind = false;

  /// The header getting out of the way as the terminal is scrolled. See
  /// [TerminalChromeScroll].
  late final TerminalChromeScroll _chrome = TerminalChromeScroll(vsync: this);

  /// The last bottom inset seen, in physical pixels, and the timer that decides
  /// the animation has stopped.
  ///
  /// The platform gives no "keyboard animation finished" callback on either OS —
  /// only a stream of [didChangeMetrics] ticks — so the end is detected by the
  /// inset going quiet. The window is a little longer than one frame at 60Hz so
  /// a slow frame mid-animation does not read as the end of it.
  ///
  /// Starts at zero: see [didChangeMetrics] for why an unknown inset is taken
  /// for a keyboard that is down.
  double _lastInset = 0;
  Timer? _settleTimer;
  static const _settleWindow = Duration(milliseconds: 80);

  /// Stops the settle watch, leaving the remote resize live.
  ///
  /// ⚠️ Called from [dispose], so it must not touch [setState].
  void _cancelSettle() {
    _settleTimer?.cancel();
    _settleTimer = null;
    _slideTimer?.cancel();
    _slideTimer = null;
  }

  /// Runs for as long as [TerminalKeyBar] is sliding. See [_endSettle].
  Timer? _slideTimer;

  /// Opens (or re-opens) the window in which this pane's height is a moving
  /// target, so [TerminalPanel.settling] holds the remote resize across it.
  ///
  /// ⚠️ **The window has to open BEFORE the first height change, not on it.**
  /// Armed only from a moving inset — which is what [didChangeMetrics] alone
  /// could do — it opened a frame too late: asking for the keyboard opens
  /// [TerminalKeyBar] in the very next frame, which takes height out of the
  /// pane while the inset is still zero. xterm then re-derived rows for a height
  /// that is neither the old one nor the one the move ends at, and spent a
  /// `terminal_resize` and a real SIGWINCH on it — a full-screen TUI redrawing,
  /// and its keyframe landing on this thread, in the frames the keyboard is
  /// animating through.
  ///
  /// So every path that moves this pane's bottom arms it first: the request
  /// ([_raiseKeyboard]), the dismissal ([_dismissInput]), the key bar's slide
  /// ([_watchKeyBar]) and the inset ticks themselves.
  ///
  /// [waitForKeyBar] adds [_slideTimer], for a move that includes
  /// [TerminalKeyBar]'s own slide — which outlasts the keyboard's inset, so the
  /// inset's [_settleWindow] cannot be what ends the hold.
  ///
  /// [fromBuild] marks the one caller that runs INSIDE a build, [_watchKeyBar]:
  /// the flag is assigned rather than `setState`, because the build about to
  /// read it has not read it yet, and `setState` from a build is the
  /// "markNeedsBuild() called during build" crash.
  void _armSettle({bool waitForKeyBar = false, bool fromBuild = false}) {
    _settleTimer?.cancel();
    _settleTimer = Timer(_settleWindow, () {
      _settleTimer = null;
      _endSettle();
    });
    if (waitForKeyBar) {
      _slideTimer?.cancel();
      // A beat past the slide itself, so the frame the row lands on is inside
      // the hold rather than on its edge.
      _slideTimer = Timer(TerminalInputDock.slide + _settleWindow, () {
        _slideTimer = null;
        _endSettle();
      });
    }
    // ⚠️ Guarded. This runs on EVERY frame of the keyboard's slide; an
    // unconditional `setState` would rebuild the whole page — terminal included
    // — once per frame of the one animation this gate exists to keep smooth.
    if (_keyboardSettling) return;
    if (fromBuild) {
      _keyboardSettling = true;
    } else {
      setState(() => _keyboardSettling = true);
    }
  }

  /// Closes the window: the pane's height is final, so [TerminalPanel] may size
  /// the far shell to it — the one SIGWINCH the hold reduces the move to.
  ///
  /// ⚠️ **Two clocks have to have run out, not one.** The keyboard's inset stops
  /// moving first and [_settleWindow] closes on it; [TerminalKeyBar] is still
  /// sliding for another beat after that, and the pane is losing pixels to it
  /// the whole time. Measured on a simulator, the inset settled at +180ms and
  /// the row at +260ms, and a hold that ended on the first of those let xterm
  /// re-derive rows twice more and spend a real SIGWINCH on each — which is the
  /// judder this gate exists to remove. Whichever timer fires first finds the
  /// other still outstanding and leaves the gate shut.
  void _endSettle() {
    if (_settleTimer != null || _slideTimer != null) return;
    if (!mounted || !_keyboardSettling) return;
    setState(() => _keyboardSettling = false);
    // The keyboard has stopped moving, so whether it is up is now a fact: a
    // question read while it moved is decided here. See [_raiseForQuestion].
    _raiseForQuestion();
    _raiseForFirstSession();
  }

  /// What the last build read from the notifier — the baseline [_onNotifier]
  /// compares the next tick against.
  _PageFacts? _facts;

  /// The skeleton's one identity across the two places the body draws it.
  ///
  /// ⚠️ **Two places, one skeleton.** It stands in for the panel while there is no session, and
  /// lies OVER the panel once there is one whose first keyframe has not landed. The session arrives
  /// a moment after the page — the attach is made after the first frame — so every launch crossed
  /// from one place to the other: the first skeleton was unmounted, a second mounted in its place,
  /// and the sweep started again from the top edge a beat after the page appeared. Under one
  /// [GlobalKey] Flutter moves the same skeleton across, and its sweep carries on. The two places
  /// are never built in the same frame: one wants no session, the other a session.
  final GlobalKey _skeletonKey = GlobalKey(debugLabel: 'terminal skeleton');

  /// Reads this page's own terminal buffer for an open question dialog.
  ///
  /// ⚠️ **Built late and only once**, when the agent's engine is first known:
  /// the engine decides whether there is anything to look for at all, and it
  /// arrives with the agent rather than with the page. Null until then, and for
  /// every engine this parser is not verified against — which keeps the
  /// keyboard from being raised over a dialog nobody can read.
  QuestionPaneWatcher? _questionWatcher;

  /// The engine [_questionWatcher] was built for, so a page that somehow
  /// re-opens on a different engine rebuilds it rather than reading a Codex
  /// dialog with Claude's rules.
  QuestionEngine? _questionEngine;

  /// The dialog the keyboard was last raised for.
  ///
  /// ⚠️ **This is what stops the keyboard fighting the person.** The watcher
  /// reports every change of dialog, and a multi-question exchange changes it
  /// several times; raising on each one would shove the keyboard back up
  /// seconds after somebody put it away. One raise per question, and a question
  /// is new only when its text or its options differ.
  String? _questionRaisedFor;

  /// The queue of Codex async questions the keyboard was last raised for — see
  /// [_onQuestionPane]. Once per change of the queue, for the reason
  /// [_questionRaisedFor] is once per question: a keyboard put away while the
  /// same questions wait stays away.
  QueuedQuestions? _queueRaisedFor;

  /// Whether this page's session took input as of the last [_onNotifier] —
  /// so the moment it starts to can be told apart from every other tick.
  bool _acceptedInput = false;

  /// Point the question watcher at this page's current terminal.
  ///
  /// Called from `build`, where both the engine and the session are known, and
  /// cheap to call on every frame: [QuestionPaneWatcher.attach] returns at once
  /// for a terminal it already holds.
  void _syncQuestionWatcher(String? engineId, TerminalSession? session) {
    final engine = questionEngineOf(engineId);
    if (engine != _questionEngine) {
      _questionEngine = engine;
      _questionWatcher?.removeListener(_onQuestionPane);
      _questionWatcher?.dispose();
      // Nothing to watch for on an engine this parser does not know: leave the
      // watcher null so not even a listener is attached.
      _questionWatcher = engine == null
          ? null
          : (QuestionPaneWatcher(engine: engine)..addListener(_onQuestionPane));
    }
    _questionWatcher?.attach(session?.terminal);
  }

  /// The agent just asked something, or stopped asking.
  ///
  /// ⚠️ **Raising the keyboard is the whole feature, and it must happen at
  /// most once per question.** An agent that blocks mid-turn is waiting on a
  /// keystroke, and on a phone that keystroke is unreachable until the keyboard
  /// is up — so the page opens it rather than making the person find the
  /// terminal and tap it. But a person who puts the keyboard away during a
  /// question has said they are not answering yet, and a watcher that raised it
  /// again on the next repaint would be arguing with them.
  void _onQuestionPane() {
    if (!mounted) return;
    final view = _questionWatcher?.view;
    final open = view != null && view.answerable;
    _tellDaemon(open ? view : null);
    // VoiceOver hears it too, once per question: the answers lighting up in the terminal say
    // nothing to someone who cannot see them.
    if (open && view.question != _questionAnnounced) {
      _questionAnnounced = view.question;
      unawaited(
        SemanticsService.sendAnnouncement(
          View.of(context),
          'Asking: ${view.question}',
          Directionality.of(context),
        ),
      );
    } else if (!open) {
      _questionAnnounced = null;
    }
    setState(() {
      // Cleared as the dialog goes, so the NEXT question raises the keyboard
      // again even if it words itself identically.
      if (!open) _questionRaisedFor = null;
    });
    if (_questionWatcher?.queued == null) _queueRaisedFor = null;
    _raiseForQuestion();
    _raiseForFirstSession();
  }

  /// The daemon on this phone, cached so a page going can take its report back
  /// (a disposed page cannot look its scope up).
  DaemonHostState? _daemon;

  /// Tell the daemon a question is open on this page, or that it went. The
  /// machine's own question frame never reaches a phone on the relay, so a
  /// dialog read off the screen is how the daemon learns a harness needs you.
  void _tellDaemon(QuestionPaneView? view) {
    final host = _daemon ??= DaemonScope.maybeOf(context);
    if (host == null) return;
    final agent = widget.notifier
        .stateOf(widget.machineId)
        ?.agents
        .where((a) => a.id == widget.agentId)
        .firstOrNull;
    host.noteQuestion(
      this,
      machineId: widget.machineId,
      agentId: widget.agentId,
      key: view?.fingerprint,
      who: agent?.displayName ?? 'a harness',
      question: view?.question ?? '',
    );
  }

  /// The question VoiceOver was last told about, so a repaint of the same dialog is not said twice.
  String? _questionAnnounced;

  /// Raise the keyboard for the question on the pane, if it has not had its
  /// one raise yet — see [_questionRaisedFor] and [_queueRaisedFor].
  ///
  /// ⚠️ **A question is marked only once its raise could be DECIDED, and two
  /// moments cannot decide it.** While the session takes no input a keyboard
  /// would type nothing, so [_raiseKeyboardForQuestion] backs out — a page
  /// opened onto an agent already asking. And while the keyboard is moving
  /// ([_keyboardSettling]) the page cannot tell one on its way down from one
  /// that is up: a dialog read mid-`⌄` found the keyboard still on screen,
  /// counted it as the person's own, and marked the question — the keyboard
  /// finished leaving and nothing raised it again.
  ///
  /// ⚠️ **On a simulator with "Connect Hardware Keyboard" on, none of this
  /// shows a keyboard**, and that is iOS, not this: with a hardware keyboard
  /// attached it answers a focus with the key strip alone and no software
  /// keyboard, for a tap and for this alike. Measured: the claim landed, the
  /// input connection opened, the key strip rose with `⏎`, and the inset
  /// stayed at zero.
  ///
  /// Marking in either moment spent the one raise on nothing. So neither marks:
  /// this is asked again when the session starts taking input ([_onNotifier])
  /// and when the keyboard stops moving ([_endSettle]), and decides then.
  void _raiseForQuestion() {
    final watcher = _questionWatcher;
    if (watcher == null || _keyboardSettling) return;
    if (!(_readFacts().session?.acceptsInput ?? false)) return;
    final view = watcher.view;
    // ⚠️ **A dialog the page can answer raises nothing.** Its answers are a tap on their own lines
    // and words said to the mic (prompt mode); a keyboard would cover both, and a tap on the pane
    // under it is xterm's. Only a dialog the page cannot answer — multi-select, or an MCP form
    // whose field has the caret — still asks for the keyboard's keys.
    if (view != null && view.tappable) return;
    if (view != null && view.answerable) {
      final key = view.fingerprint;
      if (_questionRaisedFor == key) return;
      _questionRaisedFor = key;
      _raiseKeyboardForQuestion();
      return;
    }
    // A queued question — Codex's async kind — raises the keyboard too, once
    // per change of the queue, by the same rule as a dialog above: its
    // `shift+← to answer` is a key on the key strip, and the strip is only on
    // screen while the keyboard is.
    final queued = watcher.queued;
    if (queued == null || queued == _queueRaisedFor) return;
    _queueRaisedFor = queued;
    _raiseKeyboardForQuestion();
  }

  /// Open the keyboard because an agent is waiting on an answer — or because the first session has
  /// just opened over its task ([_raiseForFirstSession]).
  ///
  /// ⚠️ **Not [_raiseKeyboard], and synchronous where that one is not.** That
  /// one belongs to a TAP on the terminal, and awaits the mic's transcript to
  /// drain into the prompt first, because tapping mid-sentence is asking to
  /// finish that sentence. Nothing was said here — the agent asked — so
  /// draining voice would paste a half-spoken phrase into an answer the person
  /// has not started, and with nothing to await this runs in one frame.
  void _raiseKeyboardForQuestion() {
    final facts = _readFacts();
    final session = facts.session;
    // A terminal this page only watches cannot be typed into, so a keyboard
    // over it would be a keyboard that does nothing.
    if (session == null || !session.acceptsInput) return;
    // Already up on THIS page, or on its way: nothing to do, and calling again
    // would restart the settle hold for no reason.
    //
    // ⚠️ `_ownsInput`, not the screen-wide `_keyboardIsUp`. That flag is true
    // whenever any page's keyboard is showing — it exists to hold the keyboard
    // across a swipe — so reading it here would skip the raise on a page swiped
    // to while a keyboard belonging to the page behind it was still up.
    if (_keyboardRequested || _ownsInput) return;
    // The controls somebody reaches for next are in the header.
    _chrome.reveal();
    _keyboardWanted();
    setState(() {
      _keyboardRequested = true;
      // ⚠️ **The claim is asked for outright, not left to `focused` turning
      // true.** A tap raises the keyboard through the terminal's own gesture;
      // this has no tap, only the flag — and a flag the panel already reads as
      // true (the screen-wide [_keyboardIsUp] a moment behind a keyboard just
      // put away) is no change for it to act on. See [_restoreKeyboard], which
      // hit the same wall.
      _focusRequest++;
    });
    // The keyboard is on its way and the key bar opens with it — see
    // [_raiseKeyboard], which holds the resize the same way.
    _armSettle();
  }

  _PageFacts _readFacts() {
    final notifier = widget.notifier;
    final pane = notifier.panes
        .where(
          (p) => p.machineId == widget.machineId && p.agentId == widget.agentId,
        )
        .firstOrNull;
    final session = pane?.session;
    final machine = notifier.stateOf(widget.machineId);
    final agent = machine?.agents
        .where((a) => a.id == widget.agentId)
        .firstOrNull;
    return (
      paneId: pane?.id,
      session: session,
      status: session?.status,
      rendered: session?.hasRenderedFrame ?? false,
      // ⚠️ Everything below to `branch` is read by [build] too, and has to be compared here: this
      // page is no longer rebuilt from above on every tick of the notifier (see
      // `AgentSwipeHost._single`), so a fact left out is a fact drawn stale. The terminal itself is
      // replaced by every keyframe — each keyboard raised or lowered ends in one — and the page
      // anchors and reads the one it is handed.
      hasScreen: session?.hasScreen ?? false,
      terminal: session?.terminal,
      watching: session?.watching ?? false,
      acceptsInput: session?.acceptsInput ?? false,
      tabId: notifier.activeSwarmId,
      branch: agent?.gitContext?.branchLabel,
      agentName: agent?.displayName,
      agentEngine: agent?.engine,
      agentProject: agent?.displayProject,
      agentPresent: agent != null,
      agentsFromCache: machine?.agentsFromCache ?? true,
      agentLoadStatus: machine?.agentLoadStatus,
      machinePresent: machine != null,
      machineStatus: machine == null ? null : phoneMachineStatusOf(machine),
      // Not implied by `machineStatus`: the account's record moves it too — see [phoneMachineAway].
      machineAway: machine != null && phoneMachineAway(machine),
      imagePaste: machine?.terminalImagePasteAvailable ?? false,
      machineName: machine?.machine.displayName,
      // ⚠️ The title's `api-fix asking` is drawn from here too. Left out, a harness elsewhere
      // that stopped to ask moved no fact this page compared, so the word never appeared — the
      // one signal the title carries about the rest of the fleet, missing until something
      // unrelated happened to rebuild the page.
      asking: _askingElsewhere(),
    );
  }

  /// The notifier moved. Rebuilds only if something this page draws from it
  /// has changed.
  ///
  /// ⚠️ **This is what a [ListenableBuilder] on the notifier used to be, and
  /// the difference is the point.** `AppNotifier.notifyListeners()` fires for
  /// everything on the account — an agent list landing, one agent's row
  /// syncing, a session anywhere changing state — and the pager keeps five of
  /// these pages mounted now. Rebuilding all five, header and chrome and all,
  /// on every tick was a burst of work on exactly the thread the swipe animates
  /// on. Terminal output never came through here in the first place: xterm
  /// listens to its own `Terminal`, and the dock and the mic listen to the
  /// session for themselves.
  void _onNotifier() {
    if (!mounted) return;
    final took = kTypingTrace ? (Stopwatch()..start()) : null;
    final facts = _readFacts();
    if (took != null && took.elapsedMicroseconds >= 2000) {
      typingEvent(
        'listener page: facts read in'
        ' ${(took.elapsedMicroseconds / 1000).toStringAsFixed(1)}ms',
      );
    }
    // The session has just started taking input: a question read before it
    // could has its raise decided now. See [_raiseForQuestion].
    final accepts = facts.session?.acceptsInput ?? false;
    if (accepts != _acceptedInput) {
      _acceptedInput = accepts;
      if (accepts) {
        _raiseForQuestion();
        _raiseForFirstSession();
      }
    }
    if (facts == _facts) return;
    if (kTypingTrace) typingCount('page.rebuild(facts)');
    setState(() => _facts = facts);
  }

  @override
  void initState() {
    super.initState();
    if (kTypingTrace) typingEvent('switch: terminal page mounted');
    WidgetsBinding.instance.addObserver(this);
    _lifecycle =
        WidgetsBinding.instance.lifecycleState ?? AppLifecycleState.resumed;
    // A session already taking input when the page comes ticks nothing to raise from.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _raiseForFirstSession();
    });
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // Which of the page's rebuilds an inherited widget asked for — against
    // `page.update` (its parent) and `page.build` (all of them).
    if (kTypingTrace) typingCount('page.deps');
    _listenToApp(!OutOfSight.of(context));
  }

  /// Whether [_onNotifier] is listening.
  bool _listeningToApp = false;

  /// Listens to the app only while this page can be seen. Out of sight
  /// (Harness under Swarm Home, [OutOfSight]) every tick of the app was a
  /// read of the facts, and a rebuild whenever one moved, for a page nobody
  /// is looking at. Shown again, the rebuild that brings it back reads the
  /// facts afresh in [build], so nothing is missed.
  void _listenToApp(bool on) {
    if (on == _listeningToApp) return;
    _listeningToApp = on;
    if (on) {
      widget.notifier.addListener(_onNotifier);
    } else {
      widget.notifier.removeListener(_onNotifier);
    }
  }

  /// Releases the resize hold when this page is parked mid-animation.
  ///
  /// A settle left running would end on a page that is no longer on screen, and
  /// the pane would come back from the pager still holding its resize.
  @override
  void didUpdateWidget(TerminalPage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (kTypingTrace) typingCount('page.update');
    if (_listeningToApp && !identical(oldWidget.notifier, widget.notifier)) {
      oldWidget.notifier.removeListener(_onNotifier);
      widget.notifier.addListener(_onNotifier);
    }
    if (oldWidget.isActive && !widget.isActive) {
      // ⚠️ Parked pages come back with their chrome shown. A page swiped away
      // with its header hidden would arrive that way the next time it is swiped
      // to — chrome missing on a screen nobody has scrolled yet, and no gesture
      // on the new page to bring it back.
      _chrome.reveal();
      // A keyboard asked for and still on its way belongs to the page that
      // asked; a parked page must not claim it when it comes.
      _keyboardRequested = false;
      _cancelSettle();
      if (_keyboardSettling) setState(() => _keyboardSettling = false);
      // Find belongs to the terminal being read: swiped away, it goes, keyboard and all.
      if (_find != null) _closeFind(giveKeyboardBack: false, rebuild: false);
      // A pretend take is this session's task: carried across the swipe, the next page's mic would
      // send it there.
      if (widget.voice.pretending && _firstSessionLine() != null) {
        widget.voice.clear();
      }
    }
    if (!oldWidget.isActive && widget.isActive) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _raiseForFirstSession();
      });
    }
  }

  @override
  void dispose() {
    _endCardTimer?.cancel();
    // A take started here must not come back to a page that is gone.
    final session = widget.notifier
        .paneOfAgent(widget.machineId, widget.agentId)
        ?.session;
    if (session?.voiceDeliver == _deliverVoice) session?.voiceDeliver = null;
    if (session?.onLineSent == _onLineSent) session?.onLineSent = null;
    if (session?.voicePretend == _heardInFirstSession) {
      session?.voicePretend = null;
    }
    _stopPromptWait();
    _stopSentWait();
    // Said once: leaving the session spends the onboarding's line too. Not the onboarding's first
    // message: a line sent in any other session still answers it ([_onLineSent]), and a sign-out
    // ends it cancelled.
    _spendFirstSessionLine();
    _barMessageTimer?.cancel();
    _barMessage.dispose();
    _scrollback.dispose();
    _dropFindBack();
    _find?.dispose();
    _listenToApp(false);
    _daemon?.noteQuestion(
      this,
      machineId: widget.machineId,
      agentId: widget.agentId,
    );
    _questionWatcher?.removeListener(_onQuestionPane);
    _questionWatcher?.dispose();
    _elicitationPress.cancel();
    _cancelSettle();
    _searchHoldTimer?.cancel();
    _chrome.dispose();
    _searchOpen.dispose();
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  /// Harnesses other than this one that are asking something — the title's `api-fix asking`,
  /// or `2 asking` when there are several. Null when none are.
  String? _askingElsewhere() {
    final asking = [
      for (final entry in visibleAgents(agentIndex(widget.notifier)))
        if (entry.isWaiting &&
            !(entry.machineId == widget.machineId &&
                entry.agent.id == widget.agentId))
          entry,
    ];
    if (asking.isEmpty) return null;
    if (asking.length > 1) return '${asking.length} asking';
    return '${_windowName(asking.single.agent.displayName)} asking';
  }

  /// In the sample, the one thing to try next — `refactor-db needs you →` — following what has
  /// been done: go to the harness that is asking, answer it, start one of your own. Null outside the sample and once the sample is done.
  String? _sampleGuide() {
    final sample = SampleMode.maybeOf(context);
    if (sample == null || sample.endCardSeen) return null;
    final (step, text) = switch (null) {
      _ when widget.agentId.startsWith('sample-new-') => (
        4,
        '✓ yours is running',
      ),
      _ when _questionWatcher?.view != null => (
        2,
        'say “yes”, or tap an answer',
      ),
      _ when _askingElsewhere() != null => (
        1,
        '${_askingElsewhere()!.replaceFirst(' asking', '')} needs you →',
      ),
      _ => (3, '← start one of your own'),
    };
    if (step == 4) _scheduleEndCard(sample);
    // A step done: a tick you can feel, once.
    if (_guideStep != null && step > _guideStep!) {
      HapticFeedback.mediumImpact();
    }
    _guideStep = step;
    return text;
  }

  int? _guideStep;

  bool _showEndCard = false;
  Timer? _endCardTimer;

  void _scheduleEndCard(SampleSession sample) {
    if (_endCardTimer != null || sample.endCardSeen) return;
    _endCardTimer = Timer(const Duration(seconds: 8), () {
      if (!mounted || sample.endCardSeen) return;
      sample.endCardSeen = true;
      setState(() => _showEndCard = true);
    });
  }

  /// Back to the harness used before this one ON THIS PHONE — holding the title's name, vim's
  /// `:b#`. This phone's own visits first (the order its landings are remembered in); the
  /// account's last-used order only when it has none yet.
  void _openLastHarness() {
    final entries = visibleAgents(agentIndex(widget.notifier));
    bool here(AgentEntry entry) =>
        entry.machineId == widget.machineId && entry.agent.id == widget.agentId;
    final byId = {
      for (final entry in entries)
        phoneAgentId(entry.machineId, entry.agent.id): entry,
    };
    AgentEntry? last;
    for (final id in widget.notifier.searchHistory.recent) {
      final entry = byId[id];
      if (entry != null && !here(entry) && entry.isOpenable) {
        last = entry;
        break;
      }
    }
    // Sorted as a copy: [visibleAgents] hands back its memo, unmodifiable.
    last ??= ([...entries]..sort(compareMonitorOrder))
        .where((entry) => !here(entry) && entry.isOpenable)
        .firstOrNull;
    if (last == null) {
      _flash('no other harness yet', error: true);
      return;
    }
    HapticFeedback.selectionClick();
    openAgent(context, widget.notifier, last.machineId, last.agent.id);
  }

  /// `machine:folder` for the title — where the agent works.
  static String? _placeOf(Agent? agent, MachineState? machine) {
    final folder = agent?.displayProject?.name;
    final name = machine?.machine.displayName;
    if (folder == null || folder.isEmpty) return name;
    return name == null ? folder : '$name:$folder';
  }

  /// vim's message line, for a moment — see [_flash].
  final _barMessage = ValueNotifier<({String text, bool error})?>(null);
  Timer? _barMessageTimer;

  /// Says what went wrong, above the mic for two seconds, the way tmux's `display-message` does.
  /// Nothing that went right is said: its effect is on screen, and a tap is felt.
  ///
  /// Over a [_hold], which comes back once the two seconds are up.
  void _flash(String text, {bool error = false}) {
    _barMessageTimer?.cancel();
    _barMessage.value = (text: text, error: error);
    _barMessageTimer = Timer(const Duration(seconds: 2), () {
      if (mounted) _barMessage.value = _held;
    });
  }

  /// What the line above the mic says for as long as something is on its way, rather than for a
  /// [_flash]'s two seconds — a Change agent, which is several round trips to the computer. Null
  /// when nothing is.
  ///
  /// ⚠️ **Two seconds were not enough to say it.** The first switch tried waited half a minute on
  /// the computer, and "switching to Claude…" had gone after two seconds: the terminal looked as if
  /// nothing had been asked, and the only sign left was a menu row nobody had open.
  String? _barHold;

  ({String text, bool error})? get _held =>
      _barHold == null ? null : (text: _barHold!, error: false);

  /// Says [text] above the mic until it is held no more (null). A flash showing now keeps its two
  /// seconds and hands back to this.
  void _hold(String? text) {
    _barHold = text;
    if (_barMessageTimer?.isActive ?? false) return;
    _barMessage.value = _held;
  }

  /// This page's `⋯` menu while it is up — see [_putMenuAway].
  Route<void>? _menu;

  /// Takes the `⋯` menu down, when something it describes has just ended under it.
  ///
  /// ⚠️ **The menu's rows are read once, as it opens.** Opened mid-switch, Change agent said
  /// `switching…` — true then — and went on saying it after the switch had ended, with the answer in
  /// a snackbar the menu itself covered. A menu on a harness the switch has just stopped would also
  /// still offer its Restart. So the menu goes, and what happened is said where it can be seen.
  void _putMenuAway() {
    final menu = _menu;
    _menu = null;
    if (menu == null || !menu.isActive) return;
    final navigator = menu.navigator;
    if (navigator == null) return;
    if (menu.isCurrent) {
      navigator.pop();
    } else {
      navigator.removeRoute(menu);
    }
  }

  /// Whether [view]'s answers are each one tap: not a question that takes several answers, nor one
  /// only partly on screen, nor an MCP form being filled in — see [QuestionPaneView.tappable].
  static bool _answersTappable(QuestionPaneView view) => view.tappable;

  /// The mic's centre, up from the terminal's foot: where Siri's orb stands, just over the home
  /// strip — where the thumb already is. Fixed in points, not rows: the terminal's size must not
  /// move it.
  double get _micCenter =>
      (_windowBottomInset > 0 ? _windowBottomInset : 12) +
      4 +
      VoiceMicButton.extent / 2;

  /// The foot of the line above the mic, where what is going on is said — a take, a message, the
  /// sample's next step. See [_statusLine].
  double get _statusBottom => _micCenter + VoiceMicButton.extent / 2 + 4;

  /// How far up from the terminal's foot its last line is held while followed: just over the
  /// home strip, and no further. The terminal fills the screen; the mic floats over it, the way
  /// Siri's orb floats over the home screen (the owner: "we need to fill the screen 100%").
  ///
  /// ⚠️ **Except while the agent asks.** Its answers are the lines at its foot — and the lines to
  /// tap — and the line above the mic asks for the answer: the question lifts clear of it until it
  /// is answered.
  double get _clearAboveMic =>
      _questionWatcher?.view != null ? _statusBottom + 22 : _windowBottomInset;

  /// The line above the mic, highest first: a two-second message (`✓ 1 yes`, or an error in red),
  /// what a take is doing, how to answer the question open, the sample's next step. Null when
  /// there is nothing to say.
  ///
  /// ⚠️ **The two-second message outranks the take.** The take's line was first, and a take the
  /// question refused — `✗ no match — tap an answer` — never showed its reason: the refusal also
  /// leaves the take's generic "Not sent · terminal isn't taking input" standing, which
  /// covered the one line that said what to do, and blamed the terminal instead.
  Widget? _statusLine() {
    final tty = Tty.of(context);
    if (_barMessage.value case final message?) {
      return _StatusLine(
        text: message.text,
        color: message.error ? tty.red : tty.green,
      );
    }
    if (voiceStatus(widget.voice, tty) case final said?) {
      return _StatusLine(text: said.text, color: said.color);
    }
    // Before the question lines: an answer read off a kept screen cannot be given until the stream
    // it stands in for is up. The facts this page last built from, not a fresh read: the page
    // rebuilds when the stream moves (`status` and `rendered` in [_PageFacts]), and this line
    // rebuilds with every voice tick besides.
    if (_attaching(_facts?.session)) {
      return _StatusLine(
        text: _keyboardRequested
            ? 'attaching… · keyboard opens when live'
            : 'attaching…',
        color: tty.faint,
      );
    }
    final view = _questionWatcher?.view;
    if (view != null && !_answersTappable(view)) {
      return _StatusLine(text: 'answer on screen', color: tty.yellow);
    }
    // In the sample its guide says this in its own words, and counts the step — see [_sampleGuide].
    if (_answersOnScreen && SampleMode.maybeOf(context) == null) {
      return _StatusLine(text: 'tap an answer · or say it', color: tty.yellow);
    }
    // Not while reading back through the history: the line sat on the rows being read, halving
    // one ("FAIL src/auth/…"). It is back the moment the reader is at the end again.
    if (_scrollback.value != null) return null;
    if (_sampleGuide() case final guide?) {
      return _StatusLine(text: guide, dot: true);
    }
    // The onboarding's one line, until the first send — see [AppNotifier.firstSessionLine].
    if (_firstSessionLine() case final line?) {
      final session = _facts?.session;
      final task = session == null ? null : _firstTask(session);
      if (session != null && task != null) {
        // A take is on: the mic's own face speaks, and the suggestion waits with its line — a line
        // left over an empty row would point at nothing. Both are back if the take is dropped.
        if (VoiceLine.shows(widget.voice)) return null;
        return _FirstSessionSuggestion(
          line: line,
          suggestion: task,
          onSend: session.acceptsInput
              ? () {
                  // Read at the tap, not at the last frame: a send that landed since has spent the
                  // line, and the button is still on screen until the next frame draws that. The
                  // task too: the prompt as it stands, with whatever was changed in it since.
                  if (_firstSessionLine() == null) return;
                  final now = _firstTask(session);
                  if (now == null) return;
                  unawaited(
                    widget.voice.submitText(
                      now,
                      (text) => _sendFirstTask(session, text),
                    ),
                  );
                }
              : null,
        );
      }
      return _StatusLine(key: const ValueKey('first-session-line'), text: line);
    }
    return null;
  }

  /// Whether [session] is the first session handing its task over, on the page the onboarding
  /// opened: a fresh Claude Code or Codex ("Say what to build, or send this:"), or OpenCode with
  /// Desktop's starter ("Send it, or say anything."). The engines whose prompt the phone can clear
  /// before it sends ([TerminalSession.sendFirstTask]).
  bool _firstTaskSession(TerminalSession session) {
    final line = _firstSessionLine();
    return (line == OnboardingCopy.micSayWhat ||
            line == OnboardingCopy.micSendIt) &&
        const ['claude', 'codex', 'opencode'].contains(session.engineId);
  }

  /// The first session's task as it stands — what its Send sends, and what its mic is heard as
  /// ([_heardInFirstSession]): what the prompt holds now — Desktop's starter in OpenCode's box, the
  /// task [_raiseForFirstSession] typed into Claude Code or Codex, or whatever it was changed to —
  /// and with an empty prompt the task it opened on. Null outside the first session, and for an
  /// OpenCode box that has shown no starter.
  String? _firstTask(TerminalSession session) {
    if (!_firstTaskSession(session)) return null;
    final line = widget.notifier.firstSessionLine;
    final typed = typedPromptText(session.terminal.buffer, session.engineId);
    if (_firstSessionLine() == OnboardingCopy.micSayWhat) {
      return typed ?? firstTaskIdeas.first;
    }
    // OpenCode's box as first read is Desktop's starter: kept, so a box emptied on the keyboard
    // still offers it, never a task the screen did not show.
    if (typed != null && line != _starterFor) {
      _starterFor = line;
      _starter = typed;
    }
    return typed ?? (line == _starterFor ? _starter : null);
  }

  /// Sends the first session's task, replacing what its prompt holds — never joined to it
  /// ([TerminalSession.sendFirstTask]). A prompt holding a paste marker ([holdsPasteMarker]) goes
  /// by Return as it stands instead: what was pasted is only in the program, and read off the screen
  /// and typed again it would be the marker, with the paste cleared away.
  Future<bool> _sendFirstTask(TerminalSession session, String text) async {
    if (!holdsPasteMarker(text)) return session.sendFirstTask(text);
    if (!session.acceptsInput) return false;
    session.terminal.keyInput(TerminalKey.enter);
    return true;
  }

  /// What a take in the first session is heard as, read as it starts and as it ends: the task in
  /// the prompt ([_firstTask]; empty when there is none to send, which is heard as nothing). Null —
  /// an ordinary recording — once the first send has gone, or while a question is on screen that a
  /// spoken answer is for ([_deliverVoice] answers it).
  String? _heardInFirstSession() {
    final session = widget.notifier
        .paneOfAgent(widget.machineId, widget.agentId)
        ?.session;
    if (session == null || !_firstTaskSession(session)) return null;
    if (_questionOnScreen(session)) return null;
    return _firstTask(session) ?? '';
  }

  /// Whether [session]'s screen shows a question its engine asks — read off its terminal now, not
  /// through [_questionWatcher], which follows a new terminal only on the next build and settles a
  /// beat after it.
  static bool _questionOnScreen(TerminalSession session) {
    final engine = questionEngineOf(session.engineId);
    return engine != null && readQuestionPane(session.terminal, engine) != null;
  }

  /// The first session's mic pretends (owner, 2026-10-23) — see [TerminalSession.voicePretend]. Set
  /// while this page shows that session; [_heardInFirstSession] itself says when a take records after
  /// all.
  void _syncPretendVoice(TerminalSession? session) {
    if (session == null) return;
    if (_firstTaskSession(session)) {
      session.voicePretend = _heardInFirstSession;
    } else if (session.voicePretend == _heardInFirstSession) {
      session.voicePretend = null;
    }
  }

  /// The pane [_raiseForFirstSession] waits on for its prompt, and the listener it waits with.
  TerminalSession? _promptWaitOn;
  VoidCallback? _promptWait;

  /// The first session opens with the keyboard up over its task (owner, 2026-10-23): Return sends it
  /// as it stands, and the words are there to change. A fresh Claude Code or Codex gets the first
  /// New Harness idea typed into its empty prompt, unsent; OpenCode's starter is Desktop's. Once per
  /// hand-over ([_firstSessionRaisedFor]): put away, the keyboard stays away, and Send and the mic
  /// send the same task.
  ///
  /// ⚠️ **Not before the cursor is in the prompt** ([cursorInPrompt]). A pane still starting has no
  /// prompt to type into, and a dialog drawn first — Claude Code's trust prompt, its cursor on an
  /// answer — is answered where it is drawn, under no keyboard. So the pane is watched until then,
  /// each change read after it is written: [TerminalSession.outputTicks] moves before the write,
  /// and a keyframe moves only the session.
  ///
  /// Asked as the page first draws, when its session starts taking input ([_onNotifier]), when it
  /// becomes the page on screen ([didUpdateWidget]), when a question goes ([_onQuestionPane]) and
  /// when the keyboard stops moving ([_endSettle]).
  void _raiseForFirstSession() {
    if (_firstSessionLine() == null || !widget.isActive) return;
    if (widget.notifier.firstSessionLine == _firstSessionRaisedFor) return;
    final session = widget.notifier
        .paneOfAgent(widget.machineId, widget.agentId)
        ?.session;
    if (session == null || !_firstTaskSession(session)) return;
    if (!identical(_promptWaitOn, session)) {
      _stopPromptWait();
      void soon() => scheduleMicrotask(_tryRaiseForFirstSession);
      _promptWaitOn = session;
      _promptWait = soon;
      session.outputTicks.addListener(soon);
      session.addListener(soon);
    }
    _tryRaiseForFirstSession();
  }

  void _tryRaiseForFirstSession() {
    final session = _promptWaitOn;
    if (!mounted || session == null) return;
    final line = widget.notifier.firstSessionLine;
    if (_firstSessionLine() == null ||
        line == _firstSessionRaisedFor ||
        !_firstTaskSession(session)) {
      _stopPromptWait();
      return;
    }
    // Parked, reconnecting, or the keyboard still moving: wait on — the next change asks again.
    if (!widget.isActive || !session.acceptsInput || _keyboardSettling) return;
    final buffer = session.terminal.buffer;
    if (!cursorInPrompt(buffer, session.engineId)) return;
    _stopPromptWait();
    _firstSessionRaisedFor = line;
    if (_firstSessionLine() == OnboardingCopy.micSayWhat &&
        const ['claude', 'codex'].contains(session.engineId) &&
        emptyPromptAtCursor(buffer)) {
      session.terminal.textInput(firstTaskIdeas.first);
      session.resetInputBuffer();
    }
    _raiseKeyboardForQuestion();
  }

  void _stopPromptWait() {
    final session = _promptWaitOn;
    final wait = _promptWait;
    if (session != null && wait != null) {
      session.outputTicks.removeListener(wait);
      session.removeListener(wait);
    }
    _promptWaitOn = null;
    _promptWait = null;
  }

  /// The pane [_dismissOnceSent] watches, its listener, and how long it watches.
  TerminalSession? _sentWaitOn;
  VoidCallback? _sentWait;
  Timer? _sentDeadline;
  static const _sentWatch = Duration(seconds: 3);

  /// The first session's task went: the keyboard goes once the prompt has emptied — the task is
  /// with the harness, and what it does with it is on screen (owner, 2026-10-23). A Return that sent
  /// nothing — a file picked after `@`, a line broken with `\` — leaves the prompt holding its text
  /// and the keyboard up. Watched as [_raiseForFirstSession] watches, for [_sentWatch].
  void _dismissOnceSent(TerminalSession session) {
    _stopSentWait();
    void check() {
      if (!mounted) return _stopSentWait();
      if (typedPromptText(session.terminal.buffer, session.engineId) != null) {
        return;
      }
      _stopSentWait();
      _dismissInput();
    }

    void soon() => scheduleMicrotask(check);
    _sentWaitOn = session;
    _sentWait = soon;
    session.outputTicks.addListener(soon);
    session.addListener(soon);
    _sentDeadline = Timer(_sentWatch, _stopSentWait);
  }

  void _stopSentWait() {
    final session = _sentWaitOn;
    final wait = _sentWait;
    if (session != null && wait != null) {
      session.outputTicks.removeListener(wait);
      session.removeListener(wait);
    }
    _sentDeadline?.cancel();
    _sentDeadline = null;
    _sentWaitOn = null;
    _sentWait = null;
  }

  /// The onboarding's line by the mic, when this page is the session it opened on: "Send it, or say
  /// anything." Null on every other page, and once spent.
  String? _firstSessionLine() {
    final line = widget.notifier.firstSessionLine;
    if (line == null ||
        line.machineId != widget.machineId ||
        line.agentId != widget.agentId) {
      return null;
    }
    return line.text;
  }

  /// Takes the onboarding's line away, if it is this page's. True when it was.
  bool _spendFirstSessionLine() {
    if (_firstSessionLine() == null) return false;
    widget.notifier.firstSessionLine = null;
    // Kept for this hand-over only: a later one for the same agent reads the same.
    _firstSessionRaisedFor = null;
    _starterFor = null;
    _starter = null;
    // From here a take is a recording again — see [_syncPretendVoice].
    widget.notifier
            .paneOfAgent(widget.machineId, widget.agentId)
            ?.session
            ?.voicePretend =
        null;
    return true;
  }

  /// A line sent from this page — a Return typed or tapped, a take that went ([TerminalSession
  /// .onLineSent]). The first on this phone asks for notifications, a moment later
  /// ([NotificationsAsk]); and the onboarding's line by the mic has been answered.
  ///
  /// Not in the sample: nothing there reaches a harness, and its notices would be for nothing.
  void _onLineSent() {
    if (!mounted || SampleMode.maybeOf(context) != null) return;
    final onboarding = widget.notifier.onboardingMeasurement;
    unawaited(
      NotificationsAsk.shared.afterSend(
        () => onboarding.askNotifications(
          widget.notifier.agentNotices.system.requestPermission,
        ),
      ),
    );
    // The onboarding's first message is the first line sent after the hand-over in ANY session, not
    // only the one it opened: a person signing in again may go straight to a session of their own,
    // which read as no first message (1 in 3 on 2026-10-19). Nothing once it has ended.
    onboarding.end(ProductFlow.firstMessage, ProductOutcome.ok);
    final session = _readFacts().session;
    final firstTask = session != null && _firstTaskSession(session);
    if (!_spendFirstSessionLine()) return;
    // The first session's task is on its way: the keyboard goes once it has gone (owner,
    // 2026-10-23). Only this once — Return in a session at work keeps it up.
    if (firstTask) _dismissOnceSent(session);
    setState(() {});
  }

  /// Whether [session] is a kept screen standing in while its stream attaches — drawn like the live
  /// terminal, and taking no key until the stream is up ([TerminalSession.acceptsInput]).
  ///
  /// ⚠️ **Said on the line above the mic, because nothing else says it (owner, 2026-10-01).** A
  /// kept screen puts an agent opened again in this run up at once, before its stream is live, and
  /// a tap in that wait raised nothing — read as a terminal that would not focus. The tap is not
  /// lost: the keyboard is asked for at once ([_raiseKeyboard]) and opens the moment the pane stops
  /// being read-only. Only while the open is on its way: a stream that failed or was taken has its
  /// own answer to a tap ([_takeControl]). A launch shows no kept screen — its skeleton says it.
  static bool _attaching(TerminalSession? session) =>
      session != null &&
      session.showingKeptScreen &&
      !session.watching &&
      session.status == TerminalSessionStatus.opening;

  /// Whether the open question's answers are bands to tap in the terminal right now — not under
  /// the keyboard, where a tap on the pane is xterm's.
  ///
  /// ⚠️ **No keys beside the mic, by the owner's call (2026-09-29).** The first and last answers
  /// were keys either side of it: on a 360pt Android the first ran off the screen's edge, both
  /// labels were cut to a word ("làm app/tr…"), and the answers between had no key at all. Each
  /// answer is now its own lines, in full, where it is read — see [_answerBands].
  bool get _answersOnScreen {
    final view = _questionWatcher?.view;
    if (view == null || _ownsInput || _keyBarUp) return false;
    return _answersTappable(view);
  }

  /// The open question's answers where the terminal draws them — each its row and the description
  /// under it — as the bands [TerminalPanel] lays over them. See [questionAnswerLines].
  List<TerminalLineBand> _answerBands(Terminal terminal) {
    final view = _questionWatcher?.view;
    if (view == null || !_answersTappable(view)) return const [];
    final labels = {for (final row in view.rows) row.number: row.label};
    return [
      for (final answer in questionAnswerLines(terminal, view))
        (
          key: answer.number,
          first: answer.first,
          last: answer.last,
          label: 'Answer ${answer.number} ${labels[answer.number] ?? ''}',
          columns: answer.columns,
        ),
    ];
  }

  /// A tap on an answer's band: it presses that answer, as a tap on its row does ([_onLineTap]).
  void _onAnswerBand(TerminalLineBand band) {
    final view = _questionWatcher?.view;
    if (view == null || !_answersTappable(view)) return;
    for (final key in questionKeys(view)) {
      if (key.number == band.key) {
        HapticFeedback.selectionClick();
        _tapAnswer(view, key);
        return;
      }
    }
  }

  /// A tap on a row of the terminal while a question is open: on an answer's own line —
  /// `❯ 1. Yes`, `  2. Yes, and don't ask again` — it presses that answer.
  bool _onLineTap(String line) {
    final view = _questionWatcher?.view;
    if (view == null || !view.tappable) return false;
    final number = _optionLine.firstMatch(line)?.group(1);
    if (number == null) return false;
    for (final key in questionKeys(view)) {
      if (key.number == number) {
        HapticFeedback.selectionClick();
        _tapAnswer(view, key);
        return true;
      }
    }
    return false;
  }

  static final _optionLine = RegExp(r'^\s*(?:[❯›>]\s*)?(\d{1,2})[.)]\s');

  /// A tapped answer: pressed at once on a terminal this phone holds, else once it is taken back.
  ///
  /// ⚠️ **A tap on an answer is a claim on the terminal, as speaking one is ([_sessionForInput]).**
  /// The bands are drawn on a terminal only being watched too — after the computer took it, or
  /// when it opened watching on a reconnect — and a tap there used to buzz and send nothing: the
  /// band answers before the panel's own tap could take control, and a session that is not
  /// [TerminalSession.acceptsInput] drops the keys.
  void _tapAnswer(QuestionPaneView view, QuestionKey key) {
    final session = widget.notifier
        .paneOfAgent(widget.machineId, widget.agentId)
        ?.session;
    if (session != null && session.acceptsInput) {
      _answer(view, key);
      return;
    }
    unawaited(_answerOnceTaken(view, key));
  }

  /// Set while a tapped answer waits for the terminal to come back, so a second tap in that wait
  /// does not press a second answer once it has.
  bool _answerWaiting = false;

  /// Takes the terminal back, then presses [key] — only on the same question still open: one
  /// answered on the computer meanwhile has closed, and a digit then would land in the prompt.
  ///
  /// ⚠️ **Read off the screen the stream came back with, not the watcher's view.** Taking the
  /// terminal back answers with a keyframe of the screen as it is now, and the watcher keeps a
  /// dialog it no longer finds for one more read (its close debounce) — so a question the computer
  /// answered in the meantime would still be the watcher's at the moment the press goes out.
  Future<void> _answerOnceTaken(QuestionPaneView view, QuestionKey key) async {
    if (_answerWaiting) return;
    _answerWaiting = true;
    try {
      final session = await _sessionForInput(why: 'answer');
      if (!mounted) return;
      if (session == null) {
        _flash('✗ not sent', error: true);
        return;
      }
      final engine = _questionEngine;
      final now = engine == null
          ? null
          : readQuestionPane(session.terminal, engine);
      if (now == null ||
          now.fingerprint != view.fingerprint ||
          !_answersTappable(now)) {
        return;
      }
      for (final pressed in questionKeys(now)) {
        if (pressed.number == key.number) {
          _answer(now, pressed);
          return;
        }
      }
    } finally {
      _answerWaiting = false;
    }
  }

  /// Presses an answer: its digit, and Return only where the dialog asks for one (Codex's
  /// `request_user_input`) — a chosen Return, never a blind one. An MCP server's Accept or Decline
  /// has no digit: the caret is moved onto it and Enter pressed — see [ElicitationPress].
  void _answer(QuestionPaneView view, QuestionKey key) {
    final session = widget.notifier
        .paneOfAgent(widget.machineId, widget.agentId)
        ?.session;
    if (session == null) return;
    if (view.kind == QuestionPaneKind.elicitation) {
      _elicitationPress.press(key.number);
      return;
    }
    session.terminal.textInput(key.number);
    if (view.enterSubmits) session.terminal.keyInput(TerminalKey.enter);
  }

  /// Accept or Decline pressed on an MCP server's question, read off and keyed into whichever
  /// terminal this page's pane holds at the moment — a keyframe replaces it, and a press waiting on
  /// the caret outlives one.
  late final _elicitationPress = ElicitationPress(
    read: () {
      final session = widget.notifier
          .paneOfAgent(widget.machineId, widget.agentId)
          ?.session;
      if (session == null) return null;
      return readQuestionPane(session.terminal, QuestionEngine.claude);
    },
    send: (key) => widget.notifier
        .paneOfAgent(widget.machineId, widget.agentId)
        ?.session
        ?.terminal
        .keyInput(key),
  );

  /// Where a voice take goes: to the agent's prompt — or, while the agent's question is open, to
  /// that question, as its answer or not at all. Nothing is echoed when it lands: the words appear
  /// in the prompt, and a tap is felt. Only what went wrong is said (see [_flash]).
  Future<bool> _deliverVoice(String text) async {
    final session = await _sessionForInput();
    if (session == null) return false;
    if (_questionWatcher?.view != null) return _answerByVoice(session, text);
    // The first session's task replaces what its prompt holds, as Send does: never joined to it.
    final sent = _firstTaskSession(session)
        ? await _sendFirstTask(session, text)
        : await session.sendComposerText(text);
    // After the send is acknowledged, never before: a tap felt first would be a promise.
    if (sent && mounted) HapticFeedback.lightImpact();
    return sent;
  }

  /// The pane's session, able to take input — taken back first when another client took the
  /// terminal (the desktop, on a click there) while the take was being spoken. Speaking to a
  /// harness is as plain a claim on it as a tap or a scroll, and so are a tapped answer and
  /// Interrupt; [why] names which in the log. Null when it cannot be had in 6s.
  Future<TerminalSession?> _sessionForInput({String why = 'voice'}) async {
    TerminalSession? current() =>
        widget.notifier.paneOfAgent(widget.machineId, widget.agentId)?.session;
    if (current() case final session? when session.acceptsInput) return session;
    appLog.info(why, 'terminal not ours at send — taking it back');
    await _takeControl();
    for (var waited = 0; waited < 60 && mounted; waited++) {
      if (current() case final session? when session.acceptsInput) {
        return session;
      }
      await Future<void>.delayed(const Duration(milliseconds: 100));
    }
    appLog.warn(why, 'terminal not back in 6s — take kept');
    return null;
  }

  /// A voice take while the agent's question is open: it answers the question or it is not sent.
  Future<bool> _answerByVoice(TerminalSession session, String text) async {
    final view = _questionWatcher?.view;
    if (view == null) return session.sendComposerText(text);
    if (!view.tappable) {
      _flash('✗ answer on screen', error: true);
      return false;
    }
    final match = matchSpokenAnswer(text, view);
    if (match == null) {
      _flash('✗ no match — tap an answer', error: true);
      return false;
    }
    final key = questionKeys(view).firstWhere((k) => k.number == match.number);
    _answer(view, key);
    // "no, use dist/ instead": the rest goes to the agent once its question has closed.
    if (match.rest case final rest?) {
      Timer(const Duration(milliseconds: 900), () {
        if (!mounted || _questionWatcher?.view != null) return;
        unawaited(session.sendComposerText(rest));
      });
    }
    return true;
  }

  /// Whether the agent on screen is working — the mic wears its ring, and the menu offers Interrupt.
  bool get _agentWorking =>
      visibleAgents(agentIndex(widget.notifier))
          .where(
            (entry) =>
                entry.machineId == widget.machineId &&
                entry.agent.id == widget.agentId,
          )
          .firstOrNull
          ?.isWorking ??
      false;

  /// A window name the way tmux shortens one: the first dozen characters.
  ///
  /// ⚠️ Characters as a person counts them, not UTF-16 units: cut by `substring`, a name with an
  /// emoji near the twelfth unit kept half a surrogate pair, and the text engine throws on a string
  /// like that — the title, and the page under it, went with it.
  static String _windowName(String name) {
    final characters = name.characters;
    return characters.length <= 12 ? name : characters.take(12).toString();
  }

  /// Where the reader is while scrolled up in the history, or null at the end — what holds the
  /// terminal still under a reader ([_AnchoredTerminal.reading]).
  final _scrollback = ValueNotifier<({int above, int total})?>(null);

  /// How far left a drag has gone, for the swipe that opens Computers.
  double _swipedLeft = 0;

  /// Whether the drag under way is pulling Find in — it then drives the slide.
  bool _swipingFind = false;

  /// A sideways drag this far left opens Computers on letting go.
  static const double _computersReach = 64;

  /// A sideways fling at least this fast counts whatever distance it covered.
  static const double _swipeFlick = 300;

  void _onSwipeStart(DragStartDetails _) {
    _swipedLeft = 0;
    _swipingFind = false;
  }

  /// A drag's first move right pulls Find in, and from then on Find follows the finger; a drag
  /// that starts left is counted toward Computers instead.
  void _onSwipeUpdate(DragUpdateDetails details) {
    final dx = details.primaryDelta ?? 0;
    if (!_swipingFind) {
      if (_searching) return;
      if (dx <= 0 || _swipedLeft > 0) {
        _swipedLeft -= dx;
        return;
      }
      _openSearch(animate: false);
      _swipingFind = true;
    }
    final width = TerminalSearchOverlay.drawerWidth(
      MediaQuery.sizeOf(context).width,
    );
    _searchOpen.value += dx / width;
  }

  /// Let go: Find stays if it was flung or is a third of the way out, and goes back otherwise. A
  /// third, not half: Find is the whole screen wide, and half of it is a long reach for a thumb.
  /// A drag left far enough, or flung, opens Computers.
  void _onSwipeEnd(DragEndDetails details) {
    final velocity = details.primaryVelocity ?? 0;
    if (_swipingFind) {
      _swipingFind = false;
      if (velocity >= _swipeFlick ||
          (velocity > -_swipeFlick && _searchOpen.value > 0.3)) {
        // Counted once it stays: a swipe that lets Find go back opened nothing.
        widget.notifier.productMeasurement.screenOpened(
          PhoneScreen.find,
          ScreenOpening.swipe,
        );
        _searchOpen.forward();
      } else {
        _closeSearch();
      }
      return;
    }
    if (_swipedLeft >= _computersReach || velocity <= -_swipeFlick) {
      // The swipe alone is counted here: Find's key and a screen reader's actions are not.
      widget.notifier.productMeasurement.screenOpened(
        PhoneScreen.computers,
        ScreenOpening.swipe,
      );
      unawaited(_openComputers());
    }
  }

  void _onSwipeCancel() {
    if (!_swipingFind) return;
    _swipingFind = false;
    _closeSearch();
  }

  /// What VoiceOver reads for the terminal: its last few lines with anything on them, oldest first
  /// — where the agent says what it did and what it wants. Empty before the first frame lands.
  static String _lastLinesForVoiceOver(Terminal? terminal, {int count = 6}) {
    if (terminal == null) return '';
    final buffer = terminal.buffer;
    final lines = <String>[];
    for (var y = buffer.height - 1; y >= 0 && lines.length < count; y--) {
      final text = buffer.lines[y].getText().trim();
      if (text.isNotEmpty) lines.add(text);
    }
    return lines.reversed.join('\n');
  }

  /// Computers — the page Settings ▸ Computers opens — slid in from the right, the way a swipe left
  /// asks for. A new harness is Find's `New Harness` now (see `terminal_search.dart`).
  ///
  /// Rebuilt on the way back, as after every page pushed over this one: its chrome reads whether it
  /// is the top route.
  Future<void> _openComputers() async {
    dismissKeyboardForSwipe();
    await Navigator.of(context).push(
      phoneRoute(
        (_) => MachinesTab(
          notifier: widget.notifier,
          large: false,
          fromTerminal: true,
        ),
      ),
    );
    if (mounted) setState(() {});
  }

  /// Brings Find up over the terminal with its search field focused.
  ///
  /// Hold the terminal before Find takes the keyboard — see [_heldForSearch].
  void _openSearch({bool animate = true}) {
    if (_searching) return;
    _keyboardBeforeSearch = _keyboardIsUp;
    _keyboardUpAtSearch = _keyboardUp;
    _searchHoldTimer?.cancel();
    // Release even a hardware keyboard before the search field mounts.
    FocusManager.instance.primaryFocus?.unfocus();
    setState(() {
      _searching = true;
      _heldForSearch = true;
      // ⚠️ Handed over, not left standing. A claim still outstanding when the
      // sheet opens would race the search field for the keyboard the moment
      // the field raises one — the panel would win and the query would be
      // typed into the shell.
      _keyboardRequested = false;
    });
    if (animate) _searchOpen.forward();
  }

  /// Sends the sheet back down, and takes it down once it is gone.
  ///
  /// ⚠️ **Guarded on the controller's own status, not on [_searching].** A tap
  /// on the dimmed page, a pull on the sheet and the system back gesture can
  /// all arrive while the reverse is already running — a second `reverse()`
  /// restarts it from wherever it had got to, and the sheet visibly bounces.
  void _closeSearch() {
    if (!_searching ||
        (_searchOpen.isAnimating &&
            _searchOpen.status == AnimationStatus.reverse)) {
      return;
    }
    // ⚠️ **The keyboard up now is the SEARCH field's, not the terminal's.** Its
    // inset set [_keyboardIsUp], and left standing, the terminal read that as
    // its own the moment search came down — closing the sheet, Back or opening
    // an agent brought up a keyboard nobody had asked the terminal for. Put
    // away like a swipe's, unless the terminal had one up before search opened.
    if (!_keyboardBeforeSearch) dismissKeyboardForSwipe();
    _searchOpen.reverse().whenCompleteOrCancel(() {
      // A completed reverse is the only thing that unmounts the overlay; a
      // CANCELLED one means the search was opened again mid-collapse, and taking
      // the field down then would drop the keyboard it has just been given.
      if (!mounted || _searchOpen.status != AnimationStatus.dismissed) return;
      setState(() => _searching = false);
      // The overlay is down, but its keyboard may still be falling — see
      // [_heldForSearch]. A terminal that had its own keyboard up before search
      // is going back to one, so there is nothing to wait out.
      if (_keyboardUpAtSearch || _lastInset == 0) {
        _releaseSearchHold();
      } else {
        _searchHoldTimer = Timer(_searchHoldLimit, _releaseSearchHold);
      }
    });
  }

  /// Find in terminal: its bar where the key bar is, the terminal searched and its match lit —
  /// the desktop's ⌘F, from the `⋯` menu.
  ///
  /// The terminal is not held still for it, unlike search: the field's keyboard shrinks the page as
  /// typing into the terminal does, and the panel carries the search across the keyframe that
  /// follows (`TerminalPanel._syncTerminal`), so the match is read in the space the keyboard
  /// leaves. What the field must not do is hand the keyboard to the terminal — see [_shouldFocus].
  void _openFind() {
    if (_find != null || !mounted) return;
    _keyboardBeforeFind = _keyboardIsUp;
    // Let go of the terminal's input before the field mounts and asks for the keyboard — the race
    // [_openSearch] closes the same way.
    FocusManager.instance.primaryFocus?.unfocus();
    _chrome.reveal();
    final route = ModalRoute.of(context);
    final back = _FindBack(() => _closeFind());
    route?.registerPopEntry(back);
    _findBack = (route: route, entry: back);
    setState(() {
      _find = TerminalFindController();
      _keyboardRequested = false;
    });
  }

  /// Back while Find is up closes Find, not the page — registered on the route for as long as the
  /// bar is up, which is what a [PopScope] would do, without wrapping the page in one.
  ({ModalRoute<Object?>? route, _FindBack entry})? _findBack;

  void _dropFindBack() {
    final back = _findBack;
    _findBack = null;
    if (back == null) return;
    back.route?.unregisterPopEntry(back.entry);
    back.entry.dispose();
  }

  /// Puts Find away: the panel goes back to where the reader was, and the keyboard goes back to
  /// whoever had it — the terminal, if it had one when Find opened, else nobody.
  ///
  /// ⚠️ **Find's keyboard falls for half a second after the bar has gone**, and the terminal would
  /// take the falling inset for its own (see [_heldForSearch]). So unless the terminal is getting
  /// a keyboard back, it is held off the keyboard until that one is gone — search's own close.
  ///
  /// [rebuild] false for a page being parked ([didUpdateWidget]): it rebuilds anyway, and a parked
  /// page claims no keyboard to be held off.
  void _closeFind({bool giveKeyboardBack = true, bool rebuild = true}) {
    final find = _find;
    if (find == null) return;
    _dropFindBack();
    final back = giveKeyboardBack && _keyboardBeforeFind && widget.isActive;
    if (!back) dismissKeyboardForSwipe();
    void apply() {
      _find = null;
      if (!rebuild) return;
      if (back) {
        _keyboardWanted();
        _keyboardRequested = true;
        _focusRequest++;
      } else {
        _heldForSearch = true;
        _keyboardUpAtSearch = false;
      }
    }

    if (rebuild) {
      setState(apply);
      if (back) {
        _armSettle();
      } else if (_lastInset == 0) {
        _releaseSearchHold();
      } else {
        _searchHoldTimer?.cancel();
        _searchHoldTimer = Timer(_searchHoldLimit, _releaseSearchHold);
      }
    } else {
      apply();
    }
    // After the bar and the panel have let go of it.
    WidgetsBinding.instance.addPostFrameCallback((_) => find.dispose());
  }

  /// Hands the terminal back its own reading of the keyboard.
  void _releaseSearchHold() {
    _searchHoldTimer?.cancel();
    _searchHoldTimer = null;
    if (!mounted || _searching || !_heldForSearch) return;
    setState(() => _heldForSearch = false);
  }

  /// Watches the keyboard through [View], because MediaQuery lies to this page.
  ///
  /// ⚠️ `MediaQuery.viewInsetsOf(context).bottom` is ALWAYS ZERO here, keyboard
  /// up or down. `PhoneShell` puts this page's Navigator inside a `Scaffold`
  /// body, and a Scaffold that has already resized for the keyboard STRIPS the
  /// bottom inset from the MediaQuery it hands its body — the body must not
  /// subtract it twice. Every descendant therefore reads zero.
  ///
  /// [View.of] is the raw platform value, in PHYSICAL pixels, and no widget can
  /// intercept it.
  @override
  void didChangeMetrics() {
    super.didChangeMetrics();
    if (!mounted) return;
    final inset = View.of(context).viewInsets.bottom;
    final up = inset > 0;
    // Every mounted page writes it, and they all see the same inset — so a page
    // that was parked while the keyboard came and went still reads the truth.
    //
    // ⚠️ Except while a swipe is putting the keyboard away: the inset is still
    // falling then, and writing `true` from those ticks is exactly what used to
    // undo the dismissal. See [_keyboardDismissing]. Zero is the platform
    // saying the keyboard has finished leaving, which ends the hold-off.
    if (_keyboardDismissing) {
      if (!up) _keyboardDismissing = false;
    } else {
      _keyboardIsUp = up;
    }
    // The FIRST frame of the keyboard rising spends the request — it need not
    // finish. Spending it this early is the point: it is off long before any
    // Back press can arrive.
    final requested = _keyboardRequested && !up;
    // One input at a time. Whatever raised the keyboard, voice input yields —
    // the mic's row is hidden under the key bar, and a take nobody can see is a
    // microphone left on.
    if (up && !widget.voice.isIdle) widget.voice.clear();

    // Every tick that MOVES the inset is the animation still running; the run
    // ends when one window passes without another move. Gated on a real change
    // so the ticks this page gets for everything else — a rotation, a status
    // bar resizing — never freeze a pane whose height is not moving.
    //
    // ⚠️ The baseline starts at zero, a keyboard that is DOWN. The first tick a
    // page ever sees is almost always the keyboard's first frame on its way up,
    // and taking that tick as a mere baseline let the pane resize the remote
    // shell at the half-risen height before the settle began — two SIGWINCHes
    // and two redraws for one keyboard. A page arriving under a keyboard already
    // up costs one needless 80ms hold, and nothing else.
    // The keyboard's first frame up says whose it is: the field that raised it
    // already holds the focus. One outside this page's route is a dialog's —
    // see [_heldForCover]. Zero ends the hold, covered or not.
    if (up && _lastInset <= 0) {
      final primary = FocusManager.instance.primaryFocus;
      final scope = FocusScope.of(context);
      // ⚠️ **A SCOPE holding the focus is nobody holding it.** With no field
      // focused anywhere, `primaryFocus` is a [FocusScopeNode] — the enclosing
      // scope, which by definition is not inside this page — and reading that
      // as "a dialog's keyboard" held the terminal off its own. A field in a
      // dialog is an ordinary [FocusNode]; only that is worth standing back for.
      _heldForCover =
          primary != null &&
          primary is! FocusScopeNode &&
          primary != scope &&
          !primary.ancestors.contains(scope);
    } else if (!up) {
      _heldForCover = false;
    }
    final previous = _lastInset;
    _lastInset = inset;
    // Search's keyboard has finished leaving: the terminal may read the
    // keyboard as its own again. See [_heldForSearch].
    if (!up && _heldForSearch && !_searching) _releaseSearchHold();
    if (inset != previous) _armSettle();

    // ⚠️ **[_keyboardSettling] is NOT written here, and that is the bug this
    // line used to be.** It read `_settleTimer != null` and assigned it, which
    // made the inset's own 80ms window the only thing that could hold the gate
    // — so the moment that window expired, the next metrics tick reopened the
    // gate even though [_slideTimer] was still running and [TerminalKeyBar] was
    // still taking pixels out of the pane. Measured: the gate closed at +9ms,
    // reopened at +94ms, and the key bar did not stop moving until +255ms, with
    // four `session.resize` calls and three real SIGWINCHes in between — every
    // one of them a full-screen TUI redraw and a keyframe landing on this
    // thread, mid-animation. That is what the judder was.
    //
    // The flag belongs to [_armSettle] and [_endSettle] alone now; they know
    // about both clocks, and this method arms them like any other caller.
    // The bar itself can come and go under a live page — a switch from buttons
    // to gestures in Settings, a rotation that moves it to the side — and
    // nothing else here would notice: [_navigationBar] reads the view rather
    // than a MediaQuery, so no rebuild follows the change on its own.
    final bar = View.of(context).viewPadding.bottom;
    final barMoved = bar != _lastViewPaddingBottom;
    _lastViewPaddingBottom = bar;
    if (up == _keyboardUp && requested == _keyboardRequested) {
      if (barMoved) setState(() {});
      return;
    }
    setState(() {
      _keyboardUp = up;
      _keyboardRequested = requested;
    });
  }

  /// Leaves the page as it was found: the keyboard the app went away with is the
  /// keyboard it comes back to.
  ///
  /// ⚠️ **The restore cannot ride on `focused` alone.** [_shouldFocus] reads
  /// [_keyboardIsUp], which the keyboard's own metrics tick clears — and whether
  /// that tick lands before the process is frozen or after it is woken is
  /// Android's business, not ours. Landing early, `focused` goes false and back
  /// to true and the panel notices the change; landing late, `focused` was never
  /// false, so there is no change for the panel to notice and the keyboard stays
  /// away. [_focusRequest] covers both: it moves either way, and re-claiming a
  /// connection that turned out to still be open is a no-op.
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    super.didChangeAppLifecycleState(state);
    final was = _lifecycle;
    _lifecycle = state;
    if (state != AppLifecycleState.resumed) {
      // Only the step OUT of the foreground reads the keyboard — see [_lifecycle].
      if (was == AppLifecycleState.resumed) {
        // The search field's keyboard is not this page's to put back, and a
        // page with something stacked over it is not the page being returned to.
        _keyboardHeldForBackground =
            _find == null &&
            !_heldForSearch &&
            (_ownsInput || _keyboardRequested);
      }
      return;
    }
    if (!_keyboardHeldForBackground) return;
    _keyboardHeldForBackground = false;
    _restoreKeyboard();
  }

  /// The keyboard this page had before the app went away, asked for again.
  void _restoreKeyboard() {
    if (!mounted || !widget.isActive) return;
    if (!(ModalRoute.of(context)?.isCurrent ?? true)) return;
    // Gone, detached or read-only while the app was away: a keyboard over it
    // would be a keyboard that does nothing. See [_raiseKeyboardForQuestion].
    final session = _readFacts().session;
    if (session == null || !session.acceptsInput) return;
    _keyboardWanted();
    setState(() {
      _keyboardRequested = true;
      _focusRequest++;
    });
    // The key bar opens with it and the pane's height moves while it does — the
    // same hold [_raiseKeyboard] takes. See [_armSettle].
    _armSettle();
  }

  /// The window's own bottom inset as of the last metrics tick, in physical
  /// pixels — see the note above on why it is watched. Starts at -1 rather than
  /// 0 so a page that first hears from the platform with no bar at all is not
  /// read as a page whose bar has just gone.
  double _lastViewPaddingBottom = -1;

  /// Whether [TerminalPanel] should hold the input connection: while the
  /// keyboard is up, and while one is on its way — see [_keyboardRequested].
  ///
  /// ⚠️ Holding reads [_keyboardIsUp], the one screen-wide fact, rather than
  /// anything this page remembers — see that flag for why swiping needs it.
  ///
  /// ⚠️ **Never while search is open, and that is not cosmetic.** The search
  /// field raises the keyboard itself, [_keyboardIsUp] goes true from its inset,
  /// and the panel underneath would read that as its own — `requestKeyboard()`
  /// takes the input connection back and every letter typed into the search box
  /// would be sent to the shell instead.
  bool get _shouldFocus =>
      widget.isActive &&
      // ⚠️ Find's field owns the keyboard while its bar is up, for the reason search's does (see
      // [_heldForSearch]): read as the terminal's, the panel would take the input connection back
      // on the next keyframe — and the field's own keyboard rising ends in one — so the second
      // letter of a search would go to the shell.
      _find == null &&
      !_heldForSearch &&
      !_heldForCover &&
      (_keyboardIsUp || _keyboardRequested);

  /// A tap on the terminal while no keyboard is up or coming: the keyboard.
  /// Voice is the floating mic, never this tap — see [TerminalActionColumn].
  ///
  /// What was said and not sent is typed into the prompt on the way rather than
  /// dropped, so the keyboard picks up where the voice left off — to correct a
  /// word, or to finish the sentence. A take still being recorded is
  /// transcribed first: tapping the terminal mid-sentence is asking to fix that
  /// sentence, not to lose it.
  Future<void> _raiseKeyboard(TerminalSession session) async {
    // Typing is not scrolling: the chrome has no reason to be out of the way,
    // and the header holds the controls somebody reaches for next.
    _chrome.reveal();
    // Before the stream is live the pane is read-only, so the keyboard asked for below opens only
    // once it is up — felt now, and said above the mic meanwhile ([_attaching]), so the wait is
    // not taken for a tap that missed.
    if (!session.acceptsInput) HapticFeedback.selectionClick();
    final heard = await widget.voice.takeTranscript();
    if (!mounted) return;
    if (heard.isNotEmpty && session.acceptsInput) {
      session.terminal.textInput(heard);
    }
    _keyboardWanted();
    setState(() => _keyboardRequested = true);
    // The keyboard is on its way and the key bar opens with it. Held from here
    // rather than from the first metrics tick, which is a frame too late: see
    // [_armSettle]. The row's own slide is covered by [_watchKeyBar].
    _armSettle();
  }

  /// Puts the keyboard away without leaving the page — the `⌄` key on
  /// [TerminalKeyBar]. Dropping focus is what closes the input connection.
  ///
  /// ⚠️ **Through [dismissKeyboardForSwipe], not a bare `unfocus()`.** The inset is still falling
  /// for ~250ms after it, [_keyboardIsUp] stays true, and [_shouldFocus] with it: a keyframe that
  /// lands meanwhile — the harness answering the very line that put the keyboard away — had the
  /// panel claim it straight back, and the keyboard never went.
  void _dismissInput() {
    dismissKeyboardForSwipe();
    if (_keyboardRequested) setState(() => _keyboardRequested = false);
    // The same move as [_raiseKeyboard], run backwards. See [_armSettle].
    _armSettle();
  }

  /// Whether the keyboard on screen is THIS page's — the question the floating
  /// controls ask, which [_keyboardUp] alone answers wrongly.
  ///
  /// ⚠️ [_keyboardUp] means "an inset exists", not "this page raised it". A
  /// pushed page with a text field — search, rename — raises one of its own,
  /// and this page is still mounted underneath, still gets `didChangeMetrics`,
  /// and so still records the keyboard as up. It then stops receiving ticks
  /// once it is no longer the route being laid out, so the fall back to zero
  /// after that page closes never reaches it: the flag stays true forever and
  /// the row it hides never comes back.
  ///
  /// [ModalRoute.isCurrent] is what separates the two. False while anything is
  /// stacked above, so an inset belonging to that page is not read as this
  /// one's — and true again the moment it pops, whatever the stale flag says.
  ///
  /// Not used for [_shouldFocus] or for the key bar: those are about the
  /// keyboard ITSELF, which is screen-wide, and a covered page must keep
  /// tracking it to know what to do when it is uncovered.
  bool get _ownsInput =>
      _terminalKeyboardUp && (ModalRoute.of(context)?.isCurrent ?? true);

  /// The keyboard as the TERMINAL sees it.
  ///
  /// ⚠️ While search is open the keyboard up is the search field's, raised over
  /// an overlay that is not a route — so it reaches this page's
  /// [didChangeMetrics] as if it were the terminal's own. Read as such, the key
  /// bar came up and the floating column went away under the search, then both
  /// flipped back as it faded out: the terminal visibly re-laid out on every
  /// close. So until that keyboard is gone, the terminal keeps what it had
  /// when search opened — see [_heldForSearch], [_keyboardUpAtSearch], and
  /// [HeldHeight] for its height.
  bool get _terminalKeyboardUp =>
      _heldForSearch ? _keyboardUpAtSearch : _keyboardUp;

  /// Whether [TerminalKeyBar] should be open — what [TerminalInputDock] is
  /// handed, and the one fact that says whether that row is about to move.
  bool get _keyBarUp => _terminalKeyboardUp || _keyboardRequested;

  /// [_keyBarUp] as of the last build, so a change to it can be spotted.
  bool _keyBarWasUp = false;

  /// The strip at the foot of the window the terminal must stay out of:
  /// Android's navigation BAR, and nothing else. Zero everywhere else, which is
  /// what keeps the page edge to edge where there is nothing solid to clash
  /// with.
  ///
  /// ⚠️ **A bar and a gesture handle are not the same inset, though both arrive
  /// as `viewPadding.bottom`.** The handle is a hairline drawn ON the content —
  /// output running under it still reads, and reserving a strip for it would
  /// leave a band of window background under the newest line, which is the line
  /// being read. A three-button bar is opaque chrome with targets in it: output
  /// under THAT is gone, and a tap meant for the terminal ends the app. So the
  /// height is what separates them — a handle is 24dp on every Android that
  /// draws one, a bar is 48dp — and [_navigationBarMin] sits between the two.
  /// (`Settings.Secure.navigation_mode` would say it outright, but it needs a
  /// platform channel and a native class on both platforms to answer what one
  /// number already answers.)
  ///
  /// ⚠️ **Zero while the keyboard is up**, which [_windowBottomInset] is where
  /// this reads it: Android's IME inset already includes the bar — the keyboard
  /// reserves that strip inside its own height and the bar is drawn over it —
  /// and `PhoneShell`'s Scaffold has resized this page to sit above the whole
  /// of it. Reserving it again here opened a band of background between the key
  /// bar and the keyboard.
  double get _navigationBar {
    if (defaultTargetPlatform != TargetPlatform.android) return 0;
    final inset = _windowBottomInset;
    return inset >= _navigationBarMin ? inset : 0;
  }

  /// Between a 24dp gesture handle and a 48dp navigation bar — see
  /// [_navigationBar].
  static const double _navigationBarMin = 36;

  /// The whole inset at the foot of the WINDOW — bar, gesture handle or home
  /// indicator alike — for the chrome that wants to clear all three. The
  /// terminal is the one thing that does not: see [_navigationBar].
  ///
  /// ⚠️ **Zero while the keyboard is up, and that is the whole point of it
  /// being a getter.** `viewPadding` never moves for a keyboard — that is what
  /// separates it from `viewInsets` — so read raw it still claims a bar's
  /// height on a page the Scaffold has already cut off at the top of the
  /// keyboard. Search read it that way and left a strip of terminal showing
  /// between its last result and the keys.
  ///
  /// [View.of] rather than MediaQuery for the reason [didChangeMetrics] gives,
  /// and its value is in PHYSICAL pixels.
  double get _windowBottomInset {
    if (_keyboardUp) return 0;
    final view = View.of(context);
    return view.viewPadding.bottom / view.devicePixelRatio;
  }

  /// Starts the hold that covers [TerminalKeyBar]'s slide, if this build is the
  /// one that sets it going.
  ///
  /// ⚠️ **Read from the value the dock is actually given, not from the gesture
  /// that usually causes it.** [_raiseKeyboard] and [_dismissInput] are the two
  /// deliberate ways in and out, and arming from those alone missed every other
  /// one: a keyboard dismissed by the system, by a tap outside, by the route
  /// changing. Measured on one of those, the row slid shut over ~200ms with the
  /// gate already open, and the pane spent three SIGWINCHes climbing back to
  /// full height — the judder, in the other direction. This catches all of them,
  /// because the row cannot move without this value changing first.
  void _watchKeyBar() {
    final up = _keyBarUp;
    if (up == _keyBarWasUp) return;
    _keyBarWasUp = up;
    // Called from build: the flag it sets is read by this same build (the dock
    // is built below it), and the timers it starts are plain timers, so there is
    // no setState here and none is needed.
    _armSettle(waitForKeyBar: true, fromBuild: true);
  }

  /// Guards against a second picker while one is already up.
  ///
  /// The key bar stays on screen under the sheet the OS puts over it, so its
  /// button remains tappable — and `pickImage` answers a second call on iOS by
  /// throwing rather than by queueing.
  bool _picking = false;

  /// Picks a picture and sends it to the agent, re-encoded on the way.
  ///
  /// ⚠️ **The transcode is not an optimisation, it is what makes the picture
  /// arrive at all** — see `transcodeToPng`. Everything past this point names
  /// PNG: the binary kind, the file the CLI writes, and the three OS clipboard
  /// writers it hands the bytes to. A phone produces JPEG and HEIC.
  Future<void> _sendImage(TerminalSession session, ImageSource source) async {
    if (_picking || !session.acceptsInput) return;
    _picking = true;
    final messenger = ScaffoldMessenger.maybeOf(context);
    void report(String message) {
      if (mounted) messenger?.showSnackBar(SnackBar(content: Text(message)));
    }

    try {
      final XFile? picked;
      try {
        picked = await ImagePicker().pickImage(source: source);
      } on PlatformException catch (error) {
        // A refused camera permission lands here rather than as a null, and it
        // is the one failure somebody can do something about.
        report(
          error.code == 'camera_access_denied'
              ? 'Allow camera access in Settings to send a photo.'
              : 'Could not open the picker.',
        );
        return;
      }
      // Null is a CANCEL, not a failure: the person backed out of the sheet, and
      // a snackbar saying so would be noise over a deliberate act.
      if (picked == null) return;

      final result = await transcodeToPng(await picked.readAsBytes());
      switch (result) {
        case ImageTranscodeUnreadable():
          report("That file isn't an image this phone can read.");
        case ImageTranscodeTooLarge():
          report('That image is too large to send, even scaled down.');
        case ImageTranscodeOk(:final pngBytes):
          // Re-checked AFTER the picker, which the person may have had open for
          // a while: the stream can have been taken over or dropped since, and
          // `pasteImage` on a dead stream goes nowhere silently.
          if (!session.acceptsInput) {
            report('The terminal is no longer accepting input.');
            return;
          }
          if (!await session.pasteImage(pngBytes)) {
            report('The image could not be sent.');
          }
      }
    } finally {
      _picking = false;
    }
  }

  /// The key bar's "Choose a file": the system's document picker, then the file to the machine,
  /// which pastes its path there — see [sendFileToTerminal]. One picker at a time, shared with the
  /// image picker ([_picking]): two system sheets stacked would be one too many.
  Future<void> _sendFile(TerminalSession session) async {
    if (_picking || !session.acceptsInput) return;
    _picking = true;
    final messenger = ScaffoldMessenger.maybeOf(context);
    try {
      await sendFileToTerminal(
        session: session,
        stillShowing: () =>
            mounted &&
            widget.isActive &&
            identical(
              widget.notifier
                  .paneOfAgent(widget.machineId, widget.agentId)
                  ?.session,
              session,
            ),
        report: (message) {
          if (mounted) {
            messenger?.showSnackBar(SnackBar(content: Text(message)));
          }
        },
      );
    } finally {
      _picking = false;
    }
  }

  /// The composer starts OPEN here, and the phone owns that answer rather than the pane.
  ///
  @override
  Widget build(BuildContext context) {
    // Whatever brought this build about, the baseline the notifier is compared
    // against is what THIS build saw — see [_onNotifier]. Not the voice
    // controller: what the mic hears repaints the floating mic and its pill,
    // which listen for themselves, and never rebuilds the terminal under them.
    if (kTypingTrace) typingCount('page.build');
    _facts = _readFacts();
    AppTheme.watch(context);
    // Before anything is laid out: if the key bar is about to open or shut,
    // the hold has to already be on. See [_watchKeyBar].
    _watchKeyBar();
    final pane = widget.notifier.panes
        .where(
          (p) => p.machineId == widget.machineId && p.agentId == widget.agentId,
        )
        .firstOrNull;
    if (pane != null) {
      _hadPane = true;
    } else if (!widget.isActive) {
      // ⚠️ **A parked page whose pane went away has to FORGET it ever had one.** It is the
      // ordinary case now: the pager closes the agent behind it a beat after each swipe, so the
      // phone holds only the one on screen (see [AgentPanePruner]). The flag means "this page's
      // stream is live", and a parked page's is not — swiping back is what attaches it again.
      // Left set, the page would land saying the agent had GONE for any frame that beats the
      // attach to it, and the branch below takes the whole pager down for that.
      _hadPane = false;
    } else if (_hadPane) {
      // The pane this page was showing is gone while it was the one being READ — another tab
      // opened a different agent, or the agent was deleted. Leave rather than spin: there is
      // nothing here to come back.
      //
      // ⚠️ Only the ACTIVE page may leave, and only it ever should. A page parked beside the one
      // being read shares the route, so popping from there would take the whole pager down —
      // including the terminal actually on screen.
      _leave();
    }
    final session = pane?.session;
    final machine = widget.notifier.stateOf(widget.machineId);
    final agent = machine?.agents
        .where((a) => a.id == widget.agentId)
        .firstOrNull;
    // ⚠️ **The agent this page opened on is not in the machine's own list.**
    // Only ever true of a page opened from the cache (see [_AgentGone]): the
    // list is the machine's — `agentsFromCache` is false, so a real
    // `agents_list` has landed — it has been LOADED rather than merely
    // attempted, and the agent it named is not in it.
    //
    // Every one of those conditions matters. Without `loaded` this would
    // fire during the window the cache exists to cover; without
    // `!agentsFromCache` it would fire against the cached list itself, which
    // is where the agent came from; and a machine that errored or went
    // offline has not disowned anything — it simply has not answered, and
    // its pane keeps the terminal's own reconnect behaviour.
    //
    // Note this deliberately ignores `_hadPane`/`_leave` above: that path
    // handles a pane REMOVED while the page was live. This one is about a
    // page that should never have been built, answered before its pane
    // could be.
    final agentGone =
        agent == null &&
        machine != null &&
        !machine.agentsFromCache &&
        machine.agentLoadStatus == AgentLoadStatus.loaded;
    // Captured while the agent is still listed, for the sentence above.
    if (agent != null) _cachedAgentName = agent.displayName;
    final machineAway = machine != null && phoneMachineAway(machine);
    // What stands in for a terminal with nothing to show yet: the skeleton promises a keyframe on
    // its way, which a machine that is away is not sending — see [_MachineAway].
    final placeholder = machineAway
        ? _MachineAway(name: machine.machine.displayName)
        : _Attaching(key: _skeletonKey);
    // A screen this terminal already drew, being brought back: its stream reopening, or its socket
    // dialling again after the stream was lost with it. Kept up under [_Reconnecting] rather than
    // covered by the skeleton, which is for a terminal with nothing on it yet. Not while the machine
    // is away — nothing is on its way then, and [_MachineAway] says why.
    //
    // ⚠️ **Lost with its socket, it counts from the drop to the reopen, with no gap between.** The
    // socket comes back (`connected`) before the terminal is reopened: the one on screen waits as
    // the machine's `pendingOfflineAgentId` while the app re-reads the machine's list, a round
    // trip, and only then reopens it (`AppNotifier._recoverPendingAgent`). Read off the socket
    // alone, the spinner went in that round trip and came back a beat later, a flicker. Waiting as
    // the pending agent keeps it up; a session lost and NOT waiting — nothing is going to reopen
    // it — shows its screen plainly, as it did, for a tap to reopen.
    final waitingToReopen =
        session != null &&
        (machine?.connectionStatus != ConnectionStatus.connected ||
            machine?.pendingOfflineAgentId == widget.agentId);
    final reconnecting =
        session != null &&
        !agentGone &&
        !machineAway &&
        (session.showsEarlierScreen ||
            (session.lostWithTransport &&
                session.hasScreen &&
                waitingToReopen));
    // Read-only either way — the terminal was never this pane's (a watcher) or was taken from it.
    // `_AgentGone` owns the page when the agent itself is missing, so this stays out of its way.
    final blocked =
        !agentGone &&
        session != null &&
        (session.watching || session.status == TerminalSessionStatus.takenOver);
    // The keys the pane's chrome offers and a phone cannot press — see
    // [parseKeyHints], and [TerminalKeyBar.hints] for where they are drawn.
    // Not on a pane that cannot type.
    //
    // ⚠️ **A queued Codex question is answered from here, and only here.** Its
    // `shift+← to answer` is one of these keys; a band under the header that
    // offered the same press was taken out — the one band up there is "Take
    // control" ([_ControlBanner]), for a pane that cannot type at all.
    final keyHints = agentGone || blocked || !(session?.acceptsInput ?? false)
        ? const <KeyHint>[]
        : _questionWatcher?.hints ?? const <KeyHint>[];
    // Read this page's own buffer for a dialog, and raise the keyboard when one
    // appears. Must run on every build: the session arrives a frame or two
    // after the page, and the engine with the agent.
    //
    // ⚠️ **The buffer is the only source there is on a phone.** The daemon
    // already detects the same dialog and publishes `commander_question`, but
    // that frame goes out device-and-loopback only — a phone attached over the
    // relay never receives it. See [QuestionPaneWatcher].
    _syncQuestionWatcher(agent?.engine, session);
    // While the agent's question is open, a voice take answers it — never a paste and a blind
    // Return into the dialog. See [_answerByVoice].
    session?.voiceDeliver = _deliverVoice;
    _syncPretendVoice(session);
    // What this page sends: the first send on the phone asks for notifications, and answers the
    // onboarding's line by the mic. See [_onLineSent].
    session?.onLineSent = _onLineSent;
    // Read once: the body reserves it, and search subtracts what the body
    // already took. See [_navigationBar].
    final navigationBar = _navigationBar;
    return Scaffold(
      backgroundColor: AppPalette.windowBg,
      // ⚠️ No fab. New agent is the `+` in the header — see the note there.
      // A Scaffold fab floats over the body, and the body here is the
      // terminal: it covered the newest line of output, which on a page
      // that streams is the line being read.
      // ⚠️ **`bottom: false`, top left on.** The two edges are not the same
      // problem. At the bottom the inset reserved a strip of window background
      // under the newest line of output — the line being read — so it is off
      // and the home indicator floats over the terminal's own last row. At the
      // top the status bar sits where the header sits, and the header is
      // chrome: that inset is what keeps its row clear of the clock, so it
      // stays.
      //
      // A `bottom: !keyboardUp` toggle lived here once, computed from
      // `MediaQuery.viewInsetsOf(context).bottom > 0`; that value is pinned at
      // ZERO inside this page (see [didChangeMetrics]), so the toggle never
      // toggled. Off outright now — with the keyboard up the inset is under the
      // keyboard anyway.
      //
      // ⚠️ **`removePadding` around it, and this one is not cosmetic.** A
      // `SafeArea` only clears the edges it APPLIES, so `bottom: false` leaves
      // the bottom inset sitting in the MediaQuery it hands down — and xterm
      // reads exactly that value as the terminal's own padding
      // (`TerminalView.build`: `padding: MediaQuery.of(context).padding`). The
      // pane was therefore 812px tall while its renderer sized rows, scroll
      // extent and viewport dimension for 778, and a `Scrollable` told a
      // viewport height its box does not have re-corrects its offset every
      // frame: the terminal ran a layout loop and the page juddered. Cleared
      // here, the inset reaches nothing below — which is the whole intent of
      // turning it off.
      body: Stack(
        children: [
          // ⚠️ **What gives this Stack the window's height instead of the
          // page's.** A Stack is as tall as its tallest NON-POSITIONED child,
          // and that child is the column below — whose terminal is frozen at
          // the height it had when search opened (see [HeldHeight]). With a
          // keyboard up at that moment the column is a keyboard shorter than
          // the screen, so the search sheet, laid over this Stack, was clipped
          // to a box that ended a keyboard's height above the bottom: it drew
          // at the top of the screen with a band of empty page under it, long
          // after the keyboard had gone.
          //
          // An empty box that asks for everything is enough. It paints nothing
          // and takes no hits; it only stops the Stack from inheriting a height
          // that belongs to something being deliberately held still.
          const SizedBox.expand(),
          // ⚠️ **VoiceOver's way in, and the only one.** xterm draws the terminal without a
          // single semantics node, and VoiceOver keeps one-finger swipes for itself — so without
          // this, a VoiceOver user could neither hear what the agent last said nor reach Find or
          // Computers, which the sideways swipes are the only way to. One node under everything,
          // painting nothing and taking no touches: the agent's name, the last lines on its screen,
          // and the two swipes as actions (VoiceOver's rotor, "Actions").
          Positioned.fill(
            child: Semantics(
              container: true,
              label: '${agent?.displayName ?? widget.agentId}, terminal',
              value: _lastLinesForVoiceOver(session?.terminal),
              customSemanticsActions: widget.sideSwipes
                  ? {
                      const CustomSemanticsAction(label: 'Find'): _openSearch,
                      const CustomSemanticsAction(label: 'Computers'): () =>
                          unawaited(_openComputers()),
                    }
                  : null,
              child: const SizedBox.expand(),
            ),
          ),
          _NoBottomPadding(
            child: SafeArea(
              bottom: false,
              // ⚠️ **The one bottom inset that IS taken back, by hand rather than
              // through the MediaQuery the lines above strip.** Android's
              // navigation bar is opaque chrome with targets in it, so the page
              // ends above it; a gesture handle or a home indicator is not, and
              // this is zero there — see [_navigationBar]. Padding the box rather
              // than restoring the inset is deliberate: xterm reads
              // `MediaQuery.padding` as its own and would size rows for a height
              // its box does not have, which is the layout loop the note above
              // describes.
              child: Padding(
                padding: EdgeInsets.only(bottom: navigationBar),
                child: Stack(
                  children: [
                    // ⚠️ The terminal is FADED, never unbuilt, while search is
                    // open. Taking it down would detach the pane and drop the
                    // scrollback; cancelling has to hand back the same screen that
                    // was there, mid-stream.
                    //
                    // ⚠️ **The header is NOT inside the fade, on purpose.** The
                    // overlay's bar sits exactly on top of this one and has to read
                    // as the same object growing — fading this one out underneath
                    // it made the row flicker on every open, which is the opposite
                    // of what the expansion is for.
                    // ⚠️ **Held at its height while search is open.** The search
                    // field's keyboard shrinks this page like any other; followed,
                    // the terminal shrank under the search and grew back through it
                    // as it faded out — the flash seen on every close. Nothing here
                    // is on screen while search covers it, so nothing here moves.
                    HeldHeight(
                      hold: _heldForSearch,
                      child: Column(
                        children: [
                          Expanded(
                            // ⚠️ The mic floats INSIDE this box, over the terminal
                            // — not over the whole page. Stacked any higher it
                            // would hang over the key bar while the keyboard is
                            // up, which is the one row the thumb is working.
                            //
                            // ⚠️ **The two sideways swipes live here, on the
                            // terminal and nowhere else** — Snapchat's layout:
                            // right pulls Find in from the left edge, left opens
                            // Computers. The terminal scrolls vertically and
                            // selects only with a mouse, so the horizontal axis
                            // is free; the key bar below scrolls its hints
                            // sideways and keeps that for itself.
                            child: GestureDetector(
                              // Translucent: the terminal may sit lower than its box (see
                              // [_AnchoredTerminal]), and a swipe on the rows above it counts.
                              behavior: HitTestBehavior.translucent,
                              onHorizontalDragStart: widget.sideSwipes
                                  ? _onSwipeStart
                                  : null,
                              onHorizontalDragUpdate: widget.sideSwipes
                                  ? _onSwipeUpdate
                                  : null,
                              onHorizontalDragEnd: widget.sideSwipes
                                  ? _onSwipeEnd
                                  : null,
                              onHorizontalDragCancel: widget.sideSwipes
                                  ? _onSwipeCancel
                                  : null,
                              child: Stack(
                                children: [
                                  Positioned.fill(
                                    top: 0,
                                    // The agent's last line sits at the foot while the
                                    // output is followed — see [_AnchoredTerminal]. A move,
                                    // not a resize: a resize would redraw the agent's whole
                                    // TUI, and reading back uses every row.
                                    child: ClipRect(
                                      child: _AnchoredTerminal(
                                        terminal: session?.terminal,
                                        enabled: !_keyBarUp && !_ownsInput,
                                        reading: _scrollback,
                                        clearBottom: _clearAboveMic,
                                        // ⚠️ The chrome is driven from OUT HERE, not
                                        // from inside the panel. xterm's own
                                        // [Scrollable] is several widgets down and is
                                        // remounted whenever the agent changes;
                                        // listening for its notifications as they
                                        // bubble past is what survives that, and costs
                                        // the panel no knowledge of the page's chrome.
                                        child: NotificationListener<ScrollNotification>(
                                          // A scroll on a terminal held elsewhere takes it,
                                          // as a tap does: no button to find first.
                                          onNotification: (notification) {
                                            if (blocked &&
                                                notification
                                                    is ScrollStartNotification &&
                                                notification.dragDetails !=
                                                    null) {
                                              unawaited(_takeControl());
                                            }
                                            return _chrome.onNotification(
                                              notification,
                                            );
                                          },
                                          child: agentGone
                                              ? _AgentGone(
                                                  name: _cachedAgentName,
                                                  onPickAnother:
                                                      _pickAnotherAgent,
                                                )
                                              : pane == null || session == null
                                              ? placeholder
                                              : TerminalPanel(
                                                  key: ValueKey(pane.id),
                                                  notifier: widget.notifier,
                                                  session: session,
                                                  // Only the page on screen takes the keyboard — see
                                                  // [TerminalPage.isActive]. `visible` is the same answer for the
                                                  // panel's other half: a page parked beside this one releases
                                                  // focus, stops rendering and stops resizing its remote shell.
                                                  //
                                                  // Whether it also HOLDS one that is already
                                                  // up is a separate question, and the pager asks
                                                  // it on every swipe — see [_shouldFocus].
                                                  focused: _shouldFocus,
                                                  // What the bar is finding — see [_openFind].
                                                  find: _find,
                                                  // Asks again when `focused` did
                                                  // not move — coming back from
                                                  // another app. See
                                                  // [didChangeAppLifecycleState].
                                                  focusRequest: _focusRequest,
                                                  visible: widget.isActive,
                                                  // Hold the remote resize while the keyboard
                                                  // slides. Separate from `visible` because this
                                                  // must NOT release focus — the animation being
                                                  // waited on is the one that focus started.
                                                  //
                                                  // The keyboard is the only thing left that
                                                  // moves this pane's height: the header slides
                                                  // OVER the terminal rather than out of its
                                                  // column — see [_SlideAway].
                                                  //
                                                  // ⚠️ Held for as long as search is open, too:
                                                  // its keyboard is typing a query over a faded
                                                  // terminal, and resizing the agent's shell for
                                                  // it redrew the whole TUI on the way in and
                                                  // again on the way out.
                                                  settling:
                                                      _keyboardSettling ||
                                                      _heldForSearch,
                                                  // ⚠️ The tap is taken in the panel, not by a
                                                  // `Listener` over it. xterm's own `_onTapDown`
                                                  // calls `requestKeyboard()`, so anything that
                                                  // merely ALSO reacted to the tap would raise
                                                  // the keyboard before the words said were typed
                                                  // into the prompt — and a re-armed claim on top
                                                  // of it was measured asking Android twice per
                                                  // tap, which answers a show mid-animation by
                                                  // cancelling and restarting it. Null while the
                                                  // keyboard is up or coming, so the tap is
                                                  // xterm's and the keyboard stays.
                                                  //
                                                  // ⚠️ A tap on a pane that cannot take input
                                                  // takes the TERMINAL first, not the
                                                  // keyboard: raising one over a read-only
                                                  // pane offers a prompt that silently
                                                  // swallows every letter.
                                                  //
                                                  // ⚠️ **A stream that died is one of those
                                                  // panes.** Held to [blocked] alone, a tap on
                                                  // a closed or failed stream raised the
                                                  // keyboard over it — keys dimmed, letters
                                                  // dropped — and nothing on the page offered
                                                  // the reconnect instead. The take reopens it.
                                                  onInputTap:
                                                      blocked ||
                                                          session.status ==
                                                              TerminalSessionStatus
                                                                  .closed ||
                                                          session.status ==
                                                              TerminalSessionStatus
                                                                  .error
                                                      ? () => unawaited(
                                                          _takeControl(),
                                                        )
                                                      : _shouldFocus
                                                      ? null
                                                      : () => unawaited(
                                                          _raiseKeyboard(
                                                            session,
                                                          ),
                                                        ),
                                                  onLineTap: _onLineTap,
                                                  // The open question's answers, each a band
                                                  // across its lines — see [_answersOnScreen].
                                                  lineBands: _answersOnScreen
                                                      ? _answerBands
                                                      : null,
                                                  onBandTap: _onAnswerBand,
                                                  // A long press on the prompt offers Paste, as
                                                  // a text field's does; a hardware ⌘V (Ctrl+V
                                                  // on Android) and a right- or middle-click
                                                  // paste through it too — see [_paste].
                                                  onPaste: () =>
                                                      _paste(session),
                                                  // Where the reader is in the history —
                                                  // what holds the view still under them.
                                                  scrollback: _scrollback,
                                                  // No composer, and so no grip above it: the
                                                  // page hands the pane its full height and the
                                                  // software keyboard drives the terminal
                                                  // directly. The mic's send is what kept the
                                                  // composer's batched turn.
                                                ),
                                        ),
                                      ),
                                    ),
                                  ),
                                  // ⚠️ **The skeleton is laid OVER the live panel, not
                                  // swapped in for it, and that is not a stylistic
                                  // choice.** [TerminalPanel.initState] calls
                                  // `session.attachViewport`, which is how the machine
                                  // learns how many rows and columns to draw; a page
                                  // that showed a skeleton INSTEAD would leave the
                                  // session with no viewport, and the first keyframe
                                  // would arrive sized for nothing.
                                  //
                                  // So the panel mounts, measures and resizes as always,
                                  // and this covers the empty emulator buffer it paints
                                  // meanwhile. `session == null` upstream keeps its own
                                  // branch for the frames before a session exists at all.
                                  //
                                  // ⚠️ **This is also the bug that made the skeleton
                                  // invisible.** The only gate used to be `session ==
                                  // null`, and `selectAgent` creates the pane and the
                                  // session in one frame — so the branch above was
                                  // essentially never taken, and what a person actually
                                  // waited in front of was a mounted terminal with an
                                  // empty buffer: a black rectangle, for as long as the
                                  // keyframe took.
                                  //
                                  // ⚠️ **A page on a terminal another app holds still
                                  // renders.** It attaches as a WATCHER — live output,
                                  // no typing (see [TerminalSession.watching]) — so the
                                  // keyframe this covers arrives exactly as it does for
                                  // any other page, and nothing here needs to know the
                                  // difference. The header says who has it and offers
                                  // "Take control"; the body is the terminal.
                                  //
                                  // ⚠️ **Not while its machine is away.** The skeleton
                                  // then promised a keyframe nothing was sending: a
                                  // computer just restarted left the phone on it for close
                                  // to 90 seconds, read as a launch that hung. [_MachineAway]
                                  // covers the panel the same way and says why.
                                  //
                                  // ⚠️ **Unless the panel already shows a screen this
                                  // terminal drew** — see `reconnecting` above. Then the
                                  // screen stays and only [_Reconnecting] lies over it.
                                  if (reconnecting)
                                    const Positioned.fill(
                                      child: _Reconnecting(),
                                    )
                                  else if (session != null &&
                                      !session.hasScreen)
                                    Positioned.fill(child: placeholder),
                                  // The mic and Search, floating in the
                                  // terminal's bottom-right corner — see
                                  // [TerminalActionColumn].
                                  //
                                  // ⚠️ Hidden while this page owns the keyboard.
                                  // Typing is the other way of saying what the mic
                                  // says, the key bar is already under the thumb, and
                                  // a column floating over the prompt being typed into
                                  // would be in the way of both.
                                  // ⚠️ **Search stays while the keyboard is up; the
                                  // mic goes.** Typing says what the mic says, so
                                  // with a keyboard on screen the two are one
                                  // errand and the key bar is already under the
                                  // thumb. Search is not: another harness, another
                                  // machine, and nothing on the key bar reaches
                                  // them — so hiding the column whole meant
                                  // putting the keyboard away first just to look
                                  // something up.
                                  //
                                  // It moves to the TOP of the pane rather than
                                  // staying put. Down here it floats over the
                                  // prompt being typed into, which is exactly
                                  // what the keyboard is for; up there it covers
                                  // the oldest rows on screen.
                                ],
                              ),
                            ),
                          ),
                          // Nothing at the foot: the terminal is the screen. What vim
                          // would say on its last line — a take, a message — is said on
                          // the line above the mic. See [_statusLine].
                          // ⚠️ No strip kept for the home indicator: the terminal runs
                          // under it, to the glass, as a page does in Safari.
                          // The bottom of this page IS just above the keyboard:
                          // `PhoneShell`'s Scaffold has already resized for it —
                          // the same resize that empties this page's MediaQuery
                          // insets (see [didChangeMetrics]).
                          // Find in terminal takes the key bar's place: on the keyboard while
                          // its field has one, at the terminal's foot while not.
                          if (session != null && _find != null)
                            TerminalFindBar(find: _find!, onClose: _closeFind)
                          else if (session != null)
                            TerminalInputDock(
                              session: session,
                              keyboardUp: _keyBarUp,
                              onDismiss: _dismissInput,
                              // `clear` and `paste` on the key bar: the prompt
                              // emptied, and the phone's clipboard — text or
                              // image — through the same path as the sheet's
                              // Paste. See [_paste].
                              onClearPrompt: session.clearPrompt,
                              onPaste: () => _paste(session),
                              // A dialog the watcher can read is open: the
                              // strip offers Enter for it. See
                              // [TerminalKeyBar.questionOpen].
                              questionOpen: _questionWatcher?.view != null,
                              hints: keyHints,
                              // Only where the far side can actually take one: an
                              // older CLI never advertises the binary kind, so the
                              // upload would go nowhere silently. Null leaves the
                              // buttons undrawn rather than drawn dead.
                              onPickImage:
                                  machine?.terminalImagePasteAvailable == true
                                  ? () => unawaited(
                                      _sendImage(session, ImageSource.gallery),
                                    )
                                  : null,
                              onTakePhoto:
                                  machine?.terminalImagePasteAvailable == true
                                  ? () => unawaited(
                                      _sendImage(session, ImageSource.camera),
                                    )
                                  : null,
                              // The same rule for any other file: only a CLI that advertises
                              // `pasteFile` writes it out there.
                              onPickFile:
                                  machine?.terminalPasteFileAvailable == true
                                  ? () => unawaited(_sendFile(session))
                                  : null,
                            ),
                        ],
                      ),
                    ),
                    // The title — the agent, then machine:folder and branch — over the
                    // terminal's top rows. It slides away while the history is read back
                    // and returns at the end of the output. See [TerminalTitle].
                    Positioned(
                      top: 0,
                      left: 0,
                      right: 0,
                      child: _SlideAway(
                        progress: _chrome.header,
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            TerminalTitle(
                              sample: SampleMode.maybeOf(context) != null,
                              name:
                                  agent?.displayName ?? _cachedAgentName ?? '',
                              place: _placeOf(agent, machine),
                              branch:
                                  agent?.gitContext?.branchLabel ??
                                  agent?.displayProject?.branch,
                              // In the sample the guide line says it, once is enough.
                              asking: SampleMode.maybeOf(context) != null
                                  ? null
                                  : _askingElsewhere(),
                              onHold: _openLastHarness,
                              onFind: _openSearch,
                              // The paired daemon at the title's right end: its
                              // sprite, a tap from its sheet. Nothing outside the
                              // signed-in shell (the sample). See `daemon_chip.dart`.
                              // Before it, while Swarm is on: what the Swarms ask of
                              // the person, a tap from them. See `swarm_mark.dart`.
                              daemon: const Row(
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  SwarmMark(margin: EdgeInsets.only(left: 12)),
                                  DaemonChip(margin: EdgeInsets.only(left: 12)),
                                ],
                              ),
                              // Only over a screen: with none, [_MachineAway] says it
                              // in the terminal's place, and saying it twice is noise.
                              away:
                                  machineAway && (session?.hasScreen ?? false),
                              onTap: () {
                                // The agent as it is NOW, not as this build read it: a fact the
                                // page does not rebuild for (a Stop queued for after it finishes)
                                // still has to be right in the menu that opens.
                                final current =
                                    widget.notifier
                                        .stateOf(widget.machineId)
                                        ?.agents
                                        .where((a) => a.id == widget.agentId)
                                        .firstOrNull ??
                                    agent;
                                if (current == null) return;
                                _showActions(
                                  machineName:
                                      machine?.machine.displayName ?? '',
                                  agent: current,
                                  session: session,
                                );
                              },
                            ),
                            // ⚠️ No "take control" band: a tap or a scroll on a terminal held
                            // elsewhere takes it — see `onInputTap` and [_onScrollTakeControl].
                          ],
                        ),
                      ),
                    ),
                    // ⚠️ No `[42/1380]` at the top right while reading back, by the owner's
                    // call (2026-09-27): "we don't need the scrolling indicator". The history
                    // scrolls like any list; scrolling down is the way back to the stream.
                    // The line above the mic: what is going on, in a few words — see [_statusLine].
                    if (!_ownsInput && _find == null)
                      Positioned(
                        left: 0,
                        right: 0,
                        bottom: _statusBottom - _StatusLine.below,
                        child: ListenableBuilder(
                          listenable: Listenable.merge([
                            widget.voice,
                            _barMessage,
                            _scrollback,
                            ?session,
                          ]),
                          builder: (context, _) {
                            final line = _statusLine();
                            if (line == null) return const SizedBox.shrink();
                            // Only the first session's suggestion takes taps; every other line
                            // lies over the terminal and lets them through.
                            return line is _FirstSessionSuggestion
                                ? line
                                : IgnorePointer(child: line);
                          },
                        ),
                      ),
                    // How loud the take is: a glow behind the mic that swells with the voice.
                    if (!_ownsInput && _find == null)
                      ListenableBuilder(
                        listenable: widget.voice,
                        builder: (context, _) =>
                            widget.voice.status == VoiceInputStatus.listening
                            ? Positioned(
                                left: 0,
                                right: 0,
                                bottom: _micCenter - VoiceLevelHalo.extent / 2,
                                child: IgnorePointer(
                                  child: Center(
                                    child: VoiceLevelHalo(voice: widget.voice),
                                  ),
                                ),
                              )
                            : const Positioned(
                                left: 0,
                                bottom: 0,
                                child: SizedBox.shrink(),
                              ),
                      ),
                    // The mic: Siri's orb, low at the foot and centred, floating
                    // over the terminal — which stays full screen under it, the
                    // way the home screen stays whole under Siri. Laid over the
                    // whole page so its capsule, rising as it talks, still takes
                    // taps.
                    if (!_ownsInput && _find == null)
                      Positioned(
                        left: 0,
                        right: 0,
                        bottom: _micCenter - VoiceMicButton.extent / 2,
                        // Centred at its own size — the mic's slot must not
                        // stretch to the page's width.
                        child: Align(
                          alignment: Alignment.bottomCenter,
                          heightFactor: 1,
                          // Always there, reading or not: what is read is what gets answered.
                          child: TerminalActionColumn(
                            voice: widget.voice,
                            session: session,
                            working: _agentWorking,
                          ),
                        ),
                      ),
                    // An agent's question has no keys out here: each answer is a band on its own
                    // lines in the terminal — see [_answersOnScreen].
                    // The sample, done: what it was, and the way to the real thing. Once.
                    if (_showEndCard)
                      Positioned.fill(
                        child: _SampleEndCard(
                          started: agent?.displayName ?? 'your harness',
                          onSetUp: () =>
                              SampleMode.maybeOf(context)
                                  ?.leave(SampleExit.setUp),
                          onKeepPlaying: () =>
                              setState(() => _showEndCard = false),
                        ),
                      ),
                    // What the swipes and the mic do — only when asked for again, Settings ▸ Show
                    // the tips again: the first session opens on its own line by the mic instead,
                    // and nothing else (owner, 2026-10-12; see [FocusHintsSeen]). Not in the sample:
                    // its guide line teaches the same by having them done.
                    if (session != null &&
                        widget.isActive &&
                        !_keyBarUp &&
                        SampleMode.maybeOf(context) == null)
                      Positioned.fill(
                        child: FocusHints(
                          onDone: () => unawaited(
                            widget.notifier.agentNotices.system
                                .requestPermission(),
                          ),
                          micBottom: _micCenter,
                        ),
                      ),
                  ],
                ),
              ),
            ),
          ),
          // The search sheet, up from the bottom edge over the whole page —
          // built from the first frame of its way up to the last of its way
          // down, and not otherwise. See [_searching].
          //
          // ⚠️ **Out here, beside the insets rather than inside them.** It is a
          // sheet over the page, and the page includes the strip under the
          // status bar: laid inside the `SafeArea`, the dimming would stop at
          // the header and leave the clock on a bright band above a darkened
          // screen. Its foot runs under the home indicator the same way, and it
          // is TOLD that inset rather than reading it — the body strips it from
          // the MediaQuery (see the note on `removePadding` above).
          if (_searching)
            Positioned.fill(
              child: TerminalSearchOverlay(
                notifier: widget.notifier,
                showing: (machineId: widget.machineId, agentId: widget.agentId),
                animation: _searchCurve,
                bottomInset: _windowBottomInset,
                onClose: _closeSearch,
                voice: widget.voice,
              ),
            ),
        ],
      ),
    );
  }

  /// Pops after the frame: this runs from inside a build, where popping a route synchronously is
  /// not allowed.
  ///
  /// ⚠️ **Removes THIS page's route, which is not the same as popping.** `pop` takes whatever is on
  /// top, and this page is often not on top when its pane goes: the terminal's own `+` opens the
  /// new-agent form over it, and the agent that form creates is opened as the single pane — closing
  /// this one. Popping from here then took down the NEW agent's terminal, the page underneath
  /// surfaced, found its pane gone too and popped again, and the person landed on the list instead
  /// of in the agent they had just made.
  ///
  /// ⚠️ **Does nothing at all on the home screen, and that is correct rather than a gap.** The
  /// terminal is the root of its stack there ([AgentHome]), so `canPop` is false and the guard below
  /// returns — but the reason this is called is that the agent went away, and [AgentHome] watches
  /// the same agent list: the agent leaves it, the home screen's target stops matching, and it
  /// rebuilds onto another agent or onto its empty state. Leaving the route was never what fixed
  /// this case; it only uncovered the list that did.
  /// Leave the agent that is no longer there, and let the home screen choose.
  ///
  /// It pops rather than picking a replacement itself: `AgentHome` already
  /// decides what to open — the remembered agent, then the first openable one —
  /// and it re-runs that the moment this page is out of the way. Choosing here
  /// would be a second, competing copy of that rule.
  ///
  /// The stale record is not cleared: it names an agent no list contains, so it
  /// matches nothing and the home screen falls through to the first agent it can
  /// reach. Whatever it opens overwrites the record itself.
  void _pickAnotherAgent() => _leave();

  void _leave() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final navigator = Navigator.of(context);
      final route = ModalRoute.of(context);
      if (route == null || !navigator.canPop()) return;
      if (route.isCurrent) {
        navigator.pop();
      } else if (route.isActive) {
        // Underneath something: leave the stack quietly, so back from the page on top goes to
        // whatever was below this one.
        navigator.removeRoute(route);
      }
    });
  }

  void _showActions({
    required String machineName,
    required Agent agent,
    TerminalSession? session,
  }) {
    final agentName = agent.displayName;
    Route<void>? shown;
    final closed = showPhoneSheet(
      context,
      onShown: (route) => _menu = shown = route,
      // Where it runs, written as everywhere else: `hn` over `M2:autonomous-harness ⑂ main`.
      title: [
        '$agentName · $machineName',
        if (agent.displayProject?.label case final folder?) ':$folder',
      ].join(),
      titleBranch:
          agent.gitContext?.branchLabel ?? agent.displayProject?.shownBranch,
      // Three cards: what acts on THIS agent, the screens the app itself has, and — alone at the
      // end — the one act that cannot be undone. No caption over the first: the name above it
      // already says which harness its rows act on, which is also why they no longer repeat
      // "Harness" in their labels.
      //
      // Each screen is a door rather than a list of its own — the lists belong on the pages behind
      // them, where they have room for every row and do not push the rest of this sheet down. The
      // chevron is what tells a door from an action.
      sections: [
        PhoneSheetSection(
          actions: [
            // First, because it is the one used mid-conversation: iOS has no paste gesture on a
            // terminal (long-press is selection there), and the soft keyboard has no paste key.
            // Hidden rather than dimmed while the stream is read-only: reclaiming is the header's
            // job, and a paste that silently goes nowhere is worse than no row.
            if (session != null && session.acceptsInput) _pasteAction(session),
            // Beside Paste, its other half. Copying reads and sends nothing, so it is offered on a
            // terminal only being watched too — but only while there is a reply on it to copy.
            if (session != null && hasLastReply(session))
              _copyReplyAction(session),
            // The desktop's ⌘F. Only with a terminal on screen to search.
            if (session != null)
              PhoneSheetAction(
                icon: LucideIcons.textSearch300,
                label: 'Find in terminal',
                onTap: _openFind,
              ),
            ..._agentActions(agent),
          ],
        ),
        // Harnesses and Machines went: Find (a swipe right) is every agent on every computer, and
        // the computers are a row in Settings.
        PhoneSheetSection(
          actions: [
            // In the sample: the way back out, where a person looks for "what else can I do".
            if (SampleMode.maybeOf(context) case final sample?)
              PhoneSheetAction(
                icon: LucideIcons.logOut300,
                label: 'Leave the sample',
                onTap: () => sample.leave(),
              ),
            if (SampleMode.maybeOf(context) == null)
              PhoneSheetAction(
                icon: LucideIcons.messageSquareText300,
                label: 'Rate task outcome',
                onTap: () => showTaskFeedback(
                  context,
                  choice: () => widget.notifier.api.productUsageSettings(),
                  send: widget.notifier.api.productUsageFeedback,
                ),
              ),
            PhoneSheetAction(
              icon: LucideIcons.settings300,
              label: 'Settings',
              chevron: true,
              onTap: () => Navigator.of(context).push(
                phoneRoute(
                  (_) => SettingsPage(notifier: widget.notifier, large: false),
                ),
              ),
            ),
          ],
        ),
        PhoneSheetSection(
          actions: [
            // Above Stop while it works: stopping once it is done, rather than mid-task — and,
            // once queued, the way to call it off.
            if (AppNotifier.canStopAfterTask(agent) &&
                (agent.closePlanState == 'waiting' || _agentWorking))
              _stopAfterAction(agent),
            _stopAction(agent),
            // Stop's harder sibling, under it: the conversation goes too. Not for a terminal,
            // which keeps none.
            if (agent.engine != 'terminal') _purgeAction(agent),
          ],
        ),
      ],
    );
    unawaited(
      closed.whenComplete(() {
        if (identical(_menu, shown)) _menu = null;
      }),
    );
  }

  /// Paste: the clipboard into [session]. What it reads and sends lives in [pasteClipboard]; the
  /// page hands it only what the page alone knows, whether this is still the terminal on screen.
  PhoneSheetAction _pasteAction(TerminalSession session) => PhoneSheetAction(
    icon: LucideIcons.clipboardPaste300,
    // ⚠️ Named for WHERE it reads, not for the verb. The sheet's other rows act
    // on the agent and the machine; "Paste" alone left it open which clipboard
    // was meant — and the phone's is the surprising answer, since the agent runs
    // somewhere else. See [pasteClipboard], which says the same in its doc.
    label: 'Paste from clipboard',
    onTap: () => _paste(session),
  );

  /// The clipboard into [session] — the sheet's Paste row, the key bar's paste, and the panel's
  /// own pastes (`TerminalPanel.onPaste`): a long press on the prompt, a hardware ⌘V (Ctrl+V on
  /// Android), a right- or middle-click. One path for all, so all read the image as well as the
  /// text, ask iOS once, and send only into the terminal still on screen.
  void _paste(TerminalSession session) {
    final messenger = ScaffoldMessenger.maybeOf(context);
    unawaited(
      pasteClipboard(
        session: session,
        machine: widget.notifier.stateOf(widget.machineId),
        stillShowing: () =>
            mounted &&
            widget.isActive &&
            identical(
              widget.notifier
                  .paneOfAgent(widget.machineId, widget.agentId)
                  ?.session,
              session,
            ),
        report: (message) {
          if (mounted) {
            messenger?.showSnackBar(SnackBar(content: Text(message)));
          }
        },
      ),
    );
  }

  /// Copy last reply: what the agent last said, onto the phone's clipboard, without selecting it
  /// first. What it reads and copies lives in [copyLastReply].
  PhoneSheetAction _copyReplyAction(TerminalSession session) =>
      PhoneSheetAction(
        icon: LucideIcons.copy300,
        label: 'Copy last reply',
        onTap: () {
          final messenger = ScaffoldMessenger.maybeOf(context);
          unawaited(
            copyLastReply(
              session: session,
              report: (message) {
                if (mounted) {
                  messenger?.showSnackBar(SnackBar(content: Text(message)));
                }
              },
            ),
          );
        },
      );

  /// What acts on this agent and can be taken back — the first card of its sheet.
  List<PhoneSheetAction> _agentActions(Agent agent) => [
    PhoneSheetAction(
      icon: LucideIcons.gitBranch300,
      label: 'Branches and pull requests',
      chevron: true,
      onTap: () => Navigator.of(context).push(
        phoneRoute(
          (_) => SessionWorkPage(
            agent: agent,
            online:
                widget.notifier.stateOf(widget.machineId)?.nodeOnline !=
                    false &&
                widget.notifier.stateOf(widget.machineId)?.connectionStatus ==
                    ConnectionStatus.connected,
            read: (offset) => widget.notifier.readAgentGitHistory(
              widget.machineId,
              agent.id,
              offset: offset,
            ),
          ),
        ),
      ),
    ),
    // ⚠️ **"Paste from clipboard" was here, and it was the SECOND paste row in
    // one sheet.** It did less than the one above ([_pasteAction]): text only,
    // no image; no `Clipboard.hasStrings` first, so iOS asked for permission
    // twice; and no check that the pane it was tapped on is still the pane the
    // text lands in. The capable one stays; this one goes.
    // Stop what it is doing — Esc, as in the terminal — only while it is doing something. First,
    // because when it is wanted it is wanted now.
    if (_agentWorking)
      PhoneSheetAction(
        icon: LucideIcons.octagonPause300,
        label: 'Interrupt',
        value: 'esc',
        onTap: () => unawaited(_interrupt()),
      ),
    // Where this agent runs, above the actions that act ON it: the desktop
    // keeps it in the pane header, and this sheet is the phone's pane header.
    //
    // Offered only on the engines whose switching has been driven end to end
    // (see [modelSheetSupports]) — a row that looks like a choice and may not
    // be one costs an agent answering on a model nobody asked for.
    if (modelSheetSupports(agent.engine))
      PhoneSheetAction(
        icon: LucideIcons.cpu300,
        label: 'Model',
        // The model the agent is on now, so the sheet is worth opening only
        // when somebody means to change it. A grid model is named; its own
        // login is the engine's name, which is the word the sheet uses too.
        value:
            agent.gridModel ??
            engineIdentity(
              agent.engine,
              displayName: agent.engineDisplayName,
            ).label,
        // A picker of its own, so it ends on the chevron a Settings row with a
        // value does.
        chevron: true,
        onTap: () => unawaited(
          showAgentModelSheet(
            context,
            widget.notifier,
            machineId: widget.machineId,
            agentId: widget.agentId,
          ),
        ),
      ),
    // Another engine on the same project — what to reach for when a subscription runs out. The
    // desktop's pane agent selector. Named by the agent it is on now, as the Model row is.
    if (AppNotifier.canChangeAgent(agent))
      PhoneSheetAction(
        icon: LucideIcons.arrowLeftRight300,
        label: 'Change agent',
        value: _changing
            ? 'switching…'
            : engineIdentity(
                agent.engine,
                displayName: agent.engineDisplayName,
              ).label,
        enabled: !_changing,
        chevron: !_changing,
        onTap: () => unawaited(_changeAgent(agent)),
      ),
    // A second harness that starts with this one's conversation, in the same folder — the
    // desktop's Fork Harness. Only where the machine can fork it, and not on saved work: a stopped
    // harness is reopened, not forked.
    if (agent.canFork && !agent.isStopped)
      PhoneSheetAction(
        icon: LucideIcons.gitFork300,
        label: 'Fork',
        value: _forking ? 'forking…' : null,
        onTap: () => unawaited(_fork()),
      ),
    // Another of this one beside it — same folder and settings, a fresh conversation. The desktop's
    // Clone Harness (⌘⇧N): no form, every answer is already on the agent. Not on a grid agent,
    // whose launch key the frame never carries.
    if (agent.canClone && !agent.isStopped)
      PhoneSheetAction(
        icon: LucideIcons.copyPlus300,
        label: 'Clone',
        value: _cloning ? 'cloning…' : null,
        enabled: !_cloning,
        onTap: () => unawaited(_clone()),
      ),
    PhoneSheetAction(
      icon: LucideIcons.pencil300,
      label: 'Rename',
      onTap: () => showAgentRenameDialog(
        context,
        widget.notifier,
        widget.machineId,
        widget.agentId,
        agent.name,
      ),
    ),
    // Still immediate, no question first — the desktop's rule too ("Restart is an immediate
    // action"). While one runs it says so and takes no tap, the way Settings ▸ Computers' Try again
    // reads `trying…`: a second press is a second restart (see `AppNotifier._agentRestarts`).
    PhoneSheetAction(
      icon: LucideIcons.refreshCw300,
      label: 'Restart',
      value: _restarting ? 'restarting…' : null,
      enabled: !_restarting,
      onTap: () => unawaited(_restart(agent)),
    ),
  ];

  /// Whether this agent has a restart on its way — from this menu, or from Connectors. Read as the
  /// menu opens, like the rest of its rows: a menu left open while the restart finishes still says
  /// it, until it is opened again.
  bool get _restarting =>
      widget.notifier.agentRestarting(widget.machineId, widget.agentId);

  /// Whether this agent has a switch on its way — see [AppNotifier.agentChanging].
  bool get _changing =>
      widget.notifier.agentChanging(widget.machineId, widget.agentId);

  /// Whether a fork of this agent is on its way — see [AppNotifier.agentForking].
  bool get _forking =>
      widget.notifier.agentForking(widget.machineId, widget.agentId);

  /// Whether a Clone of this agent is on its way — see [AppNotifier.agentCloning].
  bool get _cloning =>
      widget.notifier.agentCloning(widget.machineId, widget.agentId);

  /// Clone: the new harness opens once its machine confirms it, the source left as it is in the
  /// same tab. What opens it is captured before the wait, as Change agent's is: the page can leave
  /// on its own while the answer is out.
  Future<void> _clone() async {
    final messenger = ScaffoldMessenger.maybeOf(context);
    final shell = PhoneShellScope.maybeOf(context);
    final notifier = widget.notifier;
    final machineId = widget.machineId;
    final error = await notifier.cloneAgent(machineId, widget.agentId);
    if (mounted) _putMenuAway();
    if (error != null) {
      messenger?.showSnackBar(SnackBar(content: Text(error)));
      return;
    }
    final next = notifier.cloneAttempt(machineId, widget.agentId)?.agentId;
    if (next == null) return;
    if (mounted) {
      openAgent(context, notifier, machineId, next);
    } else {
      shell?.onOpenAgent(machineId, next);
    }
  }

  /// Fork: the form, then the fork opens — the source stays as it is, in the same tab.
  ///
  /// ⚠️ **A fork outlives its form.** Closed while the fork is still out, the form says it carries
  /// on, so its answer is still said here when it lands — and the fork offered to open rather
  /// than opened over whatever the person went on to.
  Future<void> _fork() async {
    final messenger = ScaffoldMessenger.maybeOf(context);
    final shell = PhoneShellScope.maybeOf(context);
    final notifier = widget.notifier;
    final machineId = widget.machineId;
    final result = await showForkAgentDialog(
      context,
      notifier,
      machineId,
      widget.agentId,
    );
    if (result == null) {
      final pending = notifier.forkPending(machineId, widget.agentId);
      if (pending == null) return;
      final landed = await pending;
      final opened = landed.agentId;
      // A menu opened in the wait would cover the answer — see [_putMenuAway].
      if (mounted) _putMenuAway();
      messenger?.showSnackBar(
        SnackBar(
          content: Text(landed.error ?? landed.notice ?? 'Fork created.'),
          action: landed.error != null || opened == null
              ? null
              : SnackBarAction(
                  label: 'Open',
                  onPressed: () => mounted
                      ? openAgent(context, notifier, machineId, opened)
                      : shell?.onOpenAgent(machineId, opened),
                ),
        ),
      );
      return;
    }
    final said =
        result.notice ??
        (result.level == 'handoff'
            ? 'Fork opened with a handoff summary of the source conversation.'
            : null);
    if (said != null) messenger?.showSnackBar(SnackBar(content: Text(said)));
    final next = result.agentId;
    if (next == null) return;
    if (mounted) {
      openAgent(context, notifier, machineId, next);
    } else {
      shell?.onOpenAgent(machineId, next);
    }
  }

  /// Change agent: pick the engine, and the harness goes on there with the conversation handed
  /// over — then the new one opens in place of this one. See [AppNotifier.changeAgent].
  ///
  /// The choices are the desktop picker's rows in its words: the agent it is on now, and for each
  /// other whether the conversation goes with it or it starts a new one in the same project.
  ///
  /// ⚠️ **What opens the new agent is captured before the wait.** The switch stops this agent, and
  /// this page can leave on its own while the answer is still out (its pane goes — see
  /// `_hadPane`); the shell, which puts an agent on the home screen, is still there to open it.
  Future<void> _changeAgent(Agent agent) async {
    final current = agent.engine;
    final picked = await showNewAgentChooser<String>(
      context,
      title: 'Change agent',
      hint: 'Search agents',
      items: [
        for (final id in AppNotifier.agentChangeEngines())
          ChooserItem(
            value: id,
            title: id == 'claude' ? 'Claude Code' : engineIdentity(id).label,
            subtitle: id == current
                ? 'Current agent'
                : id == 'opencode'
                ? 'Muse Spark 1.3 · continue with recent context'
                : supportsAgentHandoff(id)
                ? 'Continue this project with recent context'
                : 'New conversation in the same project',
            selected: id == current,
          ),
      ],
    );
    if (picked == null || picked == current || !mounted) return;
    final messenger = ScaffoldMessenger.maybeOf(context);
    final shell = PhoneShellScope.maybeOf(context);
    // Held for the whole switch — see [_barHold].
    _hold('switching to ${engineIdentity(picked).label}…');
    final result = await widget.notifier.changeAgent(
      widget.machineId,
      widget.agentId,
      picked,
    );
    if (mounted) {
      _hold(null);
      // Before the answer is said: a menu opened in the wait would cover it — see [_putMenuAway].
      _putMenuAway();
    }
    final said = result.error ?? result.notice;
    if (said != null) messenger?.showSnackBar(SnackBar(content: Text(said)));
    final next = result.agentId;
    if (result.error != null || next == null || next == widget.agentId) return;
    if (mounted) {
      openAgent(
        context,
        widget.notifier,
        widget.machineId,
        next,
        replacingCurrentPage: true,
      );
    } else {
      shell?.onOpenAgent(widget.machineId, next);
    }
  }

  /// Stopping the agent: the last card of its sheet, alone.
  ///
  /// Alone and in red because everything above it is recoverable and this is not, so it does not
  /// sit where a thumb lands on the way to them. The label keeps "Harness" where the others dropped
  /// it: a bare "Stop" in a terminal reads as stopping the reply that is running, and the list's
  /// own sheet and the desktop say it this way too.
  ///
  /// ⚠️ Nothing here pops this page. Deleting detaches the pane, and the `_hadPane` branch above
  /// leaves on its own when that happens — the same path a delete from the list, or from the
  /// desktop, already takes. A pop here would be a second one, and the parked pages in this pager
  /// share the route.
  PhoneSheetAction _stopAction(Agent agent) => PhoneSheetAction(
    icon: LucideIcons.trash2300,
    // The least used thing here: small at the foot, not a full red row (it still confirms).
    label: 'Stop this harness',
    destructive: true,
    quiet: true,
    onTap: () => unawaited(
      confirmDeleteAgent(
        context,
        widget.notifier,
        widget.machineId,
        widget.agentId,
        agent.name,
      ),
    ),
  );

  /// Stop after it finishes, or — with one queued — Keep running. See [AppNotifier.stopAfterTask].
  /// Quiet at the foot like Stop; a queued Stop is said in the row itself, the desktop's words
  /// for it, since a quiet row draws no value.
  PhoneSheetAction _stopAfterAction(Agent agent) {
    final queued = agent.closePlanState == 'waiting';
    final pending = widget.notifier.agentClosePlanPending(
      widget.machineId,
      widget.agentId,
    );
    return PhoneSheetAction(
      icon: queued ? LucideIcons.play300 : LucideIcons.timerOff300,
      label: queued
          ? 'Stops after finishing · Keep running'
          : 'Stop after it finishes',
      enabled: !pending,
      destructive: !queued,
      quiet: true,
      onTap: () => unawaited(_stopAfter(queued: queued)),
    );
  }

  /// What the queued Stop came to, said once its machine has answered — on the snackbar, as
  /// Restart's answer is.
  Future<void> _stopAfter({required bool queued}) async {
    final messenger = ScaffoldMessenger.maybeOf(context);
    final error = queued
        ? await widget.notifier.keepRunning(widget.machineId, widget.agentId)
        : await widget.notifier.stopAfterTask(widget.machineId, widget.agentId);
    if (mounted) _putMenuAway();
    messenger?.showSnackBar(
      SnackBar(
        content: Text(
          error ?? (queued ? 'Keeps running.' : 'Stops after it finishes.'),
        ),
      ),
    );
  }

  /// Delete Harness — see [confirmPurgeAgent]. Small at the foot beside Stop, and saying so while a
  /// delete is out, as Restart does: the review and the delete can take a while. In its label, in
  /// the desktop's word for it — a quiet row draws no value.
  PhoneSheetAction _purgeAction(Agent agent) {
    final deleting = widget.notifier.agentPurging(
      widget.machineId,
      widget.agentId,
    );
    return PhoneSheetAction(
      icon: LucideIcons.trash300,
      label: deleting ? 'Deleting…' : 'Delete this harness',
      enabled: !deleting,
      destructive: true,
      quiet: true,
      onTap: () => unawaited(
        confirmPurgeAgent(
          context,
          widget.notifier,
          widget.machineId,
          widget.agentId,
          agent.name,
        ),
      ),
    );
  }

  /// Asks for the terminal this pane is only watching, or reopens the stream it lost — a tap or a
  /// scroll on a terminal held elsewhere.
  ///
  /// `selectAgent` works out which of the two it is from the stream as it stands, and declines
  /// quietly when the pane cannot be attached at all (its machine went offline meanwhile, the
  /// agent was withdrawn).
  Future<void> _takeControl() =>
      widget.notifier.selectAgent(widget.machineId, widget.agentId);

  /// The sheet's Interrupt: Esc, on a terminal taken back first when another client holds it.
  ///
  /// ⚠️ **Offered while the terminal is only watched, so it takes it.** The row shows whenever the
  /// agent works, and a terminal held by the computer drops a key the phone sends — so Interrupt,
  /// wanted most when something has to stop now, used to do nothing there and say nothing.
  Future<void> _interrupt() async {
    final held = widget.notifier
        .paneOfAgent(widget.machineId, widget.agentId)
        ?.session;
    if (held != null && held.acceptsInput) {
      held.terminal.keyInput(TerminalKey.escape);
      return;
    }
    if (_interruptWaiting) return;
    _interruptWaiting = true;
    try {
      final session = await _sessionForInput(why: 'interrupt');
      if (!mounted) return;
      if (session == null) {
        _flash('✗ not sent', error: true);
        return;
      }
      session.terminal.keyInput(TerminalKey.escape);
    } finally {
      _interruptWaiting = false;
    }
  }

  /// Set while an Interrupt waits for the terminal to come back, so a second one pressed in that
  /// wait — the sheet opened again because nothing seemed to happen — adds no second Esc once it
  /// has: on Claude Code's empty prompt, Esc twice opens the rewind to an earlier message.
  bool _interruptWaiting = false;

  /// Restarting is a round trip that can fail, and the phone has no status rail to fail into — so
  /// the answer lands as a snackbar, which is the one surface a pushed page here always has.
  ///
  /// Said only when there is something to say. A restart that came back on its own conversation
  /// says nothing: the terminal shows it. One that came back on a NEW conversation says so, in the
  /// desktop's words — the engine could not reopen the old one, which is kept as a stopped harness
  /// (`cli/src/core/agents/restart.ts`), and an empty prompt is easily taken for the conversation
  /// it replaced. Except on a terminal, which always restarts as a fresh shell (the desktop does not
  /// say it there either). Anything else is [RestartAgentResult.error], already a sentence.
  Future<void> _restart(Agent agent) async {
    final messenger = ScaffoldMessenger.maybeOf(context);
    final result = await widget.notifier.restartAgent(
      widget.machineId,
      widget.agentId,
    );
    final said =
        result.error ??
        (result.resumed || agent.engine == 'terminal'
            ? null
            : 'Restarted with a new conversation.');
    if (said == null || messenger == null || !mounted) return;
    messenger.showSnackBar(SnackBar(content: Text(said)));
  }
}

/// The page's MediaQuery with the bottom inset taken out — see the note on
/// `removePadding` in [_TerminalPageState.build].
///
/// ⚠️ **Its own widget so the PAGE does not depend on the MediaQuery.**
/// `MediaQuery.removePadding` reads the whole of it through the context it is
/// given, and given the page's, every change to any field rebuilt the page and
/// the terminal under it — once a frame while a keyboard slid (measured on a
/// phone, 2026-10-05: ~13 rebuilds a slide, all of them `didChangeDependencies`).
/// Here only this rebuilds, and hands the same [child] on: what lies below is
/// rebuilt only where it reads a value that actually changed.
class _NoBottomPadding extends StatelessWidget {
  const _NoBottomPadding({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) => MediaQuery.removePadding(
    context: context,
    removeBottom: true,
    child: child,
  );
}

/// What the terminal shows when the agent it opened on is not there any more.
///
/// ⚠️ **This is the cost of opening from the cache, and the whole of it.** The
/// phone draws its terminal from last run's agent list so the screen is usable
/// in half a second (`MachineCache`), and the machine's real list lands a moment
/// later. Almost always they agree. When they do not — the agent was deleted
/// from another device since this phone last looked — the terminal is already on
/// screen with a name on it, and this is what replaces its body.
///
/// Worded as a fact about the agent, not as a failure of the app: nothing went
/// wrong here, something simply changed elsewhere. The button is the way out,
/// because a dead end on the phone's home screen leaves nothing to tap at all.
class _AgentGone extends StatelessWidget {
  const _AgentGone({required this.name, required this.onPickAnother});

  /// The agent as the cache knew it, so the sentence names what is missing
  /// rather than gesturing at "the agent".
  final String? name;

  final VoidCallback onPickAnother;

  @override
  Widget build(BuildContext context) => Center(
    child: Padding(
      padding: const EdgeInsets.symmetric(horizontal: 32),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          // The 300 weight every other glyph on this page uses.
          Icon(LucideIcons.wind300, size: 26, color: AppPalette.textSecondary),
          const SizedBox(height: 14),
          Text(
            name == null || name!.isEmpty
                ? 'That harness is gone'
                : '$name is gone',
            textAlign: TextAlign.center,
            style: TextStyle(
              color: AppPalette.textPrimary,
              fontSize: 15,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 8),
          Text(
            'It was closed on another device since you were last here.',
            textAlign: TextAlign.center,
            style: TextStyle(
              color: AppPalette.textSecondary,
              fontSize: 13,
              height: 1.4,
            ),
          ),
          const SizedBox(height: 18),
          TextButton(
            onPressed: onPickAnother,
            style: TextButton.styleFrom(
              foregroundColor: AppPalette.accent,
              padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 10),
            ),
            child: const Text('Open another harness'),
          ),
        ],
      ),
    ),
  );
}

/// The terminal's body while its machine is away — offline, and the account agrees (see
/// [phoneMachineAway]) — with no screen of it to show.
///
/// ⚠️ **In the skeleton's place, because the skeleton would be a lie.** [_Attaching] promises a
/// keyframe on its way; a machine that is away sends none until Harness runs there again, and a
/// computer just restarted held the phone on that promise for close to 90 seconds with nothing on
/// screen saying why. This says what the machines list says of it, and that the page comes back by
/// itself: the machine's return already reattaches the agent on screen.
///
/// Drawn as the chrome is (see `tty.dart`): the terminal's own ground and face, no icon. Opaque, as
/// it lies over an empty panel, and it lets taps through to that panel, as the skeleton does.
class _MachineAway extends StatelessWidget {
  const _MachineAway({required this.name});

  /// The machine as the account names it.
  final String name;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    return IgnorePointer(
      child: ColoredBox(
        color: tty.ground,
        child: Center(
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 32),
            child: Semantics(
              liveRegion: true,
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    '$name is ${phoneMachineWord(PhoneMachineStatus.offline)}',
                    textAlign: TextAlign.center,
                    style: tty.style(
                      size: TtySize.row,
                      weight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    'turn it on, or run harness start there'
                    ' · this opens by itself when it’s back',
                    textAlign: TextAlign.center,
                    style: tty.style(size: TtySize.meta, color: tty.faint),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Laid over a screen this terminal already drew while it is brought back — its stream reopened,
/// or its socket dialled again — a light blur and a spinner, with the screen still under them.
///
/// ⚠️ **Over the old screen, not in its place (owner, 2026-10-15).** The skeleton ([_Attaching])
/// stands for a terminal with nothing on it yet. Laid over one the reader was just reading — back
/// from a network switch, a redial — it made their terminal vanish into a skeleton and come back a
/// moment later, which read as lost work. The screen stays; this only says it is being refreshed,
/// and goes the moment the new stream's keyframe replaces it.
///
/// ⚠️ **After a beat ([showAfter]).** A reopen on a good line is answered in a few hundred
/// milliseconds; a spinner and a blur flashed over a terminal for that long read as a glitch. Only
/// a wait that lasts gets them, faded in.
///
/// ⚠️ **The blur is light and short-lived, and the spinner is on its own layer.** A `BackdropFilter`
/// re-blurs what is under it whenever the frame is drawn again, which is why the floating buttons
/// lost theirs (`FloatingGlass`, `floating_glass.dart`): they sit over a streaming terminal all
/// the time. This is up only for the seconds a terminal is being brought back, over a screen that
/// is not streaming, at a small sigma; the spinner's own [RepaintBoundary] keeps its animation out
/// of the blurred layer. With animations off it stands still, so nothing redraws at all.
///
/// Taps go through to the terminal, as the skeleton's do: a swipe to Find or another agent, or a tap
/// to raise the keyboard, should not wait for the reconnect.
class _Reconnecting extends StatefulWidget {
  const _Reconnecting();

  /// How long a reconnect may take before it is shown at all.
  static const showAfter = Duration(milliseconds: 300);

  @override
  State<_Reconnecting> createState() => _ReconnectingState();
}

class _ReconnectingState extends State<_Reconnecting> {
  Timer? _wait;
  bool _shown = false;

  @override
  void initState() {
    super.initState();
    _wait = Timer(_Reconnecting.showAfter, () {
      if (mounted) setState(() => _shown = true);
    });
  }

  @override
  void dispose() {
    _wait?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    // Not even the blur before the beat: a quick reopen should leave the screen exactly as it was.
    if (!_shown) return const SizedBox.shrink();
    final tty = Tty.of(context);
    final still = MediaQuery.disableAnimationsOf(context);
    return IgnorePointer(
      child: Semantics(
        key: const ValueKey('terminal-reconnecting'),
        label: 'Reconnecting to the harness',
        liveRegion: true,
        child: TweenAnimationBuilder<double>(
          tween: Tween(begin: 0, end: 1),
          duration: still ? Duration.zero : const Duration(milliseconds: 180),
          builder: (context, fade, child) =>
              Opacity(opacity: fade, child: child),
          child: Stack(
            fit: StackFit.expand,
            children: [
              ClipRect(
                child: BackdropFilter(
                  filter: ui.ImageFilter.blur(sigmaX: 2.5, sigmaY: 2.5),
                  child: ColoredBox(color: tty.ground.withValues(alpha: 0.3)),
                ),
              ),
              Center(
                child: RepaintBoundary(
                  child: SizedBox.square(
                    dimension: 22,
                    // The app's one spinner, as Settings ▸ Sign out and the home screen draw it.
                    // Still with animations off: three quarters of a ring, so it reads as waiting.
                    child: CircularProgressIndicator(
                      strokeWidth: 2,
                      color: AppPalette.accent,
                      value: still ? 0.75 : null,
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// The terminal's body while its first keyframe is still crossing the network.
///
/// ⚠️ **A skeleton here, not a spinner, because the shape IS known** — that is
/// the rule `shared/widgets/skeleton.dart` opens with. What arrives is a page of
/// monospace lines, and drawing lines of the terminal's own type at the
/// terminal's own leading means the keyframe lands INTO the layout already on
/// screen rather than replacing a centred spinner with a wall of text. The
/// screen stops flashing between two unrelated pictures.
///
/// The content itself cannot be cached: a terminal is a live screen a remote
/// program is drawing, and the only authoritative copy is the keyframe the
/// machine sends on attach (`terminal_keyframe`). Everything AROUND it is
/// already on screen by now from the agent cache — the name, the project, the
/// header — so this is the one part of the launch that still has to wait, and
/// the skeleton is what makes that wait look like the thing being waited for.
///
/// Metrics come from `terminalFontStore`, which is loaded before the first frame
/// (`core/startup.dart`), so these rows are the height the real ones will be.
///
/// ⚠️ **It draws the transcript's STRUCTURE, not a stack of grey bars.** The
/// first version was a column of plain lines and read as a loading page for some
/// other app — nothing about it suggested a terminal. What actually arrives has
/// a strong, repeating shape: a prompt led by its `›`, a bulleted answer
/// indented under it, a dim meta line closing the turn. Standing
/// in for THAT is what makes the wait read as "your session is coming back"
/// rather than "something is loading", and it is the same rule
/// `PhoneListSkeleton` follows for a list of cards — the same cards, empty, at a
/// real row's height.
class _Attaching extends StatefulWidget {
  const _Attaching({super.key});

  @override
  State<_Attaching> createState() => _AttachingState();
}

class _AttachingState extends State<_Attaching> with TickerProviderStateMixin {
  /// How long the block takes to arrive, top edge to bottom.
  ///
  /// ⚠️ **Matched to the wait it covers, not chosen for its own sake.** Measured
  /// on this app against a real machine, the gap between the agent list landing
  /// and the terminal's first keyframe — which is exactly the stretch this
  /// skeleton is on screen — runs about 2.5 to 3 seconds. At the 620ms this
  /// started on, the sweep finished in the first fifth of that and then sat
  /// perfectly still, which reads as a page that has given up rather than one
  /// that is filling.
  ///
  /// So the sweep is paced to arrive at the bottom edge at roughly the moment
  /// the real screen does. Finishing EARLY is the one direction that is fine and
  /// is what a fast attach produces: the skeleton is simply replaced, complete,
  /// by the terminal. Finishing late is the case the curve below handles.
  static const _revealDuration = Duration(milliseconds: 2600);

  /// How much of the pane the timed sweep covers before it hands over.
  ///
  /// ⚠️ **The sweep deliberately does not finish on its own.** A reveal that
  /// completes and then holds still is the failure mode this pacing was changed
  /// to fix; running to 100% just moves that stall from five seconds in to two
  /// and a half. Stopping a little short instead means the last band of the
  /// screen is still arriving whenever the keyframe lands, so the skeleton is
  /// always replaced mid-motion — which reads as the real screen overtaking it
  /// rather than as a placeholder that gave up waiting.
  ///
  /// The remainder is never shown filling: the terminal takes the pane. On an
  /// attach slower than [_revealDuration] the bottom band simply stays dim, and
  /// the pulse underneath keeps the block alive.
  ///
  /// 0.84 leaves roughly the last 9% of the pane below the soft edge — about one
  /// turn on a phone. Worked out against [_SkeletonPainter._feather] rather than
  /// guessed: the edge travels `t * (1 + 2f) - f`, so it reaches the bottom at
  /// `t = 1`, and values much above this finish the sweep after all.
  static const _sweepExtent = 0.84;

  /// One half of the breath — rest to peak; the whole breath is twice this. The
  /// 1100ms `shared/widgets/skeleton.dart` sets for a placeholder: slower than
  /// the status LED's blink, because the two are different instruments.
  static const _pulseDuration = Duration(milliseconds: 1100);

  late final AnimationController _reveal = AnimationController(
    vsync: this,
    duration: _revealDuration,
    upperBound: _sweepExtent,
  );

  /// The bars' breath — one controller for the whole block, so the rows breathe
  /// together rather than shimmering independently.
  ///
  /// Owned here rather than borrowed from `Pulse`: that widget rebuilds its
  /// subtree on every frame of the breath, which for this block was seventy-odd
  /// widgets per frame — and the whole reason [_SkeletonPainter] exists is to
  /// spend a repaint on it instead.
  late final AnimationController _pulse = AnimationController(
    vsync: this,
    duration: _pulseDuration,
  );

  late final Animation<double> _breath = CurvedAnimation(
    parent: _pulse,
    curve: Curves.easeInOut,
  );

  /// Whether the sweep and the breath are running. False with the page parked
  /// beside the one on screen, or with animations turned off — see
  /// [didChangeDependencies] for what is drawn then.
  ///
  /// ⚠️ **Null until the first [didChangeDependencies], not false.** Starting
  /// on false, a skeleton BUILT still — Reduce Motion on, or a page built parked
  /// — found nothing changed, skipped the jump to the sweep's end, and drew bare
  /// ground for the whole wait.
  bool? _animating;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // ⚠️ **Still, not blank, when it cannot animate.** The pager keeps this page
    // mounted beside the one on screen with its tickers off (see
    // `AgentSwipeHost`), and a sweep that never started would leave the reveal
    // covering everything: the page would slide in as bare ground. So with no
    // ticker the sweep is jumped to where it would end and the breath held at
    // rest, and the block is simply there. The same answer for a person who has
    // turned animations off, which `Pulse` gives too.
    final animate =
        TickerMode.valuesOf(context).enabled &&
        !MediaQuery.disableAnimationsOf(context);
    if (animate == _animating) return;
    _animating = animate;
    if (animate) {
      if (!_reveal.isCompleted) _reveal.forward();
      _pulse.repeat(reverse: true);
    } else {
      _reveal
        ..stop()
        ..value = _sweepExtent;
      _pulse
        ..stop()
        ..value = 0;
    }
  }

  @override
  void dispose() {
    _reveal.dispose();
    _pulse.dispose();
    super.dispose();
  }

  /// The shapes turns are cut from, cycled to fill whatever height the pane has.
  ///
  /// ⚠️ **A fixed list of turns cannot fill a screen.** Four of them left the
  /// top half of a tall phone empty, which reads as a page that finished loading
  /// with almost nothing on it — the opposite of what a skeleton is for. The
  /// painter measures the pane and takes as many of these as it needs, so the
  /// block reaches the top edge on any device at any terminal font size.
  ///
  /// Five, and a prime count, so cycling does not line the same shape up under
  /// itself every other turn: with four the eye picks out the repeat immediately.
  static const _shapes = <_SkeletonTurn>[
    _SkeletonTurn(prompt: 0.44, answer: [0.89, 0.57], meta: 0.42),
    _SkeletonTurn(prompt: 0.52, answer: [0.94, 0.88, 0.41], meta: 0.46),
    _SkeletonTurn(prompt: 0.38, answer: [0.91, 0.62], meta: 0.44),
    _SkeletonTurn(prompt: 0.57, answer: [0.83, 0.96, 0.49], meta: 0.39),
    _SkeletonTurn(prompt: 0.61, answer: [0.86, 0.93, 0.77, 0.35], meta: null),
  ];

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final style = terminalFontStore.value;
    final fontSize = style.fontSize;
    // The terminal's own line box, so a row here and a row of output occupy the
    // same band. `height` is xterm's line-height multiplier.
    final lineHeight = fontSize * style.height;
    // Resolved exactly as [TerminalPanel] resolves it for the view underneath,
    // so the skeleton's ground and the terminal's are the same colour.
    final ground = terminalScreenThemeFor(
      AppTheme.palette.value,
      terminalThemeStore.value,
    ).background;
    // ⚠️ **Mixed against the terminal's OWN ground, not taken from
    // `AppSurface.recess`.** That token is a translucent well meant to sit on a
    // card — around 6% white — and over this app's near-black terminal
    // (`#181818`) it renders at about `#262626`: a difference of sixteen values,
    // which is invisible on a phone screen in daylight and is why the first
    // version of this skeleton could not be seen at all.
    //
    // These are opaque blends instead, so the contrast is a property of the bars
    // rather than of whatever happens to be behind them, and the terminal's
    // background is read from the user's chosen scheme so a light terminal theme
    // gets bars that are darker than its ground rather than lighter.
    final light =
        ThemeData.estimateBrightnessForColor(ground) == Brightness.light;
    final ink = light ? Colors.black : Colors.white;
    final rest = Color.alphaBlend(ink.withValues(alpha: 0.10), ground);
    final peak = Color.alphaBlend(ink.withValues(alpha: 0.17), ground);
    // The prompt — the line the person typed — a step brighter than the answer
    // under it, and breathing with it.
    //
    // ⚠️ **This is what marks the prompt now, in place of a band.** The prompt
    // used to sit on its own full-width ground: a square-cornered band with a
    // rounded bar inside it — one shape nested in another, and the only square
    // corners in a block of rounded bars. It read as a table row with a
    // placeholder in it rather than as a line of a transcript. What sets the
    // prompt apart on the real screen is its `›` and its weight, so that is what
    // is drawn: the chevron in the gutter, and a bar a step brighter than the
    // answer's. Its rest is the answer's peak, so the two never meet mid-breath.
    final promptRest = Color.alphaBlend(ink.withValues(alpha: 0.17), ground);
    final promptPeak = Color.alphaBlend(ink.withValues(alpha: 0.25), ground);
    final bar = (fontSize * 0.62).clamp(5.0, 12.0).toDouble();
    return SkeletonBlock(
      semanticsLabel: 'Attaching to the harness',
      // ⚠️ **One painter, repainted, in a layer of its own** — where this was a
      // column of seventy-odd widgets rebuilt on every frame of the breath, under
      // a [ShaderMask] that pushed the whole pane through an offscreen buffer on
      // every frame of the sweep. Both animations are a repaint of one render
      // object now, and the [RepaintBoundary] keeps that repaint from reaching
      // the live panel underneath or the chrome above.
      child: RepaintBoundary(
        child: CustomPaint(
          painter: _SkeletonPainter(
            breath: _breath,
            reveal: _reveal,
            lineHeight: lineHeight,
            bar: bar,
            ground: ground,
            rest: rest,
            peak: peak,
            promptRest: promptRest,
            promptPeak: promptPeak,
          ),
          child: const SizedBox.expand(),
        ),
      ),
    );
  }

  /// What one turn occupies, so the painter can work out how many fit.
  ///
  /// ⚠️ **Must stay in step with [_SkeletonPainter._turn]**, which is why the
  /// terms are written in the same order as the rows it draws: prompt, gap,
  /// answer lines, gap and meta line, trailing gap. A drift here does not break
  /// the picture — the block is clipped either way — it just means a turn too
  /// few (a band of empty ground at the top) or one too many (wasted paint).
  static double _turnHeight(_SkeletonTurn turn, {required double lineHeight}) =>
      lineHeight + // the prompt
      lineHeight * 0.35 + // the gap under it
      lineHeight * turn.answer.length +
      (turn.meta == null ? 0 : lineHeight * 0.35 + lineHeight) +
      lineHeight * 0.9; // the gap to the next turn
}

/// Paints [_Attaching]: the turns of a transcript, bottom-aligned and clipped at
/// the top the way a terminal sits, breathing with [breath] and wiped in from
/// the top by [reveal].
///
/// Everything the widget tree this replaced did, as drawing — each piece keeps
/// the note that explained it there.
class _SkeletonPainter extends CustomPainter {
  _SkeletonPainter({
    required this.breath,
    required this.reveal,
    required this.lineHeight,
    required this.bar,
    required this.ground,
    required this.rest,
    required this.peak,
    required this.promptRest,
    required this.promptPeak,
  }) : super(repaint: Listenable.merge([breath, reveal]));

  /// 0 at rest, 1 at the peak of the breath.
  final Animation<double> breath;

  /// The sweep's progress, 0→1; where the edge is for a value is worked out in
  /// [_revealFrom].
  final Animation<double> reveal;

  final double lineHeight;

  /// A bar's thickness — the height of a line of text, roughly.
  final double bar;

  final Color ground;
  final Color rest;
  final Color peak;

  /// The prompt's bar at rest and at the peak of the breath — a step above
  /// [rest] and [peak]. See the note where they are mixed.
  final Color promptRest;
  final Color promptPeak;

  /// ⚠️ The terminal view's OWN padding (`TerminalPanel` passes
  /// `EdgeInsets.all(10)` to the xterm view), so a bar starts on the column the
  /// first character will occupy. A different gutter here would shift every
  /// line sideways the moment the keyframe lands.
  static const _padding = 10.0;

  /// The soft edge's depth, as a fraction of the pane.
  ///
  /// 0.10, down from the 0.18 a fast sweep used: feather is a fraction of the
  /// PANE, so at a slow rate a wide one keeps a fifth of the screen in permanent
  /// half-light as it crawls past. Narrow enough to stay crisp, wide enough that
  /// what crosses a row is still a brightening rather than a switch.
  static const _feather = 0.10;

  @override
  void paint(Canvas canvas, Size size) {
    final full = Offset.zero & size;
    // Opaque, because this covers a live [TerminalPanel] — see the note at the
    // call site. Without it the empty emulator buffer shows between the bars
    // and the two grounds differ by a hair, which reads as a smudge.
    canvas.drawRect(full, Paint()..color = ground);
    final inner = full.deflate(_padding);
    if (inner.width <= 0 || inner.height <= 0) return;
    // ⚠️ **As many turns as the pane is tall, not a fixed four.** A fixed list
    // left the top half of a tall phone empty, which reads as a page that has
    // finished loading and has almost nothing on it. One extra turn is added
    // beyond the measured fit so the topmost one is genuinely cut by the edge
    // rather than ending a few pixels short of it.
    final shapes = _AttachingState._shapes;
    final perTurn = _AttachingState._turnHeight(
      shapes[0],
      lineHeight: lineHeight,
    );
    final count = perTurn > 0
        ? (inner.height / perTurn).ceil() + 1
        : shapes.length;
    final turns = [
      for (var i = 0; i < count; i++)
        // Cycled from the back, so the LAST shape is always the one at the
        // bottom edge: it is the only one written without a closing meta line,
        // which is what an in-progress turn looks like.
        shapes[shapes.length - 1 - i % shapes.length],
    ].reversed.toList();
    // ⚠️ Aligned to the BOTTOM and clipped at the top, which is how a terminal
    // itself sits: the newest output is at the bottom edge and history runs off
    // the top. The extra turn above guarantees the column exceeds the pane; the
    // clip cuts what runs past.
    var total = 0.0;
    for (final turn in turns) {
      total += _AttachingState._turnHeight(turn, lineHeight: lineHeight);
    }
    // The newest turn ends at the bottom edge, as the live screen's does — no
    // gap after it. See `last` in [_turn].
    total -= lineHeight * 0.9;
    final fill = Color.lerp(rest, peak, breath.value)!;
    final prompt = Color.lerp(promptRest, promptPeak, breath.value)!;
    canvas.save();
    canvas.clipRect(full);
    var top = inner.bottom - total;
    for (var i = 0; i < turns.length; i++) {
      // Oldest at 0.4, newest at full: the block nearest the top edge is the one
      // about to be clipped by it, so it fades INTO that edge rather than ending
      // against it. Blended against the ground rather than composited through
      // an opacity layer — the ground is opaque, so the picture is the same.
      final opacity = turns.length == 1
          ? 1.0
          : 0.4 + (i / (turns.length - 1)) * 0.6;
      top = _turn(
        canvas,
        turns[i],
        inner: inner,
        top: top,
        fill: Color.lerp(ground, fill, opacity)!,
        prompt: Color.lerp(ground, prompt, opacity)!,
        last: i == turns.length - 1,
      );
    }
    _revealFrom(canvas, full);
    canvas.restore();
  }

  /// One turn: the prompt, the bulleted answer under it, the meta line — drawn
  /// from [top] down, answering with where the next turn starts.
  ///
  /// Every row is exactly one terminal line box tall, so the whole block
  /// occupies a whole number of rows and the keyframe replaces it without the
  /// page growing or shrinking by a fraction of a line.
  ///
  /// ⚠️ **Must stay in step with [_AttachingState._turnHeight]**: the terms
  /// there are written in the order of the rows here.
  double _turn(
    Canvas canvas,
    _SkeletonTurn turn, {
    required Rect inner,
    required double top,
    required Color fill,
    required Color prompt,
    required bool last,
  }) {
    final x = inner.left;
    final width = inner.width;
    final paint = Paint()..color = fill;
    // Where every row's text starts — after the prompt's `›` and the answer's
    // bullet alike, so the block keeps the one left edge the transcript has.
    final indent = bar * 1.25;
    var y = top;
    // The prompt: its `›` in the gutter, then the line, a step brighter than
    // the answer — the two things that set it apart on the real screen.
    _chevron(canvas, x, y, prompt);
    _bar(
      canvas,
      x + indent,
      y,
      turn.prompt * (width - indent),
      Paint()..color = prompt,
    );
    y += lineHeight + lineHeight * 0.35;
    // The answer: a bullet on the first row, the rest indented under it.
    for (var i = 0; i < turn.answer.length; i++) {
      if (i == 0) {
        final dot = bar * 0.55;
        canvas.drawCircle(
          Offset(x + dot / 2, y + lineHeight / 2),
          dot / 2,
          paint,
        );
      }
      _bar(canvas, x + indent, y, turn.answer[i] * (width - indent), paint);
      y += lineHeight;
    }
    final meta = turn.meta;
    if (meta != null) {
      y += lineHeight * 0.35;
      // The `✳ Crunched for 3s · done 10:36` line that closes a turn: always
      // shorter, thinner than a line of body text, and quieter than it — the
      // third step down from the prompt.
      _bar(
        canvas,
        x,
        y,
        meta * width,
        Paint()..color = Color.lerp(ground, fill, 0.7)!,
        height: bar * 0.7,
      );
      y += lineHeight;
    }
    if (!last) y += lineHeight * 0.9;
    return y;
  }

  /// The prompt's `›`, in the gutter the real one keeps: as tall as a bar and
  /// centred on the row like the bullet under it, so the two marks line up.
  void _chevron(Canvas canvas, double left, double top, Color color) {
    final height = bar * 0.84;
    final start = left + bar * 0.08;
    final middle = top + lineHeight / 2;
    final stroke = bar * 0.22;
    canvas.drawPath(
      Path()
        ..moveTo(start, middle - height / 2)
        ..lineTo(start + height * 0.5, middle)
        ..lineTo(start, middle + height / 2),
      Paint()
        ..color = color
        ..style = PaintingStyle.stroke
        // Floored at a pixel and a bit: at the smallest terminal fonts the bar
        // is 5pt, and a stroke in proportion to it would be a hairline beside
        // bars and a bullet that are not.
        ..strokeWidth = stroke < 1.2 ? 1.2 : stroke
        ..strokeCap = StrokeCap.round
        ..strokeJoin = StrokeJoin.round,
    );
  }

  /// A bar of text, centred in the line box that starts at [top].
  void _bar(
    Canvas canvas,
    double left,
    double top,
    double width,
    Paint paint, {
    double? height,
  }) {
    final thickness = height ?? bar;
    canvas.drawRRect(
      RRect.fromRectAndRadius(
        Rect.fromLTWH(
          left,
          top + (lineHeight - thickness) / 2,
          width,
          thickness,
        ),
        // Round-ended, the same family as the bullet and the chevron's caps:
        // with a fixed 3pt corner a large terminal font drew square-shouldered
        // slabs beside a round dot.
        Radius.circular(thickness / 2),
      ),
      paint,
    );
  }

  /// Wipes the block in from the top edge to the bottom over [reveal]'s 0→1.
  ///
  /// ⚠️ **A wipe, not a fade or a slide.** The skeleton stands in for a terminal
  /// whose rows must not move — every bar is already at the pixel its text will
  /// occupy — so the reveal cannot translate anything. A plain fade would have
  /// the whole block appear at once, which says nothing about the direction
  /// output arrives from. Covering by height instead lets the rows arrive the
  /// way a screen paints: from the top, downward, each one landing where it
  /// will stay.
  ///
  /// The leading edge is a short gradient rather than a hard line, so what
  /// crosses a row is a brightening rather than a switch — at 60fps a hard edge
  /// stepping down the screen reads as a tear.
  ///
  /// ⚠️ **Linear, and that is the point for a sweep this long.** Every eased
  /// curve front-loads the travel: `easeOutQuad` has the edge 84% of the way
  /// down at the halfway mark, so over a 2.6-second reveal the last row would
  /// take more than a second to gain its final sliver — a sweep that visibly
  /// stalls just before it arrives. A constant rate reads as steady progress,
  /// which is what it is standing in for.
  void _revealFrom(Canvas canvas, Rect full) {
    final t = reveal.value;
    // Kept even though the controller stops short of 1 (see
    // [_AttachingState._sweepExtent]): a cover that hides nothing is pure cost
    // per frame.
    if (t >= 1) return;
    // Travels from just above the top edge towards just past the bottom, so the
    // first row is fully revealed rather than starting at half brightness. It
    // does not arrive: the controller is bounded below the value that would
    // take it there.
    final edge = t * (1 + _feather * 2) - _feather;
    // Ground laid OVER the bars from the edge down — the same picture the
    // `dstIn` mask this replaced gave, without the offscreen layer a mask needs:
    // the ground is opaque, so covering is as good as cutting.
    final cover = Paint()
      ..shader = LinearGradient(
        begin: Alignment.topCenter,
        end: Alignment.bottomCenter,
        colors: [
          ground.withValues(alpha: 0),
          ground.withValues(alpha: 0),
          ground,
        ],
        // Clamped because a stop list must be non-decreasing and within 0..1;
        // at the extremes of the travel above, both terms run outside it.
        stops: [0, (edge - _feather).clamp(0.0, 1.0), edge.clamp(0.0, 1.0)],
      ).createShader(full);
    canvas.drawRect(full, cover);
  }

  @override
  bool shouldRepaint(_SkeletonPainter old) =>
      old.lineHeight != lineHeight ||
      old.bar != bar ||
      old.ground != ground ||
      old.rest != rest ||
      old.peak != peak ||
      old.promptRest != promptRest ||
      old.promptPeak != promptPeak ||
      !identical(old.breath, breath) ||
      !identical(old.reveal, reveal);
}

/// The shape of one transcript turn, for [_Attaching].
class _SkeletonTurn {
  const _SkeletonTurn({
    required this.prompt,
    required this.answer,
    required this.meta,
  });

  /// Width of the prompt's text, as a fraction of the row after its `›`.
  final double prompt;

  /// The answer's lines, longest first — a paragraph wraps full-width and its
  /// last line runs short.
  final List<double> answer;

  /// The closing meta line, or null for the newest turn, which has not finished.
  final double? meta;
}

/// Slides the title off the top as [progress] runs 0 → 1, fading it as it goes.
class _SlideAway extends StatelessWidget {
  const _SlideAway({required this.progress, required this.child});

  /// 0 fully shown, 1 fully gone.
  final Animation<double> progress;

  final Widget child;

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: progress,
    // ⚠️ Built ONCE and passed through. What changes on a frame of a scroll is where the title is
    // painted, not anything in it.
    child: child,
    builder: (context, child) {
      final value = progress.value;
      return IgnorePointer(
        ignoring: value > 0,
        child: FractionalTranslation(
          translation: Offset(0, -value),
          child: Opacity(
            opacity: (1 - value / 0.66).clamp(0.0, 1.0),
            child: child,
          ),
        ),
      );
    },
  );
}

/// Holds the agent's last line at the foot of the screen while the output is followed at its end,
/// by moving the terminal rather than resizing it.
///
/// A terminal fills from the top, so output shorter than the screen left a band of empty rows at
/// the bottom while its first lines sat under the title. Moved, it fills the screen from the
/// bottom up, the empty rows above it, under the title — the screen is always full. The pty
/// keeps the whole screen, so reading back through the history uses every row: while it is read
/// ([enabled] off) the terminal eases back to where it is drawn. Nothing moves on the alternate
/// screen, where a full-screen program owns its own layout.
/// What [_AnchoredTerminal] places the terminal by: the buffer's height and its last line with
/// anything on it.
typedef _Anchor = ({int height, int last});

class _AnchoredTerminal extends StatefulWidget {
  const _AnchoredTerminal({
    required this.terminal,
    required this.enabled,
    required this.reading,
    required this.clearBottom,
    required this.child,
  });

  final Terminal? terminal;
  final bool enabled;

  /// Non-null while the history is read back: the terminal is where it is drawn, then.
  final ValueListenable<Object?> reading;

  /// How far above the terminal's foot its last line is held.
  final double clearBottom;
  final Widget child;

  @override
  State<_AnchoredTerminal> createState() => _AnchoredTerminalState();
}

class _AnchoredTerminalState extends State<_AnchoredTerminal> {
  /// Eases only when the reading starts or stops; output moves it at once, as output moves.
  DateTime _easeUntil = DateTime.fromMillisecondsSinceEpoch(0);

  late bool _on = _wantsOn;

  bool get _wantsOn => widget.enabled && widget.reading.value == null;

  @override
  void initState() {
    super.initState();
    widget.reading.addListener(_toggled);
    terminalFontStore.addListener(_changed);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _listenToOutput(!OutOfSight.of(context));
  }

  /// Whether [_output] is listening.
  bool _listeningToOutput = false;

  /// Follows the output only while the terminal can be seen. Out of sight
  /// (Harness under Swarm Home, [OutOfSight]) the output stays in the buffer,
  /// and the rebuild that shows the terminal again places it by what is there
  /// then.
  void _listenToOutput(bool on) {
    if (on == _listeningToOutput) return;
    _listeningToOutput = on;
    if (on) {
      widget.terminal?.addListener(_output);
    } else {
      widget.terminal?.removeListener(_output);
    }
  }

  @override
  void didUpdateWidget(_AnchoredTerminal old) {
    super.didUpdateWidget(old);
    if (_listeningToOutput && !identical(old.terminal, widget.terminal)) {
      old.terminal?.removeListener(_output);
      widget.terminal?.addListener(_output);
    }
    if (!identical(old.reading, widget.reading)) {
      old.reading.removeListener(_toggled);
      widget.reading.addListener(_toggled);
    }
    // The keyboard coming or going moves everything at once; the terminal goes with it.
    _settle(ease: false);
  }

  @override
  void dispose() {
    _listenToOutput(false);
    widget.reading.removeListener(_toggled);
    terminalFontStore.removeListener(_changed);
    super.dispose();
  }

  /// Reading started or stopped (eased — it moves the way the scroll does), or the keyboard
  /// came or went (at once).
  void _settle({required bool ease}) {
    if (_on == _wantsOn) return;
    _on = _wantsOn;
    _easeUntil = ease
        ? DateTime.now().add(const Duration(milliseconds: 240))
        : DateTime.fromMillisecondsSinceEpoch(0);
  }

  void _toggled() {
    _settle(ease: true);
    _changed();
  }

  /// What the last layout placed the terminal by — see [_output].
  _Anchor? _drawnFor;

  /// The terminal changed: output, the cursor's blink, a resize.
  ///
  /// ⚠️ **Rebuilt only when that moves where the terminal is drawn.** Every byte of output and every
  /// blink of the cursor lands here, and each one used to rebuild this widget — and with it ask for
  /// a fresh layout — even with the keyboard up, when nothing is anchored at all, which is exactly
  /// while somebody types. What the place is worked out from is a few rows read off the buffer, so
  /// it is compared first.
  void _output() {
    if (!mounted || _anchor() == _drawnFor) return;
    if (kTypingTrace) typingCount('anchor.rebuild');
    _changed();
  }

  void _changed() {
    if (!mounted) return;
    // Output can land mid-frame (a resize answered during layout): rebuild after it, then.
    if (SchedulerBinding.instance.schedulerPhase ==
        SchedulerPhase.persistentCallbacks) {
      SchedulerBinding.instance.addPostFrameCallback((_) {
        if (mounted) setState(() {});
      });
    } else {
      setState(() {});
    }
  }

  /// The rendered height of one row, measured as xterm measures it.
  static final _cells = Expando<double>();
  static double _cellHeight(TerminalStyle style) => _cells[style] ??= () {
    final text = style.toTextStyle();
    final builder = ui.ParagraphBuilder(text.getParagraphStyle())
      ..pushStyle(text.getTextStyle())
      ..addText('mmmmmmmmmm');
    final paragraph = builder.build()
      ..layout(const ui.ParagraphConstraints(width: double.infinity));
    final height = paragraph.height;
    paragraph.dispose();
    return height;
  }();

  /// What [_shift] places the terminal by, read off it now — null while nothing is anchored.
  _Anchor? _anchor() {
    final terminal = widget.terminal;
    if (!_on || terminal == null || terminal.isUsingAltBuffer) return null;
    final buffer = terminal.buffer;
    final height = buffer.height;
    if (height == 0) return null;
    // The last line with anything on it — the cursor's, or below it where a TUI parked the
    // cursor higher up.
    var last = buffer.absoluteCursorY.clamp(0, height - 1);
    for (var y = height - 1; y > last; y--) {
      if (buffer.lines[y].getText().trim().isNotEmpty) {
        last = y;
        break;
      }
    }
    return (height: height, last: last);
  }

  double _shift(double viewport) {
    final anchor = _drawnFor = _anchor();
    if (anchor == null) return 0;
    final (:height, :last) = anchor;
    final cell = _cellHeight(terminalFontStore.value);
    // Rows are laid from the top until there is history to scroll, and from the foot after.
    final bottom = height * cell <= viewport
        ? (last + 1) * cell
        : viewport - (height - 1 - last) * cell;
    return viewport - widget.clearBottom - bottom;
  }

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, box) {
      final ease = DateTime.now().isBefore(_easeUntil);
      return TweenAnimationBuilder<double>(
        tween: Tween(end: _shift(box.maxHeight)),
        duration: ease ? const Duration(milliseconds: 240) : Duration.zero,
        curve: const Cubic(0.2, 0, 0, 1),
        builder: (context, dy, child) =>
            Transform.translate(offset: Offset(0, dy), child: child),
        child: widget.child,
      );
    },
  );
}

/// The first session's line with one suggestion and its Send under it (owner, 2026-10-22). The only
/// status line that takes taps: [TerminalPage] lets the others through to the terminal.
class _FirstSessionSuggestion extends StatelessWidget {
  const _FirstSessionSuggestion({
    required this.line,
    required this.suggestion,
    required this.onSend,
  });

  final String line;
  final String suggestion;

  /// Null while the terminal is not taking input: Send shows disabled, and waits.
  final VoidCallback? onSend;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    return ColoredBox(
      color: tty.ground,
      child: Padding(
        padding: const EdgeInsets.only(bottom: _StatusLine.below),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            _StatusLine(key: const ValueKey('first-session-line'), text: line),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: Tty.origin),
              child: FirstSessionSuggestion(text: suggestion, onSend: onSend),
            ),
          ],
        ),
      ),
    );
  }
}

/// The line above the mic, centred over it with an opaque ground.
/// Its fixed yellow dot uses the same asking colour as Find.
///
/// ⚠️ **Centred, not on the gutter**, by the owner's call (2026-09-29): it stands over the mic,
/// which is centred too. A second line centres the same way.
///
/// ⚠️ **Wraps to a second line rather than cut.** What is said here fits one line (see
/// `VoiceNotice`), but not on every phone at every text size — and a warning cut mid-word hid
/// what to do. Positioned by its foot, a second line grows up over the terminal, off the mic.
class _StatusLine extends StatelessWidget {
  const _StatusLine({
    super.key,
    required this.text,
    this.color,
    this.dot = false,
  });

  final String text;
  final Color? color;
  final bool dot;
  static const double below = 6;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    return Semantics(
      liveRegion: true,
      child: ColoredBox(
        color: tty.ground,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(Tty.origin, 8, Tty.origin, below),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (dot) ...[
                // Centred on the first line, not between two.
                Padding(
                  padding: const EdgeInsets.only(
                    top: (TtySize.meta * 1.2 - 6) / 2,
                  ),
                  child: Container(
                    key: const ValueKey('sample-guide-dot'),
                    width: 6,
                    height: 6,
                    decoration: BoxDecoration(
                      color: tty.yellow,
                      shape: BoxShape.circle,
                    ),
                  ),
                ),
                const SizedBox(width: 8),
              ],
              Flexible(
                child: Text(
                  text,
                  textAlign: TextAlign.center,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: tty.style(
                    size: TtySize.meta,
                    color: color ?? tty.text,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// The sample's last word: what it was, and the way to the real thing.
class _SampleEndCard extends StatelessWidget {
  const _SampleEndCard({
    required this.started,
    required this.onSetUp,
    required this.onKeepPlaying,
  });

  /// The harness the person started — the last line of the tally.
  final String started;
  final VoidCallback onSetUp;
  final VoidCallback onKeepPlaying;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    Widget tick(String text) => Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Text.rich(
        TextSpan(
          children: [
            TextSpan(
              text: '✓ ',
              style: tty.style(color: tty.green, size: TtySize.row),
            ),
            TextSpan(
              text: text,
              style: tty.style(size: TtySize.row),
            ),
          ],
        ),
      ),
    );
    return Material(
      color: tty.ground,
      child: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(24, 24, 24, 24),
          // ⚠️ **Scrolls when it does not fit.** Centred by its spacers on a screen with room, but
          // a small phone at a large text size has less room than the card has words — as a
          // fixed column it overflowed, and the one button that leads anywhere went off the foot.
          child: LayoutBuilder(
            builder: (context, box) => SingleChildScrollView(
              child: ConstrainedBox(
                constraints: BoxConstraints(minHeight: box.maxHeight),
                child: IntrinsicHeight(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      const Spacer(),
                      TtyText(
                        'That’s Harness.',
                        size: 26,
                        weight: FontWeight.w600,
                      ),
                      const SizedBox(height: 20),
                      tick('watched a harness work'),
                      tick('answered its question'),
                      tick('started $started'),
                      const SizedBox(height: 6),
                      TtyText('3 passed', size: TtySize.meta, color: tty.green),
                      const SizedBox(height: 24),
                      Text(
                        'Now do it on your own code. The real ones run on your '
                        'computer; this phone is the remote.',
                        style: tty.style(size: TtySize.row),
                      ),
                      const Spacer(),
                      TtyPrimaryButton(
                        label: 'Set up my computer',
                        onPressed: onSetUp,
                      ),
                      const SizedBox(height: 4),
                      Center(
                        child: TtyTextButton(
                          label: 'Keep playing',
                          onPressed: onKeepPlaying,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Find's hold on the back gesture — see `_TerminalPageState._findBack`.
class _FindBack extends PopEntry<Object?> {
  _FindBack(this.onBack);

  final VoidCallback onBack;

  @override
  final ValueNotifier<bool> canPopNotifier = ValueNotifier(false);

  /// ⚠️ **After the route is done asking, not while it asks.** The route walks its entries to tell
  /// each of them, and closing Find takes this one off the route — taken off mid-walk, the walk
  /// threw (`ConcurrentModificationError`) and Back did nothing.
  @override
  void onPopInvokedWithResult(bool didPop, Object? result) {
    if (!didPop) scheduleMicrotask(onBack);
  }

  void dispose() => canPopNotifier.dispose();
}
