import test from 'node:test';
import assert from 'node:assert/strict';

const NETWORK_LIMITS = {
  x: { maxChars: 280, maxMediaBytes: 5 * 1024 * 1024, allowedMimes: ['image/png', 'image/jpeg', 'video/mp4'] },
  linkedin: { maxChars: 3000, maxMediaBytes: 10 * 1024 * 1024, allowedMimes: ['image/png', 'image/jpeg', 'video/mp4'] },
  bluesky: { maxChars: 300, maxMediaBytes: 1 * 1024 * 1024, allowedMimes: ['image/png', 'image/jpeg'] },
};

function formatInTimezone(isoUtc, timeZone) {
  const date = new Date(isoUtc);
  if (Number.isNaN(date.getTime())) {
    throw new RangeError(`Invalid ISO timestamp: ${isoUtc}`);
  }
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function validateScheduledPost(network, { text, media = [], scheduledAtUtc }) {
  const spec = NETWORK_LIMITS[network];
  if (!spec) return { ok: false, reason: `Unsupported network: ${network}` };
  if (!text || text.length > spec.maxChars) {
    return { ok: false, reason: `Text length must be 1..${spec.maxChars}` };
  }
  const ts = Date.parse(scheduledAtUtc);
  if (Number.isNaN(ts)) return { ok: false, reason: 'Invalid scheduledAtUtc' };
  for (const item of media) {
    if (!spec.allowedMimes.includes(item.mime)) {
      return { ok: false, reason: `Disallowed MIME ${item.mime} for ${network}` };
    }
    if (item.bytes > spec.maxMediaBytes) {
      return { ok: false, reason: `Media exceeds ${spec.maxMediaBytes} bytes for ${network}` };
    }
  }
  return { ok: true };
}

test('converts UTC timestamps deterministically across IANA timezones', () => {
  const utc = '2026-11-28T05:00:00Z';
  assert.equal(formatInTimezone(utc, 'Asia/Seoul'), '2026-11-28, 14:00');
  assert.equal(formatInTimezone(utc, 'America/New_York'), '2026-11-28, 00:00');
  assert.equal(formatInTimezone(utc, 'Europe/London'), '2026-11-28, 05:00');
});

test('rejects invalid timestamps when formatting schedule', () => {
  assert.throws(() => formatInTimezone('not-a-date', 'UTC'), RangeError);
});

test('validates character limits, MIME types, and media size per network', () => {
  assert.deepEqual(
    validateScheduledPost('x', {
      text: 'Hello world',
      media: [{ mime: 'image/png', bytes: 1024 }],
      scheduledAtUtc: '2026-11-28T15:00:00Z',
    }),
    { ok: true },
  );

  const tooLong = validateScheduledPost('x', {
    text: 'a'.repeat(281),
    scheduledAtUtc: '2026-11-28T15:00:00Z',
  });
  assert.equal(tooLong.ok, false);

  const badMime = validateScheduledPost('bluesky', {
    text: 'Video not allowed here',
    media: [{ mime: 'video/mp4', bytes: 500 }],
    scheduledAtUtc: '2026-11-28T15:00:00Z',
  });
  assert.equal(badMime.ok, false);

  const tooBig = validateScheduledPost('bluesky', {
    text: 'Oversized image',
    media: [{ mime: 'image/jpeg', bytes: 2 * 1024 * 1024 }],
    scheduledAtUtc: '2026-11-28T15:00:00Z',
  });
  assert.equal(tooBig.ok, false);
});
