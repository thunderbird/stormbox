import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  accountsUrlForHostname,
  appointmentUrlForHostname,
  defaultJmapServerUrl,
  defaultJmapWsProxyUrl,
  isProdWebmailHostname,
  jmapAccountOriginForServer,
  jmapWsProxyUrlForServer,
  sendUrlForHostname,
  senderAvatarProxyUrlForHostname,
  staffAppUrlForHostname,
} from '../../src/defines';

describe('isProdWebmailHostname', () => {
  it('treats the prod and alpha webmail hosts as production', () => {
    expect(isProdWebmailHostname('webmail.thundermail.com')).toBe(true);
    expect(isProdWebmailHostname('alpha-app.thundermail.com')).toBe(true);
  });

  it('treats stage, dev and missing hosts as non-production', () => {
    expect(isProdWebmailHostname('webmail.stage-thundermail.com')).toBe(false);
    expect(isProdWebmailHostname('localhost')).toBe(false);
    expect(isProdWebmailHostname(undefined)).toBe(false);
  });
});

describe('staffAppUrlForHostname', () => {
  it('sends production webmail staff to alpha-app', () => {
    expect(staffAppUrlForHostname('webmail.thundermail.com')).toBe('https://alpha-app.thundermail.com');
  });

  it('is disabled on alpha-app itself, stage and dev hosts', () => {
    expect(staffAppUrlForHostname('alpha-app.thundermail.com')).toBe('');
    expect(staffAppUrlForHostname('webmail.stage-thundermail.com')).toBe('');
    expect(staffAppUrlForHostname('localhost')).toBe('');
    expect(staffAppUrlForHostname(undefined)).toBe('');
  });
});

describe('accountsUrlForHostname', () => {
  it('uses Thunderbird Accounts stage for dev hosts', () => {
    expect(accountsUrlForHostname('localhost')).toBe('https://accounts.stage-thundermail.com');
    expect(accountsUrlForHostname('127.0.0.1')).toBe('https://accounts.stage-thundermail.com');
    expect(accountsUrlForHostname('sancus.thunderbird.net')).toBe('https://accounts.stage-thundermail.com');
  });

  it('uses Thunderbird Accounts production for the production webmail hosts', () => {
    expect(accountsUrlForHostname('webmail.thundermail.com')).toBe('https://accounts.tb.pro');
    expect(accountsUrlForHostname('alpha-app.thundermail.com')).toBe('https://accounts.tb.pro');
  });

  it('uses Thunderbird Accounts stage for hosted non-production webmail', () => {
    expect(accountsUrlForHostname('webmail.stage-thundermail.com')).toBe('https://accounts.stage-thundermail.com');
  });
});

describe('appointmentUrlForHostname', () => {
  it('uses Thunderbird Appointment stage for dev hosts', () => {
    expect(appointmentUrlForHostname('localhost')).toBe('https://appointment-stage.tb.pro');
    expect(appointmentUrlForHostname('127.0.0.1')).toBe('https://appointment-stage.tb.pro');
    expect(appointmentUrlForHostname('sancus.thunderbird.net')).toBe('https://appointment-stage.tb.pro');
  });

  it('uses Thunderbird Appointment production for the production webmail hosts', () => {
    expect(appointmentUrlForHostname('webmail.thundermail.com')).toBe('https://appointment.tb.pro');
    expect(appointmentUrlForHostname('alpha-app.thundermail.com')).toBe('https://appointment.tb.pro');
  });

  it('uses Thunderbird Appointment stage for hosted non-production webmail', () => {
    expect(appointmentUrlForHostname('webmail.stage-thundermail.com')).toBe('https://appointment-stage.tb.pro');
  });
});

describe('sendUrlForHostname', () => {
  it('uses Thunderbird Send stage for dev hosts', () => {
    expect(sendUrlForHostname('localhost')).toBe('https://send-stage.tb.pro');
    expect(sendUrlForHostname('127.0.0.1')).toBe('https://send-stage.tb.pro');
    expect(sendUrlForHostname('sancus.thunderbird.net')).toBe('https://send-stage.tb.pro');
  });

  it('uses Thunderbird Send production for the production webmail hosts', () => {
    expect(sendUrlForHostname('webmail.thundermail.com')).toBe('https://send.tb.pro');
    expect(sendUrlForHostname('alpha-app.thundermail.com')).toBe('https://send.tb.pro');
  });

  it('uses Thunderbird Send stage for hosted non-production webmail', () => {
    expect(sendUrlForHostname('webmail.stage-thundermail.com')).toBe('https://send-stage.tb.pro');
  });
});

describe('senderAvatarProxyUrlForHostname', () => {
  it('uses the hosted proxy for Thunderbird webmail hosts', () => {
    expect(senderAvatarProxyUrlForHostname('webmail.stage-thundermail.com')).toBe('https://avatars.thunderbird.net');
    expect(senderAvatarProxyUrlForHostname('webmail.thundermail.com')).toBe('https://avatars.thunderbird.net');
    expect(senderAvatarProxyUrlForHostname('alpha-app.thundermail.com')).toBe('https://avatars.thunderbird.net');
  });

  it('defaults to disabled for local and self-hosted origins', () => {
    expect(senderAvatarProxyUrlForHostname('localhost')).toBe('');
    expect(senderAvatarProxyUrlForHostname('mail.example.com')).toBe('');
  });
});

