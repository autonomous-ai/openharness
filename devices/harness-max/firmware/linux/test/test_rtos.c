// The binary semaphore of the FreeRTOS shim (linux/esp/rtos.c), as max_present.c's helper signals the render task with
// it: created empty, a give that any task makes lets one take through, a second give to a full one is refused, and a
// take waits for a give from another task or times out.
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

static int checks;
#define CHECK(c) do { if (!(c)) { fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #c); abort(); } checks++; } while (0)

static void *give_later(void *sem)
{
    nanosleep(&(struct timespec){0, 20 * 1000 * 1000}, NULL);
    CHECK(xSemaphoreGive(sem) == pdTRUE);
    return NULL;
}

int main(void)
{
    SemaphoreHandle_t sem = xSemaphoreCreateBinary();
    CHECK(sem);
    CHECK(xSemaphoreTake(sem, 0) == pdFALSE);   // empty when created
    CHECK(xSemaphoreGive(sem) == pdTRUE);
    CHECK(xSemaphoreGive(sem) == pdFALSE);      // full: the second give changes nothing
    CHECK(xSemaphoreTake(sem, 0) == pdTRUE);
    CHECK(xSemaphoreTake(sem, 0) == pdFALSE);   // one give, one take
    CHECK(xSemaphoreTake(sem, pdMS_TO_TICKS(30)) == pdFALSE);   // times out

    // A give from another thread wakes a take waiting for it; the taker gives back nothing (it is not a mutex).
    pthread_t giver;
    CHECK(pthread_create(&giver, NULL, give_later, sem) == 0);
    CHECK(xSemaphoreTake(sem, portMAX_DELAY) == pdTRUE);
    CHECK(pthread_join(giver, NULL) == 0);
    CHECK(xSemaphoreTake(sem, 0) == pdFALSE);

    // Given before anyone waits, the give is kept for the next take, by any thread.
    CHECK(xSemaphoreGive(sem) == pdTRUE);
    CHECK(xSemaphoreTake(sem, pdMS_TO_TICKS(1000)) == pdTRUE);

    // The mutexes beside it are unchanged: only the holder gives one back.
    SemaphoreHandle_t mu = xSemaphoreCreateMutex();
    CHECK(xSemaphoreGive(mu) == pdFALSE);
    CHECK(xSemaphoreTake(mu, 0) == pdTRUE);
    CHECK(xSemaphoreTake(mu, 0) == pdFALSE);
    CHECK(xSemaphoreGive(mu) == pdTRUE);
    printf("test_rtos: %d checks passed\n", checks);
    return 0;
}
