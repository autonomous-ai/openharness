import 'dart:async';

import 'package:flutter/material.dart';
import 'package:harness/terminal/terminal_text.dart';

import '../core/models.dart';
import '../core/test_run.dart';
import '../state/app_state.dart';
import '../shared/theme/app_type.dart';
import '../theme/app_theme.dart';
import '../usage/models_menu_controller.dart';
import 'engine_identity.dart';
import 'model_picker_chrome.dart';
import 'pane_menu.dart';

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

  /// Whether the agent can search the web on [currentModel], as the daemon decided when it built
  /// the launch. Shown as a subtitle under the current Local row and in the control's tooltip —
  /// only for the two degraded values; `on` and null (nothing said) show nothing. Read only when
  /// [currentModel] is set: it is a fact about a Local-model launch, and the Subscription row has
  /// its own web tools.
  final GridWebSearch? webSearch;

  /// The agent's engine, for the subscription row's icon and label.
  final String? engineLabel;
  final bool compact;

  const GridModelPicker({
    super.key,
    required this.notifier,
    required this.machineId,
    this.onSelected,
    this.onUseOwnLogin,
    this.onRunLocalModel,
    this.currentModel,
    this.webSearch,
    this.engineLabel,
    this.compact = false,
  });

  @override
  State<GridModelPicker> createState() => _GridModelPickerState();
}

class _GridModelPickerState extends State<GridModelPicker> {
  bool _loading = false;
  ModelsMenuController? _usage;
  GridModels? _last;

  @override
  void initState() {
    super.initState();
    // Warm the answer as soon as the control exists, so a click lands on a memo rather than on two
    // subprocess spawns and two network round trips — measured at ~1.4s, which is a person watching
    // a header do nothing. Fire-and-forget: nothing here waits on it, and a failure just means the
    // first open pays what it used to.
    unawaited(_prefetch());
  }

  Future<void> _prefetch() async {
    // Created here, not only on the cold path: a warm open reads `_usage.rows` for the subscription
    // row's provider name and percentage, and skipping it left that row falling back to the bare
    // engine label with no status beside it.
    _usage ??= ModelsMenuController(remote: widget.notifier.readRemoteUsage);
    // Not under `flutter test`: a refresh reads the Keychain and asks the vendors, the same reads the
    // usage rail keeps out of tests (kUnderTest) — here every test that drew a pane header left that
    // work's timers pending after the tree was gone. Opening the menu still refreshes.
    if (!kUnderTest) unawaited(_usage!.refresh().catchError((_) {}));
    final answer = await widget.notifier.gridModels(widget.machineId);
    if (mounted) _last = answer;
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
  }

  /// The answer the OPEN menu is drawing, and the overlay entry drawing it. Both set only while a
  /// menu is showing. A refresh that lands while the menu is open swaps the first and rebuilds
  /// the second, so a model that came up since the last open appears in THIS one rather than the
  /// next — a person who just started a model and opened the picker is looking for exactly that
  /// row, and a menu that showed it only on a second click read as the model not being there.
  GridModels? _shown;
  OverlayEntry? _entry;

