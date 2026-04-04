# Open Source Release Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make AutoCrew a polished, npm-installable open-source project with a README designed to hit GitHub Trending.

**Architecture:** Five workstreams — package fixes, LICENSE + metadata, English README, Chinese README, GitHub community files. No code logic changes, purely packaging and docs.

**Tech Stack:** npm, GitHub Actions (existing publish.yml), Markdown

---

### Task 1: Add LICENSE file

**Files:**
- Create: `LICENSE`

**Step 1: Create MIT LICENSE file**

```
MIT License

Copyright (c) 2026 alextangson

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

**Step 2: Add LICENSE to files array in package.json**

In `package.json`, add `"LICENSE"` to the `files` array.

**Step 3: Commit**

```bash
git add LICENSE package.json
git commit -m "chore: add MIT LICENSE file"
```

---

### Task 2: Fix package.json metadata

**Files:**
- Modify: `package.json`
- Modify: `packages/studio/package.json`

**Step 1: Update root package.json**

Add/update these fields:

```json
{
  "description": "One-person content studio powered by AI — from trending topics to published posts",
  "engines": { "node": ">=18.0.0" },
  "homepage": "https://github.com/alextangson/AutoCrew#readme",
  "bugs": { "url": "https://github.com/alextangson/AutoCrew/issues" },
  "keywords": [
    "cli",
    "ai-agent",
    "content-ops",
    "content-creation",
    "automation",
    "chinese-social-media",
    "xiaohongshu",
    "douyin",
    "claude-code",
    "mcp",
    "ai-writing",
    "social-media"
  ]
}
```

Also add `"LICENSE"` and `"README.md"` to the `files` array.

**Step 2: Update studio package.json**

Add `engines`, `files`, `repository` fields:

```json
{
  "engines": { "node": ">=18.0.0" },
  "files": ["src/", "LICENSE"],
  "repository": {
    "type": "git",
    "url": "https://github.com/alextangson/AutoCrew.git",
    "directory": "packages/studio"
  }
}
```

**Step 3: Commit**

```bash
git add package.json packages/studio/package.json
git commit -m "chore: update package metadata for npm publishing"
```

---

### Task 3: Write English README.md

**Files:**
- Rewrite: `README.md`

**Step 1: Write the new README**

Structure (this is the GitHub Trending formula):

1. **Hero section** — Project name + tagline + badges
   - Tagline: "One-person content studio powered by AI — from trending topics to published posts"
   - Badges: MIT, npm version, Node.js, GitHub stars
   
2. **What it does** — 4-line conversation showing the workflow (translate the existing Chinese example to English, keep it punchy)

3. **Quick Start** — 3 steps max
   ```bash
   npm install -g autocrew
   autocrew init
   autocrew research    # find trending topics
   ```

4. **Features** — bullet list, grouped by workflow stage:
   - Research: trending topic discovery, scoring
   - Write: style-calibrated drafts, Hook-Body-CTA structure
   - Review: sensitivity scan, de-AI-ification, quality score
   - Publish: multi-platform (Xiaohongshu, Douyin, WeChat)
   - Learn: auto-learns your edits, improves over time

5. **How it works** — 1-paragraph architecture explanation:
   - Standalone CLI + thin plugin layer for Claude Code / OpenClaw
   - All data local (`~/.autocrew/`)
   - Free tier is fully functional, Pro adds platform crawling

6. **Use with Claude Code** — Short section with MCP config snippet

7. **Use with OpenClaw** — Short section

8. **CLI Reference** — Condensed table of key commands

9. **Web Dashboard** — Mention `autocrew serve` for the web UI

10. **Free vs Pro** — Clean table (translate existing)

11. **Development** — clone, install, test

12. **Contributing** — Link to CONTRIBUTING.md

13. **License** — MIT

Key README principles for GitHub Trending:
- First 5 lines must hook — tagline + badges + "what it does" immediately
- Quick Start within first scroll
- No wall of text — use tables, code blocks, headers
- English primary, link to README_CN.md for Chinese speakers

**Step 2: Verify all links work**

Check that badge URLs, repo URLs, and internal links are correct.

**Step 3: Commit**

```bash
git add README.md
git commit -m "docs: rewrite README for open-source launch"
```

---

### Task 4: Write Chinese README_CN.md

**Files:**
- Create: `README_CN.md`

**Step 1: Write Chinese README**

Largely translate the English README but adapt for Chinese audience:
- Keep the conversation examples in Chinese (they're more natural)
- Add more detail on supported platforms (小红书, 抖音, 微信公众号, B站)
- Link back to main README.md
- Add language switcher at top: `[English](README.md) | 中文`

Add corresponding language switcher in README.md: `English | [中文](README_CN.md)`

**Step 2: Add README_CN.md to files array in package.json**

**Step 3: Commit**

```bash
git add README_CN.md README.md package.json
git commit -m "docs: add Chinese README"
```

---

### Task 5: Add GitHub community files

**Files:**
- Create: `CONTRIBUTING.md`
- Create: `.github/ISSUE_TEMPLATE/bug_report.md`
- Create: `.github/ISSUE_TEMPLATE/feature_request.md`
- Create: `.github/PULL_REQUEST_TEMPLATE.md`

**Step 1: Write CONTRIBUTING.md**

Short and welcoming. Sections:
- Getting Started (clone, install, test)
- Project Structure (brief directory overview)
- Making Changes (branch naming, commit style)
- Running Tests (`npm test`)
- Submitting a PR

Keep it under 80 lines. Don't over-engineer.

**Step 2: Write issue templates**

Bug report template:
- Description, steps to reproduce, expected vs actual, environment (Node version, OS)

Feature request template:
- Problem description, proposed solution, alternatives considered

**Step 3: Write PR template**

```markdown
## What

## Why

## How to test
```

**Step 4: Commit**

```bash
git add CONTRIBUTING.md .github/
git commit -m "docs: add contributing guide and issue/PR templates"
```

---

### Task 6: Final verification

**Step 1: Run tests**

```bash
npm test
```

Expected: All 341 tests pass.

**Step 2: Dry-run npm pack**

```bash
npm pack --dry-run
```

Verify: LICENSE, README.md, bin/, src/, adapters/, skills/, templates/ are all included. No node_modules, no .env, no .pro.

**Step 3: Verify CLI works after install**

```bash
npm link
autocrew --version
autocrew --help
autocrew init
```

**Step 4: Final commit if any fixes needed, then tag**

```bash
git tag v0.1.0
```

Do NOT push tag yet — wait for user to configure NPM_TOKEN in GitHub Secrets first.
