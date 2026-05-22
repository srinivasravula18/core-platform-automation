import fs from "node:fs";
import path from "node:path";
import { request, type FullConfig } from "@playwright/test";
import {
  TEST_PASSWORD,
  TEST_USERNAME
} from "./helpers/sessionAuth";

const adminBaseUrl = process.env.ADMIN_BASE_URL || "http://localhost:5002";
const keystoneBaseUrl =
  process.env.TEST_BASE_URL || process.env.TEST_UI_URL || "http://localhost:5003";
const serviceBaseUrl = process.env.TEST_API_URL || "http://localhost:5001";

const ACCESS_COOKIE_NAME = "cp_access_token";
const REFRESH_COOKIE_NAME = "cp_refresh_token";

const ensureDir = (target: string) => {
  if (!fs.existsSync(target)) {
    fs.mkdirSync(target, { recursive: true });
  }
};

const hostnamesForAuth = () =>
  Array.from(
    new Set(
      [adminBaseUrl, keystoneBaseUrl, serviceBaseUrl].map((url) => new URL(url).hostname)
    )
  );

const originsForApps = () =>
  Array.from(new Set([adminBaseUrl, keystoneBaseUrl].map((url) => new URL(url).origin))).map(
    (origin) => ({ origin, localStorage: [] })
  );

const ensureCookieForHost = (
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: "Strict" | "Lax" | "None";
  }>,
  host: string,
  name: string,
  value: string,
  expires: number
) => {
  if (
    cookies.some(
      (cookie) =>
        cookie.name === name &&
        cookie.path === "/" &&
        (cookie.domain === host || cookie.domain === `.${host}`)
    )
  ) {
    return;
  }
  cookies.push({
    name,
    value,
    domain: host,
    path: "/",
    expires,
    httpOnly: true,
    secure: false,
    sameSite: "Lax"
  });
};

const globalSetup = async (_config: FullConfig) => {
  if (!TEST_USERNAME || !TEST_PASSWORD) {
    throw new Error("List-view regression credentials are missing.");
  }

  const storageDir = path.join(__dirname, ".storage");
  ensureDir(storageDir);
  const storagePath = path.join(storageDir, "list-view.json");

  const api = await request.newContext({ baseURL: serviceBaseUrl });
  try {
    const loginResponse = await api.post("/auth/login", {
      data: { username: TEST_USERNAME, password: TEST_PASSWORD }
    });
    const rawBody = await loginResponse.text();
    if (!loginResponse.ok()) {
      const retryAfter = loginResponse.headers()["retry-after"];
      const retryMessage = retryAfter ? ` Retry after ${retryAfter} seconds.` : "";
      throw new Error(
        `List-view auth setup failed with HTTP ${loginResponse.status()}.${retryMessage} ${rawBody}`.trim()
      );
    }

    const payload = JSON.parse(rawBody) as {
      access_token?: string;
      refresh_token?: string;
    };
    if (!payload.access_token) {
      throw new Error("List-view auth setup did not receive an access token.");
    }

    const state = await api.storageState();
    const cookies = [...state.cookies];
    const now = Math.floor(Date.now() / 1000);
    for (const host of hostnamesForAuth()) {
      ensureCookieForHost(cookies, host, ACCESS_COOKIE_NAME, payload.access_token, now + 8 * 60 * 60);
      if (payload.refresh_token) {
        ensureCookieForHost(cookies, host, REFRESH_COOKIE_NAME, payload.refresh_token, now + 30 * 24 * 60 * 60);
      }
    }

    fs.writeFileSync(
      storagePath,
      JSON.stringify(
        {
          cookies,
          origins: originsForApps()
        },
        null,
        2
      ),
      "utf8"
    );
  } finally {
    await api.dispose();
  }
};

export default globalSetup;
