import { isRecord } from "./json.ts";

const clientId = "app_EMoamEEZ73f0CkXaXp7hrann";
const base = "https://auth.openai.com";

export interface DeviceLogin {
  device_auth_id: string;
  user_code: string;
  interval?: number | string;
  expires: number;
}

export interface OAuthCredential {
  access: string;
  refresh: string;
  expires: number;
  accountId: string;
}

export async function startDeviceLogin(): Promise<DeviceLogin> {
  const response = await fetch(`${base}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: clientId }),
  });
  if (!response.ok) throw new Error(`Device login could not start (${response.status})`);
  const device: unknown = await response.json();
  if (
    !isRecord(device) ||
    typeof device["device_auth_id"] !== "string" ||
    typeof device["user_code"] !== "string"
  ) {
    throw new Error("Device login returned no code");
  }
  const interval = device["interval"];
  return {
    device_auth_id: device["device_auth_id"],
    user_code: device["user_code"],
    ...(typeof interval === "number" || typeof interval === "string" ? { interval } : {}),
    expires: Date.now() + 15 * 60_000,
  };
}

/** Seconds between polls, as the device endpoint requested, but never under five. */
export function pollDelay(device: DeviceLogin): number {
  return Math.max(5_000, Number(device.interval ?? 0) * 1_000);
}

export async function pollDeviceLogin(device: DeviceLogin): Promise<OAuthCredential | null> {
  if (Date.now() > device.expires) throw new Error("The device code expired; start login again");
  const response = await fetch(`${base}/api/accounts/deviceauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_auth_id: device.device_auth_id, user_code: device.user_code }),
  });
  if (response.status === 403 || response.status === 404) return null;
  if (!response.ok) throw new Error(`Device login polling failed (${response.status})`);
  const authorization: unknown = await response.json();
  if (
    !isRecord(authorization) ||
    typeof authorization["authorization_code"] !== "string" ||
    typeof authorization["code_verifier"] !== "string"
  ) {
    throw new Error("Device login returned no authorization code");
  }
  return tokenRequest({
    grant_type: "authorization_code",
    code: authorization["authorization_code"],
    code_verifier: authorization["code_verifier"],
    redirect_uri: `${base}/deviceauth/callback`,
  });
}

/** The ChatGPT account ID inside a subscription access token. */
export function accountIdOf(accessToken: string): string {
  const payload = accessToken.split(".")[1];
  if (!payload) throw new Error("The subscription token is not a JWT");
  const claims: unknown = JSON.parse(atob(payload.replaceAll("-", "+").replaceAll("_", "/")));
  const auth = isRecord(claims) ? claims["https://api.openai.com/auth"] : undefined;
  const accountId = isRecord(auth) ? auth["chatgpt_account_id"] : undefined;
  if (typeof accountId !== "string")
    throw new Error("The subscription token has no ChatGPT account ID");
  return accountId;
}

async function tokenRequest(fields: Record<string, string>): Promise<OAuthCredential> {
  const response = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, ...fields }),
  });
  if (!response.ok) {
    throw new Error(`Subscription token exchange failed (${response.status}); sign in again`);
  }
  const value: unknown = await response.json();
  if (
    !isRecord(value) ||
    typeof value["access_token"] !== "string" ||
    typeof value["refresh_token"] !== "string" ||
    typeof value["expires_in"] !== "number" ||
    !value["expires_in"]
  ) {
    throw new Error("Token exchange returned incomplete credentials");
  }
  return {
    access: value["access_token"],
    refresh: value["refresh_token"],
    expires: Date.now() + value["expires_in"] * 1_000,
    accountId: accountIdOf(value["access_token"]),
  };
}
