// FreeRTOS on Linux (esp/rtos.c): the types, ticks and critical sections the shared sources use. A tick is a
// millisecond, as the device's CONFIG_FREERTOS_HZ=1000.
#pragma once

#include <pthread.h>
#include <stdint.h>

typedef uint32_t TickType_t;
typedef int BaseType_t;
typedef unsigned UBaseType_t;

#define pdTRUE 1
#define pdFALSE 0
#define pdPASS 1
#define pdFAIL 0
#define portMAX_DELAY 0xffffffffu
#define pdMS_TO_TICKS(ms) ((TickType_t)(ms))

// The device's spinlock guards a few stores against the other core; a mutex does the same between threads.
typedef pthread_mutex_t portMUX_TYPE;
#define portMUX_INITIALIZER_UNLOCKED PTHREAD_MUTEX_INITIALIZER
#define portENTER_CRITICAL(mux) pthread_mutex_lock(mux)
#define portEXIT_CRITICAL(mux) pthread_mutex_unlock(mux)
