import 'dart:async';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:desktop_drop/desktop_drop.dart';
import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../core/desktop_window.dart';
import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../widgets/desktop_chrome.dart';
import 'devices_controller.dart';
import 'loose_sheet.dart';
import 'pet_editor.dart';
import 'pet_source.dart';

export 'pet_editor.dart'
    show PetEditor, PetSheet, decodePetSheet, sheetRowCrops;

const _errorText = {
  'memory': 'The dial is out of memory for pets',
  'busy': 'The dial holds too many pets',
  'crc': 'The pet didn’t arrive intact. Reconnect the dial to try again',
  'shape': 'The pet didn’t arrive intact. Reconnect the dial to try again',
  'version': 'Update the dial’s firmware for this pet',
  'timeout': 'The dial stopped answering. Reconnect it to try again',
};

/// The custom pet for the dial: one for every agent (the protocol still holds
/// per-engine pets; the app offers one). The app turns what the user picked
/// (a pet folder or zip, WebP, or any PNG / JPEG sprite sheet) into a PNG
/// sheet; the daemon converts and sends it. This picks the source, lets the
/// user choose which row plays each state and applies it. Local computer only.
///
/// The edit lives in a [PetEditor]: [editor] when the screen shares it with a
/// [PetRowViewer] of its own (then [showViewer] is false), else one this
/// section owns, with the viewer drawn inline.
class PetSettingsSection extends StatefulWidget {
  const PetSettingsSection({
    super.key,
    required this.device,
    required this.controller,
    this.editor,
    this.showViewer = true,
    this.pickFile,
    this.pickFolder,
    this.resolveSource,
    this.loadSheet,
  });
  final HarnessDevice device;
  final DevicesController controller;

  /// The edit, owned by the caller; null makes one here.
  final PetEditor? editor;

  /// Whether the row viewer is drawn in this section, above the row cards.
  final bool showViewer;

  /// Replaces the native file chooser (tests). Returns a path, or null.
  final Future<String?> Function()? pickFile;

  /// Replaces the native folder chooser (tests). Returns a path, or null.
  final Future<String?> Function()? pickFolder;

  /// Replaces [resolvePetSource] in the editor made here (tests).
  final Future<PetSource> Function(String path)? resolveSource;

  /// Replaces [decodePetSheet] in the editor made here (tests).
  final Future<PetSheet?> Function(String path)? loadSheet;

  @override
  State<PetSettingsSection> createState() => _PetSettingsSectionState();
}

class _PetSettingsSectionState extends State<PetSettingsSection> {
  DevicesController get _controller => widget.controller;

  /// The editor this section made, when it was given none.
  PetEditor? _own;
  PetEditor get _editor => widget.editor ?? (_own ??= _make());

  PetEditor _make() => PetEditor(
    controller: widget.controller,
    deviceKey: widget.device.key,
    resolveSource: widget.resolveSource,
    loadSheet: widget.loadSheet,
  )..addListener(_changed);

  @override
  void initState() {
    super.initState();
    _controller.addListener(_changed);
    widget.editor?.addListener(_changed);
    unawaited(_controller.refreshPetStatus(widget.device.key));
  }

  @override
  void didUpdateWidget(PetSettingsSection oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.controller != widget.controller) {
      oldWidget.controller.removeListener(_changed);
      widget.controller.addListener(_changed);
    }
    if (oldWidget.editor != widget.editor) {
      oldWidget.editor?.removeListener(_changed);
      widget.editor?.addListener(_changed);
    }
    final own = _own;
    if (own != null &&
        (widget.editor != null ||
            own.deviceKey != widget.device.key ||
            own.controller != widget.controller)) {
      _own = null;
      own.dispose();
    }
    if (oldWidget.device.key != widget.device.key) {
      unawaited(_controller.refreshPetStatus(widget.device.key));
    }
  }

  @override
  void dispose() {
    _controller.removeListener(_changed);
    widget.editor?.removeListener(_changed);
    _own?.dispose();
    super.dispose();
  }

  void _changed() {
    if (mounted) setState(() {});
  }

  static Future<String?> _choose() async {
    final file = await whileNativePicker(
      () => openFile(
        acceptedTypeGroups: const [
          XTypeGroup(
            label: 'Pet',
            extensions: ['png', 'jpg', 'jpeg', 'webp', 'zip', 'json'],
          ),
        ],
      ),
    );
    return file?.path;
  }

  static Future<String?> _chooseFolder() => whileNativePicker(getDirectoryPath);

  @override
  Widget build(BuildContext context) {
    final device = widget.device;
    if (_controller.petRequest == null || !device.local) {
      return const SizedBox.shrink();
    }
    final editor = _editor;
    final status = _controller.petStatus(device.key);
    final outdated = _controller.petUnavailable(device.key);
    final locked =
        outdated ||
        (status != null && !status.supported && device.status.attached);
    final enabled = !locked && device.hostOnline && device.hostAvailable;
    return Container(
      key: const ValueKey('pet-panel'),
      padding: const EdgeInsets.fromLTRB(18, 16, 18, 18),
      decoration: BoxDecoration(
        color: grid.AppGlass.surfaceFill,
        borderRadius: BorderRadius.circular(14),
        boxShadow: grid.AppGlass.cardShadow,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text('Pet', style: DesktopChrome.heading()),
          const SizedBox(height: 10),
          if (locked) ...[
            Text(
              outdated
                  ? 'Update Harness on this computer to use custom pets'
                  : 'Update the dial’s firmware to use custom pets',
              style: DesktopChrome.text(color: DesktopChrome.muted),
            ),
            const SizedBox(height: 10),
          ],
          _PetRow(
            key: const ValueKey('pet-row-all'),
            deviceKey: device.key,
            controller: _controller,
            editor: editor,
            enabled: enabled,
            attached: device.status.attached,
            pickFile: widget.pickFile ?? _choose,
            pickFolder: widget.pickFolder ?? _chooseFolder,
          ),
          if (editor.editing)
            _EditorPanel(editor: editor, showViewer: widget.showViewer)
          else ...[
            const SizedBox(height: 10),
            Text(
              'Find pets on petdex.dev, or use any PNG, JPEG or WebP sprite '
              'sheet.',
              style: DesktopChrome.metadata(color: DesktopChrome.muted),
            ),
          ],
        ],
      ),
    );
  }
}

