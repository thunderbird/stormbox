/** Stalwart upstreams for WebSocket authentication upgrades. */
export interface Route {
  upstream: string;
}

export const STAGE_ROUTE: Route = {
  upstream: 'https://mail.stage-thundermail.com',
};

export const PROD_ROUTE: Route = {
  upstream: 'https://mail.thundermail.com',
};

/** Selects the production upstream during workers.dev smoke tests. */
export const TEST_UPSTREAM_HEADER = 'x-jmap-bridge-test-upstream';

export function selectRoute(request: Request): Route | null {
  const host = new URL(request.url).hostname;
  if (host === 'jmap.thundermail.com') {
    return PROD_ROUTE;
  }
  if (host === 'jmap.stage-thundermail.com') {
    return STAGE_ROUTE;
  }
  if (host.endsWith('.workers.dev')) {
    const which = request.headers.get(TEST_UPSTREAM_HEADER)?.toLowerCase();
    return which === 'prod' ? PROD_ROUTE : STAGE_ROUTE;
  }
  return null;
}
