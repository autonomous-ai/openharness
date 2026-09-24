import 'dart:async';

import 'package:flutter/material.dart';
// `ScrollCacheExtent` lives in the rendering layer and is not re-exported by
// the widgets barrel, even though [PageView.scrollCacheExtent] takes it.
import 'package:flutter/rendering.dart' show ScrollCacheExtent;

import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/terminal/terminal_session.dart'
    show TerminalSessionStatus;

import 'agent_pane_prune.dart';
import 'phone_search_catalog.dart' show phoneAgentId;
import 'agent_swipe_list.dart';
import 'terminal_page.dart';
import 'voice_input_controller.dart';

/// One agent's terminal, with the agents beside it a swipe away.
///
/// ⚠️ **The pager holds the route, and [TerminalPage] no longer does.** The page draws one agent's
/// header and terminal, but a swipe has to move something ABOVE it — so this sits between the route
/// and the page. Without [neighbours] it is a passthrough, which is how the Machines tab still gets
/// the old single-page behaviour.
///
/// Exactly one page is ACTIVE at a time, and that word is load-bearing: [TerminalPanel] claims the
/// keyboard whenever it is built focused, so three mounted pages all claiming it would put the
/// software keyboard on a terminal nobody is looking at — and the characters typed into it would
/// reach that agent. See [TerminalPage.isActive].
class AgentSwipeHost extends StatefulWidget {
  const AgentSwipeHost({
    super.key,
    required this.notifier,
    required this.machineId,
    required this.agentId,
    required this.neighbours,
    this.onAgentChanged,
  });

  final AppNotifier notifier;

  /// The agent the route was opened on — the page that is shown first. Never changes; where the
  /// pager has moved to since is [_AgentSwipeHostState._current].
  final String machineId;
  final String agentId;

  /// Null for a page opened without neighbours, which is then simply the page.
  final AgentSwipeList? neighbours;

  /// Told which agent a swipe has arrived at, for a host that has to keep up with the pager.
  ///
  /// Only [AgentHome] passes it, and it needs it: the pager lives at the ROOT there and is rebuilt
  /// whenever the account's state moves, so a host still naming the agent this opened on would snap
  /// the screen back to it mid-session. Every pushed pager is popped rather than rebuilt around a
  /// different agent, and passes null.
  final ValueChanged<AgentRef>? onAgentChanged;

  @override
  State<AgentSwipeHost> createState() => _AgentSwipeHostState();
}

class _AgentSwipeHostState extends State<AgentSwipeHost> {
  /// How many laps of the list the opening page sits above zero — see [initState].
  static const _origin = 1000;

  PageController? _controller;

  /// The page being looked at, which is what decides [TerminalPage.isActive].
  ///
  /// ⚠️ **A page, not an agent, and on a short list the difference is a bug.** A wrapped pager of
  /// two agents mounts pages N-1, N and N+1 — and N-1 and N+1 are the SAME agent as each other.
  /// Testing "is this page's agent the current agent" would then mark two mounted pages active at
  /// once, and two live [TerminalPanel]s both claiming the keyboard is exactly what `isActive`
  /// exists to prevent: the one that wins can be the page off-screen.
  int _page = 0;

  /// The agent showing now — [_page]'s entry, named rather than numbered.
  ///
  /// Both forms are kept because the two questions genuinely differ once the pager wraps: which PAGE
  /// is on screen decides who may hold the keyboard, and which AGENT is on screen decides which pane
  /// [_detachAll] spares on the way out. A page number cannot answer the second — the agent it names
  /// has panes attached under other page numbers too.
  late AgentRef _current = (
    machineId: widget.machineId,
    agentId: widget.agentId,
  );

