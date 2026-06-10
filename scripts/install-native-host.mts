/**
 * Install Chrome native messaging host manifest and launch wrapper.
 * 手跑安装脚本，不进测试套件。幂等可重跑。
 *
 * Usage: npx tsx scripts/install-native-host.mts <extension-id>
 * Args: extension ID（32 个小写字母 a-p —— Chrome 用 base16 映射到 a-p 字母表，
 *       不是 [0-9a-f]，别"修正"这个校验）
 *
 * Creates:
 * - ~/.autocrew/bridge/launch.sh: 启动 wrapper。绝对路径在安装时烘焙——
 *   Dock 启动的 Chrome 继承 launchd 的 PATH（没有 homebrew/nvm），
 *   `npx`/`node` 都找不到，所以直接用当前 node 可执行文件 + 仓库内
 *   node_modules/.bin/tsx 的绝对路径。
 * - ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.autocrew.bridge.json
 *   (manifest registering launch.sh and allowed extension origin)
 *
 * 安装完成后打印中文验证步骤（创始人自用）。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const extensionId = process.argv[2];

if (!extensionId) {
  console.error("用法: npx tsx scripts/install-native-host.mts <extension-id>");
  process.exit(1);
}

// 校验扩展 ID 格式（Chrome 扩展 ID = base16 映射到 a-p 字母表的 32 个小写字母）
if (!/^[a-p]{32}$/.test(extensionId)) {
  console.error(
    `扩展 ID 格式非法: "${extensionId}"\n` +
      "期望: 32 个小写字母 a-p（Chrome 扩展 ID 是 base16 映射到 a-p 字母表，不含 q-z 或数字）",
  );
  process.exit(1);
}

// Resolve repo root at install time (one level up from scripts/)
const repoRoot = path.resolve(import.meta.dirname, "..");
const home = os.homedir();
const launchShPath = path.join(home, ".autocrew/bridge/launch.sh");
const manifestDir = path.join(
  home,
  "Library/Application Support/Google/Chrome/NativeMessagingHosts",
);
const manifestPath = path.join(manifestDir, "com.autocrew.bridge.json");

// 1. Create ~/.autocrew/bridge/ directory if missing
fs.mkdirSync(path.dirname(launchShPath), { recursive: true });

// 2. Write launch.sh — 绝对路径全部在安装时烘焙（见文件头注释）
const tsxBin = path.join(repoRoot, "node_modules/.bin/tsx");
const hostEntry = path.join(repoRoot, "src/bridge/native-host.ts");
const launchScript = `#!/bin/bash
exec "${process.execPath}" "${tsxBin}" "${hostEntry}"
`;
fs.writeFileSync(launchShPath, launchScript);
fs.chmodSync(launchShPath, 0o755);

// 3. Write manifest JSON
fs.mkdirSync(manifestDir, { recursive: true });
const manifest = {
  name: "com.autocrew.bridge",
  description: "AutoCrew bridge",
  path: launchShPath,
  type: "stdio",
  allowed_origins: [`chrome-extension://${extensionId}/`],
};
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

console.log("✓ Native host 安装完成\n");
console.log("下一步验证:");
console.log("1. 打开 chrome://extensions（开启右上角「开发者模式」）");
console.log("2. 「加载已解压的扩展程序」→ 选本仓库的 extension/ 目录");
console.log("3. 核对扩展 ID 与本次安装参数一致（不一致就用新 ID 重跑本脚本）");
console.log("4. 打开抖音创作者中心作品列表页，点扩展按钮");
console.log("5. 用 autocrew_flywheel action=report 复核导入结果\n");
console.log("已写入:");
console.log(`  ${launchShPath}`);
console.log(`  ${manifestPath}\n`);
console.log("扩展 ID: " + extensionId);
