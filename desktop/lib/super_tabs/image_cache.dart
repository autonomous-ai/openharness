import 'dart:async';
import 'dart:convert';
import 'dart:ui';

import 'package:flutter/foundation.dart';

import '../core/test_run.dart';
import '../logging/app_log.dart';
import 'image_shelf_native.dart'
    if (dart.library.js_interop) 'image_shelf_web.dart';

/// The most the chat's pictures may take on disk: 200 MB, about two hundred
/// screenshots. A browser keeps them in memory, and less ([kDefaultShelfBytes]).
const kSuperTabImageCacheBytes = 200 * 1024 * 1024;

/// One picture on a shelf: its name, its weight, and when it was last shown.
@immutable
class SuperTabShelfEntry {
  const SuperTabShelfEntry({
    required this.name,
    required this.bytes,
    required this.usedAt,
  });

  final String name;
  final int bytes;
  final DateTime usedAt;
}

/// Where [SuperTabImageCache] keeps its pictures, by name: a private folder on
/// a computer ([DirectoryImageShelf]), memory in a browser and in tests.
abstract interface class SuperTabImageShelf {
  /// Every picture kept, a write left half done excepted (and removed).
  Future<List<SuperTabShelfEntry>> list();

  /// The picture [name], or null when there is none.
  Future<Uint8List?> read(String name);

  /// Keeps [bytes] as [name], whole or not at all.
  Future<void> write(String name, Uint8List bytes);

  /// Marks [name] shown now.
  Future<void> touch(String name);

  Future<void> delete(String name);

  /// Every picture gone.
  Future<void> clear();
}

/// A shelf in memory: a browser's, which has no Harness home, and every test's,
/// where a real file write never completes inside `testWidgets`.
class MemoryImageShelf implements SuperTabImageShelf {
  final _pictures = <String, (Uint8List, int)>{};

  /// Shown order, not wall time: two writes in one microsecond stay ordered.
  int _tick = 0;

  @override
  Future<List<SuperTabShelfEntry>> list() async => [
    for (final MapEntry(:key, value: (bytes, used)) in _pictures.entries)
      SuperTabShelfEntry(
        name: key,
        bytes: bytes.length,
        usedAt: DateTime.fromMicrosecondsSinceEpoch(used),
      ),
  ];

  @override
  Future<Uint8List?> read(String name) async => _pictures[name]?.$1;

  @override
  Future<void> write(String name, Uint8List bytes) async =>
      _pictures[name] = (bytes, ++_tick);

  @override
  Future<void> touch(String name) async {
    if (_pictures[name] case (final bytes, _)) {
      _pictures[name] = (bytes, ++_tick);
    }
  }

  @override
  Future<void> delete(String name) async => _pictures.remove(name);

  @override
  Future<void> clear() async => _pictures.clear();
}

/// The chat's pictures by file id, so a fresh short-lived link to a file
/// already seen downloads nothing (task #3178). Each is kept under
/// `<file id>~<width>x<height>`, its shape read back by the next launch from
/// the name alone, so the chat holds each picture's place at its shape before
/// its bytes are read. Above [capBytes], the least recently shown go first.
///
/// It holds only what the reader may read: a picture is asked of it only by a
/// load that began with a link the server signed for this reader
/// (`AttachmentImage`), and it is emptied on sign-out.
class SuperTabImageCache {
  SuperTabImageCache(this._shelf, {this.capBytes = kSuperTabImageCacheBytes});

  final SuperTabImageShelf _shelf;
  final int capBytes;

  /// What is kept, by file id: its name on the shelf and its shape.
  final _kept = <String, ({String name, Size shape, int bytes})>{};
  int _total = 0;

  int _generation = 0;

  /// Moves on at each [clear]: a load that began before it keeps nothing.
  int get generation => _generation;

  Future<void>? _listed;

