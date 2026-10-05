import 'package:harness/shared/theme/app_icons.dart';

import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../daemons/daemon_brain.dart';
import '../daemons/daemon_face.dart';
import '../daemons/daemon_lessons.dart';
import '../daemons/illustrated_art.dart';
import '../daemons/individuals.dart';
import '../daemons/roster.dart' show DaemonMood;
import '../daemons/zoo.dart';
import '../daemons/zoo_controller.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../state/dial_status.dart';
import '../theme/app_theme.dart';
import '../widgets/daemon_illustration.dart';
import 'companion_dial.dart';
import 'companion_story.dart';
import 'memory_review_text.dart';
import 'coding_memory_connection.dart';
import 'coding_memory_library.dart';
import 'coding_memory_view.dart';

/// The illustrated left viewer of the companion DSH. The shared workspace
/// canvas owns its real agent terminal on the right.
/// The illustrated editorial surface is intentionally distinct from terminal
/// chrome (the owner's requested storybook treatment).
class CompanionHome extends StatefulWidget {
  const CompanionHome({
    super.key,
    required this.face,
    required this.brain,
    required this.onHatch,
    required this.onOpenControls,
    this.onOpenConversation,
    this.openingConversation = false,
    this.terminalStatus,
    this.dial,
    this.onDeviceSettings,
    this.openMemoryConnection,
  });
  final DaemonFace face;
  final DaemonBrain brain;
  final ValueChanged<ZooEgg> onHatch;
  final ValueChanged<String> onOpenControls;
  final VoidCallback? onOpenConversation;
  final bool openingConversation;
  final String? terminalStatus;
  final DialState? dial;
  final void Function(String, Map<String, Object?>)? onDeviceSettings;
  final CodingMemoryConnection? Function()? openMemoryConnection;

  @override
  State<CompanionHome> createState() => _CompanionHomeState();
}

class _CompanionHomeState extends State<CompanionHome> {
  String _section = 'Story';
  String? _viewingUid, _previewSpecies, _forgetting;
  String _previewVersion = '2.0';
  bool _renaming = false, _exploring = false;
  String? _renameError;
  final _name = TextEditingController();
  final _scroll = ScrollController();
  final _memoryViewport = GlobalKey();
  late final _lessons = DaemonLessons(widget.brain)..addListener(_changed);
  Timer? _memoryRefresh;
  CodingMemoryLibrary? _codingMemory;
  String? _lastPairEngine;
  ZooController get zoo => widget.face.zoo;
  ZooDaemon? get individual =>
      _previewSpecies != null ? null : zoo.zoo.byUid(_viewingUid) ?? zoo.paired;
  String get species => _previewSpecies ?? individual?.id ?? 'tim';
  CompanionStory get story => CompanionStory.of(species);
  String get name => individual == null
      ? IllustratedArt.name(species)
      : companionName(individual!);

  @override
  void initState() {
    super.initState();
    zoo.addListener(_changed);
    widget.face.addListener(_changed);
    widget.brain.addListener(_changed);
    _lastPairEngine = widget.brain.pairEngine;
  }

  void _changed() {
    if (!mounted) return;
    final engineChanged = _lastPairEngine != widget.brain.pairEngine;
    _lastPairEngine = widget.brain.pairEngine;
    setState(() {});
    if (engineChanged && _section == 'Memories' && !_lessons.busy) {
      unawaited(_lessons.refresh());
    }
  }

  TextStyle ink([double size = 14, Color? color]) => TextStyle(
    fontFamily: grid.AppType.sansFamily,
    fontFamilyFallback: grid.AppType.sansFallback,
    fontSize: size,
    height: 1.5,
    color: color ?? AppColors.text,
  );
  TextStyle display(double size) => ink(size).copyWith(
    fontFamily: 'Georgia',
    fontFamilyFallback: const ['Times New Roman', 'serif'],
    height: 1.13,
    letterSpacing: -.7,
  );
  Color get accentInk => Color.lerp(
    story.accent,
    AppColors.text,
    grid.AppTheme.isDark ? .1 : .58,
  )!;

  void _selectSection(String value) {
    setState(() => _section = value);
    _memoryRefresh?.cancel();
    _memoryRefresh = value == 'Memories'
        ? Timer.periodic(const Duration(seconds: 30), (_) {
            if (_codingMemory?.valid == true) {
              unawaited(_codingMemory!.refresh());
            }
            if (widget.brain.active && !_lessons.busy) {
              unawaited(_lessons.refresh());
            }
          })
        : null;
    if (value == 'Memories') {
      if (_codingMemory == null || !_codingMemory!.valid) {
        _codingMemory?.removeListener(_changed);
        _codingMemory?.dispose();
        final connection = widget.openMemoryConnection?.call();
        _codingMemory = connection == null
            ? null
            : (CodingMemoryLibrary(connection)..addListener(_changed));
      }
      if (_codingMemory != null) unawaited(_codingMemory!.refresh());
    }
    if (_scroll.hasClients) _scroll.jumpTo(0);
    if (value == 'Memories' && widget.brain.active && !_lessons.busy) {
      unawaited(_lessons.refresh());
    }
  }

