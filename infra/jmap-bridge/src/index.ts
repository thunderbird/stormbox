/** WebSocket authentication bridge for the hosted Stalwart servers. */
import { selectRoute } from './routes';
import { handleWebSocketUpgrade } from './ws';

export default {
  async fetch(request: Request): Promise<Response> {
    const route = selectRoute(request);
    if (!route) {
      return new Response('Unknown host', { status: 404 });
    }
    return handleWebSocketUpgrade(request, route);
  },
};
