#include "my_application.h"

#include <flutter_linux/flutter_linux.h>
#include <gtk/gtk.h>
#ifdef GDK_WINDOWING_X11
#include <gdk/gdkx.h>
#endif

#include "flutter/generated_plugin_registrant.h"

struct _MyApplication {
  GtkApplication parent_instance;
  char** dart_entrypoint_arguments;
  FlMethodChannel* community_channel;
  FlValue* pending_links;
  gboolean links_ready;
};

G_DEFINE_TYPE(MyApplication, my_application, GTK_TYPE_APPLICATION)

// Buffer cold-start links until Dart has installed its receiver.
static void community_method_call_cb(FlMethodChannel* channel,
                                    FlMethodCall* call, gpointer user_data) {
  MyApplication* self = MY_APPLICATION(user_data);
  if (g_strcmp0(fl_method_call_get_name(call), "ready") != 0) {
    g_autoptr(FlMethodResponse) response = FL_METHOD_RESPONSE(fl_method_not_implemented_response_new());
    fl_method_call_respond(call, response, nullptr);
    return;
  }
  self->links_ready = TRUE;
  g_autoptr(FlMethodResponse) response = FL_METHOD_RESPONSE(fl_method_success_response_new(self->pending_links));
  fl_method_call_respond(call, response, nullptr);
  fl_value_unref(self->pending_links);
  self->pending_links = fl_value_new_list();
}

// Called when first Flutter frame received.
static void first_frame_cb(MyApplication* self, FlView* view) {
  gtk_widget_show(gtk_widget_get_toplevel(GTK_WIDGET(view)));
}

// Reads a native image off the GTK clipboard, as PNG bytes.
static FlMethodResponse* read_clipboard_image_png() {
  GtkClipboard* clipboard = gtk_clipboard_get(GDK_SELECTION_CLIPBOARD);
  GdkPixbuf* pixbuf = gtk_clipboard_wait_for_image(clipboard);
  if (pixbuf == nullptr) {
    // No image on the clipboard (the normal case for a plain-text paste) — the Dart side falls
    // back to today's text-paste behaviour.
    return FL_METHOD_RESPONSE(fl_method_success_response_new(fl_value_new_null()));
  }

  gchar* buffer = nullptr;
  gsize buffer_size = 0;
  g_autoptr(GError) error = nullptr;
  FlMethodResponse* response;
  if (gdk_pixbuf_save_to_buffer(pixbuf, &buffer, &buffer_size, "png", &error, nullptr)) {
    g_autoptr(FlValue) bytes = fl_value_new_uint8_list(
        reinterpret_cast<const uint8_t*>(buffer), buffer_size);
    response = FL_METHOD_RESPONSE(fl_method_success_response_new(bytes));
    g_free(buffer);
  } else {
    response = FL_METHOD_RESPONSE(fl_method_error_response_new(
        "ENCODE_FAILED",
        error != nullptr ? error->message : "failed to encode the clipboard image as PNG",
        nullptr));
  }
  g_object_unref(pixbuf);
  return response;
}

// Writes PNG bytes onto the GTK clipboard, replacing whatever was there — the LOCAL half of
// native image drag-drop (`_dropImage` in pane_grid.dart): when the pane's machine is this same
// computer, the app puts the dropped image on ITS OWN clipboard directly instead of sending it
// over the terminal wire, then forwards a Ctrl+V so the engine reads it exactly as it already
// does for an ordinary local clipboard paste. GTK's clipboard API works in terms of a decoded
// GdkPixbuf, not raw encoded bytes, unlike the read side above (which can hand back raw PNG bytes
// directly) — hence decoding through a loader here.
static FlMethodResponse* write_clipboard_image_png(FlValue* args) {
  if (args == nullptr || fl_value_get_type(args) != FL_VALUE_TYPE_UINT8_LIST) {
    return FL_METHOD_RESPONSE(fl_method_error_response_new(
        "INVALID_ARGUMENT", "expected PNG bytes", nullptr));
  }
  const uint8_t* bytes = fl_value_get_uint8_list(args);
  size_t length = fl_value_get_length(args);

  g_autoptr(GdkPixbufLoader) loader = gdk_pixbuf_loader_new();
  gdk_pixbuf_loader_write(loader, bytes, length, nullptr);
  gdk_pixbuf_loader_close(loader, nullptr);
  GdkPixbuf* pixbuf = gdk_pixbuf_loader_get_pixbuf(loader);
  if (pixbuf == nullptr) {
    return FL_METHOD_RESPONSE(fl_method_success_response_new(fl_value_new_bool(FALSE)));
  }

  GtkClipboard* clipboard = gtk_clipboard_get(GDK_SELECTION_CLIPBOARD);
  gtk_clipboard_set_image(clipboard, pixbuf);
  return FL_METHOD_RESPONSE(fl_method_success_response_new(fl_value_new_bool(TRUE)));
}

