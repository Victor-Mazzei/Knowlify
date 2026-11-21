# Contributing to Knowlify

Thank you for your interest. This guide explains how to set up the project, run the checks and send a change.

## Before you start

- Read [SECURITY.md](SECURITY.md) before you report a security issue.
- Open an issue to discuss a large change before you write code.
- Use English for code, comments, commit messages and issues.

## Requirements

- Node 22 LTS, current release (tested on 22.23.5; the documented minimum is 22.23.5). Node 24 also works.
- npm.
- Rust and the Tauri prerequisites for the desktop app. See [apps/desktop/README.md](apps/desktop/README.md).

## Setup

1. Install the dependencies: `npm install`
2. Start the API: `npm run dev:server`
3. Start the web app in a second terminal: `npm run dev:web`

The web app runs on port 5174 and proxies `/api` to the API on port 8787.

If you change the Node version, run `npm install` again. The native modules `better-sqlite3` and `@napi-rs/canvas` must match the Node ABI.

## Checks

Run these checks before you open a pull request:

```bash
npm install
npm test
npm run typecheck -w @knowlify/server
npm run build -w @knowlify/server
npm run build -w @knowlify/web
npm run version:check
```

`npm test` runs the tests of every workspace. Use `npm run test:server` or `npm run test:web` for one workspace.

If you change the desktop Rust code, also run:

```bash
cd apps/desktop/src-tauri
cargo check --locked
cargo test --locked
cargo clippy --locked -- -D warnings
cargo fmt --check
```

If you change authentication, run `scripts/e2e-account.sh`. If you change indexing, run `scripts/e2e-index.sh`. These scripts start real processes.

## Tests

- Add a test for each bug that you fix.
- Add a test for each new behavior.
- Test behavior, not implementation details.
- Use Vitest for the server and the web app. Use the Node test runner for the scripts and the desktop scripts.
- Use SQLite in memory and temporary files in adapter tests.
- Use `app.inject` for HTTP route tests.

## Code style

- Use TypeScript with strict types. Do not use `any` or `@ts-ignore`.
- Use clear names. Keep functions small and focused.
- Comment the reason for the code, not the code itself.
- Use `const` and immutable data when possible.
- Use English identifiers and comments.
- Preserve the style of the file near your change.

## Architecture rules

The server uses Clean Architecture with lean Domain-Driven Design. Dependencies point inward:

- `domain/`: entities, value objects and pure rules. No I/O.
- `ports/`: interfaces for repositories, clocks, metadata readers and external sources.
- `use-cases/`: application rules. They depend on `domain/` and `ports` only.
- `adapters/`: Fastify routes, SQLite repositories, file readers, RSS and other integrations.
- `index.ts`: the composition root. Instantiate adapters here only.

Keep these rules:

- A route translates input and output. It calls a use case. It does not contain SQL or business rules.
- A use case receives ports by constructor. It does not import an adapter.
- The web app and the server do not share code. The HTTP API is the contract.
- A React component does not call `fetch` directly. Use the API service or the module hook.
- Put invariants in the entity or value object. Do not put them in routes.
- Reference another context by identifier, not by object.
- Keep one repository per aggregate.

Use the domain language in names: `Book`, `Source`, `Note`, `ReadingProgress`, `Feed`.

## Security rules

These rules are not optional:

- Do not commit secrets or `.env` files.
- Validate all external input: size, type and format.
- Set limits for JSON bodies and uploads.
- Block SSRF for every URL that a user supplies: use HTTP(S) on ports 80 and 443, resolve DNS, refuse private and reserved IPs, pin the resolved address, limit the response to 2 MB and set a 10-second timeout.
- Sanitize third-party text before you send it to the UI.
- Treat book files in source folders as read-only.
- Do not log tokens, API keys, passwords, book text or notes.
- Keep the LLM key encrypted and out of API responses and logs.
- Add a new environment variable to `.env.example`.
- Keep the authentication checks on `/api`, `/opds`, `/kosync` and `/mcp`.

If your change touches security, explain the threat and the protection in the pull request.

## Commit messages

Write commit messages in English in the imperative mood. Use this format:

```
type(scope): short summary
```

Examples: `fix(server): reject private IPs on metadata lookup`, `feat(web): add a tag filter to the library`.

Use one of these types: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`, `ci`, `chore`.

Keep one logical change per commit.

## Versioning and changelog

The project uses [Semantic Versioning](https://semver.org/). One version applies to the server, the web app and the desktop app. The maintainers set the version. Do not change version fields in a pull request.

Add a user-visible change to the `[Unreleased]` section of [CHANGELOG.md](CHANGELOG.md). Use the Keep a Changelog format. A change to docs, tests or CI does not need a version bump.

## License

Knowlify is licensed under AGPL-3.0-only. By contributing, you agree that your contribution is licensed under the same terms and that you have the right to submit it.

## Code of conduct

Follow the [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
