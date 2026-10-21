// The renderer's title bar height in CSS pixels (Tailwind h-10).
const TITLE_BAR_HEIGHT = 40

// macOS draws its traffic lights in window points, unaffected by the page zoom.
const TRAFFIC_LIGHT_X = 16
const TRAFFIC_LIGHT_HEIGHT = 16
// Width the traffic lights occupy, plus the gap before the logo.
export const TRAFFIC_LIGHT_INSET = 84

// Keeps the traffic lights vertically centred on the title bar at any font scale.
export function trafficLightPosition(fontScale: number): { x: number; y: number } {
  const barHeight = (TITLE_BAR_HEIGHT * fontScale) / 100
  return { x: TRAFFIC_LIGHT_X, y: Math.round((barHeight - TRAFFIC_LIGHT_HEIGHT) / 2) }
}
