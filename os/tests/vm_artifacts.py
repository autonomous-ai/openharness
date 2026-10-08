"""Discard owned test disks after a passing receipt and VM shutdown."""
import json
from pathlib import Path
import stat


def discard_passed_disks(output, receipt, *disks):
    if receipt.get('status') != 'passed':
        return
    output = Path(output).resolve()
    record = output / 'receipt.json'
    try:
        # Require the durable result first. Validate the entire deletion set
        # before removing anything; input fixtures are outside this directory.
        if json.loads(record.read_text()) != json.loads(json.dumps(receipt)):
            raise ValueError('Write the matching passing receipt before cleanup')
        owned = []
        for path in dict.fromkeys(map(Path, disks)):
            if path.is_symlink():
                raise ValueError('Refusing a symlink disk')
            path = path.resolve()
            path.relative_to(output)
            if path.suffix not in {'.raw', '.qcow2', '.img'}:
                raise ValueError('Not a disposable disk')
            if path.exists():
                info = path.stat()
                if not stat.S_ISREG(info.st_mode):
                    raise ValueError('Not a regular disk file')
                owned.append((path, info))
        removed = []
        receipt['disk_cleanup'] = {'removed': removed}
        for path, info in owned:
            path.unlink()
            removed.append({'path': str(path.relative_to(output)),
                            'logical_bytes': info.st_size})
        record.write_text(json.dumps(receipt, indent=2) + '\n')
    except Exception as error:
        receipt.update(status='failed', disk_cleanup_error=str(error))
        record.write_text(json.dumps(receipt, indent=2) + '\n')
        raise
