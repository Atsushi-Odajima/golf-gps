"use client";

import { useEffect, useRef, useState } from "react";

export interface GpsFix {
  lat: number;
  lng: number;
  accuracy: number;
  timestamp: number;
}

export interface UseGeolocationResult {
  fix: GpsFix | null;
  error: string | null;
  watching: boolean;
}

export function useGeolocation(active: boolean): UseGeolocationResult {
  const [fix, setFix] = useState<GpsFix | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [watching, setWatching] = useState(false);
  const watchIdRef = useRef<number | null>(null);

  useEffect(() => {
    if (!active) return;
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setError("このブラウザは位置情報に対応していません");
      return;
    }
    setWatching(true);
    setError(null);

    const id = navigator.geolocation.watchPosition(
      (pos) => {
        setFix({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          timestamp: pos.timestamp,
        });
        setError(null);
      },
      (err) => {
        setError(`GPSエラー: ${err.message}`);
      },
      {
        enableHighAccuracy: true,
        maximumAge: 1000,
        timeout: 15000,
      },
    );
    watchIdRef.current = id;

    return () => {
      if (watchIdRef.current !== null) {
        navigator.geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }
      setWatching(false);
    };
  }, [active]);

  return { fix, error, watching };
}
