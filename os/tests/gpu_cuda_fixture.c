/* ABI test double, never a GPU acceptance result or product payload. */
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
static unsigned int values[1024];
static int mode, allocations, contexts, modules;
void fixture_mode(int value) { mode = value; }
int fixture_live(void) { return allocations + contexts + modules; }
int cuGetErrorName(int code, const char **name) { (void)code; *name = "CUDA_FIXTURE_ERROR"; return 0; }
int cuInit(unsigned int flags) { return flags ? 1 : 0; }
int cuDeviceGetByPCIBusId(int *device, const char *address) {
    if (strcmp(address, "0000:01:00.0")) return 101;
    *device = 3; return 0;
}
int cuDeviceGetPCIBusId(char *address, int size, int device) {
    if (device != 3) return 101;
    snprintf(address, size, "%s", mode == 4 ? "0000:02:00.0" : "0000:01:00.0"); return 0;
}
int cuDeviceGetName(char *name, int size, int device) { (void)device; snprintf(name, size, "Fixture only"); return 0; }
int cuDeviceTotalMem_v2(size_t *bytes, int device) { (void)device; *bytes = (size_t)24 << 30; return 0; }
int cuDriverGetVersion(int *version) { *version = 13040; return 0; }
int cuCtxCreate_v2(void **context, unsigned int flags, int device) {
    if (flags != 4 || device != 3) return 1;
    *context = (void *)(uintptr_t)0x100000004ULL; ++contexts; return 0;
}
int cuMemAlloc_v2(uint64_t *memory, size_t bytes) {
    if (bytes != sizeof(values)) return 1;
    *memory = (uint64_t)(uintptr_t)values; ++allocations; return 0;
}
int cuMemcpyHtoD_v2(uint64_t device, const void *host, size_t bytes) {
    if (device != (uint64_t)(uintptr_t)values || bytes != sizeof(values)) return 1;
    memcpy(values, host, bytes); return 0;
}
int cuMemcpyDtoH_v2(void *host, uint64_t device, size_t bytes) {
    if (device != (uint64_t)(uintptr_t)values || bytes != sizeof(values)) return 1;
    memcpy(host, values, bytes); if (mode == 1) ((unsigned int *)host)[17] ^= 1; return 0;
}
int cuModuleLoadData(void **module, const void *ptx) {
    if (!strstr(ptx, ".visible .entry harness_check")) return 218;
    *module = (void *)(uintptr_t)0x100000008ULL; ++modules; return 0;
}
int cuModuleGetFunction(void **function, void *module, const char *name) {
    if (module != (void *)(uintptr_t)0x100000008ULL || strcmp(name, "harness_check")) return 1;
    *function = (void *)(uintptr_t)0x10000000cULL; return 0;
}
int cuLaunchKernel(void *function, unsigned int gx, unsigned int gy, unsigned int gz,
                   unsigned int bx, unsigned int by, unsigned int bz, unsigned int shared,
                   void *stream, void **parameters, void **extra) {
    if (function != (void *)(uintptr_t)0x10000000cULL || gx != 4 || gy != 1 || gz != 1 ||
        bx != 256 || by != 1 || bz != 1 || shared || stream || extra ||
        *(uint64_t *)parameters[0] != (uint64_t)(uintptr_t)values) return 1;
    for (int i = 0; i < 1024; ++i) values[i] = values[i] + values[i] + values[i] + 7;
    if (mode == 2) values[513] += 1;
    return 0;
}
int cuCtxSynchronize(void) { return mode == 3 ? 700 : 0; }
int cuMemFree_v2(uint64_t memory) {
    if (memory != (uint64_t)(uintptr_t)values) return 1;
    --allocations; return 0;
}
int cuModuleUnload(void *module) {
    if (module != (void *)(uintptr_t)0x100000008ULL) return 1;
    --modules; return 0;
}
int cuCtxDestroy_v2(void *context) {
    if (context != (void *)(uintptr_t)0x100000004ULL) return 1;
    --contexts; return 0;
}