class _PetRow extends StatefulWidget {
  const _PetRow({
    super.key,
    required this.deviceKey,
    required this.controller,
    required this.editor,
    required this.enabled,
    required this.attached,
    required this.pickFile,
    required this.pickFolder,
  });
  final String deviceKey;
  final DevicesController controller;
  final PetEditor editor;
  final bool enabled, attached;
  final Future<String?> Function() pickFile, pickFolder;

  @override
  State<_PetRow> createState() => _PetRowState();
}

class _PetRowState extends State<_PetRow> {
  bool _hovering = false;

  Future<void> _use(String? path) async {
    if (!widget.enabled) return;
    await widget.editor.use(path);
  }

  @override
  Widget build(BuildContext context) {
    final editor = widget.editor;
    final status = widget.controller.petStatus(widget.deviceKey);
    final current = status?.all;
    final sending = status?.sending;
    final info = current == null ? null : status?.pets[current];
    final failure = current == null ? null : status?.errors[current];
    final progress = current != null && sending?.id == current;
    final onDial = current != null && (status?.held.contains(current) ?? false);
    // Only a dial that can take pets has anything pending.
    final live = status?.supported ?? false;
    final note = current != null && !widget.attached
        ? 'Will be sent when the dial connects'
        : null;
    final can = widget.enabled && !editor.busy;
    final error = editor.editing ? null : editor.error;
    final detail = editor.editing
        ? '${editor.name} · not applied yet'
        : current == null
        ? 'Default'
        : info?.name ?? 'Custom pet';
    return DropTarget(
      enable: can,
      onDragEntered: (_) => setState(() => _hovering = true),
      onDragExited: (_) => setState(() => _hovering = false),
      onDragDone: (details) async {
        setState(() => _hovering = false);
        if (details.files.isNotEmpty) await _use(details.files.first.path);
      },
      child: DecoratedBox(
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
          border: Border.all(
            color: _hovering ? DesktopChrome.accent : Colors.transparent,
          ),
        ),
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 2),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              _PetRowHead(
                detail: detail,
                thumb: editor.editing ? null : info?.thumb,
                status: status == null
                    ? null
                    : note != null
                    ? Text(note, style: DesktopChrome.metadata())
                    : failure != null
                    ? Text(
                        _errorText[failure] ??
                            'The dial couldn’t take this pet',
                        style: DesktopChrome.metadata(
                          color: Theme.of(context).colorScheme.error,
                        ),
                      )
                    : progress
                    ? Text(
                        'Sending to dial… ${sending!.percent} %',
                        style: DesktopChrome.metadata(),
                      )
                    : onDial
                    ? Text('On dial ✓', style: DesktopChrome.metadata())
                    : current != null && live
                    ? Text(
                        'Waiting for the dial…',
                        style: DesktopChrome.metadata(
                          color: DesktopChrome.muted,
                        ),
                      )
                    : null,
                buttons: [
                  OutlinedButton(
                    onPressed: can
                        ? () async => _use(await widget.pickFolder())
                        : null,
                    style: _pillButton,
                    child: const Text('Choose folder…'),
                  ),
                  OutlinedButton(
                    onPressed: can
                        ? () async => _use(await widget.pickFile())
                        : null,
                    style: _pillButton,
                    child: const Text('Choose file…'),
                  ),
                  if (current != null && !editor.editing)
                    OutlinedButton(
                      onPressed: can ? editor.reset : null,
                      style: _pillButton,
                      child: const Text('Reset'),
                    ),
                ],
              ),
              if (error != null)
                _line(
                  Text(
                    error,
                    style: DesktopChrome.metadata(
                      color: Theme.of(context).colorScheme.error,
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }

  static Widget _line(Widget child) =>
      Padding(padding: const EdgeInsets.only(top: 6), child: child);
}

/// The quiet pill buttons of the Pet section.
final _pillButton = OutlinedButton.styleFrom(
  shape: const StadiumBorder(),
  padding: const EdgeInsets.symmetric(horizontal: 14),
  visualDensity: VisualDensity.compact,
);

/// "All agents" and what it shows on the left, the choosers side by side on
/// the right; under the text when the row is too narrow for both.
class _PetRowHead extends StatelessWidget {
  const _PetRowHead({
    required this.detail,
    required this.buttons,
    this.thumb,
    this.status,
  });
  final String detail;
  final List<Widget> buttons;

  /// The current pet's picture, when it has one.
  final Uint8List? thumb;

  /// Where the pet is: on the dial, being sent, waiting, refused.
  final Widget? status;

  @override
  Widget build(BuildContext context) {
    final words = Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(
          'All agents',
          style: DesktopChrome.text(
            size: 14,
            medium: true,
            height: 1.3,
          ).copyWith(fontWeight: FontWeight.w600),
        ),
        const SizedBox(height: 2),
        Text(
          detail,
          maxLines: 2,
          overflow: TextOverflow.ellipsis,
          style: DesktopChrome.text(size: 13, color: DesktopChrome.muted),
        ),
        if (status case final status?) ...[const SizedBox(height: 2), status],
      ],
    );
    final picture = thumb;
    final text = picture == null
        ? words
        : Row(
            children: [
              Container(
                key: const ValueKey('pet-thumb-all'),
                width: 44,
                height: 44,
                padding: const EdgeInsets.all(4),
                decoration: BoxDecoration(
                  color: grid.AppSurface.recess,
                  borderRadius: BorderRadius.circular(10),
                ),
                child: Image.memory(
                  picture,
                  gaplessPlayback: true,
                  filterQuality: FilterQuality.none,
                ),
              ),
              const SizedBox(width: 12),
              Flexible(child: words),
            ],
          );
    final row = Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        for (final (i, button) in buttons.indexed) ...[
          if (i > 0) const SizedBox(width: 8),
          button,
        ],
      ],
    );
    return LayoutBuilder(
      builder: (context, constraints) {
        final scale = MediaQuery.textScalerOf(context).scale(1);
        if (constraints.maxWidth >= 520 * scale) {
          return Row(
            children: [
              Expanded(child: text),
              const SizedBox(width: 16),
              row,
            ],
          );
        }
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            text,
            const SizedBox(height: 10),
            Wrap(spacing: 8, runSpacing: 8, children: buttons),
          ],
        );
      },
    );
  }
}

