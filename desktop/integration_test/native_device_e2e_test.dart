// Run the device scenarios in one native process, avoiding repeated app launches.
// FLUTTER_TEST=1 flutter test -d macos --no-pub integration_test/native_device_e2e_test.dart
import 'native_device_finder_e2e_test.dart' as finder;
import 'native_device_form_e2e_test.dart' as form;
import 'native_device_output_search_e2e_test.dart' as search;
import 'native_device_passage_e2e_test.dart' as passage;
import 'native_device_reading_e2e_test.dart' as reading;
import 'native_device_visit_e2e_test.dart' as visit;

void main() {
  finder.main();
  form.main();
  search.main();
  passage.main();
  reading.main();
  visit.main();
}
