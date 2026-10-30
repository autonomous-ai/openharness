#include <windows.h>

#include <cstddef>
#include <cstdint>

static_assert(sizeof(void*) == 8);
static_assert(sizeof(wchar_t) == 2);
static_assert(sizeof(OVERLAPPED) == 32);
static_assert(offsetof(OVERLAPPED, hEvent) == 24);

// Capture inside this native call: separate Dart FFI calls cannot preserve
// thread-local last-error across arbitrary VM work (dart-lang/sdk#38832).
extern "C" __declspec(dllexport) intptr_t __cdecl harness_pipe_open_v1(
    const wchar_t* path, uint32_t* error_out) {
  const HANDLE handle = CreateFileW(
      path, GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING,
      FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
      nullptr);
  const DWORD error = handle == INVALID_HANDLE_VALUE ? GetLastError() : ERROR_SUCCESS;
  *error_out = error;
  return reinterpret_cast<intptr_t>(handle);
}

extern "C" __declspec(dllexport) int32_t __cdecl harness_pipe_read_v1(
    intptr_t handle, void* buffer, uint32_t length, OVERLAPPED* overlapped,
    uint32_t* error_out) {
  const BOOL ok = ReadFile(reinterpret_cast<HANDLE>(handle), buffer, length,
                           nullptr, overlapped);
  const DWORD error = ok ? ERROR_SUCCESS : GetLastError();
  *error_out = error;
  return ok;
}

extern "C" __declspec(dllexport) int32_t __cdecl harness_pipe_write_v1(
    intptr_t handle, const void* buffer, uint32_t length, OVERLAPPED* overlapped,
    uint32_t* error_out) {
  const BOOL ok = WriteFile(reinterpret_cast<HANDLE>(handle), buffer, length,
                            nullptr, overlapped);
  const DWORD error = ok ? ERROR_SUCCESS : GetLastError();
  *error_out = error;
  return ok;
}

extern "C" __declspec(dllexport) intptr_t __cdecl harness_pipe_create_event_v1(
    uint32_t* error_out) {
  const HANDLE event = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  const DWORD error = event == nullptr ? GetLastError() : ERROR_SUCCESS;
  *error_out = error;
  return reinterpret_cast<intptr_t>(event);
}