describe('defaultJmapServerUrl', () => {
  it('points the production webmail hosts at the production Stalwart server', () => {
    expect(defaultJmapServerUrl('webmail.thundermail.com')).toBe('https://mail.thundermail.com');
    expect(defaultJmapServerUrl('alpha-app.thundermail.com')).toBe('https://mail.thundermail.com');
  });

  it('points every non-production host at the stage Stalwart server', () => {
    expect(defaultJmapServerUrl('webmail.stage-thundermail.com')).toBe('https://mail.stage-thundermail.com');
    expect(defaultJmapServerUrl('localhost')).toBe('https://mail.stage-thundermail.com');
  });
});

describe('defaultJmapWsProxyUrl', () => {
  it('uses the production WebSocket auth bridge', () => {
    expect(defaultJmapWsProxyUrl('webmail.thundermail.com')).toBe('wss://jmap.thundermail.com/jmap/ws');
    expect(defaultJmapWsProxyUrl('alpha-app.thundermail.com')).toBe('wss://jmap.thundermail.com/jmap/ws');
  });

  it('uses the stage WebSocket auth bridge for non-production hosts', () => {
    expect(defaultJmapWsProxyUrl('webmail.stage-thundermail.com')).toBe('wss://jmap.stage-thundermail.com/jmap/ws');
    expect(defaultJmapWsProxyUrl('localhost')).toBe('wss://jmap.stage-thundermail.com/jmap/ws');
  });
});

describe('jmapAccountOriginForServer', () => {
  it.each([
    ['mail.thundermail.com', 'jmap.thundermail.com'],
    ['mail.stage-thundermail.com', 'jmap.stage-thundermail.com'],
  ])('preserves the existing account key for %s', (serverHost, accountHost) => {
    expect(jmapAccountOriginForServer(`https://${serverHost}`)).toBe(
      jmapAccountOriginForServer(`https://${accountHost}`),
    );
  });

  it('keeps other server origins distinct', () => {
    expect(jmapAccountOriginForServer('https://mail.example.org/jmap/')).toBe('https://mail.example.org');
    expect(jmapAccountOriginForServer('http://localhost:3001/stalwart-jmap')).toBe('http://localhost:3001');
  });
});

describe('jmapWsProxyUrlForServer', () => {
  it('maps the hosted Stalwart servers to their WebSocket auth bridges', () => {
    expect(jmapWsProxyUrlForServer('https://mail.stage-thundermail.com')).toBe(
      'wss://jmap.stage-thundermail.com/jmap/ws',
    );
    expect(jmapWsProxyUrlForServer('https://mail.thundermail.com')).toBe(
      'wss://jmap.thundermail.com/jmap/ws',
    );
  });

  it('drops local HTTP proxy paths when deriving the local WebSocket route', () => {
    expect(jmapWsProxyUrlForServer('https://localhost:3000/stalwart-jmap')).toBe(
      'wss://localhost:3000/jmap/ws',
    );
  });

  it('retains a custom server origin and port', () => {
    expect(jmapWsProxyUrlForServer('http://localhost:3001/stalwart-jmap')).toBe(
      'ws://localhost:3001/jmap/ws',
    );
    expect(jmapWsProxyUrlForServer('https://mail.example.org:8443/jmap/')).toBe(
      'wss://mail.example.org:8443/jmap/ws',
    );
  });
});

describe('JMAP endpoint configuration', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('uses the hosted WebSocket bridge with direct production HTTP', async () => {
    vi.stubEnv('VITE_JMAP_SERVER_URL', 'https://mail.thundermail.com');
    vi.stubEnv('VITE_JMAP_WS_PROXY_URL', undefined);
    vi.resetModules();
    const config = await import('../../src/defines');
    expect(config.JMAP_SERVER_URL).toBe('https://mail.thundermail.com');
    expect(config.JMAP_WS_PROXY_URL).toBe('wss://jmap.thundermail.com/jmap/ws');
  });

  it('allows the WebSocket auth bridge to be configured independently', async () => {
    vi.stubEnv('VITE_JMAP_SERVER_URL', 'https://mail.example.org');
    vi.stubEnv('VITE_JMAP_WS_PROXY_URL', 'wss://ws.example.org/jmap/ws');
    vi.resetModules();
    const config = await import('../../src/defines');
    expect(config.JMAP_SERVER_URL).toBe('https://mail.example.org');
    expect(config.JMAP_WS_PROXY_URL).toBe('wss://ws.example.org/jmap/ws');
  });

  it('preserves an explicitly disabled WebSocket auth bridge', async () => {
    vi.stubEnv('VITE_JMAP_WS_PROXY_URL', '');
    vi.resetModules();
    const config = await import('../../src/defines');
    expect(config.JMAP_WS_PROXY_URL).toBe('');
  });
});