  @override
  void dispose() {
    _expiry?.cancel();
    // A pane can go away under an open menu — closed, moved, or its swarm switched — and an overlay
    // entry outlives the State that inserted it.
    _close?.call();
    _usage?.dispose();
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
  /// Built from the same controller the window's own Models menu uses, so the percentage here and
  /// the percentage up there cannot disagree. Its refresh is capped at once a minute and it answers
  /// from cache in between, which is why opening this menu does not cost a request.
  Map<String, Object?>? _subscriptionRow() {
    final engine = widget.engineLabel?.trim().toLowerCase();
    if (engine == null || engine.isEmpty) return null;
    for (final row in _usage?.rows ?? const <Map<String, Object?>>[]) {
      if (row['engine'] == engine) return row;
    }
    return null;
  }

  Future<void> _open() async {
    if (_loading) return;
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
      _usage ??= ModelsMenuController(remote: widget.notifier.readRemoteUsage);
      // ⚠️ The usage read is NOT awaited. It is decoration — a percentage beside the subscription
      // row — while the grid list is the menu's actual content, and a menu that waits on a credential
      // read to draw a list it already has is a menu that feels broken whenever that source is slow.
      // This open uses whatever is cached; the refresh lands for the next one. `refresh()` is itself
      // capped at once a minute, so opening the menu repeatedly costs nothing.
      unawaited(_usage!.refresh().catchError((_) {}));
      answer = await widget.notifier.gridModels(widget.machineId);
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
    if (!mounted) return;
    _shown = answer;

    final box = context.findRenderObject() as RenderBox?;
    final overlay =
        Overlay.of(context).context.findRenderObject() as RenderBox?;
    if (box == null || overlay == null) return;
    final origin = box.localToGlobal(Offset.zero, ancestor: overlay);
    final position = RelativeRect.fromLTRB(
      origin.dx,
      origin.dy + box.size.height + 6,
      overlay.size.width - origin.dx - box.size.width,
      0,
    );

    final subscription = _subscriptionRow();
    final chosen = await _showMenu(
      position: position,
      body: (close) => _ModelPickerPanel(
        answer: _shown!,
        engineLabel: widget.engineLabel,
        currentModel: _effectiveModel,
        subscription: subscription,
        sections: _sectionsToDraw(_shown!),
        subtitleFor: _subtitleFor,
        emptySentence: (section) => _emptySentence(_shown!, section),
        close: close,
      ),
    );
    if (chosen == null) return;
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
    if (chosen.model!.id != _effectiveModel) {
      _expect(chosen.model!.id);
      widget.onSelected?.call(chosen.model!);
    }
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
  List<GridSection> _sectionsToDraw(GridModels answer) {
    final sections = answer.sections
        .where((s) => s.own || s.models.isNotEmpty)
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
    if (_sameAnswer(fresh, shown)) return;
    _shown = fresh;
    // One safe path for every redraw — see [_redrawOpenMenu]. This one arrives off an async read
    // and so is usually clear of the build phase, but "usually" is what the crash was.
    _redrawOpenMenu();
  }

  static bool _sameAnswer(GridModels a, GridModels b) {
    if (a.reachable != b.reachable ||
        a.gridName != b.gridName ||
        a.gridCli != b.gridCli) {
      return false;
    }
    if (a.models.length != b.models.length) return false;
    for (var i = 0; i < a.models.length; i += 1) {
      if (a.models[i].id != b.models[i].id ||
          a.models[i].node != b.models[i].node) {
        return false;
      }
    }
    if (a.grids.length != b.grids.length) return false;
    for (var i = 0; i < a.grids.length; i += 1) {
      final left = a.grids[i];
      final right = b.grids[i];
      if (left.name != right.name ||
          left.own != right.own ||
          left.models.length != right.models.length) {
        return false;
      }
      for (var j = 0; j < left.models.length; j += 1) {
        if (left.models[j].id != right.models[j].id ||
            left.models[j].node != right.models[j].node ||
            left.models[j].grid != right.models[j].grid) {
          return false;
        }
      }
    }
    return true;
  }

  @override
  Widget build(BuildContext context) {
    TerminalFontScope.watch(context);
    final sentence = _webSearchSentence;
    final current =
        widget.currentModel ??
        switch (widget.engineLabel?.toLowerCase()) {
          'codex' => 'OpenAI',
          'claude' => 'Anthropic',
          'opencode' => 'OpenCode',
          _ => 'Model',
        };
    final label = _expecting ? 'Switching…' : current;
    return Tooltip(
      // The same sentence the menu shows, one line under the control's own — so a person can learn
      // the agent has no web search without opening the menu at all.
      message: sentence == null
          ? 'Model: $current · Click to switch'
          : 'Model: $current · Click to switch\n$sentence',
      waitDuration: const Duration(milliseconds: 700),
      child: MouseRegion(
        // Stated rather than inherited. The pane header sits over a terminal, and the cursor a
        // person sees while hovering this was whatever the surface underneath asked for — so a
        // control that opens a menu did not look like one until you clicked it.
        cursor: SystemMouseCursors.click,
        // Its own ink surface: an InkWell needs a Material above it, and a pane header is not
        // always inside one — every test that drew a header threw "No Material widget found".
        child: Material(
          type: MaterialType.transparency,
          child: InkWell(
            onTap: _open,
            // Stated on the InkWell as well as on the MouseRegion above it. The cursor a person sees is
            // the INNERMOST annotation under the pointer, and InkWell installs one of its own — so an
            // ancestor asking for a hand is not, by itself, the thing that decides.
            mouseCursor: SystemMouseCursors.click,
            borderRadius: BorderRadius.circular(4),
            child: Padding(
              padding: EdgeInsets.symmetric(
                horizontal: widget.compact ? 3 : 6,
                vertical: 3,
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  ConstrainedBox(
                    constraints: BoxConstraints(
                      maxWidth: widget.compact ? 44 : 140,
                    ),
                    child: Text(
                      label,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: AppType.monoLabel(
                        fontWeight: FontWeight.w400,
                        color: AppColors.textSoft,
                      ),
                    ),
                  ),
                  // Replace the arrow while loading so a read cannot squeeze
                  // the session name or move the pane's other controls.
                  if (_loading)
                    const SizedBox(
                      width: 14,
                      height: 14,
                      child: CircularProgressIndicator(strokeWidth: 1.5),
                    )
                  else
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
    required this.close,
  });

  final GridModels answer;
  final String? engineLabel;
  final String? currentModel;
  final Map<String, Object?>? subscription;
  final List<GridSection> sections;
  final String? Function(GridModel) subtitleFor;
  final String? Function(GridSection) emptySentence;
  final void Function(_Choice?) close;

  @override
  State<_ModelPickerPanel> createState() => _ModelPickerPanelState();
}

class _ModelPickerPanelState extends State<_ModelPickerPanel> {
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
      if (models.isEmpty) {
        final sentence = widget.emptySentence(section);
        if (sentence != null) rows.add(_panelSentence(sentence));
        continue;
      }
      for (final model in models) {
        rows.add(
          Padding(
            padding: const EdgeInsets.only(bottom: 2),
            child: Tooltip(
              message: [
                'Where this agent runs',
                ?widget.subtitleFor(model),
              ].join('\n'),
              child: ModelPickerRow(
                title: model.id,
                subtitle: model.node,
                // The web-search sentence for the CURRENT model only — a fact
                // about this agent's launch, not about the model. Dropped when
                // the panel replaced the old row list, which lost it silently;
                // the tests that caught it are the reason it is back.
                hint: widget.subtitleFor(model),
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

class _Choice {
  final GridModel? model;
  final bool runLocalModel;
  const _Choice.model(GridModel this.model) : runLocalModel = false;
  const _Choice.ownLogin() : model = null, runLocalModel = false;
  const _Choice.runLocalModel() : model = null, runLocalModel = true;
}
