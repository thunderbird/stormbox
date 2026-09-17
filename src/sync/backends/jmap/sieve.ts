import {
  compileRules,
  emptyRuleDocument,
  isManagedRulesScript,
  MANAGED_SCRIPT_NAME,
  normalizeRuleDocument,
  parseRulesSource,
  RuleValidationError,
  SIEVE_CAPABILITY,
  uniqueManagedScriptName,
} from '../../../sieve/rules';
import type { MailRuleDocument, SieveRuleCapabilities } from '../../../sieve/rules';
import { JMAP_CAPS } from './transport';
import { callJmap, pickResponse, requireResponse } from './invoke';

interface SieveScriptRecord {
  id: string;
  name: string | null;
  blobId: string;
  isActive: boolean;
}

export interface MailRulesSnapshot {
  supported: boolean;
  accountId: string | null;
  state: string | null;
  capabilities: SieveRuleCapabilities;
  scripts: Array<{ id: string; name: string | null; isActive: boolean }>;
  managedScript: { id: string; name: string | null; isActive: boolean } | null;
  editableScript: { id: string; name: string | null; isActive: boolean } | null;
  source: string;
  document: MailRuleDocument;
  visualizationError: string | null;
  parseError: string | null;
}

interface SieveContext {
  accountId: string;
  capabilities: SieveRuleCapabilities;
}

export async function getMailRules({
  transport,
  account,
  useWebSocket = false,
}: {
  transport: any;
  account: { remote_account_id: string };
  useWebSocket?: boolean;
}): Promise<MailRulesSnapshot> {
  const context = await sieveContext(transport, account);
  if (!context) return unsupportedSnapshot();

  const raw = await callJmap(transport, {
    using: [JMAP_CAPS.CORE, JMAP_CAPS.SIEVE],
    methodCalls: [['SieveScript/get', {
      accountId: context.accountId,
      ids: null,
      properties: ['id', 'name', 'blobId', 'isActive'],
    }, 'sieve-get']],
    useWebSocket,
  });
  const response = requireResponse(raw, 'SieveScript/get');
  const scripts = normalizeScriptList(response.list);
  const sources = new Map<string, string>();

  for (const script of scripts) {
    const bytes = await transport.download({
      accountId: context.accountId,
      blobId: script.blobId,
      type: 'application/sieve',
      name: `${script.name || 'script'}.siv`,
    });
    const source = new TextDecoder().decode(bytes);
    sources.set(script.id, source);
  }

  const active = scripts.find((script) => script.isActive) ?? null;
  const managed = scripts.filter((script) =>
    isManagedRulesScript(sources.get(script.id) ?? ''));
  let parseError: string | null = null;
  let selected = active;
  if (!selected && managed.length > 1) {
    parseError = 'More than one Stormbox-managed rule script exists. Resolve the duplicate scripts before saving.';
  } else if (!selected) {
    selected = managed[0] ?? null;
  }

  const source = selected ? (sources.get(selected.id) ?? '') : '';
  let document = emptyRuleDocument();
  let visualizationError: string | null = null;
  if (selected && !parseError) {
    try {
      document = parseRulesSource(source);
    } catch (error) {
      visualizationError = errorMessage(error);
    }
  }

  return {
    supported: true,
    accountId: context.accountId,
    state: typeof response.state === 'string' ? response.state : null,
    capabilities: context.capabilities,
    scripts: scripts.map(publicScript),
    managedScript: selected && isManagedRulesScript(source)
      ? publicScript(selected)
      : null,
    editableScript: selected ? publicScript(selected) : null,
    source,
    document,
    visualizationError,
    parseError,
  };
}

