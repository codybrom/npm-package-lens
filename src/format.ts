const MS_PER_MINUTE = 60 * 1000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/**
 * Formats an ISO 8601 timestamp as a coarse relative-time string (e.g.
 * `"3 hours ago"`, `"3 days ago"`, `"2 years ago"`), for showing how
 * recently something happened without requiring the reader to do date
 * arithmetic.
 * @param isoTimestamp - The timestamp to format, if known.
 * @returns A relative-time string, or `undefined` if `isoTimestamp` is missing or unparsable.
 */
export function formatRelativeTime(
  isoTimestamp: string | undefined,
): string | undefined {
  if (!isoTimestamp) {
    return undefined;
  }

  const timestamp = new Date(isoTimestamp).getTime();
  if (Number.isNaN(timestamp)) {
    return undefined;
  }

  const elapsedMs = Date.now() - timestamp;

  const minutesAgo = Math.floor(elapsedMs / MS_PER_MINUTE);
  if (minutesAgo < 1) {
    return "just now";
  }
  if (minutesAgo < 60) {
    return `${minutesAgo.toString()} minute${minutesAgo === 1 ? "" : "s"} ago`;
  }

  const hoursAgo = Math.floor(elapsedMs / MS_PER_HOUR);
  if (hoursAgo < 24) {
    return `${hoursAgo.toString()} hour${hoursAgo === 1 ? "" : "s"} ago`;
  }

  const daysAgo = Math.floor(elapsedMs / MS_PER_DAY);
  if (daysAgo < 30) {
    return `${daysAgo.toString()} day${daysAgo === 1 ? "" : "s"} ago`;
  }

  const monthsAgo = Math.floor(daysAgo / 30);
  if (monthsAgo < 12) {
    return `${monthsAgo.toString()} month${monthsAgo === 1 ? "" : "s"} ago`;
  }

  const yearsAgo = Math.floor(monthsAgo / 12);
  return `${yearsAgo.toString()} year${yearsAgo === 1 ? "" : "s"} ago`;
}
