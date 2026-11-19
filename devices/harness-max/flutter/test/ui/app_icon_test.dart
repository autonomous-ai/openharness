import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_max_bar/ui/app_icon.dart';

void main() {
  test('Harness has its symbol as an asset, whatever the id is written as', () {
    expect(appIconAsset('harness'), 'assets/apps/harness.png');
    expect(appIconAsset('Harness'), 'assets/apps/harness.png');
    expect(hasAppIcon('harness'), isTrue);
  });

  test('the Harness symbol ships in the bundle', () async {
    TestWidgetsFlutterBinding.ensureInitialized();
    final png = await rootBundle.load('assets/apps/harness.png');
    // PNG signature: the asset is a picture, not a placeholder.
    expect(png.buffer.asUint8List(0, 4), [0x89, 0x50, 0x4E, 0x47]);
  });

  testWidgets('Harness draws its symbol as the other apps draw theirs, no lettered square', (tester) async {
    await tester.pumpWidget(const Directionality(
      textDirection: TextDirection.ltr,
      child: Center(child: AppIcon('harness', size: 60)),
    ));
    final image = tester.widget<Image>(find.byType(Image));
    expect((image.image as AssetImage).assetName, 'assets/apps/harness.png');
    expect(tester.getSize(find.byType(Image)), const Size(60, 60));
    expect(find.text('H'), findsNothing);
  });

  test('an app the mockup has no icon for still has none', () {
    expect(appIconAsset('ghostty'), isNull);
    expect(hasAppIcon('ghostty'), isFalse);
  });
}
