import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:archive/archive.dart';
import 'package:path/path.dart' as p;

import 'loose_sheet.dart';

/// Why a dropped or chosen pet could not be turned into a PNG sheet. [message]
/// is shown to the user as is.
class PetSourceError implements Exception {
  PetSourceError(this.message);
  final String message;
  @override
  String toString() => 'PetSourceError: $message';
}

/// A sheet ready for the daemon: a PNG on disk and the pet's own name, if the
/// package had one. [cleanup] removes whatever this made in the temp folder
/// (never the user's files); call it once the daemon no longer needs the PNG.
///
/// [loose] marks a sheet the app laid out itself from any PNG or JPEG sprite
/// sheet: its row i holds the sheet's i-th row of frames, whatever the petdex
/// row is called. [defaultRows] is then the app's first guess at which row
/// (by petdex row name) plays each state (`rest`, `working`, `listening`,
/// `sending`, `asking`); null for a petdex sheet, whose rows the daemon maps.
class PetSource {
  const PetSource({
    required this.pngPath,
    this.name,
    required this.cleanup,
    this.loose = false,
    this.defaultRows,
  });
  final String pngPath;
  final String? name;
  final Future<void> Function() cleanup;
  final bool loose;
  final Map<String, String>? defaultRows;
}

const _sheetMessage =
    'The sheet must be 1536 × 1872 (8 × 9 cells of 192 × 208)';
const _maxWebp = 8 * 1024 * 1024;
const _maxZipBytes = 32 * 1024 * 1024;
const _maxZipEntries = 64;
const _maxJson = 64 * 1024;

Future<void> _noCleanup() async {}

/// Turns what the user picked into a PNG sheet. Accepts a petdex package
/// (folder, `pet.json`, or a zip of either), a `.webp`, or a `.png` / `.jpg`
/// sprite sheet: a PNG of the petdex size is used as is, any other is laid
/// out by [looseSheetSource]. Everything
/// from outside the app is untrusted: paths stay inside the package folder, a
/// zip is bounded in entries and size, and a WebP's size is read from its header
/// before any decoding.
Future<PetSource> resolvePetSource(String path) async {
  if (FileSystemEntity.isDirectorySync(path)) {
    return _fromDirectory(path, cleanup: _noCleanup);
  }
  switch (p.extension(path).toLowerCase()) {
    case '.png':
      if (_petdexSized(path)) {
        return PetSource(pngPath: path, cleanup: _noCleanup);
      }
      return looseSheetSource(path, name: p.basenameWithoutExtension(path));
    case '.jpg' || '.jpeg':
      return looseSheetSource(path, name: p.basenameWithoutExtension(path));
    case '.webp':
      return _fromWebp(path, name: p.basenameWithoutExtension(path));
    case '.json':
      return _fromDirectory(p.dirname(path), cleanup: _noCleanup);
    case '.zip':
      return _fromZip(path);
  }
  throw PetSourceError('Choose a pet folder, zip, pet.json, WebP, PNG or JPEG');
}

/// Whether the PNG at [path] has a petdex sheet's size, or a header this can't
/// read (the daemon then says what is wrong with it).
bool _petdexSized(String path) {
  final Uint8List head;
  try {
    final file = File(path).openSync();
    try {
      head = file.readSync(32);
    } finally {
      file.closeSync();
    }
  } on FileSystemException {
    return true;
  }
  final size = imageSize(head);
  return size == null || size == (1536, 1872) || size == (768, 936);
}

