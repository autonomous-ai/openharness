import 'dart:io';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/theme/app_type.dart';
import 'package:harness/super_tabs/buddy_rows.dart';
import 'package:harness/super_tabs/chat/send_button.dart';
import 'package:harness/super_tabs/avatar_art.dart';
import 'package:harness/super_tabs/identity.dart';
import 'package:harness/super_tabs/message_row.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/tasks/personal_task_card.dart';
import 'package:harness/super_tabs/tasks/personal_tasks.dart';
import 'package:harness/terminal/terminal_typography.dart';

/// The Swarm elements gallery (desktop-design-system.md, Swarm elements): every
/// element drawn in light and dark against its checked-in image. A new or
/// changed element updates the doc and this gallery in the same pull request.
///
/// Update the images with
/// `flutter test --no-pub --update-goldens test/swarm_elements_gallery_test.dart`
/// and look at them before committing.
void main() {
  late GoldenFileComparator previous;
  setUpAll(() async {
    // One font file on every host, so the images match on macOS, Linux and
    // Windows; text is set in the bundled Roboto Mono, icons in Lucide.
    final mono = rootBundle.load('assets/fonts/roboto-mono/RobotoMono.ttf');
    for (final family in {AppType.sansFamily, terminalFontFamily, 'Roboto'}) {
      await (FontLoader(family)..addFont(mono)).load();
    }
    // The activity marks' symbols (◌ ✓ ■ ⊘ and the spinner) come from the
    // host's symbol font, as in the app; they are a few dozen pixels, inside
    // the comparator's tolerance where hosts differ.
    for (final (family, paths) in [
      ('Apple Symbols', ['/System/Library/Fonts/Apple Symbols.ttf']),
      (
        'DejaVu Sans',
        [
          '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
          // macOS has no DejaVu; this face carries the same marks (✓).
          '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
        ],
      ),
    ]) {
      final file = paths.map(File.new).where((f) => f.existsSync()).firstOrNull;
      if (file == null) continue;
      final bytes = ByteData.sublistView(file.readAsBytesSync());
      await (FontLoader(family)..addFont(Future.value(bytes))).load();
    }
    await (FontLoader('packages/lucide_icons_flutter/Lucide400')..addFont(
          rootBundle.load(
            'packages/lucide_icons_flutter/assets/build_font/LucideVariable-w400.ttf',
          ),
        ))
        .load();
    previous = goldenFileComparator;
    goldenFileComparator = _NearlyComparator(
      (previous as LocalFileComparator).basedir.resolve(
        'swarm_elements_gallery_test.dart',
      ),
    );
  });
  tearDownAll(() => goldenFileComparator = previous);

  for (final brightness in Brightness.values) {
    testWidgets('every Swarm element matches its image in ${brightness.name}', (
      tester,
    ) async {
      await _show(tester, brightness);
      (goldenFileComparator as _NearlyComparator).parts = _parts(tester);
      await expectLater(
        find.byKey(_Gallery.boundary),
        matchesGoldenFile('goldens/swarm-elements-${brightness.name}.png'),
      );
    });
  }

  // Review of task #4461: a whole-image tolerance let a changed element pass. Ellis has Kai's colour with another
  // tilt: only its eyes and smile move.
  testWidgets('one changed face fails the gallery', (tester) async {
    await _show(tester, Brightness.light, faces: ['Ellis', ..._faces.skip(1)]);
    final boundary = tester.renderObject<RenderRepaintBoundary>(
      find.byKey(_Gallery.boundary),
    );
    final problem = await tester.runAsync(() async {
      final image = await boundary.toImage();
      final png = await image.toByteData(format: ui.ImageByteFormat.png);
      image.dispose();
      return galleryDifference(
        png!.buffer.asUint8List(),
        File('test/goldens/swarm-elements-light.png').readAsBytesSync(),
        _parts(tester),
      );
    });
    expect(problem, contains('agent face Ellis'));
  });
}

