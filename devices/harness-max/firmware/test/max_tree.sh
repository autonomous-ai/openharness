# Sourced by the host scripts (run.sh, golden.sh, raster_same.sh, max_motion_bench.sh, ../bench/profile.sh): what a
# host build of Harness Max's sources takes from the Max's tree before the Pro's, as sources.cmake has it for the
# device and Linux builds. Needs $fw (devices/harness-max/firmware).
#   max_pro_flags   ahead of every -I of the Pro's: main/pro_fork/ first on the path (its pro_app_api.h and app/pro_app.h
#                   are the ones the Max's build reads) and the glass (main/max_glass.h, force-included)
#   max_compositor  the Max's copies of the Pro's terminal.c, pro_canvas.c and pod_draw.c, built in place of the Pro's
max_pro_flags=(-I"$fw/main/pro_fork" -include "$fw/main/max_glass.h")
max_compositor=("$fw/main/pro_fork/display/terminal.c" "$fw/main/pro_fork/display/pro_canvas.c"
                "$fw/main/pro_fork/pod/pod_draw.c")
