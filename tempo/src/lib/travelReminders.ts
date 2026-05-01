import { locationService, type LocationCoordinates } from './locationService'
import { getTravelTimeMinutes } from './routingService'
import { useAppStore } from '../stores/appStore'
import type { CalendarEvent } from '../types'

// --- GPS cache (2-minute TTL) ---
// Avoids re-prompting the user or hammering GPS on every 60-second tick
interface CachedLocation {
  coords: LocationCoordinates
  expiresAt: number
}
let locationCache: CachedLocation | null = null
const LOCATION_CACHE_TTL_MS = 120_000

async function getCachedLocation(): Promise<LocationCoordinates> {
  if (locationCache && Date.now() < locationCache.expiresAt) {
    return locationCache.coords
  }
  const coords = await locationService.getCurrentLocation()
  locationCache = { coords, expiresAt: Date.now() + LOCATION_CACHE_TTL_MS }
  return coords
}

// --- Already-notified tracking ---
// Map of eventId → startUtc at the time notification was sent
// Prevents re-firing the same notification within a session
// If startUtc changes (event rescheduled), the entry is invalidated
const notified = new Map<string, string>() // eventId → startUtc

function isAlreadyNotified(event: CalendarEvent): boolean {
  return notified.get(event.id) === event.startUtc
}

function markNotified(event: CalendarEvent): void {
  notified.set(event.id, event.startUtc)
}

// --- Travel mode selection ---
function pickMode(distanceKm: number): 'driving' | 'walking' {
  return distanceKm < 1.2 ? 'walking' : 'driving'
}

// --- Haversine fallback travel estimate ---
function estimateMinutes(distanceKm: number, mode: 'driving' | 'walking'): number {
  const speedKmh = mode === 'walking' ? 5 : 40
  return Math.ceil((distanceKm / speedKmh) * 60)
}

// --- Permission helper ---
export async function ensureNotificationPermission(): Promise<NotificationPermission> {
  if (!('Notification' in window)) return 'denied'
  if (Notification.permission !== 'default') return Notification.permission
  return Notification.requestPermission()
}

// --- Main tick ---
async function tick(): Promise<void> {
  const { events, user, addNotification } = useAppStore.getState()

  if (!user.travelAwareRemindersEnabled) return
  if (!locationService.isSupported()) return

  const now = Date.now()
  const threeHoursFromNow = now + 3 * 60 * 60 * 1000

  // Filter to upcoming events in the next 3 hours with coordinates, not yet completed
  const candidates = events.filter(
    (e) =>
      !e.isCompleted &&
      e.locationLat != null &&
      e.locationLng != null &&
      new Date(e.startUtc).getTime() > now &&
      new Date(e.startUtc).getTime() <= threeHoursFromNow &&
      !isAlreadyNotified(e)
  )

  for (const event of candidates) {
    let userCoords: LocationCoordinates
    try {
      userCoords = await getCachedLocation()
    } catch {
      // Geolocation denied or unavailable — disable for this session
      locationCache = null
      if (!geolocationDeniedNotified) {
        geolocationDeniedNotified = true
        addNotification({
          type: 'suggestion',
          title: 'Location access needed',
          body: 'Enable location access in your browser to get travel-aware reminders.',
          read: false,
        })
      }
      return  // stop the tick entirely; will retry next interval
    }

    const distanceKm = locationService.calculateDistance(
      userCoords.latitude,
      userCoords.longitude,
      event.locationLat!,
      event.locationLng!
    )

    // Already there — suppress notification
    if (distanceKm < 0.15) {
      markNotified(event)
      continue
    }

    const mode = pickMode(distanceKm)

    let travelMinutes: number
    try {
      travelMinutes = await getTravelTimeMinutes(
        userCoords,
        { lat: event.locationLat!, lng: event.locationLng! },
        mode
      )
    } catch {
      console.warn('[travelReminders] Routing API failed, using haversine fallback')
      travelMinutes = estimateMinutes(distanceKm, mode)
    }

    const leaveTimeMs =
      new Date(event.startUtc).getTime() - travelMinutes * 60_000 - user.travelBufferMinutes * 60_000

    if (now >= leaveTimeMs) {
      const modeLabel = mode === 'walking' ? 'walk' : 'drive'
      const locationName = event.locationLabel ?? 'your destination'
      const title = `Time to leave for ${event.title}`
      const body = `${travelMinutes} min ${modeLabel} to ${locationName}`

      // In-app notification
      addNotification({
        type: 'reminder',
        title,
        body,
        eventId: event.id,
        action: {
          route: '/',
          viewMode: 'day',
          focusDateUtc: event.startUtc,
          ctaLabel: 'View event',
        },
        read: false,
      })

      // Browser OS notification (if permission granted)
      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification(title, { body, tag: event.id })
      }

      markNotified(event)
    }
  }
}

let geolocationDeniedNotified = false

// --- Public API ---

/**
 * Starts the travel reminder polling loop. Returns a cleanup function to stop it.
 * Call once on app mount; call the returned function on unmount.
 */
export function startTravelReminderLoop(): () => void {
  // Check geolocation support once at startup
  if (!locationService.isSupported()) return () => {}

  const intervalId = setInterval(() => {
    tick().catch((err) => {
      console.error('[travelReminders] tick error:', err)
    })
  }, 60_000)

  // Run immediately on start so user gets a notification within 60s if already past leave time
  tick().catch((err) => {
    console.error('[travelReminders] initial tick error:', err)
  })

  return () => clearInterval(intervalId)
}
