/*
 * Read-only macOS process evidence. The optional --paths discovery mode reads
 * executable images only. Strict --control reads bounded argv and descriptors,
 * never emits environment data, and rejects an incomplete observation in full.
 *
 * stdout is versioned JSON lines. Paths are hex-encoded filesystem bytes, not
 * interpolated JSON or assumed UTF-8. A consumer must validate them before use.
 */
#include <errno.h>
#include <limits.h>
#include <locale.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <libproc.h>
#include <sys/proc_info.h>
#include <sys/proc.h>
#include <sys/stat.h>
#include <sys/sysctl.h>
#include <CommonCrypto/CommonDigest.h>

#define MAX_PIDS 4096

static int parse_pid(const char *text, pid_t *pid) {
    if (!text || !*text) return 0;
    /* Reject signs, whitespace and nondecimal forms before strtol. */
    for (const char *p = text; *p; ++p) {
        if (*p < '0' || *p > '9') return 0;
    }
    errno = 0;
    char *end = NULL;
    long value = strtol(text, &end, 10);
    if (errno || !end || *end || value <= 0 || value > INT_MAX) return 0;
    *pid = (pid_t)value;
    return 1;
}

static int birth_including_zombies(pid_t pid, int zombies, struct proc_bsdinfo *info) {
    memset(info, 0, sizeof(*info));
    return proc_pidinfo(pid, PROC_PIDTBSDINFO, zombies, info, sizeof(*info)) == sizeof(*info)
        && info->pbi_pid == (uint32_t)pid && info->pbi_start_tvsec > 0 && info->pbi_start_tvusec < 1000000;
}
static int birth(pid_t pid, struct proc_bsdinfo *info) { return birth_including_zombies(pid, 0, info); }

static int image_path(pid_t pid, char *path, size_t capacity, size_t *length) {
    memset(path, 0, capacity);
    int count = proc_pidpath(pid, path, (uint32_t)capacity);
    if (count <= 0 || (size_t)count >= capacity || path[0] != '/') return 0;
    size_t size = strnlen(path, capacity);
    if (!size || size >= capacity) return 0;
    *length = size;
    return 1;
}

static void print_hex(const unsigned char *value, size_t size) {
    static const char digits[] = "0123456789abcdef";
    for (size_t i = 0; i < size; ++i) {
        putchar(digits[value[i] >> 4]);
        putchar(digits[value[i] & 15]);
    }
}

static void print_image(pid_t pid) {
    struct proc_bsdinfo before, after;
    char first[PROC_PIDPATHINFO_MAXSIZE], second[PROC_PIDPATHINFO_MAXSIZE];
    size_t first_size = 0, second_size = 0;
    char marker[32];
    struct tm started;
    if (!birth(pid, &before)
        || !image_path(pid, first, sizeof(first), &first_size)
        || !image_path(pid, second, sizeof(second), &second_size)
        || !birth(pid, &after)
        || before.pbi_start_tvsec != after.pbi_start_tvsec
        || before.pbi_start_tvusec != after.pbi_start_tvusec
        || first_size != second_size || memcmp(first, second, first_size) != 0) {
        printf("{\"pid\":%d,\"unavailable\":true}\n", pid);
        return;
    }
    time_t seconds = (time_t)before.pbi_start_tvsec;
    if (seconds < 0 || (uint64_t)seconds != before.pbi_start_tvsec
        || !localtime_r(&seconds, &started)
        || !strftime(marker, sizeof(marker), "%a %b %e %H:%M:%S %Y", &started)) {
        printf("{\"pid\":%d,\"unavailable\":true}\n", pid);
        return;
    }
    /* LC_TIME is fixed below, so this marker contains only the ps date grammar. */
    printf("{\"pid\":%d,\"startMarker\":\"%s\",\"startSeconds\":%llu,"
           "\"startMicros\":%llu,\"imageHex\":\"", pid, marker,
           (unsigned long long)before.pbi_start_tvsec,
           (unsigned long long)before.pbi_start_tvusec);
    print_hex((const unsigned char *)first, first_size);
    puts("\"}");
}

/* A joined control observation has no interleaved ps/lsof subprocess waits. It
 * reads only the requested processes, argv (never environment output), numeric
 * descriptors and an optional direct-child set. No signals or filesystem writes.
 * The two bounded passes detect change; this is not an atomic kernel snapshot. */