Future<PetSource> _fromDirectory(
  String dir, {
  required Future<void> Function() cleanup,
}) async {
  final String root;
  try {
    root = Directory(dir).resolveSymbolicLinksSync();
  } on FileSystemException {
    throw PetSourceError('That folder can’t be read');
  }
  String? name;
  String? sheetRel;
  final json = File(p.join(root, 'pet.json'));
  if (json.existsSync()) {
    final meta = await _readMeta(json);
    name = meta.$1;
    sheetRel = meta.$2;
  }
  if (sheetRel == null) {
    final found = [
      for (final ext in ['webp', 'png'])
        if (File(p.join(root, 'spritesheet.$ext')).existsSync())
          'spritesheet.$ext',
    ];
    if (found.length != 1) {
      throw PetSourceError(
        found.isEmpty
            ? 'No pet found: expected pet.json or a spritesheet.webp / .png'
            : 'The folder holds both spritesheet.webp and spritesheet.png',
      );
    }
    sheetRel = found.single;
  }
  final sheet = _inside(root, sheetRel);
  final ext = p.extension(sheet).toLowerCase();
  if (ext == '.png') {
    return PetSource(pngPath: sheet, name: name, cleanup: cleanup);
  }
  if (ext != '.webp') {
    throw PetSourceError('The sprite sheet must be a WebP or PNG');
  }
  final decoded = await _fromWebp(
    sheet,
    name: name ?? p.basenameWithoutExtension(sheet),
  );
  return PetSource(
    pngPath: decoded.pngPath,
    name: decoded.name,
    cleanup: () async {
      await decoded.cleanup();
      await cleanup();
    },
  );
}

/// (name, spritesheetPath) from a petdex `pet.json`.
Future<(String?, String?)> _readMeta(File json) async {
  if (json.lengthSync() > _maxJson) {
    throw PetSourceError('pet.json is too large');
  }
  final Object? raw;
  try {
    raw = jsonDecode(await json.readAsString());
  } on FormatException {
    throw PetSourceError('pet.json isn’t valid JSON');
  }
  if (raw is! Map) throw PetSourceError('pet.json isn’t valid');
  String? text(Object? v) =>
      v is String && v.trim().isNotEmpty ? v.trim() : null;
  final sheet = raw['spritesheetPath'];
  if (sheet != null && text(sheet) == null) {
    throw PetSourceError('pet.json has no usable spritesheetPath');
  }
  return (text(raw['displayName']) ?? text(raw['id']), text(sheet));
}