String _size(int bytes) => bytes >= 1024 * 1024
    ? '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB'
    : '${(bytes / 1024).round()} KB';

/// [row]'s frames, from the editor's local sheet when it was read.
_RowArt _art(PetEditor editor, PetSheetRow row) {
  final index = petRows.indexOf(row.row);
  return _RowArt(
    frames: row.frames,
    sheet: editor.sheet?.image,
    row: index,
    crop: editor.sheet?.crop(index),
    strip: row.strip,
  );
}

/// Muted copy in the Pet section: what was found, what a row plays.
TextStyle _note() =>
    DesktopChrome.text(size: 13, color: DesktopChrome.muted, height: 1.35);

/// The edit in progress, under the All agents row: what was found, a card
/// per sheet row to view, the states the viewed row plays, then Apply.
class _EditorPanel extends StatelessWidget {
  const _EditorPanel({required this.editor, required this.showViewer});
  final PetEditor editor;
  final bool showViewer;

  @override
  Widget build(BuildContext context) {
    final preview = editor.preview!;
    final sheetRows = preview.sheetRows;
    final viewed = editor.viewedRow;
    final most = sheetRows
        .map((r) => r.frames)
        .fold(0, (a, b) => b > a ? b : a);
    final found = sheetRows.isEmpty
        ? null
        : editor.loose
        ? 'Background removed · ${sheetRows.length} '
              '${sheetRows.length == 1 ? 'row' : 'rows'} × $most '
              '${most == 1 ? 'frame' : 'frames'} found'
        : '${sheetRows.length} ${sheetRows.length == 1 ? 'row' : 'rows'} found';
    final error = editor.error;
    return Padding(
      padding: const EdgeInsets.only(top: 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (showViewer) ...[
            PetRowViewer(editor: editor),
            const SizedBox(height: 14),
          ],
          Text(
            [
              ?found,
              '${_size(preview.bytes)} · ${preview.colours} colours',
            ].join(' · '),
            key: const ValueKey('pet-found'),
            style: _note(),
          ),
          for (final warning in preview.warnings)
            Text(warning, style: DesktopChrome.metadata()),
          if (viewed != null) ...[
            const SizedBox(height: 10),
            _RowGrid(editor: editor, viewed: viewed.row),
            const SizedBox(height: 16),
            Text(
              '${editor.rowLabel(viewed.row)} plays on the dial as',
              key: const ValueKey('pet-plays-as'),
              style: _note(),
            ),
            const SizedBox(height: 8),
            Wrap(
              spacing: 6,
              runSpacing: 6,
              children: [
                for (final MapEntry(key: state, value: label)
                    in petStateLabels.entries)
                  _StateChip(
                    key: ValueKey('pet-state-$state'),
                    label: label,
                    on: editor.rows[state] == viewed.row,
                    onTap: () => editor.choose(state, viewed.row),
                  ),
              ],
            ),
            const SizedBox(height: 10),
            Text(
              'A state plays exactly one row; picking it here moves it.',
              style: DesktopChrome.metadata(),
            ),
          ],
          const SizedBox(height: 16),
          Row(
            key: const ValueKey('pet-actions'),
            children: [
              Expanded(
                child: error == null
                    ? const SizedBox.shrink()
                    : Text(
                        error,
                        style: DesktopChrome.metadata(
                          color: Theme.of(context).colorScheme.error,
                        ),
                      ),
              ),
              const SizedBox(width: 8),
              TextButton(
                onPressed: editor.busy ? null : editor.cancel,
                style: TextButton.styleFrom(
                  backgroundColor: DesktopChrome.field,
                  foregroundColor: DesktopChrome.foreground,
                  padding: const EdgeInsets.symmetric(horizontal: 18),
                ),
                child: const Text('Cancel'),
              ),
              const SizedBox(width: 8),
              FilledButton(
                onPressed: editor.busy || !editor.current ? null : editor.apply,
                style: FilledButton.styleFrom(
                  padding: const EdgeInsets.symmetric(horizontal: 20),
                ),
                child: const Text('Apply'),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

/// The sheet's rows as cards of one height, three to a line.
class _RowGrid extends StatelessWidget {
  const _RowGrid({required this.editor, required this.viewed});
  final PetEditor editor;
  final String viewed;

  @override
  Widget build(BuildContext context) {
    final sheetRows = editor.preview!.sheetRows;
    final scale = MediaQuery.textScalerOf(context).scale(1);
    return LayoutBuilder(
      builder: (context, constraints) {
        final cols = constraints.maxWidth < 380 ? 2 : 3;
        const gap = 8.0;
        final cardWidth = (constraints.maxWidth - gap * (cols - 1)) / cols;
        final thumb = (cardWidth * .37).clamp(44.0, 72.0);
        final height = _RowCard.heightFor(thumb, scale);
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            for (var i = 0; i < sheetRows.length; i += cols) ...[
              if (i > 0) const SizedBox(height: gap),
              Row(
                children: [
                  for (var j = i; j < i + cols; j++) ...[
                    if (j > i) const SizedBox(width: gap),
                    Expanded(
                      child: j < sheetRows.length
                          ? _RowCard(
                              key: ValueKey(
                                'pet-sheet-row-${sheetRows[j].row}',
                              ),
                              label: editor.rowLabel(sheetRows[j].row),
                              art: _art(editor, sheetRows[j]),
                              thumb: thumb,
                              height: height,
                              selected: sheetRows[j].row == viewed,
                              states: editor.statesOf(sheetRows[j].row),
                              onTap: () => editor.view(sheetRows[j].row),
                            )
                          : const SizedBox.shrink(),
                    ),
                  ],
                ],
              ),
            ],
          ],
        );
      },
    );
  }
}

/// The edit's viewed row, played large with a frame scrubber, then what the
/// dial will draw. Beside the Pet section on a wide screen, inline in it
/// otherwise. Draws nothing while [editor] has no edit.
class PetRowViewer extends StatelessWidget {
  const PetRowViewer({super.key, required this.editor, this.maxViewer = 300});
  final PetEditor editor;

  /// The tallest the checkered viewer grows.
  final double maxViewer;

  /// The dial scenes shown, with their labels. Asking falls back to the small
  /// pet when the daemon sends no asking frames.
  static const _dial = [
    ('Idle', 'small'),
    ('Working', 'working'),
    ('Asking', 'asking'),
  ];

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: editor,
    builder: (context, _) {
      final preview = editor.preview;
      if (preview == null) return const SizedBox.shrink();
      final viewed = editor.viewedRow;
      final scenes = [
        for (final (label, scene) in _dial)
          (preview.frames[scene] ?? const []).isEmpty
              ? (
                  label,
                  scene,
                  preview.frames['small'] ?? const <Uint8List>[],
                  preview.stepMs['small'] ?? 200,
                )
              : (
                  label,
                  scene,
                  preview.frames[scene]!,
                  preview.stepMs[scene] ?? 200,
                ),
      ];
      // One scale for the three, so each is as big against the others as
      // the dial draws it.
      final side = dialFrameSide([for (final s in scenes) s.$3]);
      return Container(
        key: const ValueKey('pet-row-viewer'),
        padding: const EdgeInsets.all(16),
        decoration: _cardDecoration(),
        child: LayoutBuilder(
          builder: (context, constraints) {
            final width = constraints.maxWidth;
            final size = math.min(112.0, (width - 2 * 10) / 3);
            return Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (viewed != null) ...[
                  _ViewerHead(
                    key: ValueKey('pet-viewer-${viewed.row}'),
                    editor: editor,
                    label: editor.rowLabel(viewed.row),
                    art: _art(editor, viewed),
                    width: width,
                    maxViewer: maxViewer,
                  ),
                  const SizedBox(height: 16),
                ],
                Text('On the dial', style: _note()),
                const SizedBox(height: 8),
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    for (final (label, scene, frames, stepMs) in scenes)
                      _DialPreview(
                        key: ValueKey('pet-dial-$scene-${preview.id}'),
                        label: label,
                        size: size,
                        frames: frames,
                        stepMs: stepMs,
                        pixel: side == 0
                            ? null
                            : size * (1 - 2 * _DialPreview.inset) / side,
                      ),
                  ],
                ),
              ],
            );
          },
        ),
      );
    },
  );
}