// The files the GTK clipboard holds, as paths in the order they were copied — what a file
// manager's Copy puts there (Nautilus, Dolphin, Thunar and the rest all offer `text/uri-list`).
// An empty list when the clipboard holds none. A URI that is not a local file — a remote mount
// with no path here — is left out.
static FlMethodResponse* read_clipboard_file_paths() {
  GtkClipboard* clipboard = gtk_clipboard_get(GDK_SELECTION_CLIPBOARD);
  g_autoptr(FlValue) paths = fl_value_new_list();
  g_auto(GStrv) uris = gtk_clipboard_wait_for_uris(clipboard);
  if (uris != nullptr) {
    for (gchar** uri = uris; *uri != nullptr; uri++) {
      g_autofree gchar* path = g_filename_from_uri(*uri, nullptr, nullptr);
      if (path != nullptr) {
        fl_value_append_take(paths, fl_value_new_string(path));
      }
    }
  }
  return FL_METHOD_RESPONSE(fl_method_success_response_new(paths));
}

// Dart calls into this channel to read/write a native image on the GTK clipboard. Flutter's own
// `Clipboard` API only ever sees text/plain — see terminal_panel.dart's `_paste()` — so a real
// image (a screenshot, "Copy Image" from a browser, ...) needs this native round trip instead.
// It also answers for the FILES a clipboard holds (`readFilePaths`), which that API cannot see
// either. Mirrors macOS's `harness/clipboard_image` channel (MainFlutterWindow.swift).
static void clipboard_image_method_call_cb(FlMethodChannel* channel,
                                            FlMethodCall* method_call,
                                            gpointer user_data) {
  g_autoptr(FlMethodResponse) response = nullptr;
  const gchar* method = fl_method_call_get_name(method_call);
  if (g_strcmp0(method, "readImagePng") == 0) {
    response = read_clipboard_image_png();
  } else if (g_strcmp0(method, "writeImagePng") == 0) {
    response = write_clipboard_image_png(fl_method_call_get_args(method_call));
  } else if (g_strcmp0(method, "readFilePaths") == 0) {
    response = read_clipboard_file_paths();
  } else {
    response = FL_METHOD_RESPONSE(fl_method_not_implemented_response_new());
  }
  fl_method_call_respond(method_call, response, nullptr);
}

// The app's command key is Meta — ⌘ on a Mac. A PC keyboard's logo key reaches
// GTK as Super, which Flutter's Linux embedder maps to its own `superKey`
// rather than to meta, so HardwareKeyboard.isMetaPressed never saw it and no
// ⌘ shortcut could fire. Rewrite the key and its modifier bit before FlView's
// own handler (the class default, which runs after this) reads the event.
static gboolean super_as_meta_cb(GtkWidget* widget, GdkEventKey* event,
                                 gpointer user_data) {
  if (event->keyval == GDK_KEY_Super_L) {
    event->keyval = GDK_KEY_Meta_L;
  } else if (event->keyval == GDK_KEY_Super_R) {
    event->keyval = GDK_KEY_Meta_R;
  }
  if (event->state & GDK_SUPER_MASK) {
    event->state = static_cast<GdkModifierType>(event->state | GDK_META_MASK);
  }
  return FALSE;
}

// Held for the app's lifetime (same scope as the window itself), never unreffed — there is no
// natural teardown point before process exit, the same reason `fl_register_plugins` below registers
// its plugins on `view` with no matching cleanup in this function.
static void install_clipboard_image_channel(FlView* view) {
  FlMethodChannel* channel = fl_method_channel_new(
      fl_engine_get_binary_messenger(fl_view_get_engine(view)), "harness/clipboard_image",
      FL_METHOD_CODEC(fl_standard_method_codec_new()));
  fl_method_channel_set_method_call_handler(
      channel, clipboard_image_method_call_cb, nullptr, nullptr);
}

// True under a tiling compositor (Hyprland — Omarchy's — sway, niri, river,
// i3). Windows there carry no title bar: the compositor places them and a key
// closes them, so a GTK header bar is a strip of chrome no other app has.
static gboolean is_tiling_session() {
  const gchar* sockets[] = {"HYPRLAND_INSTANCE_SIGNATURE", "SWAYSOCK",
                            "NIRI_SOCKET", "I3SOCK"};
  for (const gchar* name : sockets) {
    const gchar* value = g_getenv(name);
    if (value != nullptr && value[0] != '\0') return TRUE;
  }
  const gchar* desktop = g_getenv("XDG_CURRENT_DESKTOP");
  if (desktop == nullptr) return FALSE;
  g_auto(GStrv) names = g_strsplit(desktop, ":", -1);
  for (gchar** name = names; *name != nullptr; name++) {
    if (g_ascii_strcasecmp(*name, "Hyprland") == 0 ||
        g_ascii_strcasecmp(*name, "sway") == 0 ||
        g_ascii_strcasecmp(*name, "niri") == 0 ||
        g_ascii_strcasecmp(*name, "river") == 0 ||
        g_ascii_strcasecmp(*name, "i3") == 0) {
      return TRUE;
    }
  }
  return FALSE;
}

