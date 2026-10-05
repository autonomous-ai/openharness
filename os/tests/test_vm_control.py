import io
import json
from pathlib import Path
import importlib.util
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('os_vm', Path(__file__).with_name('vm.py'))
vm_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vm_module)


class MonitorCommands(unittest.TestCase):
    def test_network_device_name_is_sent_as_a_qmp_argument(self):
        vm = vm_module.VM.__new__(vm_module.VM)
        vm.qmp = Mock()
        vm.qmp_file = io.BytesIO(b'{"return": {}, "id": "network-check"}\n')
        with patch.object(vm_module.uuid, 'uuid4', return_value=Mock(hex='network-check')):
            self.assertEqual(vm.monitor('set_link', name='hnnet', up=False), {})
        sent = json.loads(vm.qmp.sendall.call_args.args[0])
        self.assertEqual(sent, {'execute': 'set_link', 'arguments': {'name': 'hnnet', 'up': False}, 'id': 'network-check'})

    def test_ocr_click_maps_the_lowest_control_back_to_the_real_frame(self):
        words = 'left\ttop\twidth\theight\ttext\n124\t224\t100\t24\tInstall\n'
        words += '492\t1576\t120\t28\tInstall\n'
        self.assertEqual(vm_module.control_point(words, 'Install', 1280, 800, 2, 24),
                         (round(264 * 32767 / 1279), round(783 * 32767 / 799)))

    def test_missing_or_out_of_frame_controls_never_generate_a_click(self):
        for words in ['left\ttop\twidth\theight\ttext\n0\t0\t8\t8\tOther\n',
                      'left\ttop\twidth\theight\ttext\n0\t0\t8\t8\tInstall\n']:
            with self.assertRaises(AssertionError):
                vm_module.control_point(words, 'Install', 1280, 800, 2, 24)


class LiveMedia(unittest.TestCase):
    def test_automatic_mode_records_the_observed_media(self):
        vm = Mock()
        vm.command.return_value = ('HN_LIVE_MEDIA={"mode":"media","boot_usb_rejected":true}\n', 0)
        result = {'checks': []}
        vm_module.check_live_media(vm, result)
        self.assertEqual(result['live_media']['mode'], 'media')
        self.assertEqual(len(result['checks']), 2)

    def test_required_ram_path_cannot_pass_using_the_usb(self):
        vm = Mock()
        vm.command.return_value = ('HN_LIVE_MEDIA={"mode":"media","boot_usb_rejected":true}\n', 0)
        result = {'checks': []}
        with self.assertRaisesRegex(AssertionError, 'Expected ram boot, observed media'):
            vm_module.check_live_media(vm, result, 'ram')
        self.assertEqual(result['checks'], [])
        self.assertEqual(result['live_media']['mode'], 'media')

    def test_missing_guest_result_never_passes(self):
        vm = Mock()
        vm.command.return_value = ('shell prompt only', 0)
        with self.assertRaisesRegex(AssertionError, 'did not report'):
            vm_module.check_live_media(vm, {'checks': []})


if __name__ == '__main__':
    unittest.main()
