// FreeRTOS semaphores on Linux (esp/rtos.c): mutexes, recursive mutexes and binary semaphores with timed takes, on a
// pthread condition variable (macOS has no pthread_mutex_timedlock).
#pragma once

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

typedef struct rtos_sem *SemaphoreHandle_t;

SemaphoreHandle_t xSemaphoreCreateMutex(void);
SemaphoreHandle_t xSemaphoreCreateRecursiveMutex(void);
// Created empty, as FreeRTOS's: a take waits for a give, which any task may make.
SemaphoreHandle_t xSemaphoreCreateBinary(void);
BaseType_t xSemaphoreTake(SemaphoreHandle_t sem, TickType_t ticks);
BaseType_t xSemaphoreGive(SemaphoreHandle_t sem);
#define xSemaphoreTakeRecursive(sem, ticks) xSemaphoreTake(sem, ticks)
#define xSemaphoreGiveRecursive(sem) xSemaphoreGive(sem)
