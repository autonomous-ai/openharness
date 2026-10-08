import 'dart:async';
import 'dart:io';
import 'dart:isolate';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter/painting.dart' show Rect;
import 'package:path/path.dart' as p;

import 'devices_controller.dart';
import 'loose_sheet.dart';
import 'pet_source.dart';

/// The dial states a row can be picked for, and their labels.
const petStateLabels = {
  'rest': 'Rest',
  'working': 'Working',
  'listening': 'Listening',
  'sending': 'Sending',
  'asking': 'Asking',
};

/// How long the row picker waits for more changes before asking again.
const petRowsDebounce = Duration(milliseconds: 250);

/// How long the row viewer shows each frame of the sheet.
const petViewerStep = Duration(milliseconds: 120);

/// A sheet decoded for the row viewer, with where each row's art sits in its
/// cells.
class PetSheet {
  PetSheet(this.image, {this.crops = const []});
  final ui.Image image;

  /// Per sheet row, the box (in cell coordinates) that holds every frame of
  /// it, padded; see [sheetRowCrops]. Missing or null shows the whole cell.
  final List<Rect?> crops;

  /// Row [row]'s box, or null for the whole cell.
  Rect? crop(int row) => row >= 0 && row < crops.length ? crops[row] : null;

  void dispose() => image.dispose();
}

