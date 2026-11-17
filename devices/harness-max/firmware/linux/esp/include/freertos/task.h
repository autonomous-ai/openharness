// FreeRTOS tasks on Linux (esp/rtos.c): each task is a pthread with its own notification counter.
#pragma once

#include "freertos/FreeRTOS.h"

typedef struct rtos_task *TaskHandle_t;
typedef void (*TaskFunction_t)(void *arg);

// Priority and core are the device's scheduling; Linux schedules threads itself. The stack is the system's: Linux
// frames are larger than the device's, so the device's sizes would be too small here.
BaseType_t xTaskCreatePinnedToCore(TaskFunction_t fn, const char *name, uint32_t stack_bytes, void *arg,
                                   UBaseType_t priority, TaskHandle_t *out, BaseType_t core);
#define xTaskCreate(fn, name, stack, arg, prio, out) xTaskCreatePinnedToCore(fn, name, stack, arg, prio, out, 0)
// NULL ends the calling task; another task is cancelled (the shared sources only do that on a failed start).
void vTaskDelete(TaskHandle_t task);
void vTaskDelay(TickType_t ticks);

TaskHandle_t xTaskGetHandle(const char *name);
const char *pcTaskGetName(TaskHandle_t task);
// Always 0: a Linux thread's stack is the system's, so there is no device high-water mark to report.
UBaseType_t uxTaskGetStackHighWaterMark(TaskHandle_t task);

// The direct-to-task notification as a counting semaphore, the only way the shared sources use it.
void xTaskNotifyGive(TaskHandle_t task);
uint32_t ulTaskNotifyTake(BaseType_t clear_on_exit, TickType_t ticks);