#define CONTROL_PIDS 33
#define CONTROL_FDS 4096
#define CONTROL_ARGS 65536
struct control_fd { int32_t fd; uint32_t type, mode, device; uint64_t inode; };
struct control_row {
    pid_t pid;
    uint32_t parent, fd_capacity;
    uint64_t seconds, micros;
    char command[MAXCOMLEN + 1], image[PROC_PIDPATHINFO_MAXSIZE];
    unsigned char command_digest[CC_SHA256_DIGEST_LENGTH];
    int fd_count;
    struct control_fd fds[CONTROL_FDS];
};
static struct timespec control_deadline;
static int control_work = 32768;
static int control_step(void) {
    struct timespec now;
    if (--control_work < 0 || clock_gettime(CLOCK_MONOTONIC, &now)) return 0;
    return now.tv_sec < control_deadline.tv_sec
        || (now.tv_sec == control_deadline.tv_sec && now.tv_nsec < control_deadline.tv_nsec);
}
static int control_birth(pid_t pid, struct proc_bsdinfo *info) {
    return control_step() && birth(pid, info) && info->pbi_status != SZOMB
        && !(info->pbi_flags & PROC_FLAG_INEXIT);
}
static int same_birth(const struct proc_bsdinfo *a, const struct proc_bsdinfo *b) {
    return a->pbi_start_tvsec == b->pbi_start_tvsec && a->pbi_start_tvusec == b->pbi_start_tvusec
        && a->pbi_ppid == b->pbi_ppid && a->pbi_nfiles == b->pbi_nfiles
        && !memcmp(a->pbi_comm, b->pbi_comm, sizeof(a->pbi_comm));
}
static int control_command_digest(pid_t pid, unsigned char *out) {
    unsigned char raw[CONTROL_ARGS];
    size_t size = sizeof(raw);
    int mib[] = { CTL_KERN, KERN_PROCARGS2, pid };
    if (!control_step() || sysctl(mib, 3, raw, &size, NULL, 0) || size <= sizeof(int) || size >= sizeof(raw)) return 0;
    int argc;
    memcpy(&argc, raw, sizeof(argc));
    if (argc <= 0 || argc > 4096) return 0;
    /* A rewritten title can destroy argv boundaries while the kernel retains
     * the original argc. This view can also include environment strings. Never
     * interpret or emit them as arguments: only compare a digest of the complete
     * bounded view. Darwin's existing command reader supplies display text. */
    return CC_SHA256(raw, (CC_LONG)size, out) != NULL;
}
static int compare_fd(const void *a, const void *b) {
    int left = ((const struct control_fd *)a)->fd, right = ((const struct control_fd *)b)->fd;
    return (left > right) - (left < right);
}
static int control_fds(pid_t pid, struct control_row *row, int *total) {
    struct proc_fdinfo list[CONTROL_FDS + 1];
    if (!control_step()) return 0;
    errno = 0;
    int size = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, list, sizeof(list));
    if (errno || size < 0 || size % sizeof(list[0]) || (size_t)size >= sizeof(list)) return 0;
    row->fd_count = size / (int)sizeof(list[0]);
    *total += row->fd_count;
    if (*total > CONTROL_FDS) return 0;
    for (int index = 0; index < row->fd_count; index++) {
        if (!control_step() || list[index].proc_fd < 0) return 0;
        struct control_fd *fd = &row->fds[index];
        fd->fd = list[index].proc_fd; fd->type = list[index].proc_fdtype;
        if (fd->type > PROX_FDTYPE_NEXUS || fd->type == 8) return 0;
        if (fd->type == PROX_FDTYPE_VNODE) {
            struct vnode_fdinfo info;
            memset(&info, 0, sizeof(info));
            if (proc_pidfdinfo(pid, fd->fd, PROC_PIDFDVNODEINFO, &info, sizeof(info)) != sizeof(info)) return 0;
            fd->mode = info.pvi.vi_stat.vst_mode & S_IFMT;
            fd->device = info.pvi.vi_stat.vst_dev;
            fd->inode = info.pvi.vi_stat.vst_ino;
            if (!fd->mode || !fd->inode) return 0;
        }
    }
    qsort(row->fds, row->fd_count, sizeof(row->fds[0]), compare_fd);
    for (int index = 1; index < row->fd_count; index++) if (row->fds[index - 1].fd == row->fds[index].fd) return 0;
    return 1;
}
static int control_read(pid_t pid, struct control_row *row, int *fds) {
    struct proc_bsdinfo before, after;
    char final_image[PROC_PIDPATHINFO_MAXSIZE];
    unsigned char final_digest[CC_SHA256_DIGEST_LENGTH];
    size_t size, final_size;
    memset(row, 0, sizeof(*row)); row->pid = pid;
    if (!control_birth(pid, &before) || !control_step()
        || !image_path(pid, row->image, sizeof(row->image), &size)
        || !control_command_digest(pid, row->command_digest)
        || !control_fds(pid, row, fds) || !control_step()
        || !image_path(pid, final_image, sizeof(final_image), &final_size)
        || !control_command_digest(pid, final_digest)
        || !control_birth(pid, &after) || !same_birth(&before, &after)
        || size != final_size || memcmp(row->image, final_image, size)
        || memcmp(row->command_digest, final_digest, sizeof(final_digest))) return 0;
    row->parent = before.pbi_ppid; row->fd_capacity = before.pbi_nfiles;
    row->seconds = before.pbi_start_tvsec; row->micros = before.pbi_start_tvusec;
    memcpy(row->command, before.pbi_comm, sizeof(before.pbi_comm));
    return row->command[0] != 0;
}
static int compare_pid(const void *a, const void *b) {
    int left = *(const pid_t *)a, right = *(const pid_t *)b;
    return (left > right) - (left < right);
}
static int control_children(pid_t parent, pid_t *children) {
    if (!parent) return 0;
    if (!control_step()) return -1;
    errno = 0;
    int count = proc_listchildpids(parent, children, sizeof(pid_t) * CONTROL_PIDS);
    if (errno || count < 0 || count >= CONTROL_PIDS) return -1;
    int live = 0;
    for (int index = 0; index < count; index++) {
        struct proc_bsdinfo info;
        /* Enumeration includes zombies. A complete BSD record can exclude one;
         * ESRCH from the ordinary live-only read cannot establish its state. */
        if (!control_step() || children[index] <= 0 || !birth_including_zombies(children[index], 1, &info)
            || info.pbi_ppid != (uint32_t)parent) return -1;
        if (info.pbi_status != SZOMB && !(info.pbi_flags & PROC_FLAG_INEXIT)) children[live++] = children[index];
    }
    qsort(children, live, sizeof(pid_t), compare_pid);
    for (int index = 1; index < live; index++) if (children[index] == children[index - 1]) return -1;
    return live;
}
static int control_main(int argc, char **argv) {
    if (argc < 5 || argc > CONTROL_PIDS + 4) return 64;
    pid_t timeout, parent = 0, pids[CONTROL_PIDS], first_children[CONTROL_PIDS], last_children[CONTROL_PIDS];
    if (!parse_pid(argv[2], &timeout) || timeout > 3000
        || (strcmp(argv[3], "0") && !parse_pid(argv[3], &parent))) return 64;
    for (int i = 4; i < argc; i++) {
        if (!parse_pid(argv[i], &pids[i - 4])) return 64;
        for (int j = 4; j < i; j++) if (pids[i - 4] == pids[j - 4]) return 64;
    }
    if (clock_gettime(CLOCK_MONOTONIC, &control_deadline)) return 74;
    control_deadline.tv_sec += timeout / 1000;
    control_deadline.tv_nsec += (timeout % 1000) * 1000000L;
    if (control_deadline.tv_nsec >= 1000000000L) { control_deadline.tv_sec++; control_deadline.tv_nsec -= 1000000000L; }
    int count = argc - 4, okay = 0, first_count = control_children(parent, first_children), final_count;
    struct control_row *first = calloc(count, sizeof(*first)), *last = calloc(count, sizeof(*last));
    if (!first || !last || first_count < 0) goto done;
    int fds = 0;
    for (int i = 0; i < count; i++) if (!control_read(pids[i], &first[i], &fds)) goto done;
    fds = 0;
    for (int i = 0; i < count; i++) if (!control_read(pids[i], &last[i], &fds)
        || memcmp(&first[i], &last[i], sizeof(first[i]))) goto done;
    final_count = control_children(parent, last_children);
    if (final_count != first_count || memcmp(first_children, last_children, first_count * sizeof(pid_t)) || !control_step()) goto done;
    printf("{\"schema\":2,\"mode\":\"control\",\"parent\":%d,\"children\":[", parent);
    for (int i = 0; i < first_count; i++) printf("%s%d", i ? "," : "", first_children[i]);
    puts("]}");
    for (int i = 0; i < count; i++) {
        struct control_row *row = &last[i];
        printf("{\"pid\":%d,\"parentPid\":%u,\"startSeconds\":%llu,\"startMicros\":%llu,\"commandHex\":\"", row->pid, row->parent,
            (unsigned long long)row->seconds, (unsigned long long)row->micros);
        print_hex((unsigned char *)row->command, strlen(row->command));
        printf("\",\"imageHex\":\""); print_hex((unsigned char *)row->image, strlen(row->image));
        printf("\",\"commandDigest\":\""); print_hex(row->command_digest, sizeof(row->command_digest));
        printf("\",\"fds\":[");
        for (int f = 0; f < row->fd_count; f++) {
            struct control_fd *fd = &row->fds[f];
            printf("%s{\"fd\":%d,\"type\":%u,\"mode\":%u,\"device\":\"%u\",\"inode\":\"%llu\"}",
                f ? "," : "", fd->fd, fd->type, fd->mode, fd->device, (unsigned long long)fd->inode);
        }
        puts("]}");
    }
    okay = !ferror(stdout) && !fflush(stdout);
done:
    free(first); free(last);
    return okay ? 0 : 75;
}

int main(int argc, char **argv) {
    if (argc >= 2 && !strcmp(argv[1], "--control")) return control_main(argc, argv);
    if (argc < 3 || argc > MAX_PIDS + 2 || strcmp(argv[1], "--paths") != 0) return 64;
    pid_t pids[MAX_PIDS];
    for (int i = 2; i < argc; ++i) {
        if (!parse_pid(argv[i], &pids[i - 2])) return 64;
    }
    if (!setlocale(LC_TIME, "C")) return 69;
    puts("{\"schema\":1,\"mode\":\"paths\"}");
    for (int i = 0; i < argc - 2; ++i) print_image(pids[i]);
    return ferror(stdout) || fflush(stdout) ? 74 : 0;
}