/// [relative] resolved under [root]; refuses `..`, absolute paths and links
/// that lead out of [root].
String _inside(String root, String relative) {
  final parts = relative.split(RegExp(r'[\\/]'));
  if (relative.contains('\u0000') ||
      relative.startsWith('/') ||
      relative.startsWith(r'\') ||
      RegExp(r'^[A-Za-z]:').hasMatch(relative) ||
      parts.contains('..')) {
    throw PetSourceError('The sprite sheet path in pet.json isn’t allowed');
  }
  final file = File(p.joinAll([root, ...parts.where((s) => s.isNotEmpty)]));
  final String real;
  try {
    real = file.resolveSymbolicLinksSync();
  } on FileSystemException {
    throw PetSourceError('The sprite sheet “$relative” wasn’t found');
  }
  if (!p.isWithin(root, real) || !File(real).existsSync()) {
    throw PetSourceError('The sprite sheet path in pet.json isn’t allowed');
  }
  return real;
}

Future<PetSource> _fromZip(String path) async {
  final file = File(path);
  if (!file.existsSync()) throw PetSourceError('That file can’t be read');
  if (file.lengthSync() > _maxZipBytes) {
    throw PetSourceError('The zip is too large');
  }
  final Archive archive;
  try {
    archive = ZipDecoder().decodeBytes(await file.readAsBytes());
  } catch (_) {
    throw PetSourceError('That zip can’t be read');
  }
  final files = <(String, ArchiveFile)>[];
  var declared = 0;
  for (final entry in archive) {
    final name = entry.name.replaceAll('\\', '/');
    // Finder adds these; they are not part of the pet.
    if (name.startsWith('__MACOSX/') || name.endsWith('.DS_Store')) continue;
    if (name.contains('\u0000') ||
        name.startsWith('/') ||
        RegExp(r'^[A-Za-z]:').hasMatch(name) ||
        name.split('/').contains('..')) {
      throw PetSourceError('The zip has an entry outside its folder');
    }
    if (entry.isSymbolicLink) {
      throw PetSourceError('The zip holds a link, which isn’t allowed');
    }
    if (!entry.isFile) continue;
    files.add((name, entry));
    declared += entry.size;
    if (files.length > _maxZipEntries) {
      throw PetSourceError('The zip has too many files');
    }
    if (declared > _maxZipBytes) throw PetSourceError('The zip is too large');
  }
  final temp = await Directory.systemTemp.createTemp('harness-pet-');
  Future<void> cleanup() async {
    if (temp.existsSync()) await temp.delete(recursive: true);
  }

  try {
    var written = 0;
    for (final (name, entry) in files) {
      final bytes = entry.content as List<int>;
      written += bytes.length;
      if (written > _maxZipBytes) throw PetSourceError('The zip is too large');
      final target = File(p.joinAll([temp.path, ...name.split('/')]));
      await target.parent.create(recursive: true);
      await target.writeAsBytes(bytes);
    }
    var root = temp.resolveSymbolicLinksSync();
    bool holdsPet(String dir) =>
        File(p.join(dir, 'pet.json')).existsSync() ||
        File(p.join(dir, 'spritesheet.webp')).existsSync() ||
        File(p.join(dir, 'spritesheet.png')).existsSync();
    if (!holdsPet(root)) {
      final children = Directory(root).listSync();
      if (children.length == 1 && children.single is Directory) {
        root = children.single.path;
      }
    }
    return await _fromDirectory(root, cleanup: cleanup);
  } catch (_) {
    await cleanup();
    rethrow;
  }
}

/// (width, height) from a WebP's header, without decoding; null when [b] isn't
/// a WebP this can read.
(int, int)? webpSize(Uint8List b) {
  String tag(int at) =>
      at + 4 <= b.length ? String.fromCharCodes(b.sublist(at, at + 4)) : '';
  if (b.length < 30 || tag(0) != 'RIFF' || tag(8) != 'WEBP') return null;
  int le(int at, int n) {
    var v = 0;
    for (var i = n - 1; i >= 0; i--) {
      v = (v << 8) | b[at + i];
    }
    return v;
  }

  switch (tag(12)) {
    case 'VP8X':
      return (le(24, 3) + 1, le(27, 3) + 1);
    case 'VP8L':
      if (b[20] != 0x2f) return null;
      final bits = le(21, 4);
      return ((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
    case 'VP8 ':
      if (b[23] != 0x9d || b[24] != 0x01 || b[25] != 0x2a) return null;
      return (le(26, 2) & 0x3fff, le(28, 2) & 0x3fff);
  }
  return null;
}

Future<PetSource> _fromWebp(String path, {required String name}) async {
  final file = File(path);
  if (!file.existsSync()) throw PetSourceError('That file can’t be read');
  if (file.lengthSync() > _maxWebp) {
    throw PetSourceError('The WebP is larger than 8 MB');
  }
  final bytes = await file.readAsBytes();
  final size = webpSize(bytes);
  if (size == null) throw PetSourceError('That isn’t a WebP image');
  if (size != (1536, 1872) && size != (768, 936)) {
    throw PetSourceError(_sheetMessage);
  }
  final Uint8List png;
  try {
    final codec = await ui.instantiateImageCodec(bytes);
    try {
      final image = (await codec.getNextFrame()).image;
      try {
        final data = await image.toByteData(format: ui.ImageByteFormat.png);
        if (data == null) throw StateError('no PNG data');
        png = data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes);
      } finally {
        image.dispose();
      }
    } finally {
      codec.dispose();
    }
  } catch (_) {
    throw PetSourceError('The WebP can’t be decoded');
  }
  final temp = await Directory.systemTemp.createTemp('harness-pet-');
  final out = File(p.join(temp.path, 'sheet.png'));
  await out.writeAsBytes(png);
  return PetSource(
    pngPath: out.path,
    name: name,
    cleanup: () async {
      if (temp.existsSync()) await temp.delete(recursive: true);
    },
  );
}
