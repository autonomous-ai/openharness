import 'dart:async';

import 'package:dio/dio.dart' show CancelToken;
import 'package:flutter/foundation.dart';

import 'model.dart' show superTabMap;
import 'swarm_outgoing_files.dart';
import 'swarm_reader.dart';
import 'swarm_request.dart';

/// What one [SwarmUploads.upload] came to: the files' ids, or what stopped
/// it — neither when it was given up.
typedef SwarmUploaded = ({List<String>? ids, Object? failure});

/// What to tell the person about an upload that stopped on [failure], of
/// [count] files: the backend's own words, or the chat's.
String swarmUploadError(Object failure, int count) => failure is SuperTabFailure
    ? failure.message
    : failure is TimeoutException
    ? 'The upload stopped moving. Try again.'
    : 'Could not upload ${count == 1 ? 'the file' : 'the files'}. Try again.';

/// The files of one composer's message on their way to the backend before
/// the message is sent — the chat's, or a thread's reply box: one by one,
/// each given up when no byte has moved for [timeout], and the ids of those
/// already up kept, so a retry sends them rather than uploading again.
class SwarmUploads {
  SwarmUploads(
    this.reader,
    this.conversationId, {
    required this.timeout,
    required this.onChanged,
    required this.onProgress,
  });

  final SwarmReader reader;

  /// The conversation the files go up for: the only one they may go with.
  final String conversationId;

  /// How long an upload may go without a byte moving before it gives up.
  final Duration timeout;

  /// [uploading] turned on or off.
  final VoidCallback onChanged;

  /// A file went further up, or is up.
  final VoidCallback onProgress;

  /// Files are on their way.
  bool get uploading => _uploading;
  bool _uploading = false;

  /// Files already up for the message being sent, with their ids.
  final _uploaded = <SwarmOutgoingFile, String>{};

  /// How much of each file going up has gone, from 0 to 1.
  final _progress = <SwarmOutgoingFile, double>{};

  /// The files of the upload under way; [_run] moves when it is given up, so
  /// an answer that lands after is dropped.
  List<SwarmOutgoingFile>? _going;
  int _run = 0;
  CancelToken? _cancel;

  /// Whether [file] is still on its way.
  bool isUploading(SwarmOutgoingFile file) =>
      _uploading &&
      (_going?.contains(file) ?? false) &&
      !_uploaded.containsKey(file);

  /// How much of [file] has gone up, from 0 to 1, while it is going up.
  double? progress(SwarmOutgoingFile file) => _progress[file];

  /// Uploads each of [outgoing] that has not gone up yet and returns their
  /// ids, what stopped it, or neither when it was given up meanwhile.
  Future<SwarmUploaded> upload(List<SwarmOutgoingFile> outgoing) async {
    if (outgoing.isEmpty) return (ids: const <String>[], failure: null);
    final run = ++_run;
    _uploading = true;
    _going = outgoing;
    _uploaded.removeWhere((file, _) => !outgoing.contains(file));
    onChanged();
    try {
      final ids = <String>[];
      for (final file in outgoing) {
        var id = _uploaded[file];
        if (id == null) {
          final answer = await _uploadFile(file);
          if (run != _run) return (ids: null, failure: null);
          id = superTabMap(answer['attachment'])['id'] as String;
          _uploaded[file] = id;
          _progress.remove(file);
          onProgress();
        }
        ids.add(id);
      }
      return (ids: ids, failure: null);
    } catch (failure) {
      return (ids: null, failure: run == _run ? failure : null);
    } finally {
      if (run == _run) {
        _uploading = false;
        _going = null;
        _progress.clear();
        onChanged();
      }
    }
  }

  /// Sends [file] to the backend and returns its attachment. Gives up when no
  /// byte has moved for [timeout], or when the upload is given up.
  Future<Map<String, dynamic>> _uploadFile(SwarmOutgoingFile file) async {
    final token = _cancel = CancelToken();
    Timer? watchdog;
    var stalled = false;
    void watch() {
      watchdog?.cancel();
      watchdog = Timer(timeout, () {
        stalled = true;
        token.cancel('stalled');
      });
    }

    watch();
    try {
      // The token also ends a transport that ignores it.
      return await Future.any([
        reader.upload(
          tabId: reader.tabId,
          conversationId: conversationId,
          name: file.name,
          mime: swarmMimeForName(file.name),
          file: file,
          cancel: token,
          onProgress: (sent) {
            if (token.isCancelled) return;
            watch();
            _progress[file] = sent;
            onProgress();
          },
        ),
        token.whenCancel.then<Map<String, dynamic>>(
          (cancelled) => throw cancelled,
        ),
      ]);
    } catch (_) {
      if (stalled) throw TimeoutException('The upload stopped moving.');
      rethrow;
    } finally {
      watchdog?.cancel();
    }
  }

  /// [files] go up again at the next send: the backend refused them, or the
  /// message they went with was taken.
  void forget(Iterable<SwarmOutgoingFile> files) {
    for (final file in files) {
      _uploaded.remove(file);
    }
  }

  /// Gives up the files on their way: the composer is free again, and its
  /// draft and files stay.
  void cancel() {
    if (!_uploading) return;
    _cancel?.cancel('given up');
    _run++;
    _uploading = false;
    _going = null;
    _progress.clear();
    onChanged();
  }

  /// Gives the upload up when one of its files is no longer among [files]:
  /// taken off while it went up.
  void keepTo(List<SwarmOutgoingFile> files) {
    final going = _going;
    if (_uploading && going != null && !files.toSet().containsAll(going)) {
      cancel();
    }
  }

  /// Its composer closed: an upload on its way stops, and tells no one.
  void close() {
    _cancel?.cancel('closed');
    _run++;
  }
}