/// Each row's art box on a straight RGBA sheet of 8 x 9 cells: the union of
/// the opaque pixels (alpha 128 or more) over all of the row's cells, in cell
/// coordinates, grown by [pad] (a share of its larger side) and kept inside
/// the cell. One box per row, so a row's frames keep their place against
/// each other when played. Null for an empty row.
List<Rect?> sheetRowCrops(
  Uint8List rgba,
  int width,
  int height, {
  double pad = .06,
}) {
  final cw = width ~/ sheetCols, ch = height ~/ sheetRows;
  final crops = <Rect?>[];
  for (var r = 0; r < sheetRows; r++) {
    var left = cw, top = ch, right = -1, bottom = -1;
    for (var y = 0; y < ch; y++) {
      final row = (r * ch + y) * width;
      for (var x = 0; x < width; x++) {
        if (rgba[(row + x) * 4 + 3] < 128) continue;
        final cx = x % cw;
        if (cx < left) left = cx;
        if (cx > right) right = cx;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
    if (right < 0) {
      crops.add(null);
      continue;
    }
    final box = Rect.fromLTRB(
      left.toDouble(),
      top.toDouble(),
      right + 1.0,
      bottom + 1.0,
    );
    final grow = pad * math.max(box.width, box.height);
    crops.add(
      box
          .inflate(grow)
          .intersect(Rect.fromLTWH(0, 0, cw.toDouble(), ch.toDouble())),
    );
  }
  return crops;
}

/// Reads the sheet the daemon converts, for the row viewer's full-resolution
/// frames, and finds each row's art box; null when it cannot be read or is
/// not 8 x 9 cells.
Future<PetSheet?> decodePetSheet(String path) async {
  ui.Image? image;
  try {
    final file = File(path);
    if (await file.length() > 32 * 1024 * 1024) return null;
    final codec = await ui.instantiateImageCodec(await file.readAsBytes());
    final frame = await codec.getNextFrame();
    codec.dispose();
    image = frame.image;
    final w = image.width, h = image.height;
    if (w % sheetCols != 0 || h % sheetRows != 0) {
      image.dispose();
      return null;
    }
    var crops = const <Rect?>[];
    final data = await image.toByteData(
      format: ui.ImageByteFormat.rawStraightRgba,
    );
    if (data != null) {
      final rgba = data.buffer.asUint8List(
        data.offsetInBytes,
        data.lengthInBytes,
      );
      crops = await Isolate.run(() => sheetRowCrops(rgba, w, h));
    }
    return PetSheet(image, crops: crops);
  } catch (_) {
    image?.dispose();
    return null;
  }
}

/// Which frame of the viewed row the row viewer shows, and whether it plays.
/// Apart from [PetEditor] so a frame step repaints only the viewer.
class PetPlayback extends ChangeNotifier {
  Timer? _timer;
  int _frames = 0, _index = 0;
  bool _disposed = false;

  int get frames => _frames;
  int get index => _frames == 0 ? 0 : _index % _frames;
  bool get playing => _timer != null;

  /// Starts over on a row of [frames] frames, playing.
  void restart(int frames) {
    _stop();
    _frames = frames;
    _index = 0;
    play();
    notifyListeners();
  }

  void play() {
    if (_disposed || _timer != null || _frames < 2) return;
    _timer = Timer.periodic(petViewerStep, (_) {
      _index = (_index + 1) % _frames;
      notifyListeners();
    });
    notifyListeners();
  }

  void pause() {
    if (_timer == null) return;
    _stop();
    notifyListeners();
  }

  void toggle() => playing ? pause() : play();

  /// Pauses on frame [i].
  void hold(int i) {
    _stop();
    _index = i;
    notifyListeners();
  }

  /// Stops without a frame (nothing to view).
  void clear() {
    _stop();
    _frames = 0;
    _index = 0;
  }

  void _stop() {
    _timer?.cancel();
    _timer = null;
  }

  @override
  void dispose() {
    _disposed = true;
    _stop();
    super.dispose();
  }
}

/// One custom-pet edit for one dial: the sheet the user picked, the daemon's
/// preview of it, which row plays each state, the row being viewed and its
/// playback. Shared by the Pet section and the row viewer beside it, so the
/// two columns of the devices screen show the same edit. Owns the sheet's
/// temp files and decoded image until the edit is applied, cancelled,
/// replaced or disposed.
class PetEditor extends ChangeNotifier {
  PetEditor({
    required this.controller,
    required this.deviceKey,
    Future<PetSource> Function(String path)? resolveSource,
    Future<PetSheet?> Function(String path)? loadSheet,
  }) : resolveSource = resolveSource ?? resolvePetSource,
       loadSheet = loadSheet ?? decodePetSheet;

  final DevicesController controller;
  final String deviceKey;

  /// [resolvePetSource], or a test's.
  final Future<PetSource> Function(String path) resolveSource;

  /// [decodePetSheet], or a test's.
  final Future<PetSheet?> Function(String path) loadSheet;

  final playback = PetPlayback();

  PetPreview? _preview;
  String? _error;
  bool _busy = false, _disposed = false;

  /// The sheet being previewed, kept until it is applied or dropped so a new
  /// row choice can be converted again.
  PetSource? _source;

  /// [_source]'s sheet, decoded for the row viewer; null until it is read,
  /// or when it can't be (the viewer then shows the daemon's strips).
  PetSheet? _sheet;

  /// The row (by petdex row name) the user has chosen for each state.
  Map<String, String> _rows = const {};

  /// Whether [_preview] matches [_rows]; false while a new preview is pending
  /// or after it failed, so Apply never sends an outdated pet.
  bool _current = true;
  Timer? _debounce;

  /// Bumped by every preview request; a reply for an older one is ignored.
  int _seq = 0;

  /// The sheet row in the viewer; starts on the row Working plays.
  String? _viewed;

  PetPreview? get preview => _preview;
  String? get error => _error;
  bool get busy => _busy;
  bool get current => _current;
  PetSource? get source => _source;
  PetSheet? get sheet => _sheet;
  Map<String, String> get rows => _rows;
  bool get loose => _source?.loose ?? false;

  /// The edited pet's name: its own, else its sheet's file name.
  String? get name => switch (_source) {
    null => null,
    final source => source.name ?? p.basenameWithoutExtension(source.pngPath),
  };

  /// True while a preview waits to be applied or cancelled.
  bool get editing => _preview != null;

  /// The sheet row in the viewer, or null when the preview lists none (an
  /// older daemon).
  PetSheetRow? get viewedRow {
    final rows = _preview?.sheetRows ?? const <PetSheetRow>[];
    if (rows.isEmpty) return null;
    for (final row in rows) {
      if (row.row == _viewed) return row;
    }
    final working = _rows['working'];
    return rows.firstWhere((r) => r.row == working, orElse: () => rows.first);
  }

  /// The states [row] plays.
  List<String> statesOf(String row) => [
    for (final state in petStateLabels.keys)
      if (_rows[state] == row) state,
  ];

  /// A row's label: its petdex name ("Running right"), or its place on a
  /// loose sheet ("Row 3").
  String rowLabel(String row) {
    if (loose) {
      final i = petRows.indexOf(row);
      return i < 0 ? row : 'Row ${i + 1}';
    }
    final words = row.replaceAllMapped(
      RegExp('[A-Z]'),
      (m) => ' ${m[0]!.toLowerCase()}',
    );
    return words.isEmpty ? row : words[0].toUpperCase() + words.substring(1);
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  /// Restarts the viewer's playback when the viewed row is another one.
  void _syncPlayback({bool force = false}) {
    final row = viewedRow;
    if (row == null) {
      playback.clear();
      _viewed = null;
      return;
    }
    if (force || row.row != _viewed || playback.frames != row.frames) {
      _viewed = row.row;
      playback.restart(row.frames);
    }
  }

  /// Forgets the previewed sheet and removes what it left in the temp folder.
  void _drop() {
    _debounce?.cancel();
    _seq++;
    final source = _source;
    _source = null;
    _preview = null;
    _sheet?.dispose();
    _sheet = null;
    _rows = const {};
    _current = true;
    _viewed = null;
    playback.clear();
    unawaited(source?.cleanup());
  }

  /// Decodes [source]'s sheet for the row viewer, unless it was dropped
  /// meanwhile.
  Future<void> _loadSheet(PetSource source) async {
    final image = await loadSheet(source.pngPath);
    if (_disposed || !identical(source, _source)) {
      image?.dispose();
      return;
    }
    _sheet = image;
    _notify();
  }

  /// Converts what the user picked at [path] and previews it, dropping any
  /// edit in progress.
  Future<void> use(String? path) async {
    if (path == null || _busy || _disposed) return;
    _drop();
    _busy = true;
    _error = null;
    _notify();
    final seq = _seq;
    PetSource? source;
    PetPreview? preview;
    String? error;
    try {
      source = await resolveSource(path);
      preview = await controller.previewPet(
        deviceKey,
        source.pngPath,
        name: source.name,
        // A petdex sheet starts on the daemon's own mapping; a loose one on
        // the app's guess, since its rows are not named for what they hold.
        rows: source.loose ? source.defaultRows : null,
      );
      if (preview == null) error = controller.petError(deviceKey);
    } on PetSourceError catch (e) {
      error = e.message;
    } catch (_) {
      // An unreadable file, a corrupt zip entry, a full disk: the section must
      // stay usable, so this ends the attempt like any other refusal.
      error = 'Couldn’t read this pet';
    }
    if (_disposed || seq != _seq) {
      await source?.cleanup();
      return;
    }
    if (preview == null) await source?.cleanup();
    _busy = false;
    _preview = preview;
    _error = error;
    if (preview != null) {
      _source = source;
      _rows = {...?source?.defaultRows, ...preview.rows};
      _syncPlayback(force: true);
    }
    _notify();
    if (preview != null && preview.sheetRows.isNotEmpty) {
      unawaited(_loadSheet(source!));
    }
  }

  /// Shows [row] in the viewer.
  void view(String row) {
    if (_preview == null || row == _viewed) return;
    _viewed = row;
    _syncPlayback(force: true);
    _notify();
  }

  /// The user picked [row] for [state]: asks for a new preview once the
  /// choices settle.
  void choose(String state, String row) {
    if (_preview == null || _rows[state] == row) return;
    _rows = {..._rows, state: row};
    _current = false;
    // A reply still on its way answers the choices before this one.
    _seq++;
    _notify();
    _debounce?.cancel();
    _debounce = Timer(petRowsDebounce, _refresh);
  }

  Future<void> _refresh() async {
    final source = _source;
    if (source == null || _disposed) return;
    final seq = ++_seq;
    final rows = Map.of(_rows);
    final preview = await controller.previewPet(
      deviceKey,
      source.pngPath,
      name: source.name,
      rows: rows,
    );
    if (_disposed || seq != _seq || !identical(source, _source)) return;
    if (preview == null) {
      _error = controller.petError(deviceKey);
    } else {
      _preview = preview;
      _rows = {...rows, ...preview.rows};
      _current = true;
      _error = null;
      _syncPlayback();
    }
    _notify();
  }

  /// Sends the previewed pet to every agent; the edit ends when it is taken.
  Future<void> apply() async {
    final preview = _preview;
    if (preview == null || _busy || !_current) return;
    _busy = true;
    _error = null;
    _notify();
    final message = await controller.applyPet(deviceKey, preview.id);
    if (_disposed) return;
    _busy = false;
    _error = message;
    if (message == null) _drop();
    _notify();
  }

  /// Back to the built-in pet; drops any edit.
  Future<void> reset() async {
    _busy = true;
    _notify();
    await controller.resetPet(deviceKey);
    if (_disposed) return;
    _busy = false;
    _error = null;
    _drop();
    _notify();
  }

  /// Ends the edit without applying it.
  void cancel() {
    if (_busy) return;
    _drop();
    _notify();
  }

  @override
  void dispose() {
    _disposed = true;
    _debounce?.cancel();
    _sheet?.dispose();
    _sheet = null;
    final source = _source;
    _source = null;
    unawaited(source?.cleanup());
    playback.dispose();
    super.dispose();
  }
}
