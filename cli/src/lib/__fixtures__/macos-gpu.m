// Disposable Metal workload for RUN_MACOS_GPU=1. No windows or user files.
#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#include <stdio.h>

int main(void) {
  @autoreleasepool {
    id<MTLDevice> device = MTLCreateSystemDefaultDevice();
    NSError *error = nil;
    NSString *source = @"#include <metal_stdlib>\nusing namespace metal;\n"
      "kernel void work(device float *out [[buffer(0)]], uint i [[thread_position_in_grid]]) {"
      "float x = float(i) * 0.001f; for (uint j = 0; j < 512; ++j) x = sin(x) + 0.01f; out[i] = x; }";
    id<MTLLibrary> library = [device newLibraryWithSource:source options:nil error:&error];
    id<MTLFunction> function = [library newFunctionWithName:@"work"];
    id<MTLComputePipelineState> pipeline = function ? [device newComputePipelineStateWithFunction:function error:&error] : nil;
    if (!pipeline) { fprintf(stderr, "Metal unavailable: %s\n", error.description.UTF8String); return 1; }
    id<MTLCommandQueue> queue = [device newCommandQueue];
    id<MTLBuffer> buffer = [device newBufferWithLength:65536 * sizeof(float) options:MTLResourceStorageModeShared];
    NSDate *until = [NSDate dateWithTimeIntervalSinceNow:20];
    BOOL ready = NO;
    while (until.timeIntervalSinceNow > 0) {
      @autoreleasepool {
        id<MTLCommandBuffer> command = [queue commandBuffer];
        id<MTLComputeCommandEncoder> encoder = [command computeCommandEncoder];
        [encoder setComputePipelineState:pipeline];
        [encoder setBuffer:buffer offset:0 atIndex:0];
        [encoder dispatchThreadgroups:MTLSizeMake(256, 1, 1) threadsPerThreadgroup:MTLSizeMake(256, 1, 1)];
        [encoder endEncoding];
        [command commit];
        [command waitUntilCompleted];
        if (command.status == MTLCommandBufferStatusError) return 2;
        if (!ready) { puts("ready"); fflush(stdout); ready = YES; }
      }
    }
  }
  return 0;
}
