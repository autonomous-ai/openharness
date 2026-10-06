#!/usr/bin/env python3
"""Short-lived, unprivileged GPU probes. The supervisor owns all time limits.

CUDA uses the stable, explicitly versioned Driver API, not a toolkit/runtime.
EGL uses EXT_platform_device and EXT_device_drm_render_node for exact PCI mapping.
See os/DEVELOPMENT.md for API references and what these checks do not prove.
"""
import argparse
import ctypes as C
import json
from pathlib import Path
import re

I, U, P = C.c_int, C.c_uint, C.c_void_p
N = 1024
PTX = b'''
.version 6.0
.target sm_50
.address_size 64
.visible .entry harness_check(.param .u64 data) {
    .reg .b32 i, b, n, v;
    .reg .b64 p, offset, addr;
    ld.param.u64 p, [data];
    mov.u32 i, %tid.x;
    mov.u32 b, %ctaid.x;
    mov.u32 n, %ntid.x;
    mad.lo.u32 i, b, n, i;
    mul.wide.u32 offset, i, 4;
    add.u64 addr, p, offset;
    ld.global.u32 v, [addr];
    mad.lo.u32 v, v, 3, 7;
    st.global.u32 [addr], v;
    ret;
}
'''


def event(**value):
    print(json.dumps(value), flush=True)


def function(library, name, result, *arguments):
    fn = getattr(library, name)
    fn.restype, fn.argtypes = result, list(arguments)
    return fn


class ProbeError(Exception):
    def __init__(self, operation, code=None, detail=''):
        super().__init__(detail or operation)
        self.operation, self.code, self.detail = operation, code, detail


def same_pci(first, second):
    def parts(value):
        match = re.fullmatch(r'([0-9a-f]{4,8}):([0-9a-f]{2}):([0-9a-f]{2})\.([0-7])', value.lower())
        return tuple(int(part, 16) for part in match.groups()) if match else None
    return parts(first) is not None and parts(first) == parts(second)


class CUDA:
    def __init__(self):
        self.lib = C.CDLL('libcuda.so.1')
        self.error_name = function(self.lib, 'cuGetErrorName', I, I, C.POINTER(C.c_char_p))

    def call(self, name, types, *values):
        event(operation=name)
        code = function(self.lib, name, I, *types)(*values)
        if code:
            label = C.c_char_p()
            self.error_name(code, C.byref(label))
            raise ProbeError(name, code, label.value.decode() if label.value else 'CUDA error')

    def pci(self, device):
        address = C.create_string_buffer(32)
        self.call('cuDeviceGetPCIBusId', [P, I, I], address, len(address), device)
        return address.value.decode().lower()