Future<void> _show(
  WidgetTester tester,
  Brightness brightness, {
  List<String> faces = _faces,
}) async {
  final old = grid.AppTheme.brightness.value;
  grid.AppTheme.brightness.value = brightness;
  addTearDown(() => grid.AppTheme.brightness.value = old);
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = const Size(760, 680);
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: grid.buildAppTheme(brightness: brightness),
      // A still spinner, so the image holds one frame.
      home: MediaQuery(
        data: const MediaQueryData(disableAnimations: true),
        child: _Gallery(brightness, faces: faces),
      ),
    ),
  );
  await tester.pump();
  expect(tester.takeException(), isNull);
}

/// One element's area in the gallery and the share of it that may differ.
typedef GalleryRegion = ({String name, Rect rect, double limit});

/// Faces and the Lead ring are paths Skia draws the same on every host: almost
/// nothing of them may differ.
const _art = .01;

/// An icon or letter is a font glyph that each host smooths differently; a
/// different glyph changes far more than this.
const _glyph = .25;

/// Everything else but words (fills, pills, borders, where each element sits)
/// is drawn alike on every host: at most 0.01% of the image (38 pixels) may
/// differ, under the smallest Lead ring's 80, so a lost element fails too. Words
/// are left out: macOS and Linux smooth their edges too differently to compare
/// by pixel (14,638 pixels on one image), and their copy is tested where they
/// are written.
const _rest = .0001;

/// Every element the gallery draws, each held to its own area, and its words,
/// held to none.
({List<GalleryRegion> regions, List<Rect> words}) _parts(WidgetTester tester) =>
    (
      regions: _regions(tester),
      // A glyph's smoothed edge reaches a little past its box.
      words: [
        for (final text in find.byType(RichText).evaluate())
          tester.getRect(find.byElementPredicate((e) => e == text)).inflate(2),
      ],
    );

List<GalleryRegion> _regions(WidgetTester tester) {
  final faces = find.byType(SuperTabAvatarFace);
  final avatars = find.byType(SuperTabAvatar);
  final marks = find.descendant(
    of: find.byType(SuperTabTaskStatusMark),
    matching: find.byType(Icon),
  );
  return [
    for (var i = 0; i < faces.evaluate().length; i++)
      if (tester.widget<SuperTabAvatarFace>(faces.at(i)) case final face)
        face.face && face.picture == null
            ? (
                name: 'agent face ${face.name}',
                rect: tester.getRect(faces.at(i)),
                limit: _art,
              )
            : (
                name: 'avatar ${face.name}',
                rect: tester.getRect(faces.at(i)),
                limit: _glyph,
              ),
    for (var i = 0; i < avatars.evaluate().length; i++)
      if (tester.widget<SuperTabAvatar>(avatars.at(i)) case final avatar
          when avatar.lead)
        (
          name: 'Lead ring ${avatar.name}',
          // The ring, 12% of the face outside its box, and its smoothed edge.
          rect: tester.getRect(avatars.at(i)).inflate(avatar.size * .12 + 1),
          limit: _art,
        ),
    for (var i = 0; i < marks.evaluate().length; i++)
      (
        name: 'status mark ${tester.widget<Icon>(marks.at(i)).semanticLabel}',
        rect: tester.getRect(marks.at(i)),
        limit: _glyph,
      ),
  ];
}

