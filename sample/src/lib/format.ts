const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now", "5m ago", "3h ago", "2d ago" */
export function formatAge(time: number, now = Date.now()): string {
    const age = now - time;
    if (age < MINUTE) return 'just now';
    if (age < HOUR) return `${Math.floor(age / MINUTE)}m ago`;
    if (age < DAY) return `${Math.floor(age / HOUR)}h ago`;
    return `${Math.floor(age / DAY)}d ago`;
}
