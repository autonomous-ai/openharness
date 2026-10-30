// Task stack sizes, in bytes, in one place. Comments elsewhere name the task, not the number.
// ram_telemetry_periodic() reports each task's real high-water mark by name: tune from that.
#pragma once

#define STACK_CABLE_LINK 12288   // cable_link reader: also runs pro_cable's parser, Pod's feeds and the OTA write (host proxy: 6.9 KB parser)
#define STACK_RENDER 24576       // pro_render: the ROM inflater and the 24-row strips want room
#define STACK_TOUCH 10240        // pro_touch: a tap runs Pod's gesture and (after the lock is released) a cable send
#define STACK_CABLE_HELLO 4096
#define STACK_BEEP 4096
#define STACK_PTT 4096
#define STACK_VOICE 5120         // voice_capture and voice_send