  /// Done once the shelf has been listed (and, at launch, [claim]ed), so
  /// [shapeOf] knows what an earlier launch kept.
  Future<void> get ready => _listed ??= _serial(_list);

  /// The shelf's writes, clears and claims, one after another: a clear waits
  /// for a write under way, then takes it too.
  Future<void>? _tail;

  Future<T> _serial<T>(Future<T> Function() work) {
    // Chained from the caller's own zone: a finished future made elsewhere
    // would run the work in the zone that made it.
    final next = switch (_tail) {
      null => Future<T>.sync(work),
      final tail => tail.then((_) => work()),
    };
    _tail = next.then((_) {}, onError: (Object _) {});
    return next;
  }

  /// Whose pictures these are: the CLI's machine id they were kept under, the
  /// one id that proves an account with no network (as `ProfileCache` keeps
  /// it). Not a picture's name, so never listed, shown or evicted.
  static const _ownerName = 'owner';

  /// At launch: the pictures stay only when [owner], the machine id the CLI is
  /// signed in under now (null: signed out), is the one they were kept under.
  /// A sign-out this app never saw (in a terminal, while it was closed, or a
  /// clear that failed) leaves them to this, and so does another account
  /// signing in on this computer. Reads wait for it.
  Future<void> claim(String? owner) => _listed = _serial(() async {
    try {
      final mark = await _shelf.read(_ownerName);
      final was = mark == null ? null : utf8.decode(mark, allowMalformed: true);
      final pictures = (await _shelf.list()).any(
        (entry) => entry.name != _ownerName,
      );
      if (owner == null || (was != owner && (was != null || pictures))) {
        _forgetAll();
        await _shelf.clear();
      }
      if (owner != null && was != owner) {
        await _shelf.write(_ownerName, utf8.encode(owner));
      }
    } catch (error) {
      appLog.warn(
        'super-tabs',
        'image cache not claimed: ${error.runtimeType}',
      );
    }
    await _list();
  });

  /// A sign-in this session proved [owner]: what it keeps is its, at the next
  /// launch too. Pictures under another owner are not adopted but cleared.
  Future<void> owned(String owner) => _serial(() async {
    try {
      final mark = await _shelf.read(_ownerName);
      final was = mark == null ? null : utf8.decode(mark, allowMalformed: true);
      if (was == owner) return;
      if (was != null) {
        _forgetAll();
        await _shelf.clear();
      }
      await _shelf.write(_ownerName, utf8.encode(owner));
    } catch (error) {
      appLog.warn('super-tabs', 'image cache not owned: ${error.runtimeType}');
    }
  });

  void _forgetAll() {
    _generation++;
    _kept.clear();
    _total = 0;
  }

  /// A file id that can name a file anywhere, and its thumbnail (#3177):
  /// nothing that can leave the folder or clash with `~`.
  static final _plainId = RegExp(r'^[A-Za-z0-9_-]{1,128}(\.thumb)?$');

  static final _named = RegExp(r'^(.+)~(\d{1,6})x(\d{1,6})$');

  Future<void> _list() async {
    final List<SuperTabShelfEntry> entries;
    try {
      entries = await _shelf.list();
    } catch (error) {
      appLog.warn('super-tabs', 'image cache unreadable: ${error.runtimeType}');
      return;
    }
    for (final entry in entries) {
      final named = _named.firstMatch(entry.name);
      if (named == null || !_plainId.hasMatch(named[1]!)) continue;
      _forget(named[1]!);
      _kept[named[1]!] = (
        name: entry.name,
        shape: Size(double.parse(named[2]!), double.parse(named[3]!)),
        bytes: entry.bytes,
      );
      _total += entry.bytes;
    }
  }

  void _forget(String fileId) {
    if (_kept.remove(fileId) case final old?) _total -= old.bytes;
  }

  /// [fileId]'s width and height, as an earlier load read them; null when
  /// unknown, or before the shelf is listed ([ready]).
  Size? shapeOf(String fileId) {
    unawaited(ready);
    return _kept[fileId]?.shape;
  }

