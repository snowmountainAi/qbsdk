// The connection string for psql (libpq).
//
// Node's pg understands sslmode=no-verify (encrypt, skip the certificate
// check), which Cloud SQL URLs use because the server certificate is issued
// for the instance, not for the IP the app connects to. libpq does not know
// that mode and refuses the URL; its "require" means the same thing.
export function psqlUrl(databaseUrl) {
  try {
    const u = new URL(databaseUrl);
    if (u.searchParams.get("sslmode") === "no-verify") u.searchParams.set("sslmode", "require");
    return u.toString();
  } catch {
    return databaseUrl;
  }
}

// psql options must come before the connection string: psql on Windows does
// not reorder arguments, and treats anything after it as extra arguments.
export function psqlArgs(databaseUrl, ...options) {
  return [...options, "-d", psqlUrl(databaseUrl)];
}