  void _view({ZooDaemon? daemon, String? preview}) {
    setState(() {
      _viewingUid = daemon?.uid;
      _previewSpecies = preview;
      _previewVersion = '2.0';
      _renaming = false;
      _section = 'Story';
    });
    if (_scroll.hasClients) _scroll.jumpTo(0);
  }

  Widget _button(
    String label,
    VoidCallback? action, {
    IconData? icon,
    bool primary = false,
    Key? key,
  }) => TextButton(
    key: key,
    onPressed: action,
    style: TextButton.styleFrom(
      foregroundColor: AppColors.text,
      backgroundColor: primary ? story.accent.withValues(alpha: .16) : null,
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 13),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      side: primary
          ? BorderSide(color: story.accent.withValues(alpha: .35))
          : null,
    ),
    child: Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (icon != null) ...[Icon(icon, size: 16), const SizedBox(width: 8)],
        Flexible(
          child: Text(
            label,
            style: ink(
              13,
              action == null ? AppColors.muted : AppColors.text,
            ).copyWith(fontWeight: FontWeight.w500),
          ),
        ),
      ],
    ),
  );

  Widget _eyebrow(String text) => Text(
    text.toUpperCase(),
    style: ink(
      10.5,
      accentInk,
    ).copyWith(letterSpacing: 1.8, fontWeight: FontWeight.w600),
  );

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return Material(
      key: const ValueKey('companion-home'),
      color: AppColors.background,
      child: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(28, 20, 18, 14),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    'Companions',
                    style: ink(17).copyWith(fontWeight: FontWeight.w600),
                  ),
                ),
                IconButton(
                  tooltip: 'Companion settings',
                  key: const ValueKey('companion-settings'),
                  onPressed: () => widget.onOpenControls('settings'),
                  icon: Icon(
                    AppIcons.slidersHorizontal,
                    size: 20,
                    color: AppColors.textSoft,
                  ),
                ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 0, 20, 10),
            child: Row(
              children: [
                Expanded(
                  child: Wrap(
                    spacing: 4,
                    runSpacing: 4,
                    children: [
                      for (final section in ['Story', 'Collection', 'Memories'])
                        Semantics(
                          selected: _section == section,
                          child: _button(
                            section,
                            () => _selectSection(section),
                            primary: _section == section,
                            key: ValueKey('companion-nav-$section'),
                          ),
                        ),
                    ],
                  ),
                ),
              ],
            ),
          ),
          if (widget.terminalStatus != null)
            Padding(
              padding: const EdgeInsets.fromLTRB(28, 0, 28, 10),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      widget.terminalStatus!,
                      style: ink(13, AppColors.textSoft),
                    ),
                  ),
                  if (widget.onOpenConversation != null)
                    _button('Open terminal', widget.onOpenConversation),
                ],
              ),
            ),
          Expanded(
            child: SingleChildScrollView(
              key: _memoryViewport,
              controller: _scroll,
              padding: const EdgeInsets.fromLTRB(28, 6, 28, 40),
              child: Align(
                alignment: Alignment.topCenter,
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 1100),
                  child: switch (_section) {
                    'Collection' => _collection(),
                    'Memories' => _memories(),
                    _ =>
                      zoo.zoo.daemons.isEmpty && _previewSpecies == null
                          ? _nest()
                          : _story(),
                  },
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _story() {
    final daemon = individual;
    final isPaired = daemon?.uid == zoo.zoo.pair;
    final def = zoo.roster.byId(species)!;
    final traits = zoo.traitsOf(daemon);
    final version = daemon?.version ?? _previewVersion;
    final intro = Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _eyebrow(
          daemon == null
              ? 'A world to discover'
              : switch (version) {
                  '2.0' => 'Chapter three · Side by side',
                  '1.0' => 'Chapter two · Finding our feet',
                  _ => 'Chapter one · A little beginning',
                },
        ),
        const SizedBox(height: 22),
        Text(
          'Meet $name.',
          key: const ValueKey('companion-story-title'),
          style: display(44),
        ),
        const SizedBox(height: 14),
        Text(story.title, style: ink(18, accentInk)),
        const SizedBox(height: 16),
        Text(story.intro, style: ink(15, AppColors.textSoft)),
        const SizedBox(height: 24),
        Wrap(
          spacing: 5,
          runSpacing: 8,
          children: [
            if (daemon != null)
              _button(
                isPaired ? 'By your side' : 'Make my companion',
                isPaired ? null : () => zoo.pair(daemon.uid),
                icon: AppIcons.heart,
                primary: true,
                key: const ValueKey('companion-pair'),
              ),
            if (daemon != null)
              _button(
                'Give a name',
                () => setState(() {
                  _name.text = daemon.name ?? '';
                  _renameError = null;
                  _renaming = true;
                }),
                icon: AppIcons.pencil,
              ),
            if (daemon == null)
              _button(
                'Collection preview',
                null,
                icon: AppIcons.sparkles,
                primary: true,
              ),
          ],
        ),
      ],
    );
    final scene = CompanionScene(
      story: story,
      art: IllustratedArt.daemon(
        species,
        version: version,
        mood: isPaired ? widget.face.mood : DaemonMood.idle,
        traits: traits,
      ),
      animate: widget.face.motionEnabled,
      name: name,
      onPet: isPaired ? widget.face.boop : null,
    );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        LayoutBuilder(
          builder: (context, c) {
            final horizontal =
                c.maxWidth > 680 &&
                MediaQuery.textScalerOf(context).scale(14) < 19;
            return Container(
              padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 24),
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(24),
                gradient: LinearGradient(
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                  colors: [
                    story.accent.withValues(
                      alpha: grid.AppTheme.isDark ? .09 : .12,
                    ),
                    story.accent.withValues(alpha: .015),
                  ],
                ),
                border: Border.all(color: story.accent.withValues(alpha: .12)),
              ),
              child: horizontal
                  ? Row(
                      children: [
                        Expanded(flex: 5, child: intro),
                        Expanded(flex: 5, child: scene),
                      ],
                    )
                  : Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [scene, intro],
                    ),
            );
          },
        ),
        if (_renaming) _rename(daemon!),
        if (daemon != null &&
            widget.dial != null &&
            widget.onDeviceSettings != null)
          CompanionDial(
            dial: widget.dial!,
            zoo: zoo,
            daemon: daemon,
            setDeviceSettings: widget.onDeviceSettings!,
          ),
        if (daemon == null) ...[
          const SizedBox(height: 18),
          Wrap(
            spacing: 6,
            runSpacing: 6,
            children: [
              for (final (v, label) in [
                ('0.1', 'Little'),
                ('1.0', 'Young'),
                ('2.0', 'Grown'),
              ])
                _button(
                  label,
                  () => setState(() => _previewVersion = v),
                  primary: v == _previewVersion,
                ),
            ],
          ),
          Text(
            'A look into their world. Previewing does not unlock or pair this companion.',
            style: ink(12, AppColors.textSoft),
          ),
        ],
        const SizedBox(height: 34),
        _eyebrow(story.world),
        const SizedBox(height: 12),
        Text('A small creature.\nA story all their own.', style: display(28)),
        const SizedBox(height: 18),
        Text(story.story, style: ink(16, AppColors.textSoft)),
        const SizedBox(height: 20),
        Text(
          story.promise,
          style: ink(15, accentInk).copyWith(fontStyle: FontStyle.italic),
        ),
        if (daemon != null) ...[
          const SizedBox(height: 34),
          _growth(daemon),
          const SizedBox(height: 28),
          _eyebrow('One of a kind'),
          const SizedBox(height: 10),
          Text('The little things that make $name, $name.', style: ink(18)),
          const SizedBox(height: 14),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              for (final trait in _traits(traits)) _tag(trait),
              if (daemon.shiny) _tag('A rare shimmer'),
            ],
          ),
        ],
        const SizedBox(height: 28),
        Theme(
          data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
          child: ExpansionTile(
            tilePadding: EdgeInsets.zero,
            title: Text('A little real-world history', style: ink(14)),
            childrenPadding: const EdgeInsets.only(bottom: 16),
            children: [Text(def.lore, style: ink(14, AppColors.textSoft))],
          ),
        ),
        _button(
          'Meet the collection',
          () => _selectSection('Collection'),
          icon: AppIcons.arrowRight,
        ),
      ],
    );
  }

  List<String> _traits(DaemonTraits? traits) {
    if (traits == null) return ['A character all their own'];
    String title(String value) => value.isEmpty
        ? value
        : '${value[0].toUpperCase()}${value.substring(1).replaceAll('-', ' ')}';
    return [
      title(traits.colour),
      if (traits.marks != null) title(traits.marks!),
      if (traits.extra != null) title(traits.extra!),
      if (traits.oddEye) 'Mismatched eyes',
      traits.fidgety ? 'A curious little fidget' : 'A calm presence',
      ...individualFlags(zoo.roster, species, traits)
          .split(' ')
          .where(
            (v) =>
                v.startsWith('--') &&
                ![
                  traits.marks,
                  traits.extra,
                  'odd-eye',
                  'fidgety',
                ].contains(v.substring(2)),
          )
          .map((v) => title(v.substring(2))),
    ];
  }

  Widget _tag(String label) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
    decoration: BoxDecoration(
      color: story.accent.withValues(alpha: .08),
      borderRadius: BorderRadius.circular(8),
    ),
    child: Text(label, style: ink(12, AppColors.textSoft)),
  );

  Widget _rename(ZooDaemon daemon) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 16),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        TextField(
          key: const ValueKey('companion-rename-input'),
          controller: _name,
          autofocus: true,
          maxLength: 24,
          style: ink(),
          onSubmitted: (_) => _saveName(daemon),
          decoration: InputDecoration(
            labelText: 'A name just for them',
            hintText: IllustratedArt.name(daemon.id),
            errorText: _renameError,
          ),
        ),
        Wrap(
          spacing: 8,
          children: [
            _button('Save name', () => _saveName(daemon), primary: true),
            _button('Cancel', () => setState(() => _renaming = false)),
          ],
        ),
      ],
    ),
  );

  void _saveName(ZooDaemon daemon) {
    final ok = zoo.nickname(daemon.uid, _name.text.trim());
    setState(() {
      _renaming = !ok;
      _renameError = ok
          ? null
          : 'Use up to 24 letters, numbers, spaces, or simple punctuation.';
    });
  }

  Widget _growth(ZooDaemon daemon) {
    final next = nextCompanionGrowth(zoo.roster, daemon);
    final fraction = next == null
        ? 1.0
        : ((daemon.xp - next.start) / (next.target - next.start)).clamp(
            0.0,
            1.0,
          );
    final index = const ['0.1', '1.0', '2.0'].indexOf(daemon.version);
    return Container(
      key: const ValueKey('companion-growth'),
      padding: const EdgeInsets.all(22),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: AppColors.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _eyebrow('Growing together'),
          const SizedBox(height: 10),
          Text(
            next == null
                ? 'Look how far you’ve come.'
                : 'Good things grow with time.',
            style: display(25),
          ),
          const SizedBox(height: 12),
          Text(
            next == null
                ? 'A grown companion, with plenty of adventures still ahead.'
                : '${math.max(0, next.target - daemon.xp)} more XP until ${next.name.toLowerCase()}. '
                      'Finish turns and spend active days together to grow your bond.',
            style: ink(14, AppColors.textSoft),
          ),
          const SizedBox(height: 18),
          ClipRRect(
            borderRadius: BorderRadius.circular(3),
            child: LinearProgressIndicator(
              value: fraction,
              minHeight: 5,
              color: accentInk,
              backgroundColor: story.accent.withValues(alpha: .12),
              semanticsLabel:
                  'Growth toward ${next?.name ?? 'grown companion'}',
              semanticsValue: '${(fraction * 100).round()}%',
            ),
          ),
          const SizedBox(height: 8),
          Text(
            next == null
                ? '${daemon.xp} XP together'
                : '${daemon.xp} / ${next.target} XP',
            style: ink(12, AppColors.textSoft),
          ),
          const SizedBox(height: 10),
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              for (final (i, version) in const ['0.1', '1.0', '2.0'].indexed)
                Expanded(
                  child: Opacity(
                    opacity: i <= index ? 1 : .42,
                    child: Column(
                      children: [
                        DaemonIllustration(
                          art: IllustratedArt.daemon(
                            daemon.id,
                            version: version,
                            traits: zoo.traitsOf(daemon),
                          ),
                          size: 72,
                        ),
                        Text(
                          const ['Little', 'Young', 'Grown'][i],
                          style: ink(12),
                          textAlign: TextAlign.center,
                        ),
                        if (i == index)
                          Text(
                            'You are here',
                            style: ink(10, accentInk),
                            textAlign: TextAlign.center,
                          ),
                      ],
                    ),
                  ),
                ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _collection() => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      const SizedBox(height: 18),
      _eyebrow('Every friend has a story'),
      const SizedBox(height: 12),
      Text('A world of little wonders.', style: display(34)),
      const SizedBox(height: 14),
      Text(
        'Get to know the friends you’ve found. There is always another story waiting to begin.',
        style: ink(15, AppColors.textSoft),
      ),
      const SizedBox(height: 24),
      if (zoo.zoo.daemons.isNotEmpty)
        _cards([
          for (final d in zoo.zoo.daemons)
            _collectionCard(
              d.id,
              companionName(d),
              d.version,
              zoo.traitsOf(d),
              d.uid == zoo.zoo.pair ? 'By your side' : companionAge(d.version),
              () => _view(daemon: d),
            ),
        ]),
      if (zoo.zoo.eggs.isNotEmpty) ...[
        const SizedBox(height: 28),
        _eyebrow('New beginnings'),
        const SizedBox(height: 12),
        for (final egg in zoo.zoo.eggs)
          Padding(
            padding: const EdgeInsets.only(bottom: 10),
            child: Row(
              children: [
                DaemonIllustration(
                  art: IllustratedArt.egg(kind: egg.kind, stage: 'p4'),
                  size: 66,
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Text('Someone is ready to meet you.', style: ink()),
                ),
                _button('Hatch', () => widget.onHatch(egg), primary: true),
              ],
            ),
          ),
      ],
      const SizedBox(height: 26),
      _button(
        _exploring ? 'Hide the gallery' : 'Meet all ten companions',
        () => setState(() => _exploring = !_exploring),
        icon: AppIcons.sparkles,
      ),
      if (_exploring) ...[
        const SizedBox(height: 10),
        Text(
          'A gallery of possibilities. Exploring never changes your collection.',
          style: ink(13, AppColors.textSoft),
        ),
        const SizedBox(height: 18),
        _cards([
          for (final id in IllustratedArt.species)
            _collectionCard(
              id,
              IllustratedArt.name(id),
              '2.0',
              null,
              'Meet ${IllustratedArt.name(id)}',
              () => _view(preview: id),
            ),
        ]),
      ],
    ],
  );

  Widget _cards(List<Widget> cards) => LayoutBuilder(
    builder: (context, c) {
      final scaled = MediaQuery.textScalerOf(context).scale(14) / 14;
      final count = (c.maxWidth / (190 * math.min(scaled, 1.5))).floor().clamp(
        1,
        4,
      );
      final width = (c.maxWidth - (count - 1) * 14) / count;
      return Wrap(
        spacing: 14,
        runSpacing: 14,
        children: [
          for (final card in cards) SizedBox(width: width, child: card),
        ],
      );
    },
  );

  Widget _collectionCard(
    String id,
    String label,
    String version,
    DaemonTraits? traits,
    String detail,
    VoidCallback onTap,
  ) {
    final tint = CompanionStory.of(id).accent;
    return Material(
      color: tint.withValues(alpha: .06),
      borderRadius: BorderRadius.circular(18),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(18),
        child: Padding(
          padding: const EdgeInsets.all(18),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Center(
                child: DaemonIllustration(
                  art: IllustratedArt.daemon(
                    id,
                    version: version,
                    traits: traits,
                  ),
                  size: 118,
                ),
              ),
              const SizedBox(height: 12),
              Text(label, style: ink(18).copyWith(fontWeight: FontWeight.w500)),
              const SizedBox(height: 5),
              Text(detail, style: ink(12, AppColors.textSoft)),
            ],
          ),
        ),
      ),
    );
  }

  Widget _memories() {
    final d = zoo.paired;
    final date = d == null ? null : DateTime.tryParse(d.hatched)?.toLocal();
    final learned = _lessons.lessons.where((l) => l.approvedNow).toList();
    final pending = _lessons.lessons.where((l) => l.pending).toList();
    final history = _lessons.learning?.history;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const SizedBox(height: 18),
        _eyebrow('Your story together'),
        const SizedBox(height: 12),
        Text('The things that stay.', style: display(34)),
        const SizedBox(height: 14),
        Text(
          'Small beginnings, a growing bond, and useful things learned along the way.',
          style: ink(15, AppColors.textSoft),
        ),
        const SizedBox(height: 28),
        if (_codingMemory != null)
          CodingMemoryView(
            library: _codingMemory!,
            onOpenCompanion: widget.onOpenConversation,
            openingCompanion: widget.openingConversation,
          ),
        if (widget.brain.active && _codingMemory?.available != true) ...[
          _memoryCard(
            AppIcons.history,
            history?.title ?? 'A little time to look back',
            history?.detail ?? 'Your recent conversations can hold the beginnings of a useful memory. Review the last 24 hours on this computer with your companion’s chosen model.',
          ),
          if (history?.more == true || (history?.indexing ?? 0) > 0)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(
                'This review covers the recent conversations currently indexed on this computer. Some turns remain outside this snapshot.',
                style: ink(12, AppColors.textSoft),
              ),
            ),
          Wrap(
            spacing: 8,
            children: [
              _button(
                history?.canRetry == true
                    ? 'Retry review'
                    : 'Look back over 24 hours',
                _lessons.busy ||
                        _lessons.learning?.state == 'unopened' ||
                        (history?.active == true && history?.canRetry != true)
                    ? null
                    : () => unawaited(_lessons.reviewRecent()),
                key: const ValueKey('memory-review-recent'),
                primary: true,
                icon: AppIcons.history,
              ),
              if (history?.active == true)
                _button(
                  'Stop review',
                  _lessons.busy
                      ? null
                      : () => unawaited(_lessons.cancelReview()),
                ),
            ],
          ),
          const SizedBox(height: 20),
        ],
        _eyebrow('Shared lessons'),
        const SizedBox(height: 10),
        Text('What we’ve learned.', style: display(26)),
        const SizedBox(height: 12),
        Text(
          'These are real, approved lessons shared with your harnesses. '
          'You can read them here or forget one for all your agents.',
          style: ink(14, AppColors.textSoft),
        ),
        const SizedBox(height: 18),
        if (!widget.brain.active)
          Text(
            'Connect to the companion on this computer to see its lessons.',
            style: ink(14, AppColors.textSoft),
          )
        else if (!_lessons.loaded)
          Text(
            _lessons.busy
                ? 'Opening the memory book…'
                : 'Your memory book is ready to open.',
            style: ink(14, AppColors.textSoft),
          )
        else if (learned.isEmpty && _lessons.learning == null)
          _memoryCard(
            AppIcons.bookOpen,
            'Room for a first memory',
            'When a useful lesson is proposed and you approve it, it will appear here. No memories are invented.',
          ),
        if (widget.brain.active && _lessons.learning != null) ...[
          _memoryCard(
            AppIcons.bookOpen,
            _lessons.learning!.title,
            _lessons.learning!.detail,
          ),
          const SizedBox(height: 18),
        ],
        if (pending.isNotEmpty) ...[
          _eyebrow('Yours to decide'),
          const SizedBox(height: 10),
          Text(
            '${pending.length} ${pending.length == 1 ? 'possible memory' : 'possible memories'}',
            style: display(26),
          ),
          const SizedBox(height: 8),
          Text(
            'Read what your companion noticed. Only the lessons you approve are shared with your harnesses.',
            style: ink(14, AppColors.textSoft),
          ),
          const SizedBox(height: 16),
          for (final lesson in pending) ...[
            _pendingMemory(lesson),
            const SizedBox(height: 14),
          ],
          const SizedBox(height: 18),
        ],
        for (final lesson in learned) ...[
          Container(
            padding: const EdgeInsets.all(20),
            decoration: BoxDecoration(
              color: AppColors.surface,
              borderRadius: BorderRadius.circular(16),
              border: Border.all(color: AppColors.border),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  lesson.name.replaceAll('-', ' '),
                  style: ink(17).copyWith(fontWeight: FontWeight.w500),
                ),
                if (lesson.description.isNotEmpty) ...[
                  const SizedBox(height: 8),
                  Text(lesson.description, style: ink(14, AppColors.textSoft)),
                ],
                if (_lessons.shownId == lesson.id) ...[
                  const SizedBox(height: 16),
                  SelectableText(_lessons.shownText ?? '', style: ink(14)),
                ],
                const SizedBox(height: 10),
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    _button(
                      _lessons.shownId == lesson.id
                          ? 'Close memory'
                          : 'Read memory',
                      _lessons.busy
                          ? null
                          : () => unawaited(_lessons.show(lesson.id)),
                    ),
                    _button(
                      'Forget…',
                      _lessons.busy
                          ? null
                          : () => setState(() => _forgetting = lesson.id),
                    ),
                  ],
                ),
                if (_forgetting == lesson.id) ...[
                  Text(
                    'Forget this shared lesson for every agent? Its revision remains in your lesson history.',
                    style: ink(13, AppColors.textSoft),
                  ),
                  Wrap(
                    spacing: 8,
                    children: [
                      _button(
                        'Forget shared lesson',
                        _lessons.busy
                            ? null
                            : () {
                                setState(() => _forgetting = null);
                                unawaited(_lessons.revert(lesson.id));
                              },
                        primary: true,
                      ),
                      _button(
                        'Keep it',
                        () => setState(() => _forgetting = null),
                      ),
                    ],
                  ),
                ],
              ],
            ),
          ),
          const SizedBox(height: 12),
        ],
        if (d != null) ...[
          _memoryCard(
            AppIcons.sun,
            'The day you met',
            date == null
                ? '${companionName(d)} joined your collection.'
                : '${companionName(d)} hatched on ${_date(date)}. A little beginning, all your own.',
          ),
          const SizedBox(height: 12),
          _memoryCard(
            AppIcons.heart,
            'A bond that keeps growing',
            '${d.xp} XP together · ${companionAge(d.version)}',
          ),
          const SizedBox(height: 30),
        ],
        if (_lessons.message != null)
          Text(_lessons.message!, style: ink(13, AppColors.textSoft)),
        if (widget.brain.active)
          _button(
            'Refresh memories',
            _lessons.busy ? null : () => unawaited(_lessons.refresh()),
            icon: AppIcons.refreshCw,
          ),
      ],
    );
  }

  Widget _pendingMemory(DaemonLesson lesson) {
    final open = _lessons.shownId == lesson.id;
    final reviewId = open ? _lessons.reviewId : null;
    return Container(
      key: ValueKey('memory-candidate-${lesson.id}'),
      width: double.infinity,
      padding: const EdgeInsets.all(22),
      decoration: BoxDecoration(
        color: story.accent.withValues(alpha: .06),
        border: Border.all(color: story.accent.withValues(alpha: .22)),
        borderRadius: BorderRadius.circular(18),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            lesson.kind == 'note'
                ? lesson.description
                : lesson.name.replaceAll('-', ' '),
            style: ink(18).copyWith(fontWeight: FontWeight.w600),
          ),
          if (lesson.kind != 'note' && lesson.description.isNotEmpty) ...[
            const SizedBox(height: 8),
            Text(lesson.description, style: ink(14, AppColors.textSoft)),
          ],
          const SizedBox(height: 16),
          _eyebrow('Why this might stay'),
          const SizedBox(height: 6),
          Text(
            lesson.reason.isNotEmpty
                ? lesson.reason
                : switch (lesson.signal) {
                    'correction' =>
                      'A correction you made could help your agents next time.',
                    'repeat-failure' =>
                      'The same failure appeared more than once.',
                    'repeat-steps' =>
                      'A repeated workflow may be worth keeping.',
                    'conversation' => 'Your companion noticed this while reviewing recent conversations.',
                    _ => 'Your companion found something that may help in future work.',
                  },
            style: ink(14),
          ),
          if (lesson.sources.isNotEmpty || lesson.from.isNotEmpty) ...[
            const SizedBox(height: 14),
            for (final source in lesson.sources)
              Padding(
                padding: const EdgeInsets.only(bottom: 4),
                child: Text(
                  '${source.title.isEmpty ? source.engine : source.title} · ${source.engine} · turn ${source.turn + 1}'
                  '${source.at == null ? '' : ' · ${_date(source.at!)} ${source.at!.hour.toString().padLeft(2, '0')}:${source.at!.minute.toString().padLeft(2, '0')}'}',
                  style: ink(12, AppColors.textSoft),
                ),
              ),
            if (lesson.sources.isEmpty)
              Text(lesson.from.join('\n'), style: ink(12, AppColors.textSoft)),
          ],
          if (open && _lessons.shownText != null) ...[
            const SizedBox(height: 18),
            _eyebrow('The lesson to share'),
            const SizedBox(height: 10),
            MemoryReviewText(
              key: ValueKey(reviewId ?? 'read-${lesson.id}'),
              text: _lessons.shownText!,
              style: ink(13),
              viewport: _memoryViewport,
              scroll: _scroll,
              onRead: () {
                if (_section == 'Memories' &&
                    reviewId != null &&
                    _lessons.reviewId == reviewId) {
                  widget.brain.shown(reviewId);
                }
              },
            ),
            if (lesson.evidence.isNotEmpty) ...[
              const SizedBox(height: 16),
              _eyebrow('From the conversation'),
              const SizedBox(height: 8),
              for (final evidence in lesson.evidence)
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: SelectableText(
                    evidence,
                    style: ink(13, AppColors.textSoft),
                  ),
                ),
            ],
            const SizedBox(height: 12),
            Text(
              'Approving makes this lesson available to your agents. You can forget it later.',
              style: ink(12, AppColors.textSoft),
            ),
          ],
          const SizedBox(height: 12),
          Wrap(
            spacing: 8,
            runSpacing: 6,
            children: [
              if (open && reviewId != null)
                _button(
                  'Approve memory',
                  _lessons.busy || !widget.brain.armed(reviewId)
                      ? null
                      : _lessons.approveReviewed,
                  key: ValueKey('memory-approve-${lesson.id}'),
                  primary: true,
                  icon: AppIcons.check,
                )
              else
                _button(
                  'Review memory',
                  _lessons.busy
                      ? null
                      : () => unawaited(_lessons.review(lesson.id)),
                  key: ValueKey('memory-open-${lesson.id}'),
                  primary: true,
                ),
              _button(
                'Skip',
                _lessons.busy
                    ? null
                    : () => unawaited(_lessons.skip(lesson.id)),
                key: ValueKey('memory-skip-${lesson.id}'),
              ),
            ],
          ),
        ],
      ),
    );
  }

  String _date(DateTime date) =>
      '${const ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][date.month - 1]} ${date.day}, ${date.year}';

  Widget _memoryCard(IconData icon, String title, String body) => Container(
    padding: const EdgeInsets.all(20),
    decoration: BoxDecoration(
      color: story.accent.withValues(alpha: .06),
      borderRadius: BorderRadius.circular(16),
    ),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(icon, size: 24, color: accentInk),
        const SizedBox(width: 16),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(title, style: ink(16).copyWith(fontWeight: FontWeight.w500)),
              const SizedBox(height: 7),
              Text(body, style: ink(14, AppColors.textSoft)),
            ],
          ),
        ),
      ],
    ),
  );

  Widget _nest() => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      const SizedBox(height: 16),
      _eyebrow('Every story begins somewhere'),
      const SizedBox(height: 14),
      Text('Someone little\nis on their way.', style: display(40)),
      CompanionScene(
        story: story,
        art: IllustratedArt.egg(
          kind: zoo.readyEgg?.kind ?? 'first',
          stage: zoo.readyEgg == null ? 'p0' : 'p4',
        ),
        animate: widget.face.motionEnabled,
        name: 'Your first companion egg',
      ),
      Text(
        'A little company for the things you make. As you find your feet in Harness, '
        'your first companion gets closer to meeting you.',
        style: ink(16, AppColors.textSoft),
      ),
      const SizedBox(height: 20),
      if (zoo.readyEgg case final egg?)
        _button(
          'Meet your companion',
          () => widget.onHatch(egg),
          primary: true,
          icon: AppIcons.sparkles,
        )
      else
        _button(
          'See what helps your egg hatch',
          () => widget.onOpenControls('zoo'),
          primary: true,
        ),
      const SizedBox(height: 10),
      _button('Explore the collection', () => _selectSection('Collection')),
    ],
  );

  @override
  void dispose() {
    _memoryRefresh?.cancel();
    _codingMemory?.removeListener(_changed);
    _codingMemory?.dispose();
    zoo.removeListener(_changed);
    widget.face.removeListener(_changed);
    widget.brain.removeListener(_changed);
    _lessons.removeListener(_changed);
    _lessons.dispose();
    _name.dispose();
    _scroll.dispose();
    super.dispose();
  }
}

