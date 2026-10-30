#include <flutter_linux/flutter_linux.h>
#include <dlfcn.h>
#include <unistd.h>

#include <webview_all_linux/webview_all_linux_plugin.h>

// Keep the plugin and its WebKitGTK dependency out of the executable's DT_NEEDED.
// Resolve beside the actual executable, independent of cwd and LD_LIBRARY_PATH.
void webview_all_linux_plugin_register_with_registrar(
    FlPluginRegistrar* registrar) {
  g_autofree gchar* executable = g_file_read_link("/proc/self/exe", nullptr);
  g_autofree gchar* directory = executable ? g_path_get_dirname(executable) : nullptr;
  g_autofree gchar* path = directory
      ? g_build_filename(directory, "lib", "libwebview_all_linux_plugin.so", nullptr)
      : nullptr;
  void* library = path ? dlopen(path, RTLD_NOW | RTLD_LOCAL) : nullptr;
  using RegisterPlugin = void (*)(FlPluginRegistrar*);
  auto register_plugin = library ? reinterpret_cast<RegisterPlugin>(
      dlsym(library, "webview_all_linux_plugin_register_with_registrar")) : nullptr;
  const bool available = register_plugin != nullptr;
  if (available) {
    register_plugin(registrar);
    // The plugin's callbacks remain live for the lifetime of the process.
  } else if (library) {
    dlclose(library);
  }

  g_autoptr(FlStandardMethodCodec) codec = fl_standard_method_codec_new();
  g_autoptr(FlMethodChannel) channel = fl_method_channel_new(
      fl_plugin_registrar_get_messenger(registrar), "harness/linux_webview",
      FL_METHOD_CODEC(codec));
  fl_method_channel_set_method_call_handler(
      channel,
      [](FlMethodChannel*, FlMethodCall* call, gpointer data) {
        g_autoptr(FlMethodResponse) response = nullptr;
        if (g_strcmp0(fl_method_call_get_name(call), "isAvailable") == 0) {
          response = FL_METHOD_RESPONSE(fl_method_success_response_new(
              fl_value_new_bool(GPOINTER_TO_INT(data))));
        } else {
          response = FL_METHOD_RESPONSE(fl_method_not_implemented_response_new());
        }
        fl_method_call_respond(call, response, nullptr);
      },
      GINT_TO_POINTER(available), nullptr);
}
