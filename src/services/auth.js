import { createOidc, oidcEarlyInit } from "oidc-spa/core";
import { OIDC_ISSUER, OIDC_CLIENT_ID } from "../defines.js";

oidcEarlyInit({ BASE_URL: "/" });

let oidcInstance = null;
let oidcPromise = null;

export async function initOidc() {
  if (oidcInstance) return oidcInstance;
  if (oidcPromise) return oidcPromise;

  oidcPromise = createOidc({
    issuerUri: OIDC_ISSUER,
    clientId: OIDC_CLIENT_ID,
  });

  oidcInstance = await oidcPromise;
  oidcPromise = null;
  return oidcInstance;
}

export function getOidc() {
  return oidcInstance;
}
