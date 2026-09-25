import 'dart:async';

// `defaultTargetPlatform` — the navigation bar this page keeps clear of is
// Android's alone; see [_TerminalPageState._navigationBar].
import 'package:flutter/foundation.dart' show defaultTargetPlatform;
import 'package:flutter/material.dart';
// `PlatformException` — a refused camera permission arrives as one, and it is
// the one picker failure with something the person can do about it.
import 'package:flutter/services.dart';
import 'package:image_picker/image_picker.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/core/models.dart' show Agent, AgentProject;
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/widgets/skeleton.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/terminal/image_transcode.dart';
import 'package:harness_mobile/terminal/terminal_font_store.dart';
import 'package:harness_mobile/terminal/terminal_theme.dart';
import 'package:harness_mobile/terminal/terminal_theme_store.dart';
import 'package:harness_mobile/terminal/key_hints.dart';
import 'package:harness_mobile/terminal/question_pane.dart';
import 'package:harness_mobile/terminal/question_pane_watcher.dart';
import 'package:harness_mobile/terminal/terminal_session.dart';
import 'package:harness_mobile/widgets/engine_identity.dart'
    show engineIdentity;
import 'package:harness_mobile/widgets/rename_agent_dialog.dart';
import 'package:harness_mobile/widgets/terminal_panel.dart';

import 'agent_model_sections.dart';
import 'agent_model_sheet.dart';
import 'agents_list_page.dart';
import 'delete_agent.dart';
import 'held_height.dart';
import 'machines_tab.dart';
import 'phone_navigation.dart' show phoneRoute;
import 'phone_sheet.dart';
import 'phone_status.dart';
import 'settings_page.dart';
import 'status_pill.dart';
import 'terminal_action_column.dart';
import 'terminal_chrome_scroll.dart';
import 'terminal_header.dart';
import 'terminal_header_action.dart';
import 'terminal_input_dock.dart';
import 'terminal_paste.dart';
import 'terminal_search.dart';
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
  String? agentName,
  String? agentEngine,
  AgentProject? agentProject,
  bool agentPresent,
  bool agentsFromCache,
  AgentLoadStatus? agentLoadStatus,
  bool machinePresent,
  PhoneMachineStatus? machineStatus,
  bool redialling,
  bool imagePaste,
  String? machineName,
});

/// What a page has asked for back — see [_TerminalPageState._reclaiming].
enum _Reclaim {
  /// The keyboard, off another app that holds the terminal or is driving it.
  control,

