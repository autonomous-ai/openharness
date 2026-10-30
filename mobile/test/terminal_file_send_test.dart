import 'dart:async';

import 'package:file_selector/file_selector.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/phone/terminal_file_send.dart';
import 'package:harness_mobile/terminal/terminal_binary.dart';
import 'package:harness_mobile/terminal/terminal_session.dart';

import 'terminal_panel_fixture.dart';

/// A picked file whose size and bytes are said separately — what the picker hands over for a file
/// it can measure without reading, or one it cannot read at all.
class _File extends XFile {
  _File(super.path, {this.size, this.content, this.unreadable = false});

  final int? size;
  final Uint8List? content;
  final bool unreadable;

  @override
  String get name => path;

  @override
  Future<int> length() async => size ?? content?.length ?? 0;

  @override
  Future<Uint8List> readAsBytes() async {
    if (unreadable) throw const _Unreadable();
    return content ?? Uint8List(0);
  }
}

class _Unreadable implements Exception {
  const _Unreadable();
}

/// The key bar's "Choose a file", without the page around it: what it sends, and when it refuses
/// to send at all.
void main() {
  late List<(String, Map<String, dynamic>)> sent;
  late List<String> reports;
  late TerminalSession session;
  late Future<XFile?> Function() restore;

  setUp(() {
    sent = [];
    reports = [];
    session = controllingSession(
      send: (type, payload) async {
        sent.add((type, payload));
        return true;
      },
      sendBinary: (_) async => true,
    );
    restore = pickTerminalFile;
  });

  tearDown(() {
    pickTerminalFile = restore;
    session.dispose();
  });

  Future<void> sendPicked(XFile? file, {bool Function()? stillShowing}) {
    pickTerminalFile = () async => file;
    return sendFileToTerminal(
      session: session,
      stillShowing: stillShowing ?? () => true,
      report: reports.add,
    );
  }

  List<String> types() => [for (final (type, _) in sent) type];

  test('the file goes out as an upload under its own name', () async {
    unawaited(
      sendPicked(_File('report.pdf', content: Uint8List.fromList([1, 2, 3]))),
    );
    await pumpEventQueue();

    final begin = sent.firstWhere(
      (s) => s.$1 == 'terminal_chunked_upload_begin',
    );
    expect(begin.$2['uploadKind'], 'file');
    expect(begin.$2['filename'], 'report.pdf');
    expect(begin.$2['totalBytes'], 3);
    expect(reports, isEmpty);
  });

  test('backing out of the picker says nothing and sends nothing', () async {
    await sendPicked(null);

    expect(sent, isEmpty);
    expect(reports, isEmpty);
  });

  test('a picker that cannot open says so', () async {
    pickTerminalFile = () async => throw PlatformException(code: 'denied');

    await sendFileToTerminal(
      session: session,
      stillShowing: () => true,
      report: reports.add,
    );

    expect(reports, ['Could not open the picker.']);
    expect(sent, isEmpty);
  });

  test('a file over the limit is refused before it is read, in the '
      'desktop’s words', () async {
    await sendPicked(
      _File(
        'big.zip',
        size: terminalLocalPasteFileMaxPayloadBytes + 1,
        unreadable: true,
      ),
    );

    expect(reports, ['big.zip is larger than 20 MB']);
    expect(sent, isEmpty);
  });

  test('a file that grew past the limit by the time it was read is still '
      'refused', () async {
    await sendPicked(
      _File(
        'big.zip',
        size: 1,
        content: Uint8List(terminalLocalPasteFileMaxPayloadBytes + 1),
      ),
    );

    expect(reports, ['big.zip is larger than 20 MB']);
    expect(sent, isEmpty);
  });

  test('a file that cannot be read says which', () async {
    await sendPicked(_File('locked.key', size: 4, unreadable: true));

    expect(reports, ['Could not read locked.key']);
    expect(sent, isEmpty);
  });

  test('an empty file is not sent', () async {
    await sendPicked(_File('empty.txt', content: Uint8List(0)));

    expect(reports, ['empty.txt is empty.']);
    expect(sent, isEmpty);
  });

  test(
    'a stream that changed while the picker was open gets nothing',
    () async {
      pickTerminalFile = () async {
        session.streamId = 's2';
        return _File('notes.md', content: Uint8List.fromList([1]));
      };

      await sendFileToTerminal(
        session: session,
        stillShowing: () => true,
        report: reports.add,
      );

      expect(reports, [fileSendChangedMessage]);
      expect(types(), isNot(contains('terminal_chunked_upload_begin')));
    },
  );

  test('a page no longer showing this session sends nothing', () async {
    var showing = true;
    pickTerminalFile = () async {
      showing = false;
      return _File('notes.md', content: Uint8List.fromList([1]));
    };

    await sendFileToTerminal(
      session: session,
      stillShowing: () => showing,
      report: reports.add,
    );

    expect(reports, [fileSendChangedMessage]);
    expect(sent, isEmpty);
  });

  test('a stream taken over while the picker was open gets nothing', () async {
    pickTerminalFile = () async {
      session.status = TerminalSessionStatus.takenOver;
      return _File('notes.md', content: Uint8List.fromList([1]));
    };

    await sendFileToTerminal(
      session: session,
      stillShowing: () => true,
      report: reports.add,
    );

    expect(reports, [fileSendChangedMessage]);
    expect(types(), isNot(contains('terminal_chunked_upload_begin')));
  });

  test('an upload the machine refuses says it could not be sent', () async {
    final done = sendPicked(
      _File('notes.md', content: Uint8List.fromList([1, 2])),
    );
    await pumpEventQueue();
    await session.handleFrame('terminal_chunked_upload_begin_result', {
      'streamId': session.streamId,
      'accepted': false,
    });
    await done;

    expect(reports, ['The file could not be sent.']);
  });
}
