import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/unread_line.dart';

void main() {
  test('Mark unread after reading through offers the bar again', () {
    final lines = SuperTabUnreadLines()
      ..placeAt('lead', 'message-5')
      ..saw('lead')
      ..readThrough('lead')
      ..away = true;
    expect(lines.offersBar('lead'), isFalse);
    lines.placeAt('lead', 'message-9');
    expect(lines.offersBar('lead'), isTrue);
  });

  test('leaving a chat read through forgets it: the next visit offers the '
      'bar', () {
    final lines = SuperTabUnreadLines()
      ..placeAt('lead', 'message-5')
      ..saw('lead')
      ..readThrough('lead')
      ..forget('lead')
      ..placeAt('lead', 'message-5')
      ..away = true;
    expect(lines.offersBar('lead'), isTrue);
  });
}
