// FreeRTOS's tasks, notifications, mutexes and binary semaphores on pthreads, for the shared sources
// (include/freertos/). Real threads: the render, touch, cable, hello and voice tasks run at once, as on the device's
// two cores.
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#include <errno.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "esp_log.h"

static const char *TAG = "rtos";

struct rtos_task {
    pthread_t thread;
    char name[16];
    TaskFunction_t fn;
    void *arg;
    pthread_mutex_t mu;
    pthread_cond_t cv;
    uint32_t notified;   // xTaskNotifyGive's count, under mu
};

// Tasks by name, for xTaskGetHandle. A task's record lives as long as the program: the device's tasks never end, and
// a handle must not dangle after a failed start deletes one.
#define TASKS_MAX 32
static pthread_mutex_t s_tasks_mu = PTHREAD_MUTEX_INITIALIZER;
static struct rtos_task *s_tasks[TASKS_MAX];
static __thread struct rtos_task *s_self;

static uint64_t now_ms(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000u + (uint64_t)ts.tv_nsec / 1000000u;
}

// Condition variables wait on the monotonic clock, so a wall clock set at boot (NTP) cannot stretch a timeout. macOS
// has no pthread_condattr_setclock; it waits a relative time instead.
static void cond_init(pthread_cond_t *cv)
{
#ifdef __APPLE__
    pthread_cond_init(cv, NULL);
#else
    pthread_condattr_t attr;
    pthread_condattr_init(&attr);
    pthread_condattr_setclock(&attr, CLOCK_MONOTONIC);
    pthread_cond_init(cv, &attr);
    pthread_condattr_destroy(&attr);
#endif
}

// Waits on `cv` until signalled or the monotonic `deadline` (ms; UINT64_MAX: forever). False when the deadline passed.
static bool cond_wait(pthread_cond_t *cv, pthread_mutex_t *mu, uint64_t deadline)
{
    if (deadline == UINT64_MAX) {
        pthread_cond_wait(cv, mu);
        return true;
    }
    const uint64_t now = now_ms();
    if (now >= deadline) return false;
#ifdef __APPLE__
    const uint64_t left = deadline - now;
    const struct timespec rel = {(time_t)(left / 1000), (long)(left % 1000) * 1000000L};
    return pthread_cond_timedwait_relative_np(cv, mu, &rel) != ETIMEDOUT;
#else
    const struct timespec abs = {(time_t)(deadline / 1000), (long)(deadline % 1000) * 1000000L};
    return pthread_cond_timedwait(cv, mu, &abs) != ETIMEDOUT;
#endif
}

static uint64_t deadline_of(TickType_t ticks) { return ticks == portMAX_DELAY ? UINT64_MAX : now_ms() + ticks; }

static struct rtos_task *task_new(const char *name)
{
    struct rtos_task *t = calloc(1, sizeof *t);
    if (!t) return NULL;
    snprintf(t->name, sizeof t->name, "%s", name);
    pthread_mutex_init(&t->mu, NULL);
    cond_init(&t->cv);
    pthread_mutex_lock(&s_tasks_mu);
    for (int i = 0; i < TASKS_MAX; i++)
        if (!s_tasks[i]) {
            s_tasks[i] = t;
            break;
        }
    pthread_mutex_unlock(&s_tasks_mu);
    return t;
}

// The calling thread's task. A thread the program started itself (main, an output's or the cable's) gets one the
// first time it asks, named after nothing the device has.
static struct rtos_task *self(void)
{
    if (!s_self) {
        s_self = task_new("linux");
        if (!s_self) abort();   // a thread that cannot have a task record cannot wait on anything
        s_self->thread = pthread_self();
    }
    return s_self;
}

static void *trampoline(void *arg)
{
    s_self = arg;
    s_self->fn(s_self->arg);
    return NULL;   // a FreeRTOS task never returns; a Linux one that does just ends
}

BaseType_t xTaskCreatePinnedToCore(TaskFunction_t fn, const char *name, uint32_t stack_bytes, void *arg,
                                   UBaseType_t priority, TaskHandle_t *out, BaseType_t core)
{
    (void)stack_bytes;
    (void)priority;
    (void)core;
    struct rtos_task *t = task_new(name);
    if (!t) return pdFAIL;
    t->fn = fn;
    t->arg = arg;
    if (out) *out = t;   // before the thread runs, as FreeRTOS: the new task may be notified at once
    const int err = pthread_create(&t->thread, NULL, trampoline, t);
    if (err) {
        ESP_LOGE(TAG, "task %s not started: %s", name, strerror(err));
        if (out) *out = NULL;
        return pdFAIL;
    }
    pthread_detach(t->thread);
    return pdPASS;
}

