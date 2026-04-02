/**
 * Douyin (抖音) publisher — placeholder module.
 *
 * Implementation should use the Douyin Creator Open Platform API:
 * https://open.douyin.com/platform/doc/6848806527751489550
 *
 * Required capabilities:
 * - Video upload via /video/upload/
 * - Content publishing via /video/create/
 * - OAuth 2.0 token management
 */

export interface DouyinPublishOptions {
  title: string;
  description: string;
  videoPath?: string;
  imagePaths?: string[];
  isPrivate?: boolean;
  postTime?: string;
}

export interface DouyinPublishResult {
  ok: boolean;
  itemId?: string;
  url?: string;
  error?: string;
}

export async function publishToDouyin(_options: DouyinPublishOptions): Promise<DouyinPublishResult> {
  return {
    ok: false,
    error: "Douyin publishing is not yet implemented. Planned: Douyin Creator Open Platform API integration.",
  };
}