  /// Every agent this pager attached and has not closed yet: the one on screen and the one a swipe
  /// either side ([_prefetchAround]). Nothing is kept for having been visited — an agent that falls
  /// out of that ring is on here only until [_pruner]'s beat after the swipe closes it.
  ///
  /// ⚠️ **Without this the pager leaks terminals.** The phone's old rule was one pane, enforced by
  /// closing every other one on the way in; a pager attaches its own pages, so nothing else would
  /// ever close them. Each pane left behind is a remote stream with a 10,000-line scrollback and a
  /// heartbeat, held for a screen that is gone — and a claim on an agent the desktop then cannot
  /// open, since the daemon keeps a single controller per agent.
  ///
  /// Recorded rather than recomputed: by the time this page is disposed the list may have moved on,
  /// and the panes to close are the ones actually opened, not the ones a fresh list would name.
  ///
  /// ⚠️ **Attaching ahead of the swipe must not cost another app its terminal**: these are agents
  /// nobody has asked for yet, and the daemon keeps one controller per agent. So a page attached
  /// ahead of time asks only for a terminal that is FREE (`AppNotifier.warmAgentPane`) — one the
  /// desktop, or anyone else, is driving stays theirs, and that page simply attaches when it is
  /// landed on, as every page did before. What the phone already holds is left as it is. Every
  /// one it does take is still a claim, so the pager makes as few as an instant swipe needs: the
  /// agent ONE swipe either side, and nothing it has left behind. [_keepSet] is that set, at most
  /// [_maxOpen].
  final Set<AgentRef> _attached = {};

  /// Closes every agent outside [_keepSet], a beat after each swipe. Null for a passthrough page,
  /// which has no swipe to prune after. See [AgentPanePruner].
  AgentPanePruner? _pruner;

  /// How many pages either side of the one on screen are mounted ahead of time — and attached
  /// ahead of time too, see [_prefetchAround]. Read by [build] for the pager's cache extent.
  ///
  /// ⚠️ **One, and the agents just left are not kept either.** A swipe goes one page, so one page
  /// either side is all an instant arrival needs — going BACK is a swipe too, and lands on a page
  /// that is one away again. A second ring, and a list of recents on top, held up to eight streams
  /// open for pages two swipes out.
  static const _reach = 1;

  /// The most streams this pager holds open at once: the page on screen and one either side. Each
  /// is a scrollback and a heartbeat on the phone, and a claim on the far machine.
  static const _maxOpen = 1 + 2 * _reach;

  /// How long after landing on a page its neighbours are attached. A fling through several pages
  /// re-arms this on each one, so only the page it stops on attaches anything.
  static const _prefetchDebounce = Duration(milliseconds: 250);

  /// How long a ring of pages may take to render before the next ring is attached anyway — a page
  /// that never renders (its machine offline, say) must not hold the others back for good.
  static const _renderWait = Duration(milliseconds: 1500);

  /// The same wait for the page on SCREEN, before anything else is attached at all. Longer, because
  /// that page is the one somebody is looking at: measured, a first keyframe takes 2.5–3s to land,
  /// and neighbours opening at 1.5s would compete with it for the connection for the rest of that.
  static const _currentRenderWait = Duration(seconds: 4);

  Timer? _prefetchTimer;

  /// Bumped by every page change and by dispose, so a prefetch still in flight for a page the
  /// pager has since left finds itself stale and stops between rings. See [_prefetchAround].
  int _prefetchRun = 0;

  /// The [_awaitRendered] calls still waiting, so [dispose] can let them go. Each holds a deadline
  /// timer and a listener on the notifier; left to themselves they would clear up on the next
  /// notifier tick, but a pager is disposed on the way to another screen, and nothing should be
  /// left ticking behind it.
  final Set<Completer<void>> _waits = {};

  /// Whether [agent] belongs to a pager OTHER than this one, which is then the one to close it.
  ///
  /// `pager != this` matters only while this pager is live — [_detachAll] is out of [_livePagers]
  /// by the time it asks — and without it the prune would spare every agent on its own record.
  bool _heldByAnotherPager(AgentRef agent) => _livePagers.any(
    (pager) => pager != this && pager._attached.contains(agent),
  );

  /// Voice input for every page of this pager: a take in progress, and what has been heard so far,
  /// survive a swipe the way a keyboard that is up does. Disposed with the pager, which is what
  /// turns the microphone off on the way out.
  ///
  /// Transcribes through `notifier.api` read at CALL time, not captured here: the notifier replaces
  /// its client when the session changes, and a captured one would sign with a token that is gone.
  late final VoiceInputController _voice = VoiceInputController(
    transcriber: (wav, lang) =>
        widget.notifier.api.transcribeVoice(wav, lang: lang),
  );