void vTaskDelete(TaskHandle_t task)
{
    if (!task || task == s_self) pthread_exit(NULL);
    pthread_cancel(task->thread);
}

void vTaskDelay(TickType_t ticks)
{
    struct timespec ts = {(time_t)(ticks / 1000), (long)(ticks % 1000) * 1000000L};
    while (nanosleep(&ts, &ts) == -1 && errno == EINTR) {}   // a signal does not cut a delay short
}

TaskHandle_t xTaskGetHandle(const char *name)
{
    TaskHandle_t found = NULL;
    pthread_mutex_lock(&s_tasks_mu);
    for (int i = 0; i < TASKS_MAX && !found; i++)
        if (s_tasks[i] && !strcmp(s_tasks[i]->name, name)) found = s_tasks[i];
    pthread_mutex_unlock(&s_tasks_mu);
    return found;
}

const char *pcTaskGetName(TaskHandle_t task) { return (task ? task : self())->name; }

UBaseType_t uxTaskGetStackHighWaterMark(TaskHandle_t task)
{
    (void)task;
    return 0;
}

void xTaskNotifyGive(TaskHandle_t task)
{
    pthread_mutex_lock(&task->mu);
    task->notified++;
    pthread_cond_signal(&task->cv);
    pthread_mutex_unlock(&task->mu);
}

uint32_t ulTaskNotifyTake(BaseType_t clear_on_exit, TickType_t ticks)
{
    struct rtos_task *t = self();
    const uint64_t deadline = deadline_of(ticks);
    pthread_mutex_lock(&t->mu);
    while (!t->notified && cond_wait(&t->cv, &t->mu, deadline)) {}
    const uint32_t count = t->notified;
    if (count) t->notified = clear_on_exit ? 0 : count - 1;
    pthread_mutex_unlock(&t->mu);
    return count;
}

// ── mutexes and binary semaphores ───────────────────────────────────────────────────────────────────────────────

struct rtos_sem {
    pthread_mutex_t mu;
    pthread_cond_t cv;
    bool recursive;
    bool binary;   // a signal, not a lock: held is "empty", and any task gives it
    bool held;
    pthread_t holder;
    unsigned depth;
};

static SemaphoreHandle_t sem_new(bool recursive)
{
    struct rtos_sem *s = calloc(1, sizeof *s);
    if (!s) return NULL;
    pthread_mutex_init(&s->mu, NULL);
    cond_init(&s->cv);
    s->recursive = recursive;
    return s;
}

SemaphoreHandle_t xSemaphoreCreateMutex(void) { return sem_new(false); }
SemaphoreHandle_t xSemaphoreCreateRecursiveMutex(void) { return sem_new(true); }

SemaphoreHandle_t xSemaphoreCreateBinary(void)
{
    struct rtos_sem *s = sem_new(false);
    if (s) {
        s->binary = true;
        s->held = true;   // empty until the first give
    }
    return s;
}

BaseType_t xSemaphoreTake(SemaphoreHandle_t s, TickType_t ticks)
{
    const pthread_t me = pthread_self();
    const uint64_t deadline = deadline_of(ticks);
    pthread_mutex_lock(&s->mu);
    // A plain mutex taken again by its holder waits, as on FreeRTOS: a deadlock there is the caller's bug.
    while (s->held && !(s->recursive && pthread_equal(s->holder, me))) {
        if (!cond_wait(&s->cv, &s->mu, deadline)) {
            pthread_mutex_unlock(&s->mu);
            return pdFALSE;
        }
    }
    s->held = true;
    s->holder = me;
    s->depth++;
    pthread_mutex_unlock(&s->mu);
    return pdTRUE;
}

BaseType_t xSemaphoreGive(SemaphoreHandle_t s)
{
    pthread_mutex_lock(&s->mu);
    if (s->binary) {   // FreeRTOS's: a give to a full one is refused, and changes nothing
        const bool was_empty = s->held;
        s->held = false;
        s->depth = 0;
        pthread_cond_signal(&s->cv);
        pthread_mutex_unlock(&s->mu);
        return was_empty ? pdTRUE : pdFALSE;
    }
    if (!s->held || !pthread_equal(s->holder, pthread_self())) {   // only the holder gives a mutex back
        pthread_mutex_unlock(&s->mu);
        return pdFALSE;
    }
    if (--s->depth == 0) {
        s->held = false;
        pthread_cond_signal(&s->cv);
    }
    pthread_mutex_unlock(&s->mu);
    return pdTRUE;
}
