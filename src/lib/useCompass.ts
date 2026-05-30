"use client";

import { useEffect, useState } from "react";

export type CompassPermission = "unknown" | "granted" | "denied";

export interface UseCompassResult {
  heading: number | null;
  permission: CompassPermission;
  supported: boolean;
  requestPermission: () => Promise<boolean>;
}

/**
 * Returns the device's compass heading in degrees (0 = magnetic/true north, 90 = east).
 * On iOS Safari, DeviceOrientationEvent.requestPermission() must be invoked from a
 * user gesture (button tap). On Android and desktop, no permission prompt is needed.
 */
export function useCompass(active: boolean = false): UseCompassResult {
  const [heading, setHeading] = useState<number | null>(null);
  const [permission, setPermission] = useState<CompassPermission>("unknown");
  const [supported, setSupported] = useState(true);

  useEffect(() => {
    if (typeof window === "undefined" || !("DeviceOrientationEvent" in window)) {
      setSupported(false);
      return;
    }
    // On non-iOS browsers, no explicit permission is needed
    const DOE = (window as unknown as { DeviceOrientationEvent: { requestPermission?: () => Promise<string> } }).DeviceOrientationEvent;
    if (!DOE || typeof DOE.requestPermission !== "function") {
      setPermission("granted");
    }
  }, []);

  const requestPermission = async (): Promise<boolean> => {
    if (typeof window === "undefined") return false;
    const DOE = (window as unknown as { DeviceOrientationEvent: { requestPermission?: () => Promise<string> } }).DeviceOrientationEvent;
    if (DOE && typeof DOE.requestPermission === "function") {
      try {
        const result = await DOE.requestPermission();
        const granted = result === "granted";
        setPermission(granted ? "granted" : "denied");
        return granted;
      } catch {
        setPermission("denied");
        return false;
      }
    }
    setPermission("granted");
    return true;
  };

  useEffect(() => {
    if (!active || permission !== "granted") return;
    if (typeof window === "undefined") return;

    const handler = (e: DeviceOrientationEvent) => {
      // iOS Safari: webkitCompassHeading is the calibrated true compass heading
      const iosHeading = (e as unknown as { webkitCompassHeading?: number }).webkitCompassHeading;
      if (typeof iosHeading === "number" && !isNaN(iosHeading)) {
        setHeading(iosHeading);
        return;
      }
      // Standard: alpha (with absolute=true) gives orientation from magnetic north,
      // counter-clockwise positive — invert to compass (clockwise positive).
      if (e.absolute && typeof e.alpha === "number" && !isNaN(e.alpha)) {
        setHeading((360 - e.alpha + 360) % 360);
      }
    };

    window.addEventListener(
      "deviceorientationabsolute",
      handler as EventListener,
      true,
    );
    window.addEventListener("deviceorientation", handler as EventListener, true);

    return () => {
      window.removeEventListener(
        "deviceorientationabsolute",
        handler as EventListener,
        true,
      );
      window.removeEventListener(
        "deviceorientation",
        handler as EventListener,
        true,
      );
    };
  }, [active, permission]);

  return { heading, permission, supported, requestPermission };
}