// Implements GApplication::activate.
static void my_application_activate(GApplication* application) {
  MyApplication* self = MY_APPLICATION(application);
  GtkWindow* existing = gtk_application_get_active_window(GTK_APPLICATION(application));
  if (existing != nullptr) { gtk_window_present(existing); return; }

  // Harness Desktop is dark-only. Left alone, GTK's header bar and chrome
  // follow whatever theme preference the desktop environment has configured;
  // this pins it so native chrome matches the app's own (dark-only) palette
  // regardless of that setting.
  g_object_set(gtk_settings_get_default(), "gtk-application-prefer-dark-theme",
               TRUE, NULL);

  GtkWindow* window =
      GTK_WINDOW(gtk_application_window_new(GTK_APPLICATION(application)));

  // The packaged icon lives beside the executable in the relocatable Linux
  // bundle.
  g_autofree gchar* icon_path = nullptr;
  g_autofree gchar* exe_path = g_file_read_link("/proc/self/exe", nullptr);
  if (exe_path != nullptr) {
    g_autofree gchar* exe_dir = g_path_get_dirname(exe_path);
    icon_path = g_build_filename(exe_dir, "harness.png", nullptr);
  }

  // Who draws the window's title bar, told to Dart through the environment
  // (HARNESS_LINUX_TITLE_BAR, read by linux_menu_bar.dart):
  //  - "flutter": GNOME, the common case (e.g. Ubuntu desktop). The app draws
  //    one row itself — its menus, search, notifications, Store and the
  //    window buttons — where a GTK header bar would have taken a row of its
  //    own above them. GTK keeps drawing the shadow and the resize edges
  //    (client-side decorations) round a titlebar widget that is never shown.
  //  - "none": a tiling compositor. Windows there carry no title bar; on
  //    Wayland GTK would otherwise fall back to a client-side one of its own.
  //  - "native": X without GNOME, where the window manager may lay windows out
  //    in exotic ways, so it keeps its own traditional title bar.
  const gchar* title_bar = "flutter";
  if (is_tiling_session()) {
    title_bar = "none";
    gtk_window_set_decorated(window, FALSE);
  } else {
#ifdef GDK_WINDOWING_X11
    GdkScreen* screen = gtk_window_get_screen(window);
    if (GDK_IS_X11_SCREEN(screen)) {
      const gchar* wm_name = gdk_x11_screen_get_window_manager_name(screen);
      if (g_strcmp0(wm_name, "GNOME Shell") != 0) title_bar = "native";
    }
#endif
  }
  if (g_strcmp0(title_bar, "flutter") == 0) {
    gtk_window_set_titlebar(window, gtk_fixed_new());
  }
  g_setenv("HARNESS_LINUX_TITLE_BAR", title_bar, TRUE);
  // Keep the native window metadata correct even when a custom header is
  // drawn. Window managers use it for non-GNOME captions and accessibility.
  gtk_window_set_title(window, "Harness");

  gtk_window_set_default_size(window, 1280, 720);

  // App icon — installed at the bundle root next to the executable by
  // linux/CMakeLists.txt's install() rule (a stock `flutter create` scaffold
  // has no icon wired in at all).
  if (icon_path != nullptr) {
    gtk_window_set_icon_from_file(window, icon_path, nullptr);
  }

  g_autoptr(FlDartProject) project = fl_dart_project_new();
  fl_dart_project_set_dart_entrypoint_arguments(
      project, self->dart_entrypoint_arguments);

  FlView* view = fl_view_new(project);
  GdkRGBA background_color;
  // Background defaults to black, override it here if necessary, e.g. #00000000
  // for transparent.
  gdk_rgba_parse(&background_color, "#000000");
  fl_view_set_background_color(view, &background_color);
  gtk_widget_show(GTK_WIDGET(view));
  gtk_container_add(GTK_CONTAINER(window), GTK_WIDGET(view));
  g_signal_connect(view, "key-press-event", G_CALLBACK(super_as_meta_cb),
                   nullptr);
  g_signal_connect(view, "key-release-event", G_CALLBACK(super_as_meta_cb),
                   nullptr);

  // Show the window when Flutter renders.
  // Requires the view to be realized so we can start rendering.
  g_signal_connect_swapped(view, "first-frame", G_CALLBACK(first_frame_cb),
                           self);
  gtk_widget_realize(GTK_WIDGET(view));

  fl_register_plugins(FL_PLUGIN_REGISTRY(view));
  install_clipboard_image_channel(view);
  g_autoptr(FlStandardMethodCodec) codec = fl_standard_method_codec_new();
  self->community_channel = fl_method_channel_new(
      fl_engine_get_binary_messenger(fl_view_get_engine(view)), "harness/community_links",
      FL_METHOD_CODEC(codec));
  fl_method_channel_set_method_call_handler(self->community_channel,
      community_method_call_cb, self, nullptr);

  gtk_widget_grab_focus(GTK_WIDGET(view));
}