export async function runSetSieveRules({
  transport,
  account,
  request,
  useWebSocket = false,
}: {
  transport: any;
  account: { remote_account_id: string };
  request: any;
  useWebSocket?: boolean;
}): Promise<{ ok: boolean; error?: any; result?: any; response?: any }> {
  const mode = request?.mode ?? 'visual';
  if (mode !== 'visual' && mode !== 'source') {
    return terminalError('invalidArguments', 'The Sieve editor mode is invalid.');
  }
  const sourceMode = mode === 'source';
  if (sourceMode && typeof request?.source !== 'string') {
    return terminalError('invalidArguments', 'The Sieve source must be text.');
  }
  let document: MailRuleDocument | null = null;
  if (!sourceMode) {
    try {
      document = normalizeRuleDocument(request?.document);
    } catch (error) {
      return terminalError('invalidRules', errorMessage(error));
    }
  }

  let snapshot: MailRulesSnapshot;
  try {
    snapshot = await getMailRules({ transport, account, useWebSocket });
  } catch (error) {
    return { ok: false, error: { type: 'transport', message: errorMessage(error) } };
  }
  if (!snapshot.supported || !snapshot.accountId) {
    return terminalError('sieveUnsupported', 'This account does not advertise JMAP for Sieve.');
  }
  if (snapshot.parseError) {
    return terminalError('managedScriptUnreadable', snapshot.parseError);
  }
  if (typeof request?.expectedState === 'string' && request.expectedState !== snapshot.state) {
    return terminalError(
      'sieveStateMismatch',
      'The server’s Sieve scripts changed after this editor loaded. Reload before saving.',
    );
  }

  let source: string;
  if (sourceMode) {
    source = request.source;
  } else {
    try {
      source = compileRules(document, snapshot.capabilities, {
        managed: snapshot.managedScript !== null || snapshot.editableScript === null,
      });
    } catch (error) {
      return terminalError('invalidRules', errorMessage(error));
    }
  }

  const sourceBytes = new TextEncoder().encode(source);
  if (
    typeof snapshot.capabilities.maxSizeScript === 'number'
    && sourceBytes.byteLength > snapshot.capabilities.maxSizeScript
  ) {
    return terminalError(
      'invalidSieve',
      `The script is ${sourceBytes.byteLength} bytes; the server limit is ${snapshot.capabilities.maxSizeScript}.`,
    );
  }

  let upload;
  try {
    upload = await transport.upload({
      accountId: snapshot.accountId,
      type: 'application/sieve',
      body: sourceBytes,
    });
  } catch (error) {
    return { ok: false, error: { type: 'transport', message: errorMessage(error) } };
  }
  if (!upload?.blobId) {
    return { ok: false, error: { type: 'noResponse', message: 'The Sieve upload returned no blob id.' } };
  }

  let validationRaw;
  try {
    validationRaw = await callJmap(transport, {
      using: [JMAP_CAPS.CORE, JMAP_CAPS.SIEVE],
      methodCalls: [['SieveScript/validate', {
        accountId: snapshot.accountId,
        blobId: upload.blobId,
      }, 'sieve-validate']],
      useWebSocket,
    });
  } catch (error) {
    return { ok: false, error: { type: 'transport', message: errorMessage(error) } };
  }
  const validation = pickResponse(validationRaw, 'SieveScript/validate');
  if (!validation) {
    return methodFailure(validationRaw, 'SieveScript/validate');
  }
  if (validation.error) {
    return terminalError(
      'invalidSieve',
      validation.error.description ?? 'The server rejected the Sieve script.',
      { validationError: validation.error },
    );
  }

  const target = snapshot.editableScript;
  const creationId = 'stormbox';
  const setRequest: any = {
    accountId: snapshot.accountId,
  };
  if (typeof snapshot.state === 'string') setRequest.ifInState = snapshot.state;
  if (target) {
    setRequest.update = { [target.id]: { blobId: upload.blobId } };
    setRequest.onSuccessActivateScript = target.id;
  } else {
    setRequest.create = {
      [creationId]: {
        name: uniqueManagedScriptName(snapshot.scripts.map((script) => script.name)),
        blobId: upload.blobId,
      },
    };
    setRequest.onSuccessActivateScript = `#${creationId}`;
  }

  let setRaw;
  try {
    setRaw = await callJmap(transport, {
      using: [JMAP_CAPS.CORE, JMAP_CAPS.SIEVE],
      methodCalls: [['SieveScript/set', setRequest, 'sieve-set']],
      useWebSocket,
    });
  } catch (error) {
    return { ok: false, error: { type: 'transport', message: errorMessage(error) } };
  }
  const setResponse = pickResponse(setRaw, 'SieveScript/set');
  if (!setResponse) return methodFailure(setRaw, 'SieveScript/set');

  const setError = target
    ? setResponse.notUpdated?.[target.id]
    : setResponse.notCreated?.[creationId];
  if (setError) {
    const type = setError.type === 'stateMismatch' ? 'sieveStateMismatch' : (setError.type ?? 'sieveSetFailed');
    return terminalError(type, setError.description ?? 'The server did not save the Sieve script.', {
      setError,
    });
  }

  const scriptId = target?.id ?? setResponse.created?.[creationId]?.id ?? null;
  if (!scriptId) {
    return { ok: false, error: { type: 'noResponse', message: 'The server did not report the saved script.' } };
  }
  return {
    ok: true,
    response: setRaw,
    result: {
      scriptId,
      state: setResponse.newState ?? snapshot.state,
    },
  };
}

