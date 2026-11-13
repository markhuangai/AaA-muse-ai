export function browserTransport(origin) {
  if (process.env.MUSE_TEST_DIRECT_NETWORK !== 'true') return { origin, args: [], fetch: route => route.fetch() };
  const address = new URL(origin), containerAddress = address.hostname;
  address.hostname = 'localhost';
  return { origin: address.origin, args: [`--host-resolver-rules=MAP localhost ${containerAddress}`], fetch: route => {
    const request = new URL(route.request().url());
    return route.fetch({ url: origin + request.pathname + request.search, headers: { ...route.request().headers(), host: address.host } });
  } };
}
