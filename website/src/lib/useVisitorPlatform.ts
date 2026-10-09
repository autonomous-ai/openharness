"use client";

import { useEffect, useState } from "react";
import { detectVisitorPlatform, type VisitorPlatform } from "@/lib/desktopPlatform";

/**
 * The visitor's platform for the desktop download: null until the browser has answered, which is also
 * what the server renders, so the first client render always matches it.
 */
export function useVisitorPlatform(): VisitorPlatform | null {
  const [platform, setPlatform] = useState<VisitorPlatform | null>(null);
  useEffect(() => {
    let live = true;
    void detectVisitorPlatform(navigator).then((detected) => {
      if (live) setPlatform(detected);
    });
    return () => {
      live = false;
    };
  }, []);
  return platform;
}
