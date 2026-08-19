// Loads .env into process.env using Node's built-in loader (no dotenv
// dependency, per CLAUDE.md invariant 3: zero infra, minimal deps). Safe to
// import multiple times; missing .env is fine, real env vars still apply.
try {
  process.loadEnvFile();
} catch {
  // No .env file present (e.g. CI with real env vars already set). Fine.
}
