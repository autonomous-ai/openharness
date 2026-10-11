#pragma once
#include "FreeRTOS.h"
typedef struct host_mutex *SemaphoreHandle_t;
SemaphoreHandle_t xSemaphoreCreateMutex(void);
BaseType_t xSemaphoreTake(SemaphoreHandle_t m, TickType_t wait);
BaseType_t xSemaphoreGive(SemaphoreHandle_t m);
SemaphoreHandle_t xSemaphoreCreateRecursiveMutex(void);
BaseType_t xSemaphoreTakeRecursive(SemaphoreHandle_t m, TickType_t wait);
BaseType_t xSemaphoreGiveRecursive(SemaphoreHandle_t m);