  /// Tell the search this agent was reached.
  ///
  /// ⚠️ **Landing on an agent is the event, not searching for one.** The desktop
  /// records every pane it focuses, however you got there, and ranks its box off
  /// that — so within a day its list is "the agents you actually work in". The
  /// phone's first port only recorded agents opened THROUGH the search, which
  /// meant the history stayed nearly empty no matter how much the app was used,
  /// and the box kept falling through to its last-resort ordering. A swipe
  /// between agents is this app's focus change; this is where it belongs.
  void _rememberVisit(AgentRef agent) => widget.notifier.searchHistory.remember(
    phoneAgentId(agent.machineId, agent.agentId),
  );

  @override
  void initState() {
    super.initState();
    _livePagers.add(this);
    // A fresh pager is a fresh session: whatever the person did to the keyboard
    // the last time they were in a terminal does not decide what this one does.
    // See [resetKeyboardSession].
    resetKeyboardSession();
    _attached.add(_current);
    // What a relaunch reopens — kept up to date on every swipe, and cleared only by leaving.
    widget.notifier.lastOpenedAgent.remember(_current);
    _rememberVisit(_current);
    final neighbours = widget.neighbours;
    if (neighbours == null || neighbours.isEmpty) return;
    // The snapshot is fixed for as long as this pager lives, so the opening page is the only index
    // that ever has to be looked up — from there the controller and the list stay in step, and
    // [_page] and [_current] both follow from `onPageChanged` alone.
    final start = neighbours.indexOf(widget.machineId, widget.agentId) ?? 0;
    // Opening in the MIDDLE of the endless run, not at its start, is what lets the first swipe go
    // either way: page 0 has nothing to its left, and the last agent has to be reachable by swiping
    // back from the first one. `_origin` is far enough from both ends that neither is reachable by
    // hand — ~1,000 laps of the list — and it is a whole number of laps, so `page % length` still
    // names the agent.
    _page = neighbours.wraps
        ? _origin * neighbours.entries.length + start
        : start;
    _controller = PageController(initialPage: _page);
    _pruner = AgentPanePruner(
      notifier: widget.notifier,
      attached: _attached,
      heldElsewhere: _heldByAnotherPager,
    );
    // The opening page's neighbours too, not only a swiped-to page's: the first swipe out of a
    // freshly opened pager is the one most people make. The page itself is attached by whoever
    // opened the pager (see [AgentHome]'s `_attachOnly`), and this waits for it to render first.
    _armPrefetch();
  }

  @override
  void dispose() {
    _prefetchTimer?.cancel();
    _prefetchRun++;
    for (final wait in _waits.toList()) {
      if (!wait.isCompleted) wait.complete();
    }
    _pruner?.dispose();
    _voice.dispose();
    _controller?.dispose();
    // Out of the live set FIRST: [_detachAll] skips panes a live pager holds, and this one no
    // longer counts.
    _livePagers.remove(this);
    _detachAll();
    // ⚠️ **The record is deliberately NOT cleared here, and it used to be.** The old rule was
    // "leaving the terminal means the next launch starts on the list" — but there is no list to
    // start on any more: the terminal IS the home screen (see [AgentHome]), and a pager is disposed
    // every time the home screen rebuilds around a different agent. Forgetting on the way out would
    // erase, on an ordinary rebuild, the very record the next launch is supposed to reopen.
    //
    // Nothing else has to clear it either. A record naming an agent that no longer exists costs one
    // lookup that finds nothing, and [AgentHome] falls through to the first reachable agent.
    super.dispose();
  }

