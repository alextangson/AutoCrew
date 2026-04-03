/**
 * ASCII art banner for AutoCrew CLI.
 * Only displayed when stdout is a TTY.
 */

const LOGO = `
\x1b[38;5;196m    _         _         ____
   / \\  _   _| |_ ___  / ___|_ __ _____      __
  / _ \\| | | | __/ _ \\| |   | '__/ _ \\ \\ /\\ / /
 / ___ \\ |_| | || (_) | |___| | |  __/\\ V  V /
/_/   \\_\\__,_|\\__\\___/ \\____|_|  \\___| \\_/\\_/\x1b[0m`;

export function showBanner(version: string): void {
  if (!process.stdout.isTTY) return;
  console.log(LOGO);
  console.log(`\x1b[2m  v${version} — AI content operations crew\x1b[0m`);
  console.log();
}