  /// A dead stream, reopened.
  reconnect,
}

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
  Timer? _searchHoldTimer;
  static const _searchHoldLimit = Duration(milliseconds: 800);

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
  }

  /// What the last build read from the notifier — the baseline [_onNotifier]
  /// compares the next tick against.
  _PageFacts? _facts;

  /// What THIS page has asked for back and not yet heard about: the keyboard off another app, or a
  /// dead stream reopened. Null while it has asked for nothing.
  ///
  /// A take holds the banner up through the `opening` that answers it, so the banner can say so —
  /// rather than blinking out and back as the status moves. A reconnect raises no banner: the
  /// header draws it as the wait it is, the way it draws Attaching — see [phoneSessionSummary]'s
  /// `reconnecting`.
  ///
  /// ⚠️ **Two kinds, because they read differently.** Both are the same call, and this used to be
  /// one flag: pressing Reconnect raised a banner saying "Taking control…" over a stream nobody
  /// else held.
  ///
  /// Taken back by [_onNotifier] once that open lands, and by [_takeControl] itself for a request
  /// the notifier declined without ever changing a status.
  _Reclaim? _reclaiming;

  /// The header's status as of its last build, for the mark on the actions sheet.
  ///
  /// The sheet is a route of its own, so this page's `setState` never reaches it: the mark there
  /// listens to this instead, and shows the dot the header is showing for as long as the sheet is
  /// up — a reconnect that starts under it included — rather than the moment it opened.
  ///
  /// ⚠️ Moved AFTER the frame, never during the build that works it out: the sheet listening to it
  /// would otherwise be marked dirty in the middle of this page's build. See
  /// [_publishActionsStatus].
  final ValueNotifier<PhoneSummary> _actionsStatus = ValueNotifier((
    label: '',
    tone: PhoneTone.quiet,
  ));

  /// The status the end of this frame hands to [_actionsStatus]; null while none is waiting.
  PhoneSummary? _nextActionsStatus;

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
    setState(() {
      // Cleared as the dialog goes, so the NEXT question raises the keyboard
      // again even if it words itself identically.
      if (!open) _questionRaisedFor = null;
    });
    if (_questionWatcher?.queued == null) _queueRaisedFor = null;
    _raiseForQuestion();
  }

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

  /// Open the keyboard because an agent is waiting on an answer.
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
      agentName: agent?.displayName,
      agentEngine: agent?.engine,
      agentProject: agent?.project,
      agentPresent: agent != null,
      agentsFromCache: machine?.agentsFromCache ?? true,
      agentLoadStatus: machine?.agentLoadStatus,
      machinePresent: machine != null,
      machineStatus: machine == null ? null : phoneMachineStatusOf(machine),
      // Only while the stream is dead — the one state it changes how the
      // header reads. A live page has no reason to rebuild each time the agent
      // list refreshes underneath it.
      redialling:
          machine != null &&
          (session?.status == TerminalSessionStatus.error ||
              session?.status == TerminalSessionStatus.closed) &&
          phoneMachineRedialling(machine),
      imagePaste: machine?.terminalImagePasteAvailable ?? false,
      machineName: machine?.machine.displayName,
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
    final facts = _readFacts();
    // The session has just started taking input: a question read before it
    // could has its raise decided now. See [_raiseForQuestion].
    final accepts = facts.session?.acceptsInput ?? false;
    if (accepts != _acceptedInput) {
      _acceptedInput = accepts;
      if (accepts) _raiseForQuestion();
    }
    // ⚠️ Checked BEFORE the equality bail below, not after. A take that ends where it began —
    // `takenOver` again, because the other app answered first — moves no fact this page reads, so
    // the bail would keep the band saying "Taking control…" over a page that had already been
    // told no. See [_takeControl].
    final settled =
        _reclaiming != null &&
        facts.status != TerminalSessionStatus.opening &&
        facts.status != null;
    if (settled) _reclaiming = null;
    if (facts == _facts) {
      if (settled) setState(() {});
      return;
    }
    setState(() => _facts = facts);
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _lifecycle =
        WidgetsBinding.instance.lifecycleState ?? AppLifecycleState.resumed;
    widget.notifier.addListener(_onNotifier);
  }

  /// Releases the resize hold when this page is parked mid-animation.
  ///
  /// A settle left running would end on a page that is no longer on screen, and
  /// the pane would come back from the pager still holding its resize.
  @override
  void didUpdateWidget(TerminalPage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.notifier, widget.notifier)) {
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
    }
  }

  @override
  void dispose() {
    widget.notifier.removeListener(_onNotifier);
    _questionWatcher?.removeListener(_onQuestionPane);
    _questionWatcher?.dispose();
    _cancelSettle();
    _searchHoldTimer?.cancel();
    _chrome.dispose();
    _searchOpen.dispose();
    // A sheet still open over a page that is going keeps the last dot it was given; its listener
    // comes off when it closes, which a disposed notifier allows.
    _actionsStatus.dispose();
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  /// Hands [status] to the actions sheet's mark once this frame is done — see [_actionsStatus].
  ///
  /// The last build of a frame is the one handed over, and nothing is scheduled while the status
  /// stands still.
  void _publishActionsStatus(PhoneSummary status) {
    final waiting = _nextActionsStatus != null;
    if (!waiting && status == _actionsStatus.value) return;
    _nextActionsStatus = status;
    if (waiting) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final next = _nextActionsStatus;
      _nextActionsStatus = null;
      if (!mounted || next == null) return;
      _actionsStatus.value = next;
    });
  }

  /// Opens the account-wide agent list.
  ///
  /// Awaited: the list is backed out of as often as it is tapped through, and
  /// this page gets no rebuild when it lands back on top.
  Future<void> _openAgentList() async {
    await Navigator.of(context)
        .push(phoneRoute((_) => AgentsListPage(notifier: widget.notifier)));
    if (mounted) setState(() {});
  }

  /// Brings the search sheet up over the terminal, reading the account's tabs
  /// with its field not yet focused — see [TerminalSearchOverlay].
  ///
  /// ⚠️ **The terminal is held from THIS frame, though no keyboard is coming
  /// yet.** The sheet's field raises one the moment it is tapped, and by then
  /// the terminal must already be ignoring it — see [_heldForSearch] for what
  /// it does with that keyboard otherwise.
  void _openSearch() {
    if (_searching) return;
    _keyboardBeforeSearch = _keyboardIsUp;
    _keyboardUpAtSearch = _keyboardUp;
    _searchHoldTimer?.cancel();
    // ⚠️ **Whatever holds the keys lets go of them.** The sheet opens with its
    // field NOT focused, so nothing takes focus from the terminal the way the
    // search once did by focusing itself — and a terminal on a hardware
    // keyboard keeps its focus with no inset to show for it, so it would go on
    // typing into the shell from under the dimming.
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
    _searchOpen.forward();
  }

  /// Sends the sheet back down, and takes it down once it is gone.
  ///
  /// ⚠️ **Guarded on the controller's own status, not on [_searching].** A tap
  /// on the dimmed page, a pull on the sheet and the system back gesture can
  /// all arrive while the reverse is already running — a second `reverse()`
  /// restarts it from wherever it had got to, and the sheet visibly bounces.
  void _closeSearch() {
    if (!_searching || _searchOpen.status == AnimationStatus.reverse) return;
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
            !_heldForSearch && (_ownsInput || _keyboardRequested);
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
      !_heldForSearch &&
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
    final heard = await widget.voice.takeTranscript();
    if (!mounted) return;
    if (heard.isNotEmpty && session.acceptsInput) {
      session.terminal.textInput(heard);
    }
    setState(() => _keyboardRequested = true);
    // The keyboard is on its way and the key bar opens with it. Held from here
    // rather than from the first metrics tick, which is a frame too late: see
    // [_armSettle]. The row's own slide is covered by [_watchKeyBar].
    _armSettle();
  }

  /// Puts the keyboard away without leaving the page — the `⌄` key on
  /// [TerminalKeyBar]. Dropping focus is what closes the input connection.
  void _dismissInput() {
    FocusManager.instance.primaryFocus?.unfocus();
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

  /// The composer starts OPEN here, and the phone owns that answer rather than the pane.
  ///
  @override
  Widget build(BuildContext context) {
    // Whatever brought this build about, the baseline the notifier is compared
    // against is what THIS build saw — see [_onNotifier]. Not the voice
    // controller: what the mic hears repaints the floating mic and its pill,
    // which listen for themselves, and never rebuilds the terminal under them.
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
    // A dead stream already on its way back: its machine is redialling, or this page has just
    // asked for it. The header draws that as the wait it is — spinner on the mark, sweep along the
    // rule — rather than as Disconnected beside a button. See [phoneSessionSummary].
    //
    // Never for an agent that is gone: nothing will reopen its stream, however the socket is doing.
    final reconnecting =
        !agentGone &&
        (_reclaiming == _Reclaim.reconnect ||
            (machine != null && phoneMachineRedialling(machine)));
    final reclaim = phoneReclaimAction(session, reconnecting: reconnecting);
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
    final takerName = phoneTakerName(
      session,
      (id) => widget.notifier.stateOf(id)?.machine.displayName,
    );
    final takeoverNotice = phoneTakeoverNotice(session, takerName);
    final holderName = phoneHolderName(
      session,
      (id) => widget.notifier.stateOf(id)?.machine.displayName,
    );
    final headerStatus = phoneSessionSummary(
      session,
      takerName: takerName,
      reconnecting: reconnecting,
    );
    // The actions sheet draws the same dot beside the agent's name, and is not rebuilt by this
    // page — see [_actionsStatus].
    _publishActionsStatus(headerStatus);
    // Read this page's own buffer for a dialog, and raise the keyboard when one
    // appears. Must run on every build: the session arrives a frame or two
    // after the page, and the engine with the agent.
    //
    // ⚠️ **The buffer is the only source there is on a phone.** The daemon
    // already detects the same dialog and publishes `commander_question`, but
    // that frame goes out device-and-loopback only — a phone attached over the
    // relay never receives it. See [QuestionPaneWatcher].
    _syncQuestionWatcher(agent?.engine, session);
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
          MediaQuery.removePadding(
            context: context,
            removeBottom: true,
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
                            child: Stack(
                              children: [
                                Positioned.fill(
                                  // ⚠️ The chrome is driven from OUT HERE, not
                                  // from inside the panel. xterm's own
                                  // [Scrollable] is several widgets down and is
                                  // remounted whenever the agent changes;
                                  // listening for its notifications as they
                                  // bubble past is what survives that, and costs
                                  // the panel no knowledge of the page's chrome.
                                  child:
                                      NotificationListener<ScrollNotification>(
                                        onNotification: _chrome.onNotification,
                                        child: agentGone
                                            ? _AgentGone(
                                                name: _cachedAgentName,
                                                onPickAnother:
                                                    _pickAnotherAgent,
                                              )
                                            : pane == null || session == null
                                            ? _Attaching(key: _skeletonKey)
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
                                                // asks for the TERMINAL, not the keyboard:
                                                // raising one over a read-only pane offers
                                                // a prompt that silently swallows every
                                                // letter. The band above says why, so the
                                                // tap takes the person to its button. See
                                                // [_ControlBanner].
                                                onInputTap: blocked
                                                    ? () => unawaited(
                                                        _takeControl(),
                                                      )
                                                    : _shouldFocus
                                                    ? null
                                                    : () => unawaited(
                                                        _raiseKeyboard(session),
                                                      ),
                                                showHeader: false,
                                                // No composer, and so no grip above it: the
                                                // page hands the pane its full height and the
                                                // software keyboard drives the terminal
                                                // directly. The mic's send is what kept the
                                                // composer's batched turn.
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
                                if (session != null &&
                                    !session.hasRenderedFrame)
                                  Positioned.fill(
                                    child: _Attaching(key: _skeletonKey),
                                  ),
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
                                Positioned(
                                  right: TerminalActionColumn.inset,
                                  top: _ownsInput
                                      ? TerminalActionColumn.topInset
                                      : null,
                                  bottom: _ownsInput
                                      ? null
                                      : TerminalActionColumn.bottomInset,
                                  child: TerminalActionColumn(
                                    voice: widget.voice,
                                    session: session,
                                    onSearch: _openSearch,
                                    searchOnly: _ownsInput,
                                    unread: widget.notifier.agentNotices.unread,
                                  ),
                                ),
                              ],
                            ),
                          ),
                          // The bottom of this page IS just above the keyboard:
                          // `PhoneShell`'s Scaffold has already resized for it —
                          // the same resize that empties this page's MediaQuery
                          // insets (see [didChangeMetrics]).
                          if (session != null)
                            TerminalInputDock(
                              session: session,
                              keyboardUp: _keyBarUp,
                              onDismiss: _dismissInput,
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
                            ),
                        ],
                      ),
                    ),
                    // The header, laid OVER the terminal rather than above it in the
                    // column.
                    //
                    // ⚠️ **Over, not beside, and that is what keeps scrolling smooth.**
                    // It used to shrink out of the column and hand its height to the
                    // terminal. Every fold then changed the terminal's row count: a
                    // `terminal_resize` and a real SIGWINCH on the far machine, a
                    // keyframe back carrying up to 500 lines of history to re-parse on
                    // this thread, and the agent's whole screen redrawn — once as the
                    // header left, once as it came back, on every change of scroll
                    // direction. The renderer was held frozen for each slide on top of
                    // that, so a fling stopped dead for a third of a second.
                    //
                    // Laid over, the terminal keeps one height whatever the header
                    // does. The rows under it are the oldest on the screen, and the
                    // first push of a scroll is what slides it away from them.
                    //
                    // Nothing stands in for it while it is gone: `⋯` comes back with
                    // the header on the first scroll the other way.
                    Positioned(
                      top: 0,
                      left: 0,
                      right: 0,
                      child: _SlideAway(
                        progress: _chrome.header,
                        // Opaque: the terminal is underneath now, and the row has to
                        // read as the same bar it was when the two were stacked.
                        child: ColoredBox(
                          color: AppPalette.windowBg,
                          child: Column(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              TerminalHeader(
                                agent: agent,
                                status: headerStatus,
                                machineName: machine?.machine.displayName,
                                trailing: [
                                  // Read-only is a state to get OUT of, so its way
                                  // out is a labelled button in the header rather
                                  // than a line in the actions sheet: the sheet is
                                  // where you go having decided to do something,
                                  // and this is the thing telling you that typing
                                  // will go nowhere until you do.
                                  // ⚠️ **Not while the band is up.** The band below
                                  // carries the same words and the same button, a
                                  // finger's width under this one, and two "Take
                                  // control"s stacked read as two different offers.
                                  // The band is the better of the two — it says WHY
                                  // typing stopped, and by whom — so this one gives
                                  // way to it.
                                  //
                                  // Kept for the states the band does not cover:
                                  // "Reconnect", for a stream that died with nobody
                                  // else involved. See [_ControlBanner]. Gone while
                                  // that stream is already coming back — see
                                  // `reconnecting` above.
                                  if (reclaim != null &&
                                      !blocked &&
                                      _reclaiming == null)
                                    _ReclaimButton(
                                      action: reclaim,
                                      // The same call the band's button makes — see
                                      // [_takeControl].
                                      onPressed: () =>
                                          unawaited(_takeControl()),
                                    ),
                                  // ⚠️ **No tabs mark here.** The account's tabs
                                  // are the first thing the floating Search button
                                  // opens, above the thumb — see
                                  // [TerminalSearchOverlay] — and a mark up here
                                  // for the same panel was a second door to it.
                                  // Null while the agent is not loaded: there is
                                  // nothing to act on yet, and a menu of actions
                                  // that all fail is worse than no menu.
                                  if (agent != null)
                                    TerminalHeaderAction(
                                      // Stood up, not laid flat: three dots in a
                                      // column is the narrower mark AND the one a
                                      // phone means by "more actions", so it reads
                                      // as a menu rather than as a truncation.
                                      icon: LucideIcons.ellipsisVertical300,
                                      size: 21,
                                      tooltip: 'Harness actions',
                                      // Last in the row, so its padding stops at
                                      // the header's own right inset.
                                      last: true,
                                      onPressed: () => _showActions(
                                        machineName:
                                            machine?.machine.displayName ?? '',
                                        agent: agent,
                                        status: headerStatus,
                                        session: session,
                                      ),
                                    ),
                                ],
                              ),
                              // The hairline, carrying a sweep while the header
                              // reads as a wait — Attaching, Resyncing,
                              // Reconnecting. See [TerminalHeaderRule].
                              TerminalHeaderRule(
                                busy: headerStatus.tone == PhoneTone.busy,
                              ),
                              // ⚠️ Inside the header's own slide, not under it: the two are one bar as far
                              // as a scroll is concerned, and a band left behind while the header left
                              // would sit on the output with nothing above it.
                              //
                              // Up for a take in flight, not for a reconnect: that one is the header's
                              // own wait, and a band over it said "Taking control…" of a stream nobody
                              // else held. See [_reclaiming].
                              if (blocked || _reclaiming == _Reclaim.control)
                                _ControlBanner(
                                  watching: session?.watching ?? false,
                                  busy: !blocked,
                                  takeoverNotice: takeoverNotice,
                                  holderName: holderName,
                                  onTakeControl: _takeControl,
                                ),
                            ],
                          ),
                        ),
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
    required PhoneSummary status,
    TerminalSession? session,
  }) {
    // Set here, where no build is running, so the sheet opens on the dot the header shows now
    // rather than on whatever the last frame handed over. See [_actionsStatus].
    _actionsStatus.value = status;
    final agentName = agent.displayName;
    showPhoneSheet(
      context,
      title: '$agentName · $machineName',
      // The agent, then where it runs — the machine, then the folder with its parent beside the
      // branch — each behind its icon. The header has no room for the path.
      titleParts: [agentName],
      // The engine mark carrying the header's own dot: the sheet's anchor, and the same picture of
      // this agent the header draws above it. The ring is the sheet's ground, which the dot is
      // notched out of.
      titleLeading: ValueListenableBuilder<PhoneSummary>(
        valueListenable: _actionsStatus,
        builder: (context, status, _) {
          AppTheme.watch(context);
          return BadgedEngineMark(
            agent: agent,
            status: status,
            ring: AppPalette.panelBg,
            size: 40,
          );
        },
      ),
      titleDetail: AgentPlaceLines(
        machineName: machineName,
        project: agent.project,
      ),
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
            ..._agentActions(agent),
          ],
        ),
        PhoneSheetSection(
          caption: 'App',
          actions: [
            // Every agent on the account, not just this machine's: the sheet is opened from inside
            // one agent, and the thing somebody wants from here is another agent — which is as
            // often on the other laptop as on this one.
            //
            // [AgentsListPage] draws them, with the magnifier in its header for when the list is
            // longer than a screenful.
            PhoneSheetAction(
              icon: LucideIcons.squareTerminal300,
              label: 'Harnesses',
              chevron: true,
              onTap: () => unawaited(_openAgentList()),
            ),
            PhoneSheetAction(
              icon: LucideIcons.laptopMinimal300,
              label: 'Machines',
              chevron: true,
              onTap: () => Navigator.of(context).push(
                phoneRoute(
                  (_) => MachinesTab(notifier: widget.notifier, large: false),
                ),
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
        PhoneSheetSection(actions: [_stopAction(agent)]),
      ],
    );
  }

  /// Paste: the clipboard into [session]. What it reads and sends lives in [pasteClipboard]; the
  /// page hands it only what the page alone knows, whether this is still the terminal on screen.
  PhoneSheetAction _pasteAction(TerminalSession session) => PhoneSheetAction(
    icon: LucideIcons.clipboardPaste300,
    label: 'Paste',
    onTap: () {
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
    },
  );

  /// What acts on this agent and can be taken back — the first card of its sheet.
  List<PhoneSheetAction> _agentActions(Agent agent) => [
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
    PhoneSheetAction(
      icon: LucideIcons.pencil300,
      label: 'Rename…',
      onTap: () => showAgentRenameDialog(
        context,
        widget.notifier,
        widget.machineId,
        widget.agentId,
        agent.name,
      ),
    ),
    PhoneSheetAction(
      icon: LucideIcons.refreshCw300,
      label: 'Restart',
      onTap: () => unawaited(_restart()),
    ),
  ];

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
    label: 'Stop Harness…',
    destructive: true,
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

  /// Asks for the terminal this pane is only watching, or reopens the stream it lost — the band's
  /// button, and the header's.
  ///
  /// Which of the two it is comes from the stream as it stands, not from the button: somebody else
  /// holding or driving it makes this a take, and a dead one a reconnect. [_reclaiming] carries
  /// that through the `opening` this starts, so a take reads as one action answering rather than
  /// a band that vanished and came back, and a reconnect reads as the header's wait from the
  /// moment it is pressed. `selectAgent` declines quietly when the pane cannot be attached at all
  /// (its machine went offline meanwhile, the agent was withdrawn), and that leaves the status
  /// where it was — so the flag is taken back here too, rather than left armed over a page
  /// nothing is going to answer for.
  Future<void> _takeControl() async {
    final notifier = widget.notifier;
    final before = notifier
        .paneOfAgent(widget.machineId, widget.agentId)
        ?.session;
    final kind =
        before != null &&
            (before.watching ||
                before.status == TerminalSessionStatus.takenOver)
        ? _Reclaim.control
        : _Reclaim.reconnect;
    if (_reclaiming != kind) setState(() => _reclaiming = kind);
    await notifier.selectAgent(widget.machineId, widget.agentId);
    if (!mounted) return;
    final session = notifier
        .paneOfAgent(widget.machineId, widget.agentId)
        ?.session;
    if (_reclaiming != null &&
        session?.status != TerminalSessionStatus.opening) {
      setState(() => _reclaiming = null);
    }
  }

  /// Restarting is a round trip that can fail, and the phone has no status rail to fail into — so
  /// the answer lands as a snackbar, which is the one surface a pushed page here always has.
  Future<void> _restart() async {
    final messenger = ScaffoldMessenger.maybeOf(context);
    final result = await widget.notifier.restartAgent(
      widget.machineId,
      widget.agentId,
    );
    final error = result.error;
    if (error == null || messenger == null || !mounted) return;
    messenger.showSnackBar(SnackBar(content: Text(error)));
  }
}

