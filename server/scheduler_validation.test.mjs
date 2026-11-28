import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

describe('Social Publishing Scheduler Timezone & Media Validation Suite', () => {
  const PLATFORM_LIMITS = {
    twitter: { maxChars: 280, maxMedia: 4 },
    threads: { maxChars: 500, maxMedia: 10 },
    linkedin: { maxChars: 3000, maxMedia: 9 },
  };

  const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'video/mp4'];
  const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50MB

  function validatePostPayload(platform, content, media = []) {
    const limits = PLATFORM_LIMITS[platform];
    if (!limits) {
      throw new Error(`Unsupported platform: ${platform}`);
    }

    if (!content && media.length === 0) {
      throw new Error('Post must contain either text or media attachments');
    }

    if (content && content.length > limits.maxChars) {
      throw new Error(
        `Content exceeds character limit for ${platform}: ${content.length} > ${limits.maxChars}`
      );
    }

    if (media.length > limits.maxMedia) {
      throw new Error(`Media count exceeds maximum limit for ${platform}: ${media.length} > ${limits.maxMedia}`);
    }

    for (const item of media) {
      if (!ALLOWED_MIME_TYPES.includes(item.mimeType)) {
        throw new Error(`Unsupported media type: ${item.mimeType}`);
      }
      if (item.sizeBytes > MAX_FILE_SIZE_BYTES) {
        throw new Error(`File size ${item.sizeBytes} exceeds maximum allowance of 50MB`);
      }
    }

    return true;
  }

  function schedulePostAt(isoTimestamp, timezone) {
    const scheduledTime = new Date(isoTimestamp);
    if (isNaN(scheduledTime.getTime())) {
      throw new Error(`Invalid ISO timestamp: ${isoTimestamp}`);
    }

    const now = new Date();
    if (scheduledTime.getTime() <= now.getTime()) {
      throw new Error('Cannot schedule post in the past');
    }

    // Return normalized UTC epoch
    return {
      scheduledUtcEpoch: scheduledTime.getTime(),
      targetTimezone: timezone,
      status: 'QUEUED',
    };
  }

  test('validates character limits across Twitter, Threads, and LinkedIn', () => {
    const shortText = 'Hello Hanzo OSS!';
    assert.equal(validatePostPayload('twitter', shortText), true);
    assert.equal(validatePostPayload('threads', shortText), true);
    assert.equal(validatePostPayload('linkedin', shortText), true);

    const overTwitter = 'a'.repeat(281);
    assert.throws(() => validatePostPayload('twitter', overTwitter), {
      message: /Content exceeds character limit for twitter/,
    });

    const validThreads = 'a'.repeat(450);
    assert.equal(validatePostPayload('threads', validThreads), true);
  });

  test('validates media attachments format and size constraints', () => {
    const validMedia = [
      { mimeType: 'image/png', sizeBytes: 1024 * 500 },
      { mimeType: 'video/mp4', sizeBytes: 1024 * 1024 * 10 },
    ];
    assert.equal(validatePostPayload('twitter', 'Media post', validMedia), true);

    const invalidMime = [{ mimeType: 'application/pdf', sizeBytes: 1024 }];
    assert.throws(() => validatePostPayload('twitter', 'PDF post', invalidMime), {
      message: /Unsupported media type: application\/pdf/,
    });

    const oversized = [{ mimeType: 'video/mp4', sizeBytes: 60 * 1024 * 1024 }];
    assert.throws(() => validatePostPayload('twitter', 'Big video', oversized), {
      message: /exceeds maximum allowance/,
    });
  });

  test('schedules future post and normalizes to UTC epoch', () => {
    const futureDate = new Date(Date.now() + 3600 * 1000).toISOString();
    const queued = schedulePostAt(futureDate, 'Asia/Tokyo');
    assert.equal(queued.status, 'QUEUED');
    assert.equal(queued.targetTimezone, 'Asia/Tokyo');
    assert.ok(queued.scheduledUtcEpoch > Date.now());
  });

  test('rejects post scheduled in the past', () => {
    const pastDate = new Date(Date.now() - 3600 * 1000).toISOString();
    assert.throws(() => schedulePostAt(pastDate, 'America/New_York'), {
      message: /Cannot schedule post in the past/,
    });
  });

  test('handles multi-timezone queue ordering deterministically', () => {
    const t1 = new Date(Date.now() + 20000).toISOString();
    const t2 = new Date(Date.now() + 40000).toISOString();

    const post1 = schedulePostAt(t1, 'Europe/London');
    const post2 = schedulePostAt(t2, 'Asia/Tokyo');

    assert.ok(post1.scheduledUtcEpoch < post2.scheduledUtcEpoch);
  });
});
