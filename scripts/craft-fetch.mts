/**
 * 抓对标视频的元数据、重看强度、英文字幕（可选热门评论）到本机缓存，给拆解卡用。逻辑在 src/modules/craft。
 * 用法：npm run craft:fetch -- <YouTube 视频网址...> [--out <目录>] [--comments N] [--clean <博主>]
 */
import { runCraftCli } from "../src/modules/craft/cli.js";

process.exitCode = await runCraftCli(process.argv.slice(2));
