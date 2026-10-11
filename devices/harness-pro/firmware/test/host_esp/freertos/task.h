#pragma once
#include <stdint.h>
#include "FreeRTOS.h"
typedef struct host_task *TaskHandle_t;
typedef void (*TaskFunction_t)(void *);
BaseType_t xTaskCreate(TaskFunction_t fn, const char *name, uint32_t stack, void *arg, unsigned prio, TaskHandle_t *out);
void vTaskDelete(TaskHandle_t t);
void vTaskDelay(TickType_t ticks);
uint32_t ulTaskNotifyTake(BaseType_t clear, TickType_t wait);
BaseType_t xTaskNotifyGive(TaskHandle_t t);
BaseType_t xTaskCreatePinnedToCore(TaskFunction_t fn, const char *name, uint32_t stack, void *arg, unsigned prio,
                                   TaskHandle_t *out, int core);
uint32_t uxTaskGetStackHighWaterMark(TaskHandle_t t);