/// The header's way back into a session this device is not driving.
///
/// Re-selecting the agent is what reclaims it — the same call the desktop tile's
/// status chip makes, so one gesture means one thing on both.
class _ReclaimButton extends StatelessWidget {
  const _ReclaimButton({required this.action, required this.onPressed});

  final PhoneSummary action;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final color = phoneToneColor(action.tone);
    return TextButton.icon(
      onPressed: onPressed,
      icon: Icon(
        action.tone == PhoneTone.attention
            ? LucideIcons.lock300
            : LucideIcons.refreshCw300,
        size: 15,
      ),
      label: Text(
        action.label,
        style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600),
      ),
      style: TextButton.styleFrom(
        foregroundColor: color,
        minimumSize: Size.zero,
        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
      ),
    );
  }
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

/// The band over the output saying this pane cannot be typed into, and offering the way in.
///
/// ⚠️ **Over the output, not in the header.** The header's status word is 11pt in a corner beside
/// the agent's name, and somebody mid-sentence never looks there — the keystrokes simply stop
/// landing and nothing on screen says why. This sits where the eyes already are. The desktop puts
/// the same band in the same place for the same reason (`widgets/terminal_panel.dart`); this is
/// that band at phone width.
///
/// Covers both ways a pane goes read-only. A WATCHER never held the terminal — the page attached
/// to an agent the desktop was already driving, output and all (see [TerminalSession.watching]) —
/// while `takenOver` is a terminal this phone HAD and lost. One sentence each, because "another
/// app has it, press this" is the part that matters either way; the lost one names the taker when
/// the daemon said who.
class _ControlBanner extends StatelessWidget {
  const _ControlBanner({
    required this.watching,
    required this.busy,
    required this.takeoverNotice,
    required this.holderName,
    required this.onTakeControl,
  });

