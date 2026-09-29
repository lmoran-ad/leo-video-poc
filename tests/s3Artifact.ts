import { expect, type APIRequestContext } from '@playwright/test';

const MIN_VIDEO_BYTES = 200_000;
const CLOCK_SLACK = 5 * 60_000;
const CONTENT_TYPES: Record<string, string> = {
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
};

export type Artifact = { filename: string; format: string; url: string; taskId: string };

export async function expectArtifactInS3(request: APIRequestContext, artifact: Artifact, uploadedAfter: number) {
  const { LEO_S3_HOST } = process.env;
  expect(LEO_S3_HOST, 'Set LEO_S3_HOST in .env').toBeTruthy();
  const url = new URL(artifact.url);
  expect(url.host, 'Stored in the Leo S3 bucket').toBe(LEO_S3_HOST);
  expect(url.pathname, 'Stored under the task that produced it').toMatch(
    new RegExp(`^/ai_agent/tasks/${artifact.taskId}/[0-9a-f-]{36}\\.${artifact.format}$`),
  );

  // Presigned for GET only, so a ranged GET stands in for HEAD
  const response = await request.get(artifact.url, { headers: { Range: 'bytes=0-1023' } });
  const headers = response.headers();
  expect(response.status(), 'S3 serves the file').toBe(206);
  expect(headers.server, 'Served by S3').toBe('AmazonS3');
  expect(headers['x-amz-request-id'], 'Served by S3').toBeTruthy();
  expect(headers['content-type']).toBe(CONTENT_TYPES[artifact.format] ?? headers['content-type']);

  const size = Number(headers['content-range']?.split('/')[1]);
  expect(size, 'Full file size in bytes').toBeGreaterThan(artifact.format === 'mp4' ? MIN_VIDEO_BYTES : 0);
  expect(Date.parse(headers['last-modified']), 'Uploaded during this run').toBeGreaterThan(uploadedAfter - CLOCK_SLACK);
  if (artifact.format === 'mp4') {
    expect((await response.body()).subarray(4, 8).toString('latin1'), 'MP4 file signature').toBe('ftyp');
  }

  return { size, lastModified: headers['last-modified'], etag: headers.etag };
}
