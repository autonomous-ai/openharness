# Harness Max's display bench: an ESP-IDF app of its own that times the product's display path (the scenes, the strip
# raster, the turn on the CPU and on the PPA, a layer's copy, two cores) on an ESP32-P4. Not part of the product image:
# the product builds from ../ and never looks in here. README.md says how to build, flash and read it.
cmake_minimum_required(VERSION 3.16)

if(NOT DEFINED IDF_TARGET AND NOT DEFINED ENV{IDF_TARGET})
    set(IDF_TARGET esp32p4)
endif()

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(harness_max_bench)
