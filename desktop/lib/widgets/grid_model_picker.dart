import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../shared/theme/workspace_bar_style.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../terminal/terminal_theme.dart';
import '../terminal/terminal_theme_store.dart';

import 'package:harness/terminal/terminal_text.dart';

import '../core/models.dart';
import '../core/test_run.dart';
import '../state/app_state.dart';
import '../shared/theme/app_type.dart';
import '../theme/app_theme.dart';
import '../usage/models_menu_controller.dart';
import 'engine_identity.dart';
import 'model_picker_answer.dart';
import 'model_picker_chrome.dart';
import 'pane_menu.dart';
import 'resting_model_words.dart';
import 'resting_section.dart';
import 'workspace_bar_control.dart';

/// The engines whose panes carry a model picker.
///
/// Named here rather than derived from the daemon's `localModelEngines`, because the two answer
/// different questions. That list is which engines a Local model *can* be handed to — a launch
/// contract exists for seven of them. This is the narrower question of which ones a person is
/// OFFERED the switch on, and it is the three whose switching has been driven end to end: Claude
/// Code and Codex move by environment, and OpenCode by a config file plus its own `/models` picker.
///
/// The rest keep the header they had. A picker on an engine whose move has never been watched work
/// is a menu that looks like a choice and may not be one, and the cost of finding out is an agent
/// answering on a model nobody asked for.
const Set<String> kModelPickerEngines = {'claude', 'codex', 'opencode'};

/// Whether [engine] gets a picker. Unknown or absent is NO — a header offers nothing it cannot back.
bool modelPickerSupports(String? engine) =>
    kModelPickerEngines.contains(engine?.trim().toLowerCase());

/// The pane header's model picker, in two sections: **Subscription** and **Local**.
///
/// The shape is the app's own Models menu, deliberately — that menu already answers "what could this
/// run on" for the whole window, and a second control answering the same question in a different
/// visual language would read as a different KIND of question. It carries only two of that menu's
/// sections: the engine's own login, and the models the account's private grid is serving. There is
/// no API section here because this picker cannot put an agent on one.
///
/// **Only the private harness grid.** Not every grid this computer's `grid` CLI happens to be signed
/// into — the question the header asks is "which of MY machines could answer for this agent", and a
/// catalogue of other people's grids is a different question with a different blast radius.
///
/// The list is fetched when the menu opens rather than held in state, because it is live: an engine
/// can join or leave a grid between two openings, and an offer nobody is serving any more is worse
/// than a moment's spinner.
class GridModelPickerController extends ChangeNotifier {
  void open() => notifyListeners();
}

class GridModelPicker extends StatefulWidget {
  final AppNotifier notifier;
  final String machineId;

  /// Called with the chosen grid model.
  final ValueChanged<GridModel>? onSelected;

  /// Called to put the agent back on its own vendor login. Offered FIRST and always — a picker that
  /// can only move an agent ONTO a grid is a one-way door, and the way back must not be a thing you
  /// have to know a command for.
  final VoidCallback? onUseOwnLogin;

  /// Opens the local Models overview to discover and start compatible models.
  final VoidCallback? onRunLocalModel;

  /// The grid model this agent is on right now, or null when it is on its own login. Drives the
  /// filled row, so the menu answers "where am I" as well as "where could I go".
  final String? currentModel;

  /// Observed subscription model for the label. Does not select a Local row.
  final String? subscriptionModel;

  /// Whether the agent can search the web on [currentModel], as the daemon decided when it built
  /// the launch. Shown as a subtitle under the current Local row and in the control's tooltip —
  /// only for the two degraded values; `on` and null (nothing said) show nothing. Read only when
  /// [currentModel] is set: it is a fact about a Local-model launch, and the Subscription row has
  /// its own web tools.
  final GridWebSearch? webSearch;

  /// The agent's engine, for the subscription row's icon and label.
  final String? engineLabel;
  final bool compact;
  final bool paneHeader;
  final bool enabled;

  /// An optional programmatic trigger without a visible label. The menu anchors
  /// to the top of the Flutter surface; pane headers use the normal trigger.
  final bool menuOnly;
  final GridModelPickerController? controller;