/// Why [actual] does not match [expected], or null when it does. A pixel
/// differs when a channel moves by more than a quarter; each region may hold
/// its share of such pixels, and the image outside the words [_rest].
Future<String?> galleryDifference(
  Uint8List actual,
  Uint8List expected,
  ({List<GalleryRegion> regions, List<Rect> words}) parts,
) async {
  final (a, b) = (await _pixels(actual), await _pixels(expected));
  if (a.width != b.width || a.height != b.height) {
    return 'size ${a.width}x${a.height}, expected ${b.width}x${b.height}';
  }
  bool off(int x, int y) {
    final i = (y * a.width + x) * 4;
    for (var c = 0; c < 4; c++) {
      if ((a.bytes[i + c] - b.bytes[i + c]).abs() > 64) return true;
    }
    return false;
  }

  int count(Rect rect, {List<Rect> skip = const []}) {
    final r = rect.intersect(
      Rect.fromLTWH(0, 0, a.width.toDouble(), a.height.toDouble()),
    );
    var n = 0;
    for (var y = r.top.floor(); y < r.bottom.ceil(); y++) {
      for (var x = r.left.floor(); x < r.right.ceil(); x++) {
        final at = Offset(x + .5, y + .5);
        if (off(x, y) && !skip.any((w) => w.contains(at))) n++;
      }
    }
    return n;
  }

  for (final region in parts.regions) {
    final n = count(region.rect);
    final limit = math.max(
      2,
      region.rect.width * region.rect.height * region.limit,
    );
    if (n > limit) {
      return '${region.name}: $n pixels differ (limit ${limit.floor()})';
    }
  }
  final n = count(
    Rect.fromLTWH(0, 0, a.width.toDouble(), a.height.toDouble()),
    skip: parts.words,
  );
  final limit = a.width * a.height * _rest;
  return n > limit
      ? 'the image outside its words: $n pixels differ (limit ${limit.floor()})'
      : null;
}

Future<({int width, int height, Uint8List bytes})> _pixels(
  Uint8List png,
) async {
  final codec = await ui.instantiateImageCodec(png);
  final image = (await codec.getNextFrame()).image;
  final data = await image.toByteData();
  final pixels = (
    width: image.width,
    height: image.height,
    bytes: data!.buffer.asUint8List(),
  );
  image.dispose();
  codec.dispose();
  return pixels;
}

/// Agent names that pick each of the face's eight colours, in palette order.
const _faces = [
  'Kai',
  'River',
  'Quinn',
  'Buddy',
  'Atlas',
  'Ivy',
  'Milo',
  'Nova',
];

const _statuses = [
  'proposal',
  'planned',
  'working',
  'needs_human',
  'review',
  'blocked',
  'done',
  'stopped',
  'lost',
  'rejected',
];

SuperTabAgent _agent(String name, {String? kind}) => SuperTabAgent.fromJson({
  'id': 'id-$name',
  'name': name,
  'machineId': 'm',
  'harnessId': 'h',
  'contributorId': 'p',
  'configuration': {'engine': 'claude'},
  'kind': ?kind,
});

final _person = SuperTabPerson.fromJson({
  'id': 'p1',
  'email': 'dee@example.com',
  'role': 'owner',
});

