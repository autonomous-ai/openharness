/*
 * Says when /dev changes on macOS, so the devices process scans for a replugged
 * dial at once instead of at its next tick. Node cannot hear this itself:
 * fs.watch('/dev') goes through FSEvents, and devfs feeds FSEvents nothing.
 * It is its own program, not a mode of darwin-process-images, because the core
 * runs that one and this serves the devices process only.
 *
 * stdout: {"schema":1,"mode":"watch"} once armed, then dev per wake that holds
 * a /dev event. It reads no names: the daemon's own scan finds what changed.
 * stdin at EOF ends it, so it never outlives the process that started it.
 */
#include <errno.h>
#include <fcntl.h>
#include <string.h>
#include <unistd.h>
#include <sys/event.h>

static int say(const char *text) {
    size_t size = strlen(text);
    return write(STDOUT_FILENO, text, size) == (ssize_t)size;
}

int main(int argc, char **argv) {
    if (argc != 2 || strcmp(argv[1], "--watch") != 0) return 64;
    int dev = open("/dev", O_RDONLY | O_EVTONLY);
    if (dev < 0) return 1;
    int queue = kqueue();
    if (queue < 0) return 1;
    struct kevent changes[2];
    EV_SET(&changes[0], dev, EVFILT_VNODE, EV_ADD | EV_CLEAR, NOTE_WRITE, 0, NULL);
    EV_SET(&changes[1], STDIN_FILENO, EVFILT_READ, EV_ADD, 0, 0, NULL);
    if (kevent(queue, changes, 2, NULL, 0, NULL) < 0) return 1;
    if (!say("{\"schema\":1,\"mode\":\"watch\"}\n")) return 1;
    for (;;) {
        struct kevent events[2];
        int count = kevent(queue, NULL, 0, events, 2, NULL);
        if (count < 0) {
            if (errno == EINTR) continue;
            return 1;
        }
        int changed = 0;
        for (int i = 0; i < count; ++i) {
            if (events[i].flags & EV_ERROR) return 1;
            if (events[i].filter == EVFILT_VNODE) {
                changed = 1;
                continue;
            }
            /* EOF is checked before any /dev event in the same wake is said: the reader is gone. */
            if (events[i].flags & EV_EOF) return 0;
            char discard[256];
            ssize_t got = read(STDIN_FILENO, discard, sizeof(discard));
            if (got == 0) return 0;
            if (got < 0 && errno != EINTR) return 1;
        }
        if (changed && !say("dev\n")) return 1;
    }
}
