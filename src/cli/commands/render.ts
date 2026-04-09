import type { CommandDef } from "./index.js";
import { getOption } from "./index.js";

export const cmd: CommandDef = {
  name: "render",
  description: "Render a video timeline (TTS + screenshots + Jianying export)",
  usage: "autocrew render <project-slug> [--voice <voiceId>] [--ratio <9:16|16:9>]",
  action: async (args, _runner, ctx) => {
    const slug = args[0];
    if (!slug) {
      console.error("Usage: autocrew render <project-slug> [--voice <voiceId>] [--ratio <9:16|16:9>]");
      process.exitCode = 1;
      return;
    }

    const voice = getOption(args, "--voice") || "default";
    const ratio = getOption(args, "--ratio") || "9:16";

    // Find project and its timeline
    try {
      const { findProject } = await import("../../storage/pipeline-store.js");
      const path = await import("node:path");
      const fs = await import("node:fs/promises");

      const found = await findProject(slug);
      if (!found) {
        console.error(`Project not found: "${slug}"`);
        process.exitCode = 1;
        return;
      }

      const timelinePath = path.join(found.dir, "timeline.json");
      let timeline;
      try {
        const raw = await fs.readFile(timelinePath, "utf-8");
        timeline = JSON.parse(raw);
      } catch {
        console.error(`No timeline.json found in project "${slug}".`);
        console.error("Generate a timeline first with autocrew_timeline action='generate'.");
        process.exitCode = 1;
        return;
      }

      // Try to load studio
      let studio: any;
      try {
        studio = await import("autocrew-studio");
      } catch {
        console.error("autocrew-studio is not installed. Install it with:");
        console.error("  npm install autocrew-studio");
        process.exitCode = 1;
        return;
      }

      const config = await studio.loadConfig(ctx.dataDir);
      const outputDir = path.join(found.dir, "render");

      // Instantiate providers from config
      const tts = new studio.DoubaoTTS(config.tts.doubao || {});
      const screenshot = new studio.PuppeteerScreenshot();

      let exporter: { export(t: any, d: string): Promise<{ path: string; format: string }> };
      if (config.compositor.provider === "ffmpeg") {
        const compositor = new studio.FFmpegCompositor();
        exporter = {
          async export(t: any, outDir: string) {
            const result = await compositor.compose(t, path.join(outDir, "output.mp4"));
            return { path: result.path, format: result.format };
          },
        };
      } else {
        exporter = new studio.JianyingExporter();
      }

      console.log(`Rendering timeline for "${slug}" (${ratio}, voice: ${voice})...`);

      const result = await studio.renderTimeline({
        timeline,
        outputDir,
        tts,
        screenshot,
        exporter,
        voice: { voiceId: voice },
      });

      console.log(`Render complete: ${result.path} (${result.format})`);
    } catch (err: any) {
      console.error(`Render failed: ${err.message || err}`);
      process.exitCode = 1;
    }
  },
};