class _Gallery extends StatelessWidget {
  const _Gallery(this.brightness, {required this.faces});
  final Brightness brightness;
  final List<String> faces;
  static const boundary = ValueKey('swarm-elements-gallery');

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    Widget title(String text) => Padding(
      padding: const EdgeInsets.only(top: 14, bottom: 8),
      child: Text(text, style: Theme.of(context).textTheme.labelLarge),
    );
    Widget gap() => const SizedBox(width: 16);
    return RepaintBoundary(
      key: boundary,
      child: Material(
        color: Theme.of(context).colorScheme.surface,
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'Swarm elements / ${brightness.name}',
                style: Theme.of(context).textTheme.titleMedium,
              ),
              title('Agent face: eight colours'),
              Row(
                children: [
                  for (final name in faces) ...[
                    SuperTabAvatar.agent(
                      _agent(name),
                      size: 40,
                      engineBadge: false,
                    ),
                    gap(),
                  ],
                ],
              ),
              title('Agent face, Lead ring and person at 20, 24, 30'),
              Row(
                children: [
                  for (final size in [20.0, 24.0, 30.0]) ...[
                    SuperTabAvatar.agent(
                      _agent('Kai'),
                      size: size,
                      engineBadge: false,
                    ),
                    gap(),
                    SuperTabAvatar.agent(
                      _agent('River'),
                      size: size,
                      engineBadge: false,
                      lead: true,
                    ),
                    gap(),
                    SuperTabAvatar.person(_person, size: size),
                    gap(),
                    gap(),
                  ],
                ],
              ),
              title('Task status marks'),
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  for (final status in _statuses)
                    SizedBox(
                      width: 72,
                      child: Column(
                        children: [
                          SuperTabTaskStatusMark(status),
                          const SizedBox(height: 4),
                          Text(
                            superTabTaskStatusLabel(status),
                            textAlign: TextAlign.center,
                            maxLines: 2,
                            style: Theme.of(context).textTheme.labelSmall,
                          ),
                        ],
                      ),
                    ),
                ],
              ),
              title('Row and task card'),
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  SizedBox(
                    width: 280,
                    child: Column(
                      children: [
                        SuperTabBuddyRow(
                          agentId: 'id-River',
                          agent: _agent('River', kind: 'pm'),
                          name: 'River',
                          note: 'harness',
                          tooltip: 'River',
                          lead: true,
                          onTap: () {},
                        ),
                        SuperTabBuddyRow(
                          agentId: 'id-Quinn',
                          agent: _agent('Quinn'),
                          name: 'Quinn',
                          tooltip: 'Quinn',
                          selected: true,
                          onTap: () {},
                        ),
                      ],
                    ),
                  ),
                  gap(),
                  SizedBox(
                    width: 340,
                    child: SuperTabPersonalTaskCard(
                      task: SuperTabPersonalTask({
                        'id': 't1',
                        'version': 1,
                        'at': 0,
                        'projectId': 'harness',
                        'projectName': 'harness',
                        'title': 'Friendly agent faces and a gold Lead ring',
                        'status': 'proposal',
                      }),
                      project: 'harness',
                      selected: false,
                      onOpen: () {},
                      requester: SuperTabAvatar.person(_person, size: 20),
                      agent: SuperTabAvatar.agent(
                        _agent('Quinn'),
                        size: 20,
                        engineBadge: false,
                      ),
                      waiting: true,
                    ),
                  ),
                ],
              ),
              title('Chat: message rows and send'),
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  SizedBox(
                    width: 440,
                    child: Column(
                      children: [
                        _message(
                          'River',
                          'New Project is in the sidebar now.',
                          agent: _agent('River'),
                        ),
                        _message('dee', 'Found it, thanks!', person: _person),
                      ],
                    ),
                  ),
                  gap(),
                  const SwarmSendButton(tooltip: 'Send', onPressed: null),
                  gap(),
                  SwarmSendButton(tooltip: 'Send', onPressed: () {}),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// A chat message row, as the chat draws one; no time, so the image is the
/// same in every time zone.
Widget _message(
  String author,
  String text, {
  SuperTabAgent? agent,
  SuperTabPerson? person,
}) => SuperTabMessageRow(
  message: SuperTabMessage.fromJson({
    'id': 'm-$author',
    'conversationId': 'lead',
    'text': text,
    'sequence': 1,
    'author': agent != null
        ? {'kind': 'agent', 'id': agent.id, 'name': author}
        : {'kind': 'person', 'id': person!.id, 'name': 'dee@example.com'},
  }),
  author: author,
  agent: agent,
  person: person,
  receipts: const [],
  onReturnToComposer: () {},
  readerId: 'p1',
);

/// Matches when [galleryDifference] finds none. A mismatch fails with what
/// differs and saves the image it drew to the system temp folder, never into
/// the source tree, where CI's runner would count it as a changed source.
class _NearlyComparator extends LocalFileComparator {
  _NearlyComparator(super.testFile);

  /// The elements and words of the image being compared.
  ({List<GalleryRegion> regions, List<Rect> words}) parts = (
    regions: const [],
    words: const [],
  );

  @override
  Future<bool> compare(Uint8List imageBytes, Uri golden) async {
    final file = File.fromUri(basedir.resolveUri(golden));
    final problem = file.existsSync()
        ? await galleryDifference(imageBytes, file.readAsBytesSync(), parts)
        : 'no image yet; make it with --update-goldens';
    if (problem == null) return true;
    final drawn = File(
      '${Directory.systemTemp.createTempSync('swarm-gallery-').path}/'
      '${golden.pathSegments.last}',
    )..writeAsBytesSync(imageBytes);
    throw FlutterError('$golden: $problem. What it drew: ${drawn.path}');
  }
}
