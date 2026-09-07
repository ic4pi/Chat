/**
 * Module resolve hook: point `@vercel/sandbox` at the local stand-in sandbox
 * so the real API handlers can be exercised without cloud credentials.
 */
export function resolve(specifier, context, next) {
  if (specifier === '@vercel/sandbox') {
    return next(process.env['WORKSPACE_LOCAL_SANDBOX_URL'], context);
  }
  return next(specifier, context);
}
