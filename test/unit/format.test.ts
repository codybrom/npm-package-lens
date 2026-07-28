import * as assert from "assert";
import { formatRelativeTime } from "../../src/format";

function isoMinutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

function isoHoursAgo(hours: number): string {
  return isoMinutesAgo(hours * 60);
}

function isoDaysAgo(days: number): string {
  return isoHoursAgo(days * 24);
}

suite("format", () => {
  suite("formatRelativeTime", () => {
    test("Returns undefined when the timestamp is missing", () => {
      assert.equal(formatRelativeTime(undefined), undefined);
    });

    test("Returns undefined for an unparsable timestamp", () => {
      assert.equal(formatRelativeTime("not-a-date"), undefined);
    });

    test("Reports sub-minute timestamps as just now", () => {
      assert.equal(formatRelativeTime(isoMinutesAgo(0)), "just now");
    });

    test("Reports a single minute as singular", () => {
      assert.equal(formatRelativeTime(isoMinutesAgo(1)), "1 minute ago");
    });

    test("Reports multiple minutes as plural", () => {
      assert.equal(formatRelativeTime(isoMinutesAgo(45)), "45 minutes ago");
    });

    test("Switches to hours at 60 minutes", () => {
      assert.equal(formatRelativeTime(isoHoursAgo(1)), "1 hour ago");
      assert.equal(formatRelativeTime(isoHoursAgo(5)), "5 hours ago");
    });

    test("Switches to days at 24 hours", () => {
      assert.equal(formatRelativeTime(isoDaysAgo(1)), "1 day ago");
      assert.equal(formatRelativeTime(isoDaysAgo(4)), "4 days ago");
    });

    test("Switches to months at 30 days", () => {
      assert.equal(formatRelativeTime(isoDaysAgo(30)), "1 month ago");
      assert.equal(formatRelativeTime(isoDaysAgo(65)), "2 months ago");
    });

    test("Switches to years at 12 months", () => {
      assert.equal(formatRelativeTime(isoDaysAgo(365)), "1 year ago");
      assert.equal(formatRelativeTime(isoDaysAgo(800)), "2 years ago");
    });
  });
});