def compute(address, checks):
    event(stage='cuda.device')
    api = CUDA()
    api.call('cuInit', [U], 0)
    device, driver = I(), I()
    api.call('cuDeviceGetByPCIBusId', [P, C.c_char_p], C.byref(device), address.encode())
    actual = api.pci(device)
    if not same_pci(actual, address):
        raise ProbeError('cuDeviceGetPCIBusId', detail=f'Expected {address}, got {actual}')
    name, total = C.create_string_buffer(256), C.c_size_t()
    api.call('cuDeviceGetName', [P, I, I], name, len(name), device)
    api.call('cuDeviceTotalMem_v2', [P, I], C.byref(total), device)
    api.call('cuDriverGetVersion', [P], C.byref(driver))
    checks.append({'test': 'cuda.device', 'status': 'passed', 'pci_address': actual,
                   'name': name.value.decode(errors='replace'), 'total_memory_bytes': total.value,
                   'driver_api_version': driver.value})
    # A private context cannot reset, unload or synchronize another application's
    # context. Explicit _v2 symbols avoid the incompatible cuCtxCreate_v4 ABI.
    context, module, memory = P(), P(), C.c_uint64()
    try:
        event(stage='cuda.context')
        api.call('cuCtxCreate_v2', [P, U, I], C.byref(context), 4, device)
        event(stage='cuda.memory')
        original = [(i * 17 + 3) for i in range(N)]
        source, output = (U * N)(*original), (U * N)()
        size = C.sizeof(source)
        api.call('cuMemAlloc_v2', [P, C.c_size_t], C.byref(memory), size)
        api.call('cuMemcpyHtoD_v2', [C.c_uint64, P, C.c_size_t], memory, source, size)
        api.call('cuMemcpyDtoH_v2', [P, C.c_uint64, C.c_size_t], output, memory, size)
        if list(output) != original:
            raise ProbeError('memory_round_trip', detail='GPU memory readback differs from the uploaded pattern')
        checks.append({'test': 'cuda.memory', 'status': 'passed', 'bytes': size})
        event(stage='cuda.compute')
        api.call('cuModuleLoadData', [P, C.c_char_p], C.byref(module), PTX)
        kernel = P()
        api.call('cuModuleGetFunction', [P, P, C.c_char_p], C.byref(kernel), module, b'harness_check')
        parameters = (P * 1)(C.cast(C.byref(memory), P))
        api.call('cuLaunchKernel', [P, U, U, U, U, U, U, U, P, P, P],
                 kernel, N // 256, 1, 1, 256, 1, 1, 0, None, parameters, None)
        api.call('cuCtxSynchronize', [])
        api.call('cuMemcpyDtoH_v2', [P, C.c_uint64, C.c_size_t], output, memory, size)
        expected = [value * 3 + 7 for value in original]
        mismatch = next((i for i in range(N) if output[i] != expected[i]), None)
        if mismatch is not None:
            raise ProbeError('integer_vector', detail=f'Element {mismatch}: expected {expected[mismatch]}, got {output[mismatch]}')
        checks.append({'test': 'cuda.compute', 'status': 'passed', 'elements': N, 'operation': '3*x+7'})
    finally:
        # A context owns these allocations. Even if a cleanup call fails, always
        # attempt the remaining releases; the worker then exits entirely.
        for name, types, value in [('cuMemFree_v2', [C.c_uint64], memory),
                                   ('cuModuleUnload', [P], module), ('cuCtxDestroy_v2', [P], context)]:
            if value.value:
                try:
                    api.call(name, types, value)
                except ProbeError as error:
                    checks.append({'test': 'cuda.cleanup', 'status': 'failed',
                                   'operation': error.operation, 'code': error.code, 'detail': error.detail})


def extensions(value):
    return set(value.decode().split()) if value else set()


def device_matches(device, device_string, extension, address):
    ext = extensions(device_string(device, 0x3055))
    if 'EGL_EXT_device_drm_render_node' in ext:
        node = device_string(device, 0x3377)
        if node and same_pci((Path('/sys/class/drm') / Path(node.decode()).name / 'device').resolve().name, address):
            return True
    # Headless cards need not expose a render node. The official EGL/CUDA mapping
    # still identifies the exact PCI GPU; an EGL ordinal alone is not its identity.
    if 'EGL_NV_device_cuda' in ext:
        ordinal = C.c_ssize_t()
        device_attribute = extension('eglQueryDeviceAttribEXT', U, P, I, P)
        if device_attribute(device, 0x323A, C.byref(ordinal)):
            api = CUDA()
            api.call('cuInit', [U], 0)
            return same_pci(api.pci(ordinal.value), address)
    return False


def accelerated_renderer(vendor, renderer):
    return bool('nvidia' in vendor.lower() and renderer and not any(
        word in renderer.lower() for word in ['llvmpipe', 'softpipe', 'software']))


def graphics(address, checks):
    event(stage='graphics.device')
    egl = C.CDLL('libEGL.so.1')
    get_proc = function(egl, 'eglGetProcAddress', P, C.c_char_p)
    get_error = function(egl, 'eglGetError', I)

    def extension(name, result, *args):
        pointer = get_proc(name.encode())
        if not pointer:
            raise ProbeError(name, detail='EGL entry point is unavailable')
        return C.CFUNCTYPE(result, *args)(pointer)

    def call(name, result, types, *args):
        event(operation=name)
        value = function(egl, name, result, *types)(*args)
        if not value:
            raise ProbeError(name, get_error(), 'EGL operation failed')
        return value

    query = function(egl, 'eglQueryString', C.c_char_p, P, I)
    client = extensions(query(None, 0x3055))  # EGL_EXTENSIONS
    if not {'EGL_EXT_device_enumeration', 'EGL_EXT_device_query', 'EGL_EXT_platform_device'} <= client:
        raise ProbeError('EGL extensions', detail='EGL device selection is unavailable')
    enumerate_devices = extension('eglQueryDevicesEXT', U, I, P, P)
    device_string = extension('eglQueryDeviceStringEXT', C.c_char_p, P, I)
    devices, count = (P * 64)(), I()
    if not enumerate_devices(len(devices), devices, C.byref(count)) or not 0 < count.value <= len(devices):
        raise ProbeError('eglQueryDevicesEXT', get_error(), 'No usable EGL device inventory')
    selected = None
    for device in devices[:count.value]:
        if device_matches(device, device_string, extension, address):
            selected = device
            break
    if selected is None:
        raise ProbeError('graphics.device', detail='No EGL device maps to this PCI GPU')
    platform = extension('eglGetPlatformDisplayEXT', P, U, P, P)
    display = platform(0x313F, selected, None)  # EGL_PLATFORM_DEVICE_EXT
    if not display:
        raise ProbeError('eglGetPlatformDisplayEXT', get_error(), 'Device display is unavailable')
    context = surface = None
    initialized = False
    try:
        major, minor = I(), I()
        call('eglInitialize', U, [P, P, P], display, C.byref(major), C.byref(minor))
        initialized = True
        call('eglBindAPI', U, [U], 0x30A0)  # EGL_OPENGL_ES_API
        attributes = (I * 13)(0x3033, 1, 0x3040, 4, 0x3024, 8, 0x3023, 8, 0x3022, 8, 0x3021, 8, 0x3038)
        config, found = P(), I()
        call('eglChooseConfig', U, [P, P, P, I, P], display, attributes, C.byref(config), 1, C.byref(found))
        if found.value != 1:
            raise ProbeError('eglChooseConfig', detail='RGBA8 ES2 pbuffer is unavailable')
        surface = call('eglCreatePbufferSurface', P, [P, P, P], display, config,
                       (I * 5)(0x3057, 8, 0x3056, 8, 0x3038))
        context = call('eglCreateContext', P, [P, P, P, P], display, config, None,
                       (I * 3)(0x3098, 2, 0x3038))
        call('eglMakeCurrent', U, [P, P, P, P], display, surface, surface, context)
        gl = C.CDLL('libGLESv2.so.2')
        string = function(gl, 'glGetString', C.c_char_p, U)
        vendor, renderer = (string(token) for token in [0x1F00, 0x1F01])
        vendor = vendor.decode(errors='replace') if vendor else ''
        renderer = renderer.decode(errors='replace') if renderer else ''
        if not accelerated_renderer(vendor, renderer):
            raise ProbeError('graphics.renderer', detail=f'Expected NVIDIA acceleration, got {vendor}: {renderer}')
        event(stage='graphics.render')
        clear_color = function(gl, 'glClearColor', None, *[C.c_float] * 4)
        clear = function(gl, 'glClear', None, U)
        read_pixels = function(gl, 'glReadPixels', None, I, I, I, I, U, U, P)
        gl_error = function(gl, 'glGetError', U)
        pixel = (C.c_ubyte * 4)()
        for color in [(255, 0, 0, 255), (0, 255, 0, 255), (0, 0, 255, 255)]:
            clear_color(*(value / 255 for value in color))
            clear(0x4000)  # GL_COLOR_BUFFER_BIT
            read_pixels(0, 0, 1, 1, 0x1908, 0x1401, pixel)  # RGBA, UNSIGNED_BYTE
            code = gl_error()
            if code or tuple(pixel) != color:
                raise ProbeError('graphics.readback', code, f'Expected {color}, got {tuple(pixel)}')
        checks.append({'test': 'graphics.render', 'status': 'passed', 'vendor': vendor,
                       'renderer': renderer, 'surface': '8x8 offscreen EGL pbuffer', 'colors': 3})
    finally:
        if initialized:
            function(egl, 'eglMakeCurrent', U, P, P, P, P)(display, None, None, None)
            if context:
                function(egl, 'eglDestroyContext', U, P, P)(display, context)
            if surface:
                function(egl, 'eglDestroySurface', U, P, P)(display, surface)
            function(egl, 'eglTerminate', U, P)(display)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('probe', choices=['cuda', 'graphics'])
    parser.add_argument('address')
    args = parser.parse_args()
    if not re.fullmatch(r'[0-9a-f]{4,8}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]', args.address):
        parser.error('Expected a PCI address.')
    checks = []
    try:
        (compute if args.probe == 'cuda' else graphics)(args.address, checks)
    except (ProbeError, OSError, AttributeError) as error:
        checks.append({'test': args.probe, 'status': 'failed',
                       'operation': getattr(error, 'operation', 'load_driver'),
                       'code': getattr(error, 'code', None), 'detail': str(error)})
    event(result={'address': args.address, 'probe': args.probe, 'checks': checks,
                  'status': 'failed' if any(row['status'] == 'failed' for row in checks) else 'passed'})


if __name__ == '__main__':
    main()
