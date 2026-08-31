import { pushSettings } from '../../settings';

export async function runPushSettings({
  transport,
  account,
  handlers,
  useWebSocket,
}: {
  transport: any;
  account: any;
  handlers: Record<string, (params: any) => Promise<any>>;
  useWebSocket: boolean;
}) {
  return pushSettings({
    transport,
    account,
    handlers,
    useWebSocket,
  });
}
