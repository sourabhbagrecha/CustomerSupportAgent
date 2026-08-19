try {
  process.loadEnvFile();
} catch {
  // No .env file; rely on real environment variables (e.g. CI).
}