async function sieveContext(
  transport: any,
  account: { remote_account_id: string },
): Promise<SieveContext | null> {
  const session = transport.session ?? await transport.fetchSession();
  if (!session?.capabilities?.[SIEVE_CAPABILITY]) return null;
  const accountId = session.primaryAccounts?.[SIEVE_CAPABILITY]
    ?? account.remote_account_id;
  const accountCapability = session.accounts?.[accountId]?.accountCapabilities?.[SIEVE_CAPABILITY];
  if (!accountCapability) return null;
  return {
    accountId,
    capabilities: {
      sieveExtensions: Array.isArray(accountCapability.sieveExtensions)
        ? accountCapability.sieveExtensions.filter((item) => typeof item === 'string')
        : [],
      maxSizeScript: finiteOrNull(accountCapability.maxSizeScript),
      maxNumberRedirects: finiteOrNull(accountCapability.maxNumberRedirects),
    },
  };
}

function normalizeScriptList(value: unknown): SieveScriptRecord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((script) => {
    if (
      !isRecord(script)
      || typeof script.id !== 'string'
      || typeof script.blobId !== 'string'
    ) return [];
    return [{
      id: script.id,
      name: typeof script.name === 'string' ? script.name : null,
      blobId: script.blobId,
      isActive: script.isActive === true,
    }];
  });
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function publicScript(script: SieveScriptRecord) {
  return { id: script.id, name: script.name, isActive: script.isActive };
}

function unsupportedSnapshot(): MailRulesSnapshot {
  return {
    supported: false,
    accountId: null,
    state: null,
    capabilities: { sieveExtensions: [] },
    scripts: [],
    managedScript: null,
    editableScript: null,
    source: '',
    document: emptyRuleDocument(),
    visualizationError: null,
    parseError: null,
  };
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function methodFailure(raw: any, method: string) {
  const failure = pickResponse(raw, 'error');
  const serverType = failure?.type ?? 'noResponse';
  const type = serverType === 'stateMismatch' ? 'sieveStateMismatch' : serverType;
  const message = failure?.description ?? `${method} returned no response.`;
  if (serverType === 'stateMismatch' || serverType === 'invalidArguments') {
    return terminalError(type, message, { methodError: failure ?? null });
  }
  return { ok: false, error: { type, message, methodError: failure ?? null } };
}

function terminalError(type: string, message: string, result?: any) {
  return {
    ok: false,
    error: {
      type,
      message,
      terminal: true,
      ...(result === undefined ? {} : { result }),
    },
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof RuleValidationError || error instanceof Error) return error.message;
  return String(error);
}