  const GridModelPicker({
    super.key,
    required this.notifier,
    required this.machineId,
    this.onSelected,
    this.onUseOwnLogin,
    this.onRunLocalModel,
    this.currentModel,
    this.subscriptionModel,
    this.webSearch,
    this.engineLabel,
    this.compact = false,
    this.paneHeader = false,
    this.enabled = true,
    this.menuOnly = false,
    this.controller,
  });

  @override
  State<GridModelPicker> createState() => _GridModelPickerState();
}

class _GridModelPickerState extends State<GridModelPicker> {
  bool _loading = false;

  /// The window's shared subscription readings — the same controller the Models panel draws,
  /// so this row and that menu cannot disagree. Owned by the app, never disposed here.
  late final ModelsMenuController _usage = widget.notifier.modelsMenu;
  GridModels? _last;

  /// Set when the control was built while the app was in the background: the warm-up it skipped is
  /// owed, and paid once when the app comes back to the foreground.
  bool _prefetchOwed = false;

  @override
  void initState() {
    super.initState();
    // The app's one picture of the grids, when some other surface has already read it — or the
    // daemon has pushed it — is a warm answer for this control's first click.
    _last = widget.notifier.gridPictures[widget.machineId];
    widget.notifier.gridPictures.addListener(_pictureChanged);
    widget.notifier.foreground.addListener(_foregroundChanged);
    widget.controller?.addListener(_openFromController);
    // A reading that lands while the menu is open redraws its Subscription row, rather than
    // leaving "Checking usage…" there until the next open.
    _usage.addListener(_redrawOpenMenu);
    // Warm the answer as soon as the control exists, so a click lands on a memo rather than on two
    // subprocess spawns and two network round trips — measured at ~1.4s, which is a person watching
    // a header do nothing. Fire-and-forget: nothing here waits on it, and a failure just means the
    // first open pays what it used to. Not while the app is in the background: a pane restored
    // behind a minimised window asks nothing until somebody can see it.
    _prefetchOwed = true;
    _foregroundChanged();
  }

  void _foregroundChanged() {
    if (!mounted ||
        !widget.enabled ||
        !_prefetchOwed ||
        !widget.notifier.inForeground) {
      return;
    }
    _prefetchOwed = false;
    unawaited(_prefetch().then((_) => _refreshOpenMenu()));
  }

  /// The app's picture of this machine's grids changed — another surface read it, or the daemon
  /// pushed it. Taken as this control's memo, and drawn into the menu if one is open.
  void _pictureChanged() {
    if (!mounted) return;
    final fresh = widget.notifier.gridPictures[widget.machineId];
    if (fresh == null || identical(fresh, _last)) return;
    _last = fresh;
    _refreshOpenMenu();
  }

  Future<void> _prefetch() async {
    // Not under `flutter test`: a refresh reads the Keychain and asks the vendors, the same reads the
    // usage rail keeps out of tests (kUnderTest) — here every test that drew a pane header left that
    // work's timers pending after the tree was gone. Opening the menu still refreshes.
    if (!kUnderTest) unawaited(_usage.refresh().catchError((_) {}));
    _prefetchOwed = false;
    final picture = await widget.notifier.readGridPicture(widget.machineId);
    if (mounted) _last = picture;
  }

  /// Closes the menu this control has open, if any. Set while one is showing.
  void Function()? _close;

  /// The model this picker has just been told to move to, before the machine has confirmed it.
  ///
  /// A retarget RESPAWNS the pane, so the authoritative answer — `agent.gridModel`, which is what
  /// [GridModelPicker.currentModel] carries — only arrives once the daemon has done the work and
  /// sent a frame, seconds later. Until then the menu reopened with the tick still on the row the
  /// person had just moved off, which reads as the click having done nothing.
  ///
  /// `_expecting` is what tells "moving to the engine's own login" (a deliberate null) apart from
  /// "nothing pending", which null alone cannot.
  bool _expecting = false;
  String? _expected;
  Timer? _expiry;

  /// What the menu should tick: the guess while there is one, else what the machine says.
  String? get _effectiveModel => _expecting ? _expected : widget.currentModel;