/// A quiet, code-drawn world behind the existing authored character artwork.
/// It has no animation clock; the character's own motion respects Reduce Motion.
class CompanionScene extends StatelessWidget {
  const CompanionScene({
    super.key,
    required this.story,
    required this.art,
    required this.name,
    this.animate = false,
    this.onPet,
  });
  final CompanionStory story;
  final IllustratedArt art;
  final String name;
  final bool animate;
  final VoidCallback? onPet;

  @override
  Widget build(BuildContext context) => SizedBox(
    height: 310,
    child: LayoutBuilder(
      builder: (context, c) => Stack(
        alignment: Alignment.center,
        children: [
          Positioned.fill(
            child: ExcludeSemantics(
              child: CustomPaint(
                painter: _WorldPainter(story, grid.AppTheme.isDark),
              ),
            ),
          ),
          Semantics(
            button: onPet != null,
            label: onPet == null ? name : 'Say hello to $name',
            child: Tooltip(
              message: onPet == null ? story.world : 'A little hello',
              child: TextButton(
                onPressed: onPet,
                style: TextButton.styleFrom(
                  padding: EdgeInsets.zero,
                  shape: const CircleBorder(),
                  splashFactory: NoSplash.splashFactory,
                ),
                child: ExcludeSemantics(
                  child: DaemonIllustration(
                    art: art,
                    size: math.min(c.maxWidth, 310),
                    animate: animate,
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    ),
  );
}

class _WorldPainter extends CustomPainter {
  const _WorldPainter(this.story, this.dark);
  final CompanionStory story;
  final bool dark;

  @override
  void paint(Canvas canvas, Size size) {
    final center = Offset(size.width / 2, size.height / 2);
    final r = math.min(size.width * .43, size.height * .44);
    final color = story.accent;
    final glow = Paint()
      ..shader = RadialGradient(
        colors: [
          color.withValues(alpha: dark ? .18 : .22),
          color.withValues(alpha: 0),
        ],
      ).createShader(Rect.fromCircle(center: center, radius: r * 1.3));
    canvas.drawCircle(center, r * 1.3, glow);
    final line = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = .8
      ..color = color.withValues(alpha: dark ? .23 : .35);
    canvas.drawArc(
      Rect.fromCircle(center: center, radius: r),
      -.83 * math.pi,
      1.64 * math.pi,
      false,
      line,
    );
    canvas.drawArc(
      Rect.fromCircle(center: center, radius: r - 8),
      -.67 * math.pi,
      .92 * math.pi,
      false,
      line..color = color.withValues(alpha: .10),
    );
    final random = math.Random(
      story.motif.codeUnits.fold<int>(0, (a, b) => a + b),
    );
    for (var i = 0; i < 26; i++) {
      final a = random.nextDouble() * math.pi * 2;
      final distance = r * (.66 + random.nextDouble() * .43);
      final point = center + Offset(math.cos(a), math.sin(a)) * distance;
      final paint = Paint()
        ..color = color.withValues(alpha: .18 + random.nextDouble() * .38);
      if (i % 6 == 0) {
        canvas.drawLine(
          point - const Offset(3, 0),
          point + const Offset(3, 0),
          paint..strokeWidth = 1,
        );
        canvas.drawLine(
          point - const Offset(0, 3),
          point + const Offset(0, 3),
          paint,
        );
      } else {
        canvas.drawCircle(point, .7 + random.nextDouble(), paint);
      }
    }
    final ground = center.dy + r * .8;
    for (var i = 0; i < 3; i++) {
      canvas.drawOval(
        Rect.fromCenter(
          center: Offset(center.dx, ground + i * 6),
          width: r * (1.05 + i * .25),
          height: 10 + i * 6,
        ),
        Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = .8
          ..color = color.withValues(alpha: .18 - i * .04),
      );
    }
    // Seed-like leaves give each world a living edge without competing with
    // the silhouette. The scene stays decorative and out of the focus order.
    for (final direction in [-1.0, 1.0]) {
      final root = Offset(center.dx + direction * r * .74, ground);
      final stem = Path()
        ..moveTo(root.dx, root.dy)
        ..quadraticBezierTo(
          root.dx - direction * 16,
          root.dy - 28,
          root.dx - direction * 5,
          root.dy - 59,
        );
      canvas.drawPath(
        stem,
        Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = 1
          ..color = color.withValues(alpha: .24),
      );
      for (var i = 0; i < 4; i++) {
        canvas.save();
        canvas.translate(root.dx - direction * 7, root.dy - 12 - i * 11);
        canvas.rotate(direction * (i.isEven ? -.5 : .7));
        canvas.drawOval(
          const Rect.fromLTWH(-2, -10, 6, 14),
          Paint()..color = color.withValues(alpha: .1 + i * .02),
        );
        canvas.restore();
      }
    }
  }

  @override
  bool shouldRepaint(_WorldPainter old) =>
      old.story != story || old.dark != dark;
}
