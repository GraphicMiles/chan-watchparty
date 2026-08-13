cmake_minimum_required(VERSION 3.18.1)
project(chanvlcbrightness LANGUAGES C)

# dlopen/dlsym are resolved at runtime against libvlc.so — no link dependency.
add_library(chanvlcbrightness SHARED jni_bridge.c)

find_library(log-lib log)
target_link_libraries(chanvlcbrightness ${log-lib})
