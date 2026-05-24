import { describe, expect, it } from 'vitest';

import {
  accountsUrlForHostname,
  appointmentUrlForHostname,
  defaultJmapServerUrl,
  defaultJmapWsProxyUrl,
  sendUrlForHostname,
  senderAvatarProxyUrlForHostname,
} from '../../src/defines.js';

describe('accountsUrlForHostname', () => {
  it('uses Thunderbird Accounts stage for dev hosts', () => {
    expect(accountsUrlForHostname('localhost')).toBe('https://accounts-stage.tb.pro');
    expect(accountsUrlForHostname('127.0.0.1')).toBe('https://accounts-stage.tb.pro');
    expect(accountsUrlForHostname('sancus.thunderbird.net')).toBe('https://accounts-stage.tb.pro');
  });

  it('uses Thunderbird Accounts production for the production webmail host', () => {
    expect(accountsUrlForHostname('webmail.thundermail.com')).toBe('https://accounts.tb.pro');
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

  it('uses Thunderbird Appointment production for the production webmail host', () => {
    expect(appointmentUrlForHostname('webmail.thundermail.com')).toBe('https://appointment.tb.pro');
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

  it('uses Thunderbird Send production for the production webmail host', () => {
    expect(sendUrlForHostname('webmail.thundermail.com')).toBe('https://send.tb.pro');
  });

  it('uses Thunderbird Send stage for hosted non-production webmail', () => {
    expect(sendUrlForHostname('webmail.stage-thundermail.com')).toBe('https://send-stage.tb.pro');
  });
});

describe('senderAvatarProxyUrlForHostname', () => {
  it('uses the hosted proxy for Thunderbird webmail hosts', () => {
    expect(senderAvatarProxyUrlForHostname('webmail.stage-thundermail.com')).toBe('https://avatars.thunderbird.net');
    expect(senderAvatarProxyUrlForHostname('webmail.thundermail.com')).toBe('https://avatars.thunderbird.net');
  });

  it('defaults to disabled for local and self-hosted origins', () => {
    expect(senderAvatarProxyUrlForHostname('localhost')).toBe('');
    expect(senderAvatarProxyUrlForHostname('mail.example.com')).toBe('');
  });
});

describe('defaultJmapServerUrl', () => {
  it('points the production webmail host directly at the production Stalwart host', () => {
    expect(defaultJmapServerUrl('webmail.thundermail.com')).toBe('https://mail.thundermail.com');
  });

  it('points every non-production host at the stage Stalwart host', () => {
    expect(defaultJmapServerUrl('webmail.stage-thundermail.com')).toBe('https://mail.stage-thundermail.com');
    expect(defaultJmapServerUrl('localhost')).toBe('https://mail.stage-thundermail.com');
  });
});

describe('defaultJmapWsProxyUrl', () => {
  it('points the production webmail host at the production WebSocket auth bridge', () => {
    expect(defaultJmapWsProxyUrl('webmail.thundermail.com')).toBe('https://wsmail.thundermail.com');
  });

  it('points every non-production host at the stage WebSocket auth bridge', () => {
    expect(defaultJmapWsProxyUrl('webmail.stage-thundermail.com')).toBe('https://wsmail.stage-thundermail.com');
    expect(defaultJmapWsProxyUrl('localhost')).toBe('https://wsmail.stage-thundermail.com');
  });
});