  /// Take the choice as made, and say so at once.
  void _expect(String? model) {
    _expiry?.cancel();
    setState(() {
      _expecting = true;
      _expected = model;
    });
    // A refused retarget never produces a frame to correct this, so the guess expires on its own.
    // The request's own budget is 30s; outliving it would leave a tick on a row the agent never
    // reached.
    _expiry = Timer(const Duration(seconds: 30), () {
      if (!mounted) return;
      setState(() {
        _expecting = false;
        _expected = null;
      });
      _redrawOpenMenu();
    });
    _redrawOpenMenu();
  }

  @override
  void didUpdateWidget(GridModelPicker oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.enabled != oldWidget.enabled) {
      _foregroundChanged();
      if (!widget.enabled) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted && !widget.enabled) _close?.call();
        });
      }
    }
    if (widget.controller != oldWidget.controller) {
      oldWidget.controller?.removeListener(_openFromController);
      widget.controller?.addListener(_openFromController);
    }
    if (widget.currentModel == oldWidget.currentModel) return;
    if (_expecting && _settles(widget.currentModel)) {
      _expiry?.cancel();
      _expecting = false;
      _expected = null;
    }
    // A menu open while this lands redraws, rather than waiting to be reopened.
    //
    // ⚠️ AFTER the frame, never inside it. `didUpdateWidget` runs while the framework is building,
    // and marking an overlay entry dirty from there throws "setState() or markNeedsBuild() called
    // during build" across the window — the entry belongs to a different subtree that this build
    // pass has already gone past.
    _redrawOpenMenu();
  }

  /// Does what the machine now reports END the guess?
  ///
  /// NOT simply "the answer changed". A retarget respawns the pane, and a pane that is restarting
  /// reports no model at all for a moment — so the first frame after a click is usually a null on
  /// its way to the model that was asked for. Dropping the guess there put the tick back on the
  /// Subscription row mid-move, and the row the person clicked only claimed it once the respawn
  /// finished: a visible flicker between two different answers.
  ///
  /// So a null settles nothing while a MODEL is expected — the timer is what bounds that wait. Any
  /// other model does settle it: the agent went somewhere other than where this menu asked, and
  /// what the machine says beats what this menu hoped. Expecting the engine's own login is the
  /// mirror image, where null IS the confirmation.
  bool _settles(String? reported) =>
      _expected == null ? reported == null : reported != null;

  /// Ask an open menu to rebuild, safely from anywhere — including mid-build.
  void _redrawOpenMenu() {
    final entry = _entry;
    if (entry == null) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && _entry == entry) entry.markNeedsBuild();
    });
    // A post-frame callback waits for a frame, and nothing else may be drawing: a list pushed by the
    // daemon lands in an idle window, where the redraw would sit until some unrelated repaint.
    WidgetsBinding.instance.scheduleFrame();
  }

  /// The answer the OPEN menu is drawing, and the overlay entry drawing it. Both set only while a
  /// menu is showing. A refresh that lands while the menu is open swaps the first and rebuilds
  /// the second, so a model that came up since the last open appears in THIS one rather than the
  /// next — a person who just started a model and opened the picker is looking for exactly that
  /// row, and a menu that showed it only on a second click read as the model not being there.
  GridModels? _shown;
  OverlayEntry? _entry;
  bool _disposing = false;

  @override
  void dispose() {
    _disposing = true;
    widget.notifier.gridPictures.removeListener(_pictureChanged);
    widget.notifier.foreground.removeListener(_foregroundChanged);
    widget.controller?.removeListener(_openFromController);
    _expiry?.cancel();
    // A pane can go away under an open menu — closed, moved, or its swarm switched — and an overlay
    // entry outlives the State that inserted it.
    _close?.call();
    _usage.removeListener(_redrawOpenMenu);
    super.dispose();
  }

  /// The sentence about web search on the current Local model, or null when there is none to
  /// show. Null off a grid whatever the daemon said: a frame can lag a move home by a beat, and
  /// the Subscription row must never wear a sentence about a launch it was no part of.
  String? get _webSearchSentence =>
      _effectiveModel == null ? null : widget.webSearch?.sentence;

  /// The subtitle under one Local row: the sentence for the CURRENT model only. The status is about
  /// this agent's launch, and the other rows are places it could go, about which nothing is known.
  String? _subtitleFor(GridModel model) =>
      _effectiveModel == model.id ? _webSearchSentence : null;

  /// The subscription reading for THIS agent's engine, or null when there is none to show.
  ///
  /// Read from the same controller the Models panel uses, so the percentage here and
  /// the percentage up there cannot disagree. Its refresh is capped at once a minute and it answers
  /// from cache in between, which is why opening this menu does not cost a request.
  Map<String, Object?>? _subscriptionRow() =>
      subscriptionRowFor(widget.engineLabel, _usage.rows);

  void _openFromController() => unawaited(_open());

  Future<void> _open() async {
    if (_loading || !widget.enabled) return;
    // A warm answer opens the menu with no wait at all. It is at most seconds old — the daemon's own
    // memo is what bounds that — and the refresh below lands in time for the next open.
    final GridModels answer;
    if (_last != null) {
      answer = _last!;
      // The refresh lands INTO the open menu, not only into the memo for the next one.
      unawaited(_prefetch().then((_) => _refreshOpenMenu()));
      await _show(answer);
      return;
    }
    setState(() => _loading = true);
    try {
      // ⚠️ The usage read is NOT awaited. It is decoration — a percentage beside the subscription
      // row — while the grid list is the menu's actual content, and a menu that waits on a credential
      // read to draw a list it already has is a menu that feels broken whenever that source is slow.
      // This open uses whatever is cached; the refresh lands for the next one. `refresh()` is itself
      // capped at once a minute, so opening the menu repeatedly costs nothing.
      unawaited(_usage.refresh().catchError((_) {}));
      answer = await widget.notifier.readGridPicture(widget.machineId);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
    _last = answer;
    if (!mounted) return;
    await _show(answer);
  }

  /// Draw the menu for an answer already in hand. Split from [_open] so a warm open shares exactly
  /// the same menu as a cold one rather than a second copy of it.
  Future<void> _show(GridModels answer) async {
    if (!mounted || !widget.enabled) return;
    _shown = answer;

    final box = context.findRenderObject() as RenderBox?;
    final overlay =
        Overlay.of(context).context.findRenderObject() as RenderBox?;
    if (box == null || overlay == null) return;
    final origin = box.localToGlobal(Offset.zero, ancestor: overlay);
    final position = widget.menuOnly
        ? RelativeRect.fromLTRB(overlay.size.width - 12, 0, 12, 0)
        : RelativeRect.fromLTRB(
            origin.dx,
            origin.dy + box.size.height + 6,
            overlay.size.width - origin.dx - box.size.width,
            0,
          );

    final chosen = await _showMenu(
      position: position,
      body: (close) => _ModelPickerPanel(
        answer: _shown!,
        engineLabel: widget.engineLabel,
        currentModel: _effectiveModel,
        // Read on every draw, so a usage refresh that lands under the open menu shows in it.
        subscription: _subscriptionRow(),
        sections: _sectionsToDraw(_shown!),
        subtitleFor: _subtitleFor,
        emptySentence: (section) => _emptySentence(_shown!, section),
        onWake: (section) =>
            widget.notifier.wakeGridModels(widget.machineId, section.name),
        close: close,
      ),
    );
    if (chosen == null || !mounted || !widget.enabled) return;
    if (chosen.runLocalModel) {
      widget.onRunLocalModel?.call();
      return;
    }
    // Selecting what is already selected respawns the pane for no reason — do nothing instead.
    if (chosen.model == null) {
      if (_effectiveModel != null) {
        _expect(null);
        widget.onUseOwnLogin?.call();
      }
      return;
    }
    final model = chosen.model!;
    if (model.id == _effectiveModel) return;
    // A row whose every computer seems offline is asked about first; the move is never refused.
    if (model.unavailable case final offline?) {
      if (!mounted) return;
      final go = await confirmSwitchAnyway(
        context,
        model: model.id,
        offline: offline,
      );
      if (!go || !mounted) return;
    }
    _expect(model.id);
    widget.onSelected?.call(model);
  }

  /// What the Local section says when it lists nothing.
  ///
  /// Two sentences, because they are two different situations and only one of them is about the
  /// account. Folding them together is what put "sign in again to set them up" in front of a
  /// signed-in user whose daemon happened to be offline — advice that was wrong, and that would
  /// not have helped even if the diagnosis had been right. A reachable own grid serving nothing
  /// still answers the sentence below, so "Local models on your machines" is never left to end
  /// at an empty list that reads as a rendering gap.
  String? _emptySentence(GridModels answer, GridSection section) {
    if (!answer.reachable) return 'Could not reach this machine.';
    // The machine's gap before the account's: with no `grid` on this computer there is nothing a
    // sign-in could set up here, and the feature's name is the only word for it a person knows.
    if (answer.gridCli == GridCli.missing) {
      return 'Model Manager can finish setting up this computer.';
    }
    // The account's rest are the models on the user's own machines; an empty list there needs a
    // sentence under the heading. Shared grids are never drawn empty (see _sectionsToDraw), so
    // this branch only ever fires for the own grid.
    if (section.own) {
      return 'Set up your first local model on this computer.';
    }
    return null;
  }

  /// The sections worth a heading: "Local" always (so the empty-state sentence has a place),
  /// and a shared grid only while it serves something. A team grid with nothing running is not
  /// a choice this menu can offer, and a heading over "nothing here" was a line to read for no
  /// gain — the menu is for picking a model, not for surveying grids.
  /// Unless it has something to SAY ([SectionWords.speaks] — only ever from a newer daemon).
  List<GridSection> _sectionsToDraw(GridModels answer) {
    final sections = answer.sections
        .where((s) => s.own || s.models.isNotEmpty || sectionWords(s).speaks)
        .toList();
    if (sections.any((s) => s.own)) return sections;
    return [
      GridSection(
        name: answer.gridName ?? '',
        own: true,
        models: answer.models,
      ),
      ...sections,
    ];
  }

  /// The pane menu ([showPaneMenu]), with this picker's two hooks: the entry, so a refresh that
  /// lands while the menu is open can redraw it, and the closer, so a pane going away under an
  /// open menu can take the menu with it.
  Future<_Choice?> _showMenu({
    required RelativeRect position,
    required Widget Function(void Function(_Choice?) close) body,
  }) => showPaneMenu<_Choice>(
    context: context,
    position: position,
    body: body,
    minWidth: kModelPickerWidth,
    maxWidth: kModelPickerWidth,
    // A new focused pane disposes this picker; do not pull focus back to its owner.
    shouldRestoreFocus: () => mounted && !_disposing && widget.enabled,
    onOpen: (entry, close) {
      _entry = entry;
      _close = close;
    },
    onClose: () {
      _entry = null;
      _shown = null;
      _close = null;
    },
  );

  /// Redraw the open menu from the fresh memo, if the list changed under it. Nothing to do when
  /// no menu is open, or when the refresh said what the menu already shows — a rebuild for an
  /// identical list would only flicker the hover.
  void _refreshOpenMenu() {
    final entry = _entry;
    final fresh = _last;
    final shown = _shown;
    if (!mounted || entry == null || fresh == null || shown == null) return;
    if (drawsSameMenu(fresh, shown)) return;
    _shown = fresh;
    // One safe path for every redraw — see [_redrawOpenMenu]. This one arrives off an async read
    // and so is usually clear of the build phase, but "usually" is what the crash was.
    _redrawOpenMenu();
  }

  @override
  Widget build(BuildContext context) {
    TerminalFontScope.watch(context);
    if (widget.menuOnly) return const SizedBox.shrink();
    final sentence = _webSearchSentence;
    final current =
        widget.currentModel ??
        widget.subscriptionModel ??
        switch (widget.engineLabel?.toLowerCase()) {
          'codex' => 'OpenAI',
          'claude' => 'Anthropic',
          'opencode' => 'OpenCode',
          _ => 'Model',
        };
    final label = _expecting ? 'Switching…' : current;
    if (widget.paneHeader) {
      final theme = terminalThemeFor(
        grid.AppTheme.palette.value,
        terminalThemeStore.value,
      );
      final cell = workspaceBarCellSizeOf(context);
      final labelSize = workspaceBarTextSizeOf(context, label);
      return LayoutBuilder(
        builder: (context, constraints) {
          final padding = math.min(cell.width, constraints.maxWidth / 2);
          final textWidth = math.max(
            0.0,
            math.min(220.0, constraints.maxWidth - padding * 2),
          );
          final clipped = labelSize.width > textWidth;
          return WorkspaceBarControl(
            label: 'Model: $current',
            tooltip: [
              if (clipped || label != current) current,
              if (widget.enabled) 'Switch model · Subscription or local models',
              ?sentence,
            ].join('\n'),
            foreground: theme.foreground,
            onPressed: widget.enabled ? _open : null,
            builder: (context, emphasized) => SizedBox(
              width: math.min(labelSize.width, textWidth) + padding * 2,
              height: workspaceBarControlHeight(context),
              child: Padding(
                padding: EdgeInsets.symmetric(horizontal: padding),
                child: Center(
                  child: Text(
                    label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: workspaceBarTextStyle(emphasized: emphasized),
                  ),
                ),
              ),
            ),
          );
        },
      );
    }
    final foreground = widget.paneHeader
        ? terminalThemeFor(
            grid.AppTheme.palette.value,
            terminalThemeStore.value,
          ).foreground.withValues(alpha: .65)
        : AppColors.textSoft;
    return Tooltip(
      // The same sentence the menu shows, one line under the control's own — so a person can learn
      // the agent has no web search without opening the menu at all.
      message: [
        'Model: $current',
        if (widget.enabled) 'Switch model · Subscription or local models',
        ?sentence,
      ].join('\n'),
      waitDuration: const Duration(milliseconds: 700),
      child: MouseRegion(
        // Stated rather than inherited. The pane header sits over a terminal, and the cursor a
        // person sees while hovering this was whatever the surface underneath asked for — so a
        // control that opens a menu did not look like one until you clicked it.
        cursor: widget.enabled
            ? SystemMouseCursors.click
            : SystemMouseCursors.basic,
        // Its own ink surface: an InkWell needs a Material above it, and a pane header is not
        // always inside one — every test that drew a header threw "No Material widget found".
        child: Material(
          type: MaterialType.transparency,
          child: InkWell(
            onTap: widget.enabled ? _open : null,
            // Stated on the InkWell as well as on the MouseRegion above it. The cursor a person sees is
            // the INNERMOST annotation under the pointer, and InkWell installs one of its own — so an
            // ancestor asking for a hand is not, by itself, the thing that decides.
            mouseCursor: widget.enabled
                ? SystemMouseCursors.click
                : SystemMouseCursors.basic,
            borderRadius: BorderRadius.circular(4),
            hoverColor: foreground.withValues(alpha: 0.10),
            focusColor: foreground.withValues(alpha: 0.10),
            child: Padding(
              padding: EdgeInsets.symmetric(
                horizontal: widget.compact ? 3 : 6,
                vertical: 3,
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  // Room for a whole model id ("DeepSeek-V4-Flash-0731") where the header has
                  // it; Flexible so a header that is short of room shortens the name instead of
                  // overflowing. The tooltip always says the whole model.
                  Flexible(
                    child: ConstrainedBox(
                      constraints: BoxConstraints(
                        maxWidth: widget.compact && !widget.paneHeader
                            ? 44
                            : 220,
                      ),
                      child: Text(
                        label,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: widget.paneHeader
                            ? workspaceBarTextStyle(color: foreground)
                            : AppType.monoLabel(
                                fontWeight: FontWeight.w400,
                                color: AppColors.textSoft,
                              ),
                      ),
                    ),
                  ),
                  // Replace the arrow while loading so a read cannot squeeze
                  // the session name or move the pane's other controls.
                  if (_loading && !widget.paneHeader)
                    const SizedBox(
                      width: 14,
                      height: 14,
                      child: CircularProgressIndicator(strokeWidth: 1.5),
                    )
                  else if (!widget.paneHeader)
                    Icon(
                      Icons.arrow_drop_down,
                      size: 14,
                      color: AppColors.mutedStrong,
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

/// The picker's panel: a search field that stays put, the sections scrolling under it, and a
/// footer that stays put below.
///
/// Stateful because the query is: the menu is an overlay entry the picker rebuilds whenever a
/// refresh lands, and a query held by the picker would be rebuilt away mid-typing.
class _ModelPickerPanel extends StatefulWidget {
  const _ModelPickerPanel({
    required this.answer,
    required this.engineLabel,
    required this.currentModel,
    required this.subscription,
    required this.sections,
    required this.subtitleFor,
    required this.emptySentence,
    required this.onWake,
    required this.close,
  });

  final GridModels answer;
  final String? engineLabel;
  final String? currentModel;
  final Map<String, Object?>? subscription;
  final List<GridSection> sections;
  final String? Function(GridModel) subtitleFor;
  final String? Function(GridSection) emptySentence;

  /// "Show models": wake that section. The menu stays open; the answer lands in it.
  final Future<void> Function(GridSection) onWake;
  final void Function(_Choice?) close;

  @override
  State<_ModelPickerPanel> createState() => _ModelPickerPanelState();
}

class _ModelPickerPanelState extends State<_ModelPickerPanel>
    with SectionWakes {
  final _query = TextEditingController();
  String _needle = '';

  @override
  void dispose() {
    _query.dispose();
    super.dispose();
  }

  /// Models matching the query. The MACHINE counts as well as the model: "which of these is on
  /// zeus" is the same question as "where is DeepSeek", and a search that read only ids would
  /// answer one of them.
  List<GridModel> _matching(GridSection section) {
    if (_needle.isEmpty) return section.models;
    final needle = _needle.toLowerCase();
    return section.models
        .where(
          (m) =>
              m.id.toLowerCase().contains(needle) ||
              m.node.toLowerCase().contains(needle),
        )
        .toList();
  }

  bool get _subscriptionMatches {
    if (_needle.isEmpty) return true;
    final title =
        (widget.subscription?['title'] as String?) ??
        engineIdentity(widget.engineLabel).label;
    final account = (widget.subscription?['account'] as String?) ?? '';
    final needle = _needle.toLowerCase();
    return title.toLowerCase().contains(needle) ||
        account.toLowerCase().contains(needle);
  }

  /// Amber once the tightest window is nearly out, so the bar and the figure agree.
  static const _lowWater = 20.0;

  @override
  Widget build(BuildContext context) {
    final canRunLocally = widget.answer.canRunLocally(widget.engineLabel);
    final sections = widget.sections;
    final total = sections.fold<int>(0, (n, s) => n + _matching(s).length);
    final rows = <Widget>[];

    if (_subscriptionMatches) {
      rows
        ..add(const ModelPickerSectionHeader(label: 'Subscription'))
        ..add(_subscriptionRowWidget());
    }
    for (final section in sections) {
      final models = canRunLocally ? _matching(section) : const <GridModel>[];
      // A section a search has emptied says nothing: the query is the reason, and repeating
      // "nothing here" under every heading turns one empty result into a wall of them.
      if (_needle.isNotEmpty && models.isEmpty) continue;
      // Resting, starting, not answering — nothing for an engine that cannot use it at all.
      final words = canRunLocally ? wordsFor(section) : SectionWords.none;
      rows.add(
        ModelPickerSectionHeader(
          label: section.own ? 'On your machines' : 'Shared · ${section.name}',
          count: models.length,
        ),
      );
      if (!canRunLocally) {
        rows.add(
          _panelSentence(
            '${engineIdentity(widget.engineLabel).label} can only run on its own login.',
          ),
        );
        continue;
      }
      if (words.speaks) {
        rows.add(
          RestingSectionNotes(
            words: words,
            inset: kModelPickerInset,
            onWake: () => unawaited(wakeSection(section, widget.onWake)),
          ),
        );
      }
      if (models.isEmpty) {
        // Resting or starting is not empty: "set up your first model" would be wrong about it.
        final sentence = words.speaks ? null : widget.emptySentence(section);
        if (sentence != null) rows.add(_panelSentence(sentence));
        continue;
      }
      for (final model in models) {
        final offlineSentence = offlineRowNote(model);
        rows.add(
          Padding(
            padding: const EdgeInsets.only(bottom: 2),
            child: Tooltip(
              message: [
                'Where this agent runs',
                ?offlineSentence,
                ?widget.subtitleFor(model),
              ].join('\n'),
              child: ModelPickerRow(
                title: model.id,
                subtitle: model.node,
                // The web-search sentence for the CURRENT model only — a fact
                // about this agent's launch, not about the model. Dropped when
                // the panel replaced the old row list, which lost it silently;
                // the tests that caught it are the reason it is back. A row
                // that will not answer at all says that instead.
                hint: offlineSentence ?? widget.subtitleFor(model),
                dimmed: offlineSentence != null,
                selected: widget.currentModel == model.id,
                avatar: ModelAvatar(label: model.id),
                note: null,
                onTap: () => widget.close(_Choice.model(model)),
              ),
            ),
          ),
        );
      }
    }
    if (rows.isEmpty) rows.add(_panelSentence('Nothing matches “$_needle”.'));

    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 12, 12, 2),
          child: ModelPickerSearch(
            controller: _query,
            onChanged: (value) => setState(() => _needle = value.trim()),
          ),
        ),
        Flexible(
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(12, 0, 12, 10),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: rows,
            ),
          ),
        ),
        ModelPickerFooter(
          summary: total == 1 ? '1 model available' : '$total models available',
          actionLabel: 'Local models',
          onAction: () => widget.close(const _Choice.runLocalModel()),
        ),
      ],
    );
  }

  Widget _subscriptionRowWidget() {
    final percent = widget.subscription?['remainingPercent'];
    final low = percent is double && percent <= _lowWater;
    final status = widget.subscription?['status'] as String?;
    final account = (widget.subscription?['account'] as String?) ?? '';
    return ModelPickerRow(
      title:
          (widget.subscription?['title'] as String?) ??
          engineIdentity(widget.engineLabel).label,
      // The account, said as what it is. A bare `7f0c59` under a provider's name read as part of
      // the name rather than as the key it identifies.
      subtitle: account.isEmpty ? '' : 'key ···$account',
      selected: widget.currentModel == null,
      avatar: ModelAvatar(
        label:
            (widget.subscription?['title'] as String?) ??
            engineIdentity(widget.engineLabel).label,
      ),
      // Absent rather than "unknown": a row that cannot say how much is left says nothing, which
      // reads as "no figure" instead of as a figure that happens to be missing.
      trailing: status == null
          ? null
          : Column(
              crossAxisAlignment: CrossAxisAlignment.end,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  percent is double ? '${percent.floor()}% left' : status,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  textAlign: TextAlign.end,
                  style: AppType.body(
                    color: low ? AppColors.warning : AppColors.textSoft,
                  ).copyWith(fontSize: 12.5, fontWeight: FontWeight.w600),
                ),
                if (percent is double) ...[
                  const SizedBox(height: 2),
                  Text(
                    low ? 'Running low' : 'Healthy',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    textAlign: TextAlign.end,
                    style: AppType.body(color: AppColors.muted)
                        .copyWith(fontSize: 11),
                  ),
                ],
              ],
            ),
      meter: percent is double ? percent / 100 : null,
      note: low ? AppColors.warning : AppColors.accent,
      onTap: () => widget.close(const _Choice.ownLogin()),
    );
  }

  Widget _panelSentence(String text) => Padding(
    padding: const EdgeInsets.fromLTRB(
      kModelPickerInset,
      4,
      kModelPickerInset,
      8,
    ),
    child: Text(text, style: AppType.body(color: AppColors.textSoft)),
  );
}

/// The subscription row for [engine] among the Models menu's [rows], or null when there is none.
///
/// One engine can have several rows: this computer's login first, then each other account a
/// remote machine is signed in to. A row with a figure wins over one without — this Mac signed
/// out beside a machine whose login is live should show the live one, not "Not signed in".
@visibleForTesting
Map<String, Object?>? subscriptionRowFor(
  String? engine,
  List<Map<String, Object?>> rows,
) {
  final key = engine?.trim().toLowerCase();
  if (key == null || key.isEmpty) return null;
  final matching = rows.where((row) => row['engine'] == key);
  return matching.where((row) => row['remainingPercent'] != null).firstOrNull ??
      matching.firstOrNull;
}

class _Choice {
  final GridModel? model;
  final bool runLocalModel;
  const _Choice.model(GridModel this.model) : runLocalModel = false;
  const _Choice.ownLogin() : model = null, runLocalModel = false;
  const _Choice.runLocalModel() : model = null, runLocalModel = true;
}