/// The longest side of the first frame of any of [scenes] (PNGs), 0 when
/// none can be read.
@visibleForTesting
int dialFrameSide(List<List<Uint8List>> scenes) {
  var side = 0;
  for (final frames in scenes) {
    if (frames.isEmpty) continue;
    final size = imageSize(frames.first);
    if (size == null) continue;
    side = math.max(side, math.max(size.$1, size.$2));
  }
  return side;
}

/// The viewer's title, play pill, checkered frame and scrubber; repaints on
/// each frame step.
class _ViewerHead extends StatelessWidget {
  const _ViewerHead({
    super.key,
    required this.editor,
    required this.label,
    required this.art,
    required this.width,
    required this.maxViewer,
  });
  final PetEditor editor;
  final String label;
  final _RowArt art;
  final double width, maxViewer;

  @override
  Widget build(BuildContext context) {
    final n = art.frames;
    final checker = _CheckerPainter(
      DesktopChrome.surface,
      Color.alphaBlend(
        DesktopChrome.rim.withValues(alpha: .45),
        DesktopChrome.surface,
      ),
    );
    const gap = 4.0;
    final tile = n == 0 ? 30.0 : math.min(30.0, (width - gap * (n - 1)) / n);
    return ListenableBuilder(
      listenable: editor.playback,
      builder: (context, _) {
        final playback = editor.playback;
        final playing = playback.playing;
        final index = n == 0 ? 0 : playback.index % n;
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'ROW VIEWER',
                        style: DesktopChrome.text(
                          color: DesktopChrome.accent,
                          size: 11,
                          height: 1.3,
                        ).copyWith(fontWeight: FontWeight.w600),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        label,
                        key: const ValueKey('pet-viewer-title'),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: DesktopChrome.text(
                          size: 17,
                          height: 1.25,
                        ).copyWith(fontWeight: FontWeight.w600),
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 8),
                _PlayPill(
                  key: const ValueKey('pet-viewer-play'),
                  frames: n,
                  playing: playing,
                  onPressed: n < 2 ? null : playback.toggle,
                ),
              ],
            ),
            const SizedBox(height: 12),
            SizedBox(
              height: math.min(width * .85, maxViewer),
              child: ClipRRect(
                borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
                child: CustomPaint(
                  painter: checker,
                  child: Padding(
                    padding: const EdgeInsets.all(10),
                    child: _FrameArt(
                      key: const ValueKey('pet-viewer-art'),
                      art: art,
                      index: index,
                    ),
                  ),
                ),
              ),
            ),
            const SizedBox(height: 10),
            Row(
              children: [
                for (var i = 0; i < n; i++) ...[
                  if (i > 0) const SizedBox(width: gap),
                  GestureDetector(
                    key: ValueKey('pet-viewer-frame-$i'),
                    onTap: () => playback.hold(i),
                    child: MouseRegion(
                      cursor: SystemMouseCursors.click,
                      child: Container(
                        width: tile,
                        height: tile,
                        padding: const EdgeInsets.all(2),
                        decoration: BoxDecoration(
                          color: DesktopChrome.surface,
                          borderRadius: BorderRadius.circular(
                            DesktopChrome.controlRadius,
                          ),
                          border: Border.all(
                            color: !playing && i == index
                                ? DesktopChrome.accent
                                : DesktopChrome.rim,
                            width: !playing && i == index ? 1.5 : 1,
                          ),
                        ),
                        child: _FrameArt(art: art, index: i),
                      ),
                    ),
                  ),
                ],
              ],
            ),
          ],
        );
      },
    );
  }
}

