import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/ws/daemon_pipe_record.dart';

const _id = '0123456789abcdef0123456789abcdef';
const _pipe = r'\\.\pipe\harness-' + _id;
final _token = Uint8List.fromList(List.generate(32, (i) => i));
final _tokenHex = [for (final b in _token) b.toRadixString(16).padLeft(2, '0')]
    .join();

void main() {
  late Directory dir;

  setUp(() => dir = Directory.systemTemp.createTempSync('hrecord-'));
  tearDown(() => dir.deleteSync(recursive: true));

  void record(Object? value, {int port = 28473}) =>
      File('${dir.path}/daemon-$port.json')
          .writeAsStringSync(value is String ? value : jsonEncode(value));
  void token(String text) =>
      File('${dir.path}/daemon-token').writeAsStringSync(text);
  DaemonPipeRecord? read({int port = 28473, bool isWindows = true}) =>
      readDaemonPipeRecord(dataDir: dir.path, port: port, isWindows: isWindows);

  group('defaultDaemonDataDir', () {
    test(
      'is the CLI data folder in the profile on Windows, and in HOME elsewhere',
      () {
        expect(
          defaultDaemonDataDir(
            environment: {'USERPROFILE': r'C:\Users\Nguyễn Văn A'},
            isWindows: true,
          ),
          r'C:\Users\Nguyễn Văn A\.harness\cli\data',
        );
        expect(
          defaultDaemonDataDir(
            environment: {'HOME': '/Users/me'},
            isWindows: false,
          ),
          '/Users/me/.harness/cli/data',
        );
      },
    );

    test('takes ADAPTER_DATA_DIR first, and is null with no home', () {
      expect(
        defaultDaemonDataDir(
          environment: {
            'USERPROFILE': r'C:\Users\me',
            'ADAPTER_DATA_DIR': r'D:\scratch\data',
          },
          isWindows: true,
        ),
        r'D:\scratch\data',
      );
      expect(
        defaultDaemonDataDir(environment: const {}, isWindows: true),
        isNull,
      );
    });
  });

  group('readDaemonPipeRecord', () {
    test('reads the pipe the core recorded and the token beside it', () {
      record({'port': 51234, 'pipe': _pipe, 'pid': 4242});
      token('$_tokenHex\n');
      final found = read()!;
      expect(found.pipePath, _pipe);
      expect(found.pipeId, _id);
      expect(found.token, _token);
      // A token file without its newline is a whole token too.
      token(_tokenHex);
      expect(read()!.token, _token);
    });

    test('rereads the path and token after every daemon restart', () {
      record({'port': 51234, 'pipe': _pipe});
      token(_tokenHex);
      expect(read()!.pipePath, _pipe);
      const nextId = 'abcdef0123456789abcdef0123456789';
      const nextPipe = r'\\.\pipe\harness-' + nextId;
      record({'port': 51235, 'pipe': nextPipe});
      token('aa' * 32);
      final next = read()!;
      expect(next.pipePath, nextPipe);
      expect(next.pipeId, nextId);
      expect(next.token, List.filled(32, 0xaa));
      File('${dir.path}/daemon-28473.json').deleteSync();
      expect(read(), isNull);
    });

    test('reads the record named for the port it is asked about', () {
      record({'port': 51234, 'pipe': _pipe}, port: 28474);
      token(_tokenHex);
      expect(read(), isNull);
      expect(read(port: 28474)?.pipePath, _pipe);
    });

    test('refuses a pipe name that is not a local Harness pipe', () {
      token(_tokenHex);
      for (final pipe in <Object?>[
        null,
        42,
        '',
        r'\\.\pipe\harness-' + _id.toUpperCase(),
        r'\\.\pipe\evilharness-' + _id,
        r'\\.\pipe\x\harness-' + _id,
        r'\\host\pipe\harness-' + _id,
        r'\\?\pipe\harness-' + _id,
        '//./pipe/harness-$_id',
        r'C:\x\harness-' + _id,
        '$_pipe\n',
        r'\\.\pipe\harness-' + _id.substring(1),
        '/tmp/x/harness-$_id',
      ]) {
        record({'port': 51234, 'pipe': pipe});
        expect(read(), isNull, reason: '$pipe');
      }
    });

    test('off Windows takes only a stand-in socket named harness-<id>, as the CLI\'s tests record', () {
      token(_tokenHex);
      record({'port': 51234, 'pipe': '/tmp/x/harness-$_id'});
      expect(read(isWindows: false)?.pipeId, _id);
      for (final pipe in [
        '/tmp/x/evilharness-$_id',
        '/tmp/daemon.sock',
        _pipe,
      ]) {
        record({'port': 51234, 'pipe': pipe});
        expect(read(isWindows: false), isNull, reason: pipe);
      }
    });

    test('refuses a token of the wrong length or form', () {
      record({'port': 51234, 'pipe': _pipe});
      for (final text in [
        '',
        _tokenHex.substring(1),
        '${_tokenHex}0',
        '$_tokenHex\n\n',
        '$_tokenHex\r\n',
        _tokenHex.toUpperCase(),
        ' $_tokenHex',
        '${_tokenHex.substring(2)}zz',
      ]) {
        token(text);
        expect(read(), isNull, reason: jsonEncode(text));
      }
    });

    test(
      'refuses a record or token that is missing, unreadable, or not a file',
      () {
        expect(read(), isNull, reason: 'no record');
        record({'port': 51234, 'pipe': _pipe});
        expect(read(), isNull, reason: 'no token');
        Directory('${dir.path}/daemon-token').createSync();
        expect(read(), isNull, reason: 'a folder where the token should be');
        Directory('${dir.path}/daemon-token').deleteSync();
        token(_tokenHex);
        for (final text in ['', '{', '[]', '"x"', 'null']) {
          record(text);
          expect(read(), isNull, reason: text);
        }
        record(
          '{"pipe": "$_pipe", "pad": "${'x' * 5000}"}'.replaceAll(r'\', r'\\'),
        );
        expect(read(), isNull, reason: 'larger than any record');
      },
    );

    test(
      'refuses a record that is a link',
      () {
        token(_tokenHex);
        final elsewhere = File('${dir.path}/elsewhere')
          ..writeAsStringSync(jsonEncode({'pipe': _pipe}));
        Link('${dir.path}/daemon-28473.json').createSync(elsewhere.path);
        expect(read(), isNull);
      },
      skip: Platform.isWindows
          ? 'a file link needs Developer Mode on Windows'
          : false,
    );

    test(
      'refuses a token that is a link',
      () {
        record({'port': 51234, 'pipe': _pipe});
        final elsewhere = File('${dir.path}/elsewhere')
          ..writeAsStringSync(_tokenHex);
        Link('${dir.path}/daemon-token').createSync(elsewhere.path);
        expect(read(), isNull);
      },
      skip: Platform.isWindows
          ? 'a file link needs Developer Mode on Windows'
          : false,
    );
  });
}
