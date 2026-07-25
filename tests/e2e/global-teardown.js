import { releaseLaneLock } from './helpers/lane-lock.js';

export default function globalTeardown() {
  releaseLaneLock();
}