/// "▷ n frames" when paused, "❚❚ n frames" while playing; toggles playback.
class _PlayPill extends StatelessWidget {
  const _PlayPill({
    super.key,
    required this.frames,
    required this.playing,
    required this.onPressed,
  });
  final int frames;
  final bool playing;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    final color = onPressed == null
        ? DesktopChrome.muted
        : DesktopChrome.foreground;
    final style = DesktopChrome.control(color: color);
    final line = MediaQuery.textScalerOf(context).scale(13 * 1.25);
    return Semantics(
      button: true,
      enabled: onPressed != null,
      label: playing ? 'Pause' : 'Play',
      child: Material(
        color: Colors.transparent,
        shape: StadiumBorder(side: BorderSide(color: DesktopChrome.rim)),
        child: InkWell(
          customBorder: const StadiumBorder(),
          onTap: onPressed,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.center,
              children: [
                SizedBox(
                  height: line,
                  child: Center(
                    child: Icon(
                      playing ? AppIcons.pause : AppIcons.play,
                      size: 12,
                      color: color,
                    ),
                  ),
                ),
                const SizedBox(width: 6),
                SizedBox(
                  height: line,
                  child: Center(
                    child: Text(
                      '$frames ${frames == 1 ? 'frame' : 'frames'}',
                      style: style,
                      textHeightBehavior: const TextHeightBehavior(
                        leadingDistribution: TextLeadingDistribution.even,
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// Where a sheet row's frames come from: the decoded sheet at full
/// resolution ([sheet], row index [row], cut to [crop] of each cell), or
/// else the daemon's [strip] of them side by side.
@immutable
class _RowArt {
  const _RowArt({
    required this.frames,
    required this.sheet,
    required this.row,
    required this.strip,
    this.crop,
  });
  final int frames, row;
  final ui.Image? sheet;
  final Rect? crop;
  final Uint8List? strip;
}

/// Where frame [index] of sheet row [row] is read from on a sheet of
/// [cell]-sized cells: [crop] (the row's art box, in cell coordinates) of
/// that cell, or the whole cell without one.
@visibleForTesting
Rect frameSource(Size cell, int row, int index, Rect? crop) {
  final origin = Offset(index * cell.width, row * cell.height);
  return (crop ?? Offset.zero & cell).shift(origin);
}

/// Frame [index] of [art], fitted inside the space it is given.
class _FrameArt extends StatelessWidget {
  const _FrameArt({super.key, required this.art, required this.index});
  final _RowArt art;
  final int index;

  @override
  Widget build(BuildContext context) {
    final sheet = art.sheet;
    if (sheet != null && art.row >= 0) {
      final cell = Size(sheet.width / sheetCols, sheet.height / sheetRows);
      return SizedBox.expand(
        child: CustomPaint(
          painter: _CellPainter(
            sheet,
            frameSource(cell, art.row, index, art.crop),
          ),
        ),
      );
    }
    final strip = art.strip;
    if (strip == null) return const SizedBox.expand();
    // The strip scaled to the frame's height, slid so frame [index] shows.
    final n = art.frames;
    return Center(
      child: AspectRatio(
        aspectRatio: cellWidth / cellHeight,
        child: ClipRect(
          child: Image.memory(
            strip,
            fit: BoxFit.cover,
            alignment: Alignment(n > 1 ? -1 + 2 * index / (n - 1) : 0, 0),
            gaplessPlayback: true,
            filterQuality: FilterQuality.medium,
          ),
        ),
      ),
    );
  }
}

/// One cell of the sheet (or the part of it [source] names), scaled to fit.
/// Upscaled 2x or more it keeps hard pixels (pixel art); otherwise it is
/// filtered.
class _CellPainter extends CustomPainter {
  const _CellPainter(this.sheet, this.source);
  final ui.Image sheet;
  final Rect source;

  @override
  void paint(Canvas canvas, Size size) {
    final scale = math.min(
      size.width / source.width,
      size.height / source.height,
    );
    final w = source.width * scale, h = source.height * scale;
    final target = Rect.fromLTWH(
      (size.width - w) / 2,
      (size.height - h) / 2,
      w,
      h,
    );
    canvas.drawImageRect(
      sheet,
      source,
      target,
      Paint()
        ..filterQuality = scale >= 2
            ? FilterQuality.none
            : FilterQuality.medium,
    );
  }

  @override
  bool shouldRepaint(_CellPainter old) =>
      old.sheet != sheet || old.source != source;
}

/// The checkered backdrop that shows where a frame is clear.
class _CheckerPainter extends CustomPainter {
  const _CheckerPainter(this.light, this.dark);
  final Color light, dark;

  @override
  void paint(Canvas canvas, Size size) {
    const square = 14.0;
    canvas.drawRect(Offset.zero & size, Paint()..color = light);
    final paint = Paint()..color = dark;
    for (var y = 0; y * square < size.height; y++) {
      for (var x = y % 2; x * square < size.width; x += 2) {
        canvas.drawRect(
          Rect.fromLTWH(x * square, y * square, square, square),
          paint,
        );
      }
    }
  }

  @override
  bool shouldRepaint(_CheckerPainter old) =>
      old.light != light || old.dark != dark;
}

/// The surface the viewer and the cards sit on.
BoxDecoration _cardDecoration({bool selected = false}) => BoxDecoration(
  color: selected ? DesktopChrome.selection : DesktopChrome.field,
  borderRadius: BorderRadius.circular(DesktopChrome.dialogRadius),
  border: Border.all(
    color: selected ? DesktopChrome.accent : DesktopChrome.rim,
    width: selected ? 1.5 : 1,
  ),
);

/// A sheet row to pick for the viewer: its name and frame count, its first
/// frame at the right, the states it plays along the bottom.
class _RowCard extends StatelessWidget {
  const _RowCard({
    super.key,
    required this.label,
    required this.art,
    required this.thumb,
    required this.height,
    required this.selected,
    required this.states,
    required this.onTap,
  });
  final String label;
  final _RowArt art;
  final double thumb, height;
  final bool selected;
  final List<String> states;
  final VoidCallback onTap;

  static const _pad = EdgeInsets.fromLTRB(10, 8, 8, 8);
  static const _badgeGap = 4.0;

  /// The line of state badges, [scale] being the text scale.
  static double badgeLine(double scale) => 11 * 1.3 * scale + 2;

  /// One card height for every card of a grid: the thumbnail or the text
  /// beside it (a title of up to two lines, the frame count), whichever is
  /// taller, then the badge line.
  static double heightFor(double thumb, double scale) =>
      _pad.vertical +
      math.max(thumb, (2 * 13 * 1.3 + 12 * 1.35) * scale + 2) +
      _badgeGap +
      badgeLine(scale);

  @override
  Widget build(BuildContext context) {
    final scale = MediaQuery.textScalerOf(context).scale(1);
    return Semantics(
      button: true,
      selected: selected,
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(DesktopChrome.dialogRadius),
          child: Ink(
            height: height,
            padding: _pad,
            decoration: _cardDecoration(selected: selected),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Expanded(
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            const SizedBox(height: 2),
                            Text(
                              label,
                              maxLines: 2,
                              overflow: TextOverflow.ellipsis,
                              style: DesktopChrome.text(
                                size: 13,
                                height: 1.3,
                              ).copyWith(fontWeight: FontWeight.w600),
                            ),
                            Text(
                              '${art.frames} '
                              '${art.frames == 1 ? 'frame' : 'frames'}',
                              maxLines: 1,
                              style: DesktopChrome.metadata(),
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(width: 6),
                      Container(
                        width: thumb,
                        height: thumb,
                        padding: const EdgeInsets.all(4),
                        decoration: BoxDecoration(
                          color: DesktopChrome.surface,
                          borderRadius: BorderRadius.circular(
                            DesktopChrome.controlRadius,
                          ),
                        ),
                        child: _FrameArt(art: art, index: 0),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: _badgeGap),
                SizedBox(
                  height: badgeLine(scale),
                  child: _Badges(
                    labels: [for (final s in states) petStateLabels[s]!],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// How many of the badges [widths] fit [maxWidth] on one line with [gap]
/// between them, leaving room for a "+n" badge [more] wide when some don't.
@visibleForTesting
int fitBadges(
  List<double> widths,
  double maxWidth, {
  required double Function(int hidden) more,
  double gap = 4,
}) {
  for (var k = widths.length; k > 0; k--) {
    var w = 0.0;
    for (var i = 0; i < k; i++) {
      w += widths[i] + (i > 0 ? gap : 0);
    }
    if (k < widths.length) w += gap + more(widths.length - k);
    if (w <= maxWidth) return k;
  }
  return 0;
}

/// The states a row plays, as badges on one line: the first ones that fit,
/// then "+n" for the rest.
class _Badges extends StatelessWidget {
  const _Badges({required this.labels});
  final List<String> labels;

  static const _hPad = 6.0;

  @override
  Widget build(BuildContext context) {
    if (labels.isEmpty) return const SizedBox.shrink();
    final scaler = MediaQuery.textScalerOf(context);
    final style = DesktopChrome.text(size: 11, height: 1.3);
    double width(String text) {
      final painter = TextPainter(
        text: TextSpan(text: text, style: style),
        textDirection: TextDirection.ltr,
        textScaler: scaler,
        maxLines: 1,
      )..layout();
      final w = painter.width + 2 * _hPad;
      painter.dispose();
      return w.ceilToDouble();
    }

    final fill = Theme.of(context).colorScheme.primary.withValues(alpha: .35);
    Widget badge(String text) => Container(
      padding: const EdgeInsets.symmetric(horizontal: _hPad, vertical: 1),
      decoration: BoxDecoration(
        color: fill,
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(text, maxLines: 1, softWrap: false, style: style),
    );
    return LayoutBuilder(
      builder: (context, constraints) {
        final shown = fitBadges(
          [for (final l in labels) width(l)],
          constraints.maxWidth,
          more: (hidden) => width('+$hidden'),
        );
        final hidden = labels.length - shown;
        return ClipRect(
          child: Row(
            children: [
              for (var i = 0; i < shown; i++) ...[
                if (i > 0) const SizedBox(width: 4),
                badge(labels[i]),
              ],
              if (hidden > 0) ...[
                if (shown > 0) const SizedBox(width: 4),
                badge('+$hidden'),
              ],
            ],
          ),
        );
      },
    );
  }
}

/// What the dial draws for one scene, on a round black face: its frames at
/// [pixel] logical px per frame pixel (one scale for all the scenes shown),
/// or fitted when that is unknown.
class _DialPreview extends StatelessWidget {
  const _DialPreview({
    super.key,
    required this.label,
    required this.size,
    required this.frames,
    required this.stepMs,
    this.pixel,
  });
  final String label;
  final double size;
  final List<Uint8List> frames;
  final int stepMs;
  final double? pixel;

  /// The share of the face left clear on each side: the square inside the
  /// circle.
  static const inset = .14;

  @override
  Widget build(BuildContext context) => Column(
    mainAxisSize: MainAxisSize.min,
    children: [
      Container(
        width: size,
        height: size,
        decoration: const BoxDecoration(
          color: Colors.black,
          shape: BoxShape.circle,
        ),
        padding: EdgeInsets.all(size * inset),
        child: _FrameCycler(frames: frames, stepMs: stepMs, pixel: pixel),
      ),
      const SizedBox(height: 6),
      Text(label, style: _note()),
    ],
  );
}

/// A state the viewed row can play: filled when it plays it.
class _StateChip extends StatelessWidget {
  const _StateChip({
    super.key,
    required this.label,
    required this.on,
    required this.onTap,
  });
  final String label;
  final bool on;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Semantics(
      button: true,
      selected: on,
      child: Material(
        color: on ? scheme.primary : Colors.transparent,
        shape: StadiumBorder(
          side: BorderSide(color: on ? scheme.primary : DesktopChrome.rim),
        ),
        child: InkWell(
          customBorder: const StadiumBorder(),
          onTap: on ? null : onTap,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 5),
            child: Text(
              label,
              style: DesktopChrome.control(
                color: on ? scheme.onPrimary : DesktopChrome.foreground,
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Cycles already-decoded frames, at [pixel] logical px per frame pixel or
/// scaled down to fit; no timer for a single frame.
class _FrameCycler extends StatefulWidget {
  const _FrameCycler({required this.frames, required this.stepMs, this.pixel});
  final List<Uint8List> frames;
  final int stepMs;
  final double? pixel;

  @override
  State<_FrameCycler> createState() => _FrameCyclerState();
}

class _FrameCyclerState extends State<_FrameCycler> {
  Timer? _timer;
  int _index = 0;

  @override
  void initState() {
    super.initState();
    if (widget.frames.length > 1) {
      _timer = Timer.periodic(
        Duration(milliseconds: widget.stepMs.clamp(40, 2000)),
        (_) => setState(() => _index = (_index + 1) % widget.frames.length),
      );
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (widget.frames.isEmpty) return const SizedBox.expand();
    final pixel = widget.pixel;
    return Center(
      child: Image.memory(
        widget.frames[_index % widget.frames.length],
        scale: pixel == null ? 1 : 1 / pixel,
        fit: BoxFit.scaleDown,
        gaplessPlayback: true,
        filterQuality: pixel != null && pixel < 1
            ? FilterQuality.medium
            : FilterQuality.none,
      ),
    );
  }
}
