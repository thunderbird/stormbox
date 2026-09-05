import { APPOINTMENT_URL, SEND_URL } from '../defines';

export interface ProApp {
  id: 'appointment' | 'send';
  name: string;
  href: string;
  /** Public path of the 64px app tile, shared with the other Pro apps. */
  icon: string;
}

/** Thunderbird Pro apps other than Mail, in app-drawer order. */
export const OTHER_PRO_APPS: readonly ProApp[] = [
  { id: 'appointment', name: 'Appointment', href: APPOINTMENT_URL, icon: '/icons/icon-appointment.svg' },
  { id: 'send', name: 'Send', href: SEND_URL, icon: '/icons/icon-send.svg' },
];

export const MAIL_APP_ICON = '/icons/icon-mail.svg';
