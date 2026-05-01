import type { LocationCoordinates } from './locationService'

type TravelMode = 'driving' | 'walking'

interface CacheEntry {
  travelMinutes: number
  expiresAt: number
}

// In-memory cache: key → CacheEntry
// Key format: `${fromLat3dp},${fromLng3dp}|${toLat},${toLng}|${mode}`
// Round `from` coords to 3 decimal places (~110 m precision) to cache results when user barely moves
// TTL: 10 minutes (600_000 ms)
// 'to' coords are NOT rounded (event location is fixed)

const cache = new Map<string, CacheEntry>()
const CACHE_TTL_MS = 600_000

function cacheKey(from: LocationCoordinates, to: { lat: number; lng: number }, mode: TravelMode): string {
  const fromLat = Math.round(from.latitude * 1000) / 1000
  const fromLng = Math.round(from.longitude * 1000) / 1000
  return `${fromLat},${fromLng}|${to.lat},${to.lng}|${mode}`
}

// ORS profile names
const ORS_PROFILE: Record<TravelMode, string> = {
  driving: 'driving-car',
  walking: 'foot-walking',
}

/**
 * Returns travel time in minutes from `from` to `to` using the given mode.
 * Reads VITE_ORS_API_KEY from import.meta.env.
 * Throws on API error or missing key — callers must handle fallback.
 * Results are cached for 10 minutes per (rounded-from, to, mode) key.
 */
export async function getTravelTimeMinutes(
  from: LocationCoordinates,
  to: { lat: number; lng: number },
  mode: TravelMode
): Promise<number> {
  const key = cacheKey(from, to, mode)
  const cached = cache.get(key)
  if (cached && Date.now() < cached.expiresAt) {
    return cached.travelMinutes
  }

  const apiKey = import.meta.env.VITE_ORS_API_KEY as string | undefined
  if (!apiKey) throw new Error('VITE_ORS_API_KEY is not set')

  const profile = ORS_PROFILE[mode]
  const url = `https://api.openrouteservice.org/v2/directions/${profile}`

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: apiKey,
    },
    body: JSON.stringify({
      coordinates: [
        [from.longitude, from.latitude],   // ORS uses [lng, lat] order
        [to.lng, to.lat],
      ],
    }),
  })

  if (!response.ok) {
    throw new Error(`ORS API error ${response.status}: ${await response.text()}`)
  }

  const data = await response.json()
  // ORS response: data.routes[0].summary.duration is seconds
  const durationSeconds: number = data.routes[0].summary.duration
  const travelMinutes = Math.ceil(durationSeconds / 60)

  cache.set(key, { travelMinutes, expiresAt: Date.now() + CACHE_TTL_MS })
  return travelMinutes
}
