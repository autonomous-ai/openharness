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


if __name__ == '__main__':
    unittest.main()
