cmake_minimum_required(VERSION 3.14)
project(runner LANGUAGES CXX)

# Define the application target. To change its name, change BINARY_NAME in the
# top-level CMakeLists.txt, not the value here, or `flutter run` will no longer
# work.
#
# Any new source files that you add to the application should be added here.
add_executable(${BINARY_NAME} WIN32
  "clipboard_image.cpp"
  "community_links.cpp"
  "flutter_window.cpp"
  "fonts.cpp"
  "main.cpp"
  "single_instance.cpp"
  "tray.cpp"
  "utils.cpp"
  "win32_window.cpp"
  "${FLUTTER_MANAGED_DIR}/generated_plugin_registrant.cc"
  "Runner.rc"
  "runner.exe.manifest"
)

# Apply the standard set of build settings. This can be removed for applications
# that need different build settings.
apply_standard_settings(${BINARY_NAME})

# Add preprocessor definitions for the build version.
target_compile_definitions(${BINARY_NAME} PRIVATE "FLUTTER_VERSION=\"${FLUTTER_VERSION}\"")
target_compile_definitions(${BINARY_NAME} PRIVATE "FLUTTER_VERSION_MAJOR=${FLUTTER_VERSION_MAJOR}")
target_compile_definitions(${BINARY_NAME} PRIVATE "FLUTTER_VERSION_MINOR=${FLUTTER_VERSION_MINOR}")
target_compile_definitions(${BINARY_NAME} PRIVATE "FLUTTER_VERSION_PATCH=${FLUTTER_VERSION_PATCH}")
target_compile_definitions(${BINARY_NAME} PRIVATE "FLUTTER_VERSION_BUILD=${FLUTTER_VERSION_BUILD}")

# Disable Windows macros that collide with C++ standard library functions.
target_compile_definitions(${BINARY_NAME} PRIVATE "NOMINMAX")

# Add dependency libraries and include directories. Add any application-specific
# dependencies here.
target_link_libraries(${BINARY_NAME} PRIVATE flutter flutter_wrapper_app)
target_link_libraries(${BINARY_NAME} PRIVATE "dwmapi.lib")
# The single instance reads the user's SID (advapi32); the shell gives the
# AUMID, the tray and CF_HDROP (shell32). Both are in MSVC's default set and
# are named so the runner says what it uses.
target_link_libraries(${BINARY_NAME} PRIVATE "advapi32.lib" "shell32.lib")
# Toasts (notifications.cpp) through C++/WinRT. Its headers ship with the
# Windows SDK (Include\<version>\cppwinrt, on every Visual Studio include
# path). windowsapp.lib is the WinRT umbrella library for x64 and arm64.
# MSVC 14.51 rejects WinRT's experimental coroutine fallback in C++17.
# Keep C++20 private to this source so WinRT selects standard coroutines;
# the runner and Flutter plugins retain their existing C++17 settings.
add_library(harness_notifications OBJECT "notifications.cpp")
apply_standard_settings(harness_notifications)
target_compile_features(harness_notifications PRIVATE cxx_std_20)
target_compile_definitions(harness_notifications PRIVATE "NOMINMAX")
target_link_libraries(harness_notifications PRIVATE flutter flutter_wrapper_app)
target_link_libraries(${BINARY_NAME} PRIVATE harness_notifications "windowsapp.lib")
# WIC encodes/decodes clipboard PNGs and keeps them in a COM stream.
target_link_libraries(${BINARY_NAME} PRIVATE "windowscodecs.lib" "ole32.lib")
set_source_files_properties("notifications.cpp" PROPERTIES COMPILE_OPTIONS "/bigobj;/permissive-")
target_include_directories(${BINARY_NAME} PRIVATE "${CMAKE_SOURCE_DIR}")

# Run the Flutter tool portions of the build. This must not be removed.
add_dependencies(${BINARY_NAME} flutter_assemble)
