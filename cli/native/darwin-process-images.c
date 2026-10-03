/*
 * Read-only macOS executable-image probe. No process arguments or environment
 * are read. PID/birth and a repeated path read bracket each result; callers
 * retain their normal process-reader fallback for any unavailable identity.
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

static int birth(pid_t pid, struct proc_bsdinfo *info) {
    memset(info, 0, sizeof(*info));
    return proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, info, sizeof(*info)) == sizeof(*info)
        && info->pbi_pid == (uint32_t)pid && info->pbi_start_tvsec > 0;
}

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

int main(int argc, char **argv) {
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