  /// True where the terminal was never this pane's; false where it was taken away.
  final bool watching;

  /// The take is in flight — its `terminal_open` is out and this pane is waiting to hear.
  final bool busy;

  /// Who took it, as the one sentence [phoneTakeoverNotice] writes. Null for a watcher, which
  /// never lost a terminal, and while a take is in flight.
  final String? takeoverNotice;

  /// Who is driving the terminal a watcher is looking at, as [phoneHolderName] names it — the
  /// machine, as the desktop names a taker. Null when the daemon did not say.
  final String? holderName;

  final VoidCallback onTakeControl;

  String get _title {
    if (busy) return 'Taking control…';
    if (watching) return '${holderName ?? 'Another app'} is using this terminal';
    return takeoverNotice ?? 'Another app took control of this terminal';
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final ink = phoneToneColor(PhoneTone.attention);
    return Semantics(
      key: const ValueKey('phone-takeover-strip'),
      container: true,
      liveRegion: true,
      child: DecoratedBox(
        decoration: BoxDecoration(
          // Composited over the pane's own ground rather than laid on as a wash: the terminal
          // theme behind this band may be any colour, and a bare translucent fill would read
          // differently on each of them.
          color: Color.alphaBlend(
            ink.withValues(alpha: 0.12),
            AppPalette.windowBg,
          ),
          border: Border(
            bottom: BorderSide(color: ink.withValues(alpha: 0.55)),
          ),
        ),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(14, 10, 10, 10),
          child: Row(
            children: [
              if (busy)
                SizedBox(
                  width: 15,
                  height: 15,
                  child: CircularProgressIndicator(strokeWidth: 2, color: ink),
                )
              else
                Icon(LucideIcons.lock300, size: 15, color: ink),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      _title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: AppPalette.textPrimary,
                        fontSize: 12,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    if (!busy) ...[
                      const SizedBox(height: 2),
                      Text(
                        'Typing is paused. Take control to type here.',
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          color: AppPalette.textSecondary,
                          fontSize: 11,
                          height: 1.3,
                        ),
                      ),
                    ],
                  ],
                ),
              ),
              if (!busy) ...[
                const SizedBox(width: 10),
                TextButton(
                  onPressed: onTakeControl,
                  style: TextButton.styleFrom(
                    foregroundColor: ink,
                    padding: const EdgeInsets.symmetric(
                      horizontal: 12,
                      vertical: 8,
                    ),
                    minimumSize: Size.zero,
                    tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                  ),
                  child: const Text(
                    'Take control',
                    style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600),
                  ),
                ),
              ],
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
  bool _animating = false;

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
    final ground = terminalThemeFor(
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

/// The header sliding up off the top of the page, fading as it goes.
///
/// ⚠️ **A translation, and it must stay one.** It used to shrink with
/// [Align.heightFactor] so the terminal below could grow into the space — which
/// resized the far machine's shell on every fold. The header is laid over the
/// terminal now (see the page's build), so moving its paint is all a fold needs
/// and the terminal's layout never hears about it.
///
/// ⚠️ **The same widgets at every value, 0 included.** Returning the bare child
/// while it was fully shown swapped the widget type in that slot at the start
/// and end of every fold, which unmounted the header and built it again.
class _SlideAway extends StatelessWidget {
  const _SlideAway({required this.progress, required this.child});

  /// 0 fully shown, 1 fully gone.
  final Animation<double> progress;

  final Widget child;

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: progress,
    // ⚠️ Built ONCE and passed through. The child is a whole header, and
    // rebuilding it on every frame of a scroll is work for nothing — what
    // changes is where it is painted, not anything in it.
    child: child,
    builder: (context, child) {
      final value = progress.value;
      return IgnorePointer(
        // Part-way out it is no longer the bar it looks like — the floating
        // buttons are taking over — and fully out it is off the page.
        ignoring: value > 0,
        child: FractionalTranslation(
          translation: Offset(0, -value),
          child: Opacity(
            // Spent by the two-thirds mark, which is where the floating buttons
            // are arriving. Anything still visible after that competes with them.
            opacity: (1 - value / 0.66).clamp(0.0, 1.0),
            child: child,
          ),
        ),
      );
    },
  );
}

/// The longest agent name the header will print before it cuts.
///
/// An agent's name is usually a filename, and the header row has to hold three
/// controls beside it. Left to the width alone, a long name pushed right up
/// against `+` with no gap; cutting by COUNT keeps a fixed, predictable stretch
/// of chrome whatever the name and whatever the screen.
const int _titleMaxChars = 20;

/// The name as the header prints it: cut to [_titleMaxChars] with an ellipsis
/// when it is longer.
///
/// ⚠️ Counts runes, not code units. `String.length` counts UTF-16 units, so an
/// emoji or a decomposed Vietnamese vowel costs two and a name cuts early —
/// short of the 20 the design asks for, and at a different point per name.
///
/// ⚠️ The header's own width ellipsis stays as well. This one bounds the
/// string; that one still catches a 20-character name on a narrow screen, and
/// neither makes the other redundant.
///
/// ⚠️ **Nothing calls it** — [TerminalHeader] ellipses the name on width alone,
/// beside the machine. Kept because a count cut may be wanted there again, and
/// this is the rune-correct one it would want.
// ignore: unused_element
String _clipTitle(String name) {
  final runes = name.runes.toList();
  if (runes.length <= _titleMaxChars) return name;
  // Trailing space before the ellipsis reads as a typo, so it goes.
  return '${String.fromCharCodes(runes.take(_titleMaxChars)).trimRight()}…';
}

/// One of the header's trailing controls, padded so the three sit evenly.
///
/// ⚠️ The padding is what makes the row look right, and the reason is that
/// [AppIconButton] is a fixed 24px box for every glyph size. A 22px glyph fills
/// that box to its edges while a 20px one floats inside it, so equal gaps
/// BETWEEN the boxes read as unequal gaps between the marks. Giving every
/// action the same glyph size and the same padding puts the marks on an even
/// pitch.
///
/// ⚠️ It does NOT widen the tap target. [AppIconButton] takes its tap on a
/// 24px `GestureDetector` with no `HitTestBehavior.opaque`, so the padding is
/// dead space either side and the three stay 24px each — under the 44 iOS asks
/// for. Fixing that belongs in the shared button, where every screen's header
/// would get it, not in a wrapper one page defines.
