import { base44 } from '@/api/base44Client';
import { normalizeTimeline } from '@/lib/timelineEngine';
import { cachedRead } from '@/lib/readCache';

export function buildCanonicalTimeline(rawEvents, now = new Date()) {
  return normalizeTimeline(rawEvents || [], now).segments.map(({ start, end, ...event }) => ({
    ...event,
    start_timestamp: start.toISOString(),
    end_timestamp: end.toISOString(),
    is_ongoing: !!event.is_ongoing,
  }));
}

// Cached: the full event list is read by every route mount. Any duty-status
// write clears the cache (see timelineWriter), so reload() after a save is
// always fresh.
export async function getTimelineEvents(daysBack = 9) {
  return cachedRead(`timeline:${daysBack}`, async () => {
    const since = new Date(Date.now() - (daysBack + 1) * 24 * 3600000);
    const all = await base44.entities.DutyStatusEvent.filter({}, '-start_timestamp', 3000);
    const sorted = (all || [])
      .filter(event => event?.start_timestamp)
      .sort((a, b) => new Date(a.start_timestamp) - new Date(b.start_timestamp));
    const recent = sorted.filter(event => new Date(event.start_timestamp) >= since);
    const carryIn = [...sorted].reverse().find(event => new Date(event.start_timestamp) < since);
    return buildCanonicalTimeline(carryIn ? [carryIn, ...recent] : recent);
  });
}