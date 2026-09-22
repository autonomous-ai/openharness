import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/device_name.dart';

/// What a desktop will call this phone on its "took control" banner: the
/// person's own name for it, else the OS's, else the model — never "localhost".
void main() {
  const iphoneGeneric = DeviceInfo(
    name: 'iPhone',
    model: 'iPhone',
    modelCode: 'iPhone16,1',
    manufacturer: 'Apple',
  );

  test('the name given in Settings wins over everything', () {
    expect(
      composePhoneName(
        override: '  Work phone ',
        device: const DeviceInfo(name: "Hieu's iPhone"),
        userName: 'Hieu Nguyen',
      ),
      'Work phone',
    );
  });

  test("the OS's own name for the device is used when it is a real one", () {
    expect(
      composePhoneName(
        device: const DeviceInfo(
          name: "Hieu's iPhone",
          model: 'iPhone',
          modelCode: 'iPhone16,1',
        ),
      ),
      "Hieu's iPhone",
    );
    // The simulator reports the device it is pretending to be.
    expect(
      composePhoneName(
        device: const DeviceInfo(name: 'iPhone 16 Pro', model: 'iPhone'),
      ),
      'iPhone 16 Pro',
    );
    expect(
      composePhoneName(
        device: const DeviceInfo(
          name: 'Galaxy S23 của Hiếu',
          model: 'SM-S911B',
          manufacturer: 'samsung',
        ),
      ),
      'Galaxy S23 của Hiếu',
    );
  });

  test('a generic name falls back to the model, by its marketing name', () {
    expect(composePhoneName(device: iphoneGeneric), 'iPhone 15 Pro');
    expect(
      composePhoneName(
        device: const DeviceInfo(
          name: 'iPad',
          model: 'iPad',
          modelCode: 'iPad16,3',
        ),
      ),
      'iPad Pro 11" (M4)',
    );
    expect(
      composePhoneName(
        device: const DeviceInfo(
          model: 'SM-S911B',
          modelCode: 'dm3q',
          manufacturer: 'samsung',
        ),
      ),
      'Samsung SM-S911B',
    );
    expect(
      composePhoneName(
        device: const DeviceInfo(model: 'Pixel 8', manufacturer: 'Google'),
      ),
      'Google Pixel 8',
    );
    // A brand already in the model is not said twice.
    expect(
      composePhoneName(
        device: const DeviceInfo(model: 'Xiaomi 14', manufacturer: 'Xiaomi'),
      ),
      'Xiaomi 14',
    );
  });

  test("localhost is not a name, and neither is the model code", () {
    expect(isGenericDeviceName('localhost'), isTrue);
    expect(isGenericDeviceName('MacbookPro.local'), isTrue);
    expect(isGenericDeviceName('iPhone16,1', modelCode: 'iPhone16,1'), isTrue);
    expect(isGenericDeviceName('iPhone'), isTrue);
    expect(isGenericDeviceName("Hieu's iPhone"), isFalse);
    expect(
      composePhoneName(
        device: const DeviceInfo(name: 'localhost', modelCode: 'iPhone16,1'),
      ),
      'iPhone 15 Pro',
    );
  });

  test('an unknown model with a signed-in name reads as a possessive', () {
    expect(
      composePhoneName(
        device: const DeviceInfo(
          name: 'iPhone',
          model: 'iPhone',
          modelCode: 'iPhone99,9',
        ),
        userName: 'Hieu Nguyen',
      ),
      "Hieu's iPhone",
    );
    expect(
      composePhoneName(
        device: const DeviceInfo(name: 'iPhone', model: 'iPhone'),
      ),
      'iPhone',
    );
    expect(composePhoneName(userName: 'Hieu'), "Hieu's phone");
    expect(composePhoneName(), 'Phone');
  });

  test('a name is cut to the wire and stripped of control characters', () {
    expect(composePhoneName(override: 'x' * 100).length, phoneNameMax);
    expect(composePhoneName(override: 'a\u0000b\n c'), 'a b c');
    expect(composePhoneName(override: '   '), 'Phone');
  });

  test('the wire map is read leniently', () {
    final info = DeviceInfo.fromMap({
      'name': ' iPhone ',
      'model': 'iPhone',
      'modelCode': '',
      'manufacturer': 3,
    });
    expect(info?.name, 'iPhone');
    expect(info?.modelCode, isNull);
    expect(info?.manufacturer, isNull);
    expect(DeviceInfo.fromMap('nope'), isNull);
  });
}
