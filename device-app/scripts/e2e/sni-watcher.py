#!/usr/bin/env python3
"""A StatusNotifier tray host for linux.sh, on the session bus, and a click on a tray item's menu.

    sni-watcher.py serve FILE    owns org.kde.StatusNotifierWatcher and appends each RegisterStatusNotifierItem to FILE,
                                 one line: the item's bus name and object path. FILE is made, empty, once the name is
                                 owned. Runs until it is killed.
    sni-watcher.py click FILE LABEL
                                 clicks the menu item LABEL of the last item in FILE, through the item's
                                 com.canonical.dbusmenu, as a tray host does. Exits 1 while the menu has no such item.
"""

import sys

import dbus
import dbus.service

WATCHER = "org.kde.StatusNotifierWatcher"
ITEM = "org.kde.StatusNotifierItem"
MENU = "com.canonical.dbusmenu"


class Watcher(dbus.service.Object):
    def __init__(self, bus, file):
        super().__init__(bus, "/StatusNotifierWatcher")
        self.file = file
        self.items = []

    # The item names its object path (libayatana-appindicator does) or a bus name of its own, whose item is at
    # /StatusNotifierItem. An item registers again as its icon or menu changes: it is one item, kept once.
    @dbus.service.method(WATCHER, in_signature="s", sender_keyword="sender")
    def RegisterStatusNotifierItem(self, service, sender=None):
        name, path = (sender, service) if service.startswith("/") else (service, "/StatusNotifierItem")
        if f"{name}{path}" not in self.items:
            self.items.append(f"{name}{path}")
            with open(self.file, "a") as out:
                out.write(f"{name} {path}\n")
        self.StatusNotifierItemRegistered(f"{name}{path}")

    @dbus.service.method(WATCHER, in_signature="s")
    def RegisterStatusNotifierHost(self, service):
        pass

    @dbus.service.signal(WATCHER, signature="s")
    def StatusNotifierItemRegistered(self, service):
        pass

    def properties(self):
        return {
            "RegisteredStatusNotifierItems": dbus.Array(self.items, signature="s"),
            "IsStatusNotifierHostRegistered": dbus.Boolean(True),
            "ProtocolVersion": dbus.Int32(0),
        }

    @dbus.service.method(dbus.PROPERTIES_IFACE, in_signature="ss", out_signature="v")
    def Get(self, interface, name):
        return self.properties()[name]

    @dbus.service.method(dbus.PROPERTIES_IFACE, in_signature="s", out_signature="a{sv}")
    def GetAll(self, interface):
        return self.properties()


def serve(file):
    from dbus.mainloop.glib import DBusGMainLoop
    from gi.repository import GLib

    DBusGMainLoop(set_as_default=True)
    bus = dbus.SessionBus()
    # Both held while the loop runs: the object answers the calls, and the name is let go with it.
    watcher = Watcher(bus, file)  # noqa: F841
    name = dbus.service.BusName(WATCHER, bus, do_not_queue=True)  # noqa: F841
    open(file, "a").close()
    GLib.MainLoop().run()


def find(node, label):
    """The id of the enabled item labelled `label` in a GetLayout node, or None. A mnemonic's `_` is not read."""
    item, properties, children = node
    if str(properties.get("label", "")).replace("_", "") == label and properties.get("enabled", True):
        return int(item)
    for child in children:
        found = find(child, label)
        if found is not None:
            return found
    return None


def click(file, label):
    with open(file) as items:
        name, path = items.read().split("\n")[-2].split(" ", 1)
    bus = dbus.SessionBus()
    menu_path = bus.get_object(name, path).Get(ITEM, "Menu", dbus_interface=dbus.PROPERTIES_IFACE)
    menu = bus.get_object(name, menu_path)
    # A host asks this before it shows the menu: the app may fill it then.
    menu.AboutToShow(dbus.Int32(0), dbus_interface=MENU, signature="i")
    _, layout = menu.GetLayout(dbus.Int32(0), dbus.Int32(-1), dbus.Array([], signature="s"), dbus_interface=MENU)
    item = find(layout, label)
    if item is None:
        return 1
    menu.Event(dbus.Int32(item), "clicked", dbus.Int32(0), dbus.UInt32(0), dbus_interface=MENU, signature="isvu")
    return 0


if __name__ == "__main__":
    if sys.argv[1:2] == ["serve"] and len(sys.argv) == 3:
        serve(sys.argv[2])
    elif sys.argv[1:2] == ["click"] and len(sys.argv) == 4:
        sys.exit(click(sys.argv[2], sys.argv[3]))
    else:
        sys.exit(__doc__)