  /// Closes what this pager opened, keeping the one the phone is still pointed at.
  ///
  /// The agent last read stays attached — that is the pane the Agents tab's row now refers to, and
  /// re-opening it should be instant rather than a fresh "Attaching…". Anything [_pruner] has not
  /// caught up with yet goes with it.
  ///
  /// Not awaited, and deliberately: `dispose` cannot wait, and `closePane` only has to be STARTED —
  /// it detaches the session and tells the daemon on its own. The notifier outlives this widget, so
  /// nothing here is torn down underneath it.
  ///
  /// ⚠️ **After the frame, never from `dispose` itself.** `closePane` notifies synchronously, and
  /// `dispose` runs while the tree is locked: every listener on the notifier failed to mark itself
  /// dirty ("setState() called when widget tree was locked") and MISSED that update — the pager
  /// built in this one's place among them, whose terminal was left stuck on a stale build (it would
  /// not scroll until it was opened again). Deferred, the close lands on an unlocked tree.
  ///
  /// ⚠️ And a pane a live pager has attached since is left alone — see [_heldByAnotherPager].
  void _detachAll() {
    final notifier = widget.notifier;
    final keep = _current;
    final leaving = {
      for (final agent in _attached)
        if (agent != keep) agent,
    };
    if (leaving.isEmpty) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      releaseAgentPanes(notifier, leaving, heldElsewhere: _heldByAnotherPager);
    });
  }

  /// Every pager currently mounted — what [_detachAll] asks before closing a pane it attached.
  static final Set<_AgentSwipeHostState> _livePagers = {};

  @override
  Widget build(BuildContext context) {
    final neighbours = widget.neighbours;
    final controller = _controller;
    if (neighbours == null || controller == null || neighbours.isEmpty) {
      return TerminalPage(
        notifier: widget.notifier,
        machineId: widget.machineId,
        agentId: widget.agentId,
        voice: _voice,
        isActive: true,
      );
    }
    // ⚠️ **The keyboard goes at the START of the drag, not at [_onPageChanged].**
    // That callback fires at the halfway point of a SETTLED swipe, so a keyboard
    // dismissed there would sit over the terminal for the whole gesture and then
    // vanish once the new agent had already arrived — and it would never go at
    // all for a drag that was pulled part way and let go.
    //
    // [ScrollStartNotification] is the first frame of the finger's movement,
    // which is the moment the person has shown they are leaving this terminal.
    //
    // ⚠️ **Depth 0 only — the pager's own drag.** The terminal inside each page
    // is a vertical [Scrollable] whose notifications bubble through here too;
    // taken for a swipe, reading back through the scrollback put the keyboard
    // away, and with no keyboard up it left the next one raised ignored until it
    // had come and gone once.
    return NotificationListener<ScrollStartNotification>(
      onNotification: (notification) {
        if (notification.depth != 0) return false;
        dismissKeyboardForSwipe();
        // Let it bubble: the pager's own scroll machinery is listening too.
        return false;
      },
      child: PageView.builder(
        controller: controller,
        // The terminal below scrolls vertically and selects text only with a mouse, so the horizontal
        // axis is free — and here it is the pager's ALONE. The route's own edge-swipe back used to
        // compete for it and win at the left margin, being registered above this in the tree: a drag
        // started near the edge to reach the previous AGENT left the screen instead. The route is
        // pushed without that gesture now (see `phoneRoute`'s `swipeToGoBack`), so going back is the
        // header's back band, or Android's back button.
        physics: const PageScrollPhysics(),
        // ⚠️ **[_reach] page either side is built and laid out AHEAD of the swipe.** Three things
        // follow, and each was a cost paid on the swipe itself before: the page is not built in the
        // first frame of the drag; its [TerminalPanel] measures the viewport while it is still off
        // screen, so its `terminal_open` goes out at the right size with no 2s wait and no second
        // keyframe on arrival; and that keyframe — up to 500 lines parsed on this thread — lands
        // while nobody is looking at it. `allowImplicitScrolling` is what the cache extent requires.
        allowImplicitScrolling: true,
        scrollCacheExtent: const ScrollCacheExtent.viewport(_reach * 1.0),
        // No count is what makes it endless: the builder answers for any page, and the modulo below
        // wraps it back onto the list. A one-agent list keeps its single page instead — see
        // [AgentSwipeList.wraps].
        itemCount: neighbours.wraps ? null : neighbours.entries.length,
        onPageChanged: _onPageChanged,
        itemBuilder: (context, i) {
          final entry = neighbours.entries[i % neighbours.entries.length];
          // ⚠️ Tickers off for every page but the one on screen. Pages are mounted beside it
          // now (see `scrollCacheExtent` above), and each has things that tick — the cursor blink,
          // the skeleton's sweep and pulse — which would otherwise run at frame rate for screens
          // nobody can see. [TerminalPanel] reads this for its blink; the skeleton reads it to draw
          // itself still rather than not at all.
          return TickerMode(
            // ⚠️ Keyed by PAGE, not by agent, and the difference only shows once the pager wraps: an
            // endless run holds several pages for the same agent — the lap before and the lap after —
            // and an agent-shaped key would make Flutter treat two live pages as one widget, which
            // throws on a duplicate key the moment both are mounted. Each page then learns its own
            // `_hadPane`, which is what that flag wants anyway: it is about this page's attach, not
            // about the agent.
            key: ValueKey(i),
            enabled: i == _page,
            child: TerminalPage(
              notifier: widget.notifier,
              machineId: entry.machineId,
              agentId: entry.agent.id,
              voice: _voice,
              // Exactly one mounted page, by page number — see [_page].
              isActive: i == _page,
            ),
          );
        },
      ),
    );
  }

  void _onPageChanged(int index) {
    final neighbours = widget.neighbours;
    if (neighbours == null || neighbours.isEmpty) return;
    // The page number runs off in both directions once the pager wraps; the agent it names does not.
    final entry = neighbours.entries[index % neighbours.entries.length];
    final arrived = (machineId: entry.machineId, agentId: entry.agent.id);
    // Recorded BEFORE the attach, so a pane always has an owner to close it — see [_attached]. An
    // agent added here that never finishes attaching costs nothing: [_detachAll] looks for its pane
    // and finds none.
    _attached.add(arrived);
    widget.notifier.lastOpenedAgent.remember(arrived);
    _rememberVisit(arrived);
    // ⚠️ A second dismissal, and not a redundant one. The [ScrollStartNotification] above catches
    // the finger, which is the usual way here and the one that matters for how it looks — but a page
    // reached any other way never raised that notification, and the incoming terminal would claim
    // the keyboard the moment it built. Landing on a new agent is the invariant; the drag is only
    // where it is felt. Both are cheap: clearing a flag and unfocusing what is already unfocused.
    dismissKeyboardForSwipe();
    // Before the setState, so a host that rebuilds this pager in response already names the agent
    // swiped to — told afterwards, it would rebuild still pointing at the previous one.
    widget.onAgentChanged?.call(arrived);
    setState(() {
      _page = index;
      _current = arrived;
    });
    // The agents outside this page's keep-set go back to whoever else wants them, once the swipe
    // has settled — see [AgentPanePruner].
    _pruner?.keep(_keepSet());
    // Attaching is what makes the terminal live, and it only happens once the page has SETTLED —
    // `onPageChanged` fires at the halfway point of a settled swipe, not on every dragged pixel, so
    // flicking across five agents attaches the ones passed through rather than all of them at once.
    // `selectAgent` reuses a pane that is already there — which, with the neighbours attached ahead
    // of time, is nearly always the case — so landing costs a focus and nothing else.
    unawaited(widget.notifier.selectAgent(entry.machineId, entry.agent.id));
    _armPrefetch();
  }

  /// The agents worth holding open for the page on screen: the page itself, then the ones within
  /// [_reach] swipes of it nearest first. That order is the priority, and [_maxOpen] cuts from the
  /// end of it. The agent just left is in it only by being one swipe away — which, straight after
  /// a swipe, it always is.
  Set<AgentRef> _keepSet() {
    final ordered = <AgentRef>{_current};
    for (final ring in _rings()) {
      ordered.addAll(ring);
    }
    return ordered.take(_maxOpen).toSet();
  }

  /// The agents on the pages within [_reach] of [_page], one ring per distance — `[N−1, N+1]` at
  /// today's reach of one. An agent under several of those pages — a short list, wrapped — is
  /// named once, in the nearest ring, and [_current] not at all; a ring can therefore be short, or
  /// empty.
  List<List<AgentRef>> _rings() {
    final neighbours = widget.neighbours;
    if (neighbours == null || neighbours.isEmpty) return const [];
    final entries = neighbours.entries;
    final count = entries.length;
    final seen = <AgentRef>{_current};
    final rings = <List<AgentRef>>[];
    for (var distance = 1; distance <= _reach; distance++) {
      final ring = <AgentRef>[];
      for (final step in [-distance, distance]) {
        final entry = entries[((_page + step) % count + count) % count];
        final agent = (machineId: entry.machineId, agentId: entry.agent.id);
        if (seen.add(agent)) ring.add(agent);
      }
      rings.add(ring);
    }
    return rings;
  }

  /// Attaches the pages around the one on screen, a beat after landing on it — see
  /// [_prefetchAround]. Re-armed by every page change, so a fling attaches only where it stops.
  void _armPrefetch() {
    _prefetchTimer?.cancel();
    final run = ++_prefetchRun;
    _prefetchTimer = Timer(_prefetchDebounce, () {
      _prefetchTimer = null;
      unawaited(_prefetchAround(run));
    });
  }

  /// Opens the streams of the agents within [_reach] of the page on screen, so the next swipe —
  /// either way — lands on output rather than on "Attaching…".
  ///
  /// The pages themselves are already mounted: [build] keeps [_reach] pages either side alive,
  /// which is what lets each one measure its own viewport and take its keyframe while nobody is
  /// looking. This is the other half — asking the machine for the stream.
  ///
  /// ⚠️ **In rings, and each ring only once the one before it has rendered.** The page on screen
  /// first, then N±1 (and further rings, were [_reach] raised): a stream is a keyframe of up to 500
  /// lines and then whatever the agent prints, and several opening at once would compete with the
  /// one being read for the same connection. [_renderWait] bounds each wait, so a page that never
  /// renders does not hold the rest back for good.
  ///
  /// [run] is the page change this was armed for. Another since makes it stale, and it stops
  /// between agents rather than opening streams around a page the pager has already left.
  Future<void> _prefetchAround(int run) async {
    final notifier = widget.notifier;
    bool stale() => !mounted || run != _prefetchRun;
    await _awaitRendered(_current, run, limit: _currentRenderWait);
    if (stale()) return;
    for (final ring in _rings()) {
      for (final agent in ring) {
        if (stale()) return;
        final open = notifier.paneOfAgent(agent.machineId, agent.agentId);
        if (open == null && _openPanes() >= _maxOpen) return;
        // Recorded BEFORE the attach, for the same reason [_onPageChanged] records the page it
        // lands on: a pane always has an owner to close it.
        _attached.add(agent);
        unawaited(notifier.warmAgentPane(agent.machineId, agent.agentId));
      }
      await Future.wait([for (final agent in ring) _awaitRendered(agent, run)]);
    }
  }

  /// Completes once [agent]'s session has drawn its first keyframe — or after [limit], or as soon
  /// as [run] is stale, whichever comes first.
  ///
  /// Also once the session is `takenOver`: another app is driving that terminal and the page asked
  /// not to take it (see `AppNotifier.warmAgentPane`), so there is no keyframe coming and nothing
  /// for the next ring to wait behind.
  Future<void> _awaitRendered(
    AgentRef agent,
    int run, {
    Duration limit = _renderWait,
  }) async {
    final notifier = widget.notifier;
    bool rendered() {
      final session = notifier
          .paneOfAgent(agent.machineId, agent.agentId)
          ?.session;
      if (session == null) return false;
      return session.hasRenderedFrame ||
          session.status == TerminalSessionStatus.takenOver;
    }

    if (rendered()) return;
    final done = Completer<void>();
    void check() {
      if (done.isCompleted) return;
      if (rendered() || !mounted || run != _prefetchRun) done.complete();
    }

    _waits.add(done);
    notifier.addListener(check);
    final deadline = Timer(limit, () {
      if (!done.isCompleted) done.complete();
    });
    try {
      await done.future;
    } finally {
      deadline.cancel();
      notifier.removeListener(check);
      _waits.remove(done);
    }
  }

  /// How many agents the phone has streams for that are STAYING — every pane on the phone is a
  /// pager's.
  ///
  /// ⚠️ **Not counting the ones this pager's pending prune is about to close.** The prefetch fires
  /// [_prefetchDebounce] after landing, before [AgentPanePruner.delay] has closed what the swipe
  /// left two pages behind. Counted, that agent filled the last place under [_maxOpen], the ring's
  /// far side was never attached, and nothing re-armed it: after every swipe the next page in the
  /// direction of travel came up "Attaching…".
  int _openPanes() {
    final keeping = _keepSet();
    return widget.notifier.panes.where((pane) {
      final agentId = pane.agentId;
      if (agentId == null) return false;
      final agent = (machineId: pane.machineId, agentId: agentId);
      return keeping.contains(agent) || !_attached.contains(agent);
    }).length;
  }
}

/// Whether a pager currently mounted is holding [agent] open — on screen, a swipe away, or just
/// left. What [AgentHome] asks before closing a pane, so tidying up after a replaced pager does not
/// undo the new pager's prefetch a frame after it started.
bool agentPaneHeldByPager(AgentRef agent) => _AgentSwipeHostState._livePagers
    .any((pager) => pager._attached.contains(agent));
