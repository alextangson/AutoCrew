# Contributing to AutoCrew

Thanks for your interest in contributing! Here's how to get started.

## Setup

```bash
git clone https://github.com/alextangson/AutoCrew.git
cd AutoCrew
npm install
npm test
```

## Project Structure

```
src/
├── cli/          # CLI commands and routing
├── modules/      # Feature modules (research, writing, humanize, publish...)
├── runtime/      # Tool runner, context, event bus, workflow engine
├── server/       # HTTP API server (Hono)
├── storage/      # Local file storage layer
├── tools/        # Tool implementations (the core units of work)
├── types/        # Shared TypeScript types
└── utils/        # Utilities

packages/studio/  # Video production (TTS, composition, Jianying export)
web/              # React web dashboard
skills/           # OpenClaw/Claude Code skill definitions
templates/        # Content and prompt templates
```

## Making Changes

1. Create a branch: `feature/<name>`, `fix/<name>`, or `chore/<name>`
2. Write tests for new functionality
3. Run `npm test` before committing
4. Commit messages: `feat: ...`, `fix: ...`, `docs: ...`, `refactor: ...`, `chore: ...`

## Running Tests

```bash
npm test              # Run all tests
npm run test:watch    # Watch mode
```

## Web Dashboard Development

```bash
cd web
npm run dev           # Start Vite dev server
npm run build         # Production build
```

## Submitting a PR

- Keep PRs focused on a single change
- Include a clear description of what and why
- Make sure tests pass

## Questions?

Open an issue or start a discussion on GitHub.
