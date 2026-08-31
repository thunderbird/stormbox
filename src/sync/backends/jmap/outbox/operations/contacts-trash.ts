import { pushContactsTrash } from '../../contacts-trash';

export async function runPushContactsTrash({
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
  return pushContactsTrash({
    transport,
    account,
    handlers,
    useWebSocket,
  });
}
