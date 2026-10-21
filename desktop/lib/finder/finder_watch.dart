import 'dart:async';
import 'dart:io';

import 'package:path/path.dart' as p;

/// Git's own files worth hearing about: what was staged, which branch is out
/// and where branches point. Everything else under `.git` is churn.
final _gitSignals = RegExp(r'[/\\]\.git[/\\](index|HEAD|refs[/\\].*)$');

/// The paths under [root] that changed, in batches [settle] apart — one
/// `git checkout` is thousands of events and should be one refresh.
///
/// macOS reports the whole tree (FSEvents). Where the platform cannot watch
/// recursively (Linux), only the root's own entries are heard; the tile's
/// safety refresh covers the rest.
Stream<Set<String>> watchFolder(
  String root, {
  Duration settle = const Duration(milliseconds: 150),
}) {
  final pending = <String>{};
  StreamSubscription<FileSystemEvent>? events;
  Timer? timer;
  late final StreamController<Set<String>> batches;

  void hear(FileSystemEvent event) {
    for (final path in [
      event.path,
      if (event is FileSystemMoveEvent) ?event.destination,
    ]) {
      if (_worthHearing(path)) pending.add(p.normalize(path));
    }
    if (pending.isEmpty) return;
    timer ??= Timer(settle, () {
      timer = null;
      batches.add({...pending});
      pending.clear();
    });
  }

  batches = StreamController<Set<String>>(
    onListen: () {
      Stream<FileSystemEvent> source;
      try {
        source = Directory(root).watch(recursive: !Platform.isLinux);
      } on FileSystemException {
        return;
      }
      events = source.listen(hear, onError: (Object _) {});
    },
    onCancel: () async {
      timer?.cancel();
      await events?.cancel();
    },
  );
  return batches.stream;
}

bool _worthHearing(String path) {
  final parts = p.split(path);
  if (parts.contains('node_modules')) return false;
  if (!parts.contains('.git')) return true;
  return _gitSignals.hasMatch(path);
}

/// Whether [path] is one of Git's own files rather than the project's.
bool isGitInternal(String path) => p.split(path).contains('.git');
