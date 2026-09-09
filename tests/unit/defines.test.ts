import { describe, expect, it } from 'vitest';

import {
  accountsUrlForHostname,
  appointmentUrlForHostname,
  defaultJmapServerUrl,
  defaultJmapWsProxyUrl,
  isProdWebmailHostname,
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
    expect(accountsUrlForHostname('localhost')).toBe('https://accounts-stage.tb.pro');
    expect(accountsUrlForHostname('127.0.0.1')).toBe('https://accounts-stage.tb.pro');
    expect(accountsUrlForHostname('sancus.thunderbird.net')).toBe('https://accounts-stage.tb.pro');
  });

  it('uses Thunderbird Accounts production for the production webmail hosts', () => {
    expect(accountsUrlForHostname('webmail.thundermail.com')).toBe('https://accounts.tb.pro');
    expect(accountsUrlForHostname('alpha-app.thundermail.com')).toBe('https://accounts.tb.pro');
  });

  it('uses Thunderbird Accounts stage for hosted non-production webmail', () => {
    expect(accountsUrlForHostname('webmail.stage-thundermail.com')).toBe('https://accounts-stage.tb.pro');
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
  it('points the production webmail hosts at the production JMAP HTTP bridge', () => {
    expect(defaultJmapServerUrl('webmail.thundermail.com')).toBe('https://jmap.thundermail.com');
    expect(defaultJmapServerUrl('alpha-app.thundermail.com')).toBe('https://jmap.thundermail.com');
  });

  it('points every non-production host at the stage JMAP HTTP bridge', () => {
    expect(defaultJmapServerUrl('webmail.stage-thundermail.com')).toBe('https://jmap.stage-thundermail.com');
    expect(defaultJmapServerUrl('localhost')).toBe('https://jmap.stage-thundermail.com');
  });
});

describe('defaultJmapWsProxyUrl', () => {
  it('derives the production WebSocket auth bridge from the production JMAP bridge', () => {
    expect(defaultJmapWsProxyUrl('webmail.thundermail.com')).toBe('wss://jmap.thundermail.com/jmap/ws');
    expect(defaultJmapWsProxyUrl('alpha-app.thundermail.com')).toBe('wss://jmap.thundermail.com/jmap/ws');
  });

  it('derives every non-production WebSocket auth bridge from the stage JMAP bridge', () => {
    expect(defaultJmapWsProxyUrl('webmail.stage-thundermail.com')).toBe('wss://jmap.stage-thundermail.com/jmap/ws');
    expect(defaultJmapWsProxyUrl('localhost')).toBe('wss://jmap.stage-thundermail.com/jmap/ws');
  });
});

describe('jmapWsProxyUrlForServer', () => {
  it('uses the same origin as the configured JMAP server', () => {
    expect(jmapWsProxyUrlForServer('https://jmap.stage-thundermail.com')).toBe(
      'wss://jmap.stage-thundermail.com/jmap/ws',
    );
  });

  it('drops local HTTP proxy paths when deriving the local WebSocket route', () => {
    expect(jmapWsProxyUrlForServer('https://localhost:3000/stalwart-jmap')).toBe(
      'wss://localhost:3000/jmap/ws',
    );
  });
});