  /// [fileId]'s bytes, or null when not kept.
  Future<Uint8List?> read(String fileId) async {
    await ready;
    final kept = _kept[fileId];
    if (kept == null) return null;
    try {
      final bytes = await _shelf.read(kept.name);
      if (bytes == null) {
        _forget(fileId);
        return null;
      }
      unawaited(_shelf.touch(kept.name).catchError((Object _) {}));
      return bytes;
    } catch (error) {
      appLog.warn(
        'super-tabs',
        'image cache read failed: ${error.runtimeType}',
      );
      return null;
    }
  }

  /// Keeps [bytes] as [fileId]'s, [shape] its width and height. Nothing is
  /// kept when the cache was cleared since [generation] (the load's own, from
  /// when it began), for a picture larger than [capBytes], or for an id that
  /// is not a plain one.
  Future<void> keep(
    String fileId,
    Uint8List bytes,
    Size shape, {
    int? generation,
  }) async {
    final began = generation ?? _generation;
    if (began != _generation) return;
    if (!_plainId.hasMatch(fileId) || bytes.length > capBytes) return;
    await ready;
    final name = '$fileId~${shape.width.round()}x${shape.height.round()}';
    try {
      await _serial(() async {
        // Cleared while this waited its turn: nothing of it is kept.
        if (began != _generation) return;
        final old = _kept[fileId];
        await _shelf.write(name, bytes);
        if (old != null && old.name != name) await _shelf.delete(old.name);
        _forget(fileId);
        _kept[fileId] = (name: name, shape: shape, bytes: bytes.length);
        _total += bytes.length;
        if (_total > capBytes) await _evict();
      });
    } catch (error) {
      appLog.warn(
        'super-tabs',
        'image cache write failed: ${error.runtimeType}',
      );
    }
  }

  /// Down to the cap, the least recently shown first. The shelf is listed
  /// again, since another window may have kept or dropped pictures meanwhile.
  Future<void> _evict() async {
    final entries = await _shelf.list()
      ..sort((a, b) => a.usedAt.compareTo(b.usedAt));
    final pictures = [
      for (final entry in entries)
        if (_named.firstMatch(entry.name) case final named?) (entry, named[1]!),
    ];
    var total = pictures.fold<int>(0, (sum, p) => sum + p.$1.bytes);
    for (final (entry, fileId) in pictures) {
      if (total <= capBytes) break;
      await _shelf.delete(entry.name);
      total -= entry.bytes;
      if (_kept[fileId]?.name == entry.name) _forget(fileId);
    }
  }

  /// [fileId]'s picture gone: what was kept did not read as a picture.
  Future<void> drop(String fileId) async {
    final kept = _kept[fileId];
    if (kept == null) return;
    _forget(fileId);
    try {
      await _shelf.delete(kept.name);
    } catch (error) {
      appLog.warn(
        'super-tabs',
        'image cache drop failed: ${error.runtimeType}',
      );
    }
  }

  /// Every picture gone, and their shapes: signing out.
  Future<void> clear() async {
    _forgetAll();
    try {
      await _serial(_shelf.clear);
    } catch (error) {
      appLog.warn(
        'super-tabs',
        'image cache not cleared: ${error.runtimeType}',
      );
    }
  }
}

/// This app's picture cache: a private folder on a computer, memory in a
/// browser and in tests, which may set their own.
SuperTabImageCache superTabImageCache = kUnderTest
    ? SuperTabImageCache(MemoryImageShelf())
    : SuperTabImageCache(defaultImageShelf(), capBytes: kDefaultShelfBytes);

/// What the cache keeps file [fileId]'s thumbnail (#3177) under, apart from
/// the original: the two are different pictures of one file.
String superTabThumbId(String fileId) => '$fileId.thumb';
