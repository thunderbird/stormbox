import appointmentGlyph from '../assets/icons/app-tile-appointment.svg?raw';
import mailGlyph from '../assets/icons/app-tile-mail.svg?raw';
import sendGlyph from '../assets/icons/app-tile-send.svg?raw';
import { APPOINTMENT_URL, SEND_URL } from '../defines';

export interface ProApp {
  id: 'appointment' | 'send';
  name: string;
  href: string;
  /** Public path of the 64px app tile, shared with the other Pro apps. */
  icon: string;
  /**
   * Inline SVG of the app-drawer glyph, filled with `currentColor`. The
   * viewBox is the design's 27px glyph frame, so it sits in the tile as
   * drawn.
   */
  glyph: string;
}

/** Thunderbird Pro apps other than Mail, in app-drawer order. */
export const OTHER_PRO_APPS: readonly ProApp[] = [
  {
    id: 'appointment',
    name: 'Appointment',
    href: APPOINTMENT_URL,
    icon: '/icons/icon-appointment.svg',
    glyph: appointmentGlyph,
  },
  {
    id: 'send', name: 'Send', href: SEND_URL, icon: '/icons/icon-send.svg', glyph: sendGlyph,
  },
];

export const MAIL_APP_ICON = '/icons/icon-mail.svg';
export const MAIL_APP_GLYPH = mailGlyph;
