try {
  process.loadEnvFile('.env')
} catch {
  // no .env yet — copy .env.example
}
