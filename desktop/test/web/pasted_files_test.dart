@TestOn('browser')
library;

import 'dart:js_interop';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/clipboard/pasted_files.dart';
import 'package:web/web.dart' as web;

/// A paste the way a browser delivers one: files and text on a clipboard.
web.ClipboardEvent _paste({List<web.File> files = const [], String? text}) {
  final clipboard = web.DataTransfer();
  for (final file in files) {
    clipboard.items.add(file);
  }
  if (text != null) clipboard.setData('text/plain', text);
  return web.ClipboardEvent(
    'paste',
    web.ClipboardEventInit(
      clipboardData: clipboard,
      bubbles: true,
      cancelable: true,
    ),
  );
}

web.File _file(String name, List<int> bytes) => web.File(
  [Uint8List.fromList(bytes).toJS].toJS,
  name,
  web.FilePropertyBag(type: 'image/png'),
);

void main() {
  late List<List<PastedFile>> heard;
  late void Function() stop;
  var wanted = true;

  setUp(() {
    heard = [];
    wanted = true;
    stop = listenForPastedFiles(wanted: () => wanted, onFiles: heard.add);
  });
  tearDown(() => stop());

  // Whether the paste was taken is decided while it is dispatched (the listener's preventDefault); a
  // paste not taken is never read, so nothing more can arrive for it.
  bool dispatch(web.ClipboardEvent event) {
    web.document.body!.dispatchEvent(event);
    return event.defaultPrevented;
  }

  // A paste taken is read after the event: wait for its files to be handed over, not for a fixed
  // time (task #3730: 50 ms was not always enough on a busy machine).
  Future<void> heardPastes(int count) async {
    final deadline = DateTime.now().add(const Duration(seconds: 10));
    while (heard.length < count) {
      if (DateTime.now().isAfter(deadline)) {
        fail('expected $count paste(s) handed over, heard ${heard.length}');
      }
      await Future<void>.delayed(Duration.zero);
    }
  }

  test('a pasted picture is handed over, with its bytes, not typed', () async {
    final taken = dispatch(
      _paste(
        files: [
          _file('image.png', [1, 2, 3]),
        ],
      ),
    );
    expect(taken, isTrue);
    await heardPastes(1);
    expect(heard.single.single.name, 'image.png');
    expect(heard.single.single.bytes, [1, 2, 3]);
  });

  test('every file of one paste arrives together', () async {
    expect(
      dispatch(
        _paste(
          files: [
            _file('a.png', [1]),
            _file('b.png', [2, 2]),
          ],
        ),
      ),
      isTrue,
    );
    await heardPastes(1);
    expect([for (final file in heard.single) file.name], ['a.png', 'b.png']);
  });

  test('text beside the files is left for the field', () async {
    final taken = dispatch(
      _paste(
        files: [
          _file('image.png', [1]),
        ],
        text: 'the words copied',
      ),
    );
    expect(taken, isFalse);
    expect(heard, isEmpty);
  });

  test("a copied image's own address does not hide the image", () async {
    final taken = dispatch(
      _paste(
        files: [
          _file('image.png', [1]),
        ],
        text: 'https://example.com/cat.png',
      ),
    );
    expect(taken, isTrue);
    await heardPastes(1);
    expect(heard, hasLength(1));
  });

  test('a paste of text alone, or one nobody wants, is not touched', () async {
    expect(dispatch(_paste(text: 'hello')), isFalse);
    wanted = false;
    expect(
      dispatch(
        _paste(
          files: [
            _file('image.png', [1]),
          ],
        ),
      ),
      isFalse,
    );
    expect(heard, isEmpty);
  });

  test('after stopping, nothing is heard', () async {
    stop();
    expect(
      dispatch(
        _paste(
          files: [
            _file('image.png', [1]),
          ],
        ),
      ),
      isFalse,
    );
    expect(heard, isEmpty);
  });
}
