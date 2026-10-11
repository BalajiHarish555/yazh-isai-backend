export function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('CRITICAL SECURITY ERROR: JWT_SECRET environment variable must be set in production!');
    }
    return 'dev-fallback-secret-key-must-be-at-least-32-bytes-long!';
  }
  return secret;
}