// GApplication forwards this to the primary instance over the session bus.
static void my_application_open(GApplication* application, GFile** files,
                                gint count, const gchar* hint) {
  MyApplication* self = MY_APPLICATION(application);
  for (gint i = 0; i < count; i++) {
    g_autofree gchar* uri = g_file_get_uri(files[i]);
    if (!g_str_has_prefix(uri, "harness://") || strlen(uri) > 240) continue;
    if (self->links_ready && self->community_channel != nullptr) {
      g_autoptr(FlValue) value = fl_value_new_string(uri);
      fl_method_channel_invoke_method(self->community_channel, "open", value,
                                     nullptr, nullptr, nullptr);
    } else if (fl_value_get_length(self->pending_links) < 20) {
      fl_value_append_take(self->pending_links, fl_value_new_string(uri));
    }
  }
  g_application_activate(application);
}

// Implements GApplication::local_command_line.
static gboolean my_application_local_command_line(GApplication* application,
                                                  gchar*** arguments,
                                                  int* exit_status) {
  MyApplication* self = MY_APPLICATION(application);
  // Strip out the first argument as it is the binary name.
  self->dart_entrypoint_arguments = g_strdupv(*arguments + 1);

  g_autoptr(GError) error = nullptr;
  if (!g_application_register(application, nullptr, &error)) {
    g_warning("Failed to register: %s", error->message);
    *exit_status = 1;
    return TRUE;
  }

  gboolean opened = FALSE;
  for (gchar** arg = *arguments + 1; *arg != nullptr; arg++) {
    if (g_str_has_prefix(*arg, "harness://") && strlen(*arg) <= 240) {
      g_autoptr(GFile) file = g_file_new_for_uri(*arg);
      GFile* files[] = {file};
      g_application_open(application, files, 1, "");
      opened = TRUE;
    }
  }
  if (!opened) g_application_activate(application);
  *exit_status = 0;

  return TRUE;
}

// Implements GApplication::startup.
static void my_application_startup(GApplication* application) {
  // MyApplication* self = MY_APPLICATION(object);

  // Perform any actions required at application startup.

  G_APPLICATION_CLASS(my_application_parent_class)->startup(application);
}

// Implements GApplication::shutdown.
static void my_application_shutdown(GApplication* application) {
  // MyApplication* self = MY_APPLICATION(object);

  // Perform any actions required at application shutdown.

  G_APPLICATION_CLASS(my_application_parent_class)->shutdown(application);
}

// Implements GObject::dispose.
static void my_application_dispose(GObject* object) {
  MyApplication* self = MY_APPLICATION(object);
  g_clear_pointer(&self->dart_entrypoint_arguments, g_strfreev);
  g_clear_pointer(&self->pending_links, fl_value_unref);
  g_clear_object(&self->community_channel);
  G_OBJECT_CLASS(my_application_parent_class)->dispose(object);
}

static void my_application_class_init(MyApplicationClass* klass) {
  G_APPLICATION_CLASS(klass)->activate = my_application_activate;
  G_APPLICATION_CLASS(klass)->open = my_application_open;
  G_APPLICATION_CLASS(klass)->local_command_line =
      my_application_local_command_line;
  G_APPLICATION_CLASS(klass)->startup = my_application_startup;
  G_APPLICATION_CLASS(klass)->shutdown = my_application_shutdown;
  G_OBJECT_CLASS(klass)->dispose = my_application_dispose;
}

static void my_application_init(MyApplication* self) { self->pending_links = fl_value_new_list(); }

MyApplication* my_application_new() {
  // Set the program name to the application ID, which helps various systems
  // like GTK and desktop environments map this running application to its
  // corresponding .desktop file. This ensures better integration by allowing
  // the application to be recognized beyond its binary name.
  g_set_prgname(APPLICATION_ID);

  return MY_APPLICATION(g_object_new(my_application_get_type(),
                                     "application-id", APPLICATION_ID, "flags",
                                     G_APPLICATION_HANDLES_OPEN, nullptr));
}
