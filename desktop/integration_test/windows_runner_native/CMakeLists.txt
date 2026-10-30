cmake_minimum_required(VERSION 3.14)
project(harness_single_instance_tests LANGUAGES CXX)

if(NOT WIN32)
  message(FATAL_ERROR "These process/window regression tests require Windows")
endif()

# The override is only for a historical-source negative control in scratch.
# Normal builds compile the exact runner implementation, without Flutter.
set(HARNESS_SINGLE_INSTANCE_SOURCE_DIR "${CMAKE_CURRENT_LIST_DIR}/../../windows/runner"
    CACHE PATH "Directory containing the production single_instance.cpp and .h")
add_executable(single_instance_test
  single_instance_test.cpp
  "${HARNESS_SINGLE_INSTANCE_SOURCE_DIR}/single_instance.cpp")
target_include_directories(single_instance_test PRIVATE "${HARNESS_SINGLE_INSTANCE_SOURCE_DIR}")
target_compile_features(single_instance_test PRIVATE cxx_std_17)
target_compile_definitions(single_instance_test PRIVATE NOMINMAX UNICODE _UNICODE
  $<$<CONFIG:Debug>:_DEBUG>)
target_link_libraries(single_instance_test PRIVATE user32 advapi32)

enable_testing()
foreach(scenario successor deadline delayed-listen never-listens)
  add_test(NAME single-instance-${scenario}
    COMMAND single_instance_test --scenario ${scenario})
  set_tests_properties(single-instance-${scenario} PROPERTIES TIMEOUT 30 RUN_SERIAL TRUE)
endforeach()
