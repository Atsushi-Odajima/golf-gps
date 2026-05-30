export interface LatLng {
  lat: number;
  lng: number;
}

export interface Pixel {
  x: number;
  y: number;
}

const EARTH_RADIUS_M = 6371000;
const METERS_PER_YARD = 0.9144;

export function metersToYards(m: number): number {
  return m / METERS_PER_YARD;
}

export function yardsToMeters(y: number): number {
  return y * METERS_PER_YARD;
}

export function haversineMeters(a: LatLng, b: LatLng): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

/**
 * Initial bearing (forward azimuth) in degrees from `start` to `end`.
 * 0 = north, 90 = east, clockwise positive.
 */
export function bearingFromTo(start: LatLng, end: LatLng): number {
  const phi1 = (start.lat * Math.PI) / 180;
  const phi2 = (end.lat * Math.PI) / 180;
  const dLambda = ((end.lng - start.lng) * Math.PI) / 180;
  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  const theta = Math.atan2(y, x);
  return ((theta * 180) / Math.PI + 360) % 360;
}

/**
 * Destination point from `start` traveling `distanceMeters` along compass `bearingDeg`
 * (0° = north, 90° = east). Standard great-circle "direct" formula.
 */
export function projectLatLng(
  start: LatLng,
  bearingDeg: number,
  distanceMeters: number,
): LatLng {
  const R = EARTH_RADIUS_M;
  const delta = distanceMeters / R;
  const theta = (bearingDeg * Math.PI) / 180;
  const phi1 = (start.lat * Math.PI) / 180;
  const lambda1 = (start.lng * Math.PI) / 180;
  const sinPhi2 =
    Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(theta);
  const phi2 = Math.asin(sinPhi2);
  const y = Math.sin(theta) * Math.sin(delta) * Math.cos(phi1);
  const x = Math.cos(delta) - Math.sin(phi1) * sinPhi2;
  const lambda2 = lambda1 + Math.atan2(y, x);
  return {
    lat: (phi2 * 180) / Math.PI,
    lng: (((lambda2 * 180) / Math.PI + 540) % 360) - 180,
  };
}

/**
 * Local equirectangular projection centered at `origin`. Returns meters east/north.
 * Accurate enough for distances under a few km, which covers any golf hole.
 */
export function projectToLocalMeters(origin: LatLng, p: LatLng): { east: number; north: number } {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(p.lat - origin.lat);
  const dLng = toRad(p.lng - origin.lng);
  const east = dLng * Math.cos(toRad(origin.lat)) * EARTH_RADIUS_M;
  const north = dLat * EARTH_RADIUS_M;
  return { east, north };
}

/**
 * Similarity transform from world (lat/lng) to image pixels.
 * Built from two known correspondences: tee and green.
 *
 * Steps:
 *   1. project world coords to local meters relative to tee
 *   2. world vector (tee→green) and image vector (teePx→greenPx)
 *   3. compute rotation+uniform-scale that maps one to the other
 *   4. apply that transform to any new world point
 */
export interface Calibration {
  tee: LatLng;
  green: LatLng;
  teePx: Pixel;
  greenPx: Pixel;
}

export function worldToPixel(cal: Calibration, p: LatLng): Pixel {
  const greenLocal = projectToLocalMeters(cal.tee, cal.green);
  const pointLocal = projectToLocalMeters(cal.tee, p);

  // world vector: tee → green
  const wx = greenLocal.east;
  const wy = greenLocal.north;
  // image vector: teePx → greenPx (note: image Y increases downward, so negate)
  const ix = cal.greenPx.x - cal.teePx.x;
  const iy = -(cal.greenPx.y - cal.teePx.y);

  // Similarity transform: find (a, b) such that
  //   [ix]   [a -b] [wx]
  //   [iy] = [b  a] [wy]
  // Solve: a = (wx*ix + wy*iy)/(wx^2+wy^2), b = (wx*iy - wy*ix)/(wx^2+wy^2)
  const denom = wx * wx + wy * wy;
  if (denom === 0) return { x: cal.teePx.x, y: cal.teePx.y };
  const a = (wx * ix + wy * iy) / denom;
  const b = (wx * iy - wy * ix) / denom;

  const px = a * pointLocal.east - b * pointLocal.north;
  const py = b * pointLocal.east + a * pointLocal.north;

  return { x: cal.teePx.x + px, y: cal.teePx.y - py };
}
